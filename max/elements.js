// elements.js — 運動共感エレメント抽出 (ZIG SIM PRO OSC → 10要素の活性度)
// Max [js] 用 (ES5)。入力: udpreceive からの OSC メッセージ。
// outlet 0: 10要素の活性度リスト (0..1) を UPDATE_MS 毎に出力 (multislider と s ed-acts へ)
// outlet 1: ステータス ("rate <Hz>", "accelmode ...", "novelty ...", selftest ログ等)
// outlet 2: 音の制御ストリーム — 音の中身は各要素ボイス (elem.<名前>~.maxpat) が決める:
//   "weights w0..w9"      スポットライト重み (温度リーク込み、なめらか)
//   "gain <0..1>"         master gain (表出しないと鳴らない)
//   "spot <idx> <name>"   スポットライトの現在地
//   "event arc-stop <鋭さ>" / "event onset <強さ>"  離散イベント (打撃系の音に使う)
//
// メッセージ:
//   selftest 1 / 0   … 合成データで全パイプラインを検証 (電話不要)
//   reset            … 正規化 min/max とバッファをリセット
//   accelmode 1 / 0  … accel が重力込み(1)/重力抜き(0) を手動指定 (通常は自動判定)
//   spotlight <n>    … スポットライトを要素 n (0-9) に固定。-1 で自動 (ドリフト)
//   loadmap          … dict "elementmap" (mapping.json) から到達可能性行列を再読込

autowatch = 1;
inlets = 1;
outlets = 3;

// ---- 設定 ----
var WIN_MS = 500;        // 特徴抽出窓 (ms)
var UPDATE_MS = 50;      // 特徴計算・出力周期 (20Hz)。センサー取り込みは受信レートそのまま
var SLOW_HOP_MS = 100;   // rhythm 用バッファの hop
var SLOW_LEN = 30;       // rhythm 用バッファ長 (約3秒)
var NORM_DECAY = 0.00005; // 走行 min/max の減衰 (update 毎)。レンジ半減期 ≈ 5分

// 出力の非対称スムージング: 立ち上がりは即時、下がり・揺り戻しは滑らかに
var ATTACK_TAU = 0.12;   // 上昇の時定数 (秒)
var RELEASE_TAU = 0.5;   // 下降の時定数 (秒)
// 動きの激しさに応じてスムージングを縮める (激しいとき=即時フィードバック、
// 静かなとき=上記の時定数のまま滑らか)
var FAST_LIN = 4;        // この linRMS (m/s²) で速度感が満了
var FAST_ROT = 3;        // この rotRMS (rad/s) で速度感が満了
var FAST_ATT = 0.5;      // 最速時の ATTACK_TAU 倍率
var FAST_REL = 0.15;     // 最速時の RELEASE_TAU 倍率 (0.5s → 0.075s)
var GYRO_DEG = 0;        // ZIG SIM の gyro が deg/s なら 1 (通常 CoreMotion 準拠で rad/s)
var G2MS2 = 9.80665;     // accel/gravity は G 単位で届く前提

// 振動/張力の帯域分離 (ゆるやかなクロスフェード)
var SPEC_MS = 1500;      // スペクトル解析窓 (低域 1Hz を見るため長め)
var SPLIT_HZ = 4.5;      // 張力↔振動 の交差中心周波数
var SPLIT_W = 1.5;       // 交差のなだらかさ (大きいほどゆるやか)
var SPEC_FREQS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 13, 16, 20, 25];
var TREMOR_GAIN = 14;    // 張力の震え項のゲイン (震えは本質的に小振幅のため底上げ)
var TREMOR_SUPP = 0.35;  // 震え項の抑制係数 (1/この値 m/s² でゼロ。小さいほど寛容)

// 関節: 円弧→停止のイベント検出
var ARC_ON = 1.2;        // 円弧の開始とみなす角速度 (rad/s)
var ARC_OFF = 0.6;       // 円弧の終了 (停止) とみなす角速度の下限 (rad/s)
var MIN_ARC = 0.6;       // 停止ボーナスを与える最小掃引角 (rad)
var ARC_FULL = 2.5;      // この掃引角 (rad) で確信度が満了
var ARC_STOP_REF = 0.35; // この秒数以内に止まれば「急停止」満点
var ARC_DECAY = 1.2;     // 停止後のエンベロープ減衰時定数 (秒)

var NAMES = ["balance", "rotation", "articulation", "acceleration", "deceleration",
             "gravity", "vibration", "rhythm", "tension", "stillness"];

// ---- 音の制御 (音の中身は Max 側の要素ボイスが決める) ----
var SPOT_TAU = 0.4;      // スポットライト重みのクロスフェード時定数 (秒)
var GAIN_CURVE = 1.3;    // master gain のカーブ (活性度^この値)

// ---- Phase 4 段階1: ドリフト方策 (追いかけず、逃げる) ----
// ターゲット要素を表出したときだけ音が豊かになる。見つけて踊りきったら
// (または見つからず時間切れになったら)、まだやっていない要素へ逃げる
var SOLVE_ACT = 0.55;    // ターゲット活性がこれ以上 =「表出できている」
var SOLVE_S = 3;         // 表出の累積がこの秒数で「解けた」(GIVEUP_S より短く保つ)
var DWELL_S = 5;         // 解けてから奪うまでの滞在 (踊らせる時間)
var GIVEUP_S = 10;       // 見つからなくても諦めて移る時間
var HABIT_TAU = 120;     // 慣れトレースの時定数 (秒)
var RECENT_TAU = 300;    // 「最近ターゲットにした」ペナルティの時定数 (秒)
var TEMP_MAX = 0.3;      // 迷子のときの温度 (ターゲット外がうっすら鳴る量)
var NOVELTY_TAU = 300;   // 「普段の動き」の分布の時定数 (秒)

// 到達可能性 (行=今のターゲット、列=次の候補)。近い動きほど 1 に近い。
// dict "elementmap" の reach_<名前> で上書き可能
var REACH_DEFAULT = [
	[0,   0.3, 0.4, 0.4, 0.5, 0.9, 0.3, 0.3, 0.7, 0.8], // balance
	[0.3, 0,   0.8, 0.7, 0.5, 0.3, 0.4, 0.7, 0.3, 0.2], // rotation
	[0.4, 0.8, 0,   0.6, 0.7, 0.4, 0.4, 0.8, 0.5, 0.4], // articulation
	[0.4, 0.7, 0.6, 0,   0.9, 0.6, 0.5, 0.7, 0.3, 0.2], // acceleration
	[0.5, 0.5, 0.7, 0.9, 0,   0.6, 0.3, 0.5, 0.5, 0.8], // deceleration
	[0.9, 0.3, 0.4, 0.6, 0.6, 0,   0.3, 0.4, 0.7, 0.6], // gravity
	[0.3, 0.4, 0.4, 0.5, 0.3, 0.3, 0,   0.7, 0.9, 0.4], // vibration
	[0.3, 0.7, 0.8, 0.7, 0.5, 0.4, 0.7, 0,   0.4, 0.3], // rhythm
	[0.7, 0.3, 0.5, 0.3, 0.5, 0.7, 0.9, 0.4, 0,   0.9], // tension
	[0.8, 0.2, 0.4, 0.2, 0.8, 0.6, 0.4, 0.3, 0.9, 0  ]  // stillness
];
var REACH = REACH_DEFAULT;

// ---- 状態 ----
var samples = [];        // {t, ux,uy,uz (user accel, G), g:[gx,gy,gz]|null (G), wx,wy,wz (rad/s)}
var specBuf = [];        // {t, x,y,z: linear accel m/s² (符号つき)} — 振動/張力の帯域分離用 (1.5秒)
var slow = [];           // rhythm 用 linRMS 列
var lastSlowT = 0;
var curLinRMS = 0;
var curRotRMS = 0;

var lastGravity = null;
var lastGyro = null;

var accelModeKnown = false;
var accelIncludesGravity = false;
var detectBuf = [];
var warnedNoGravity = false;

var msgCount = 0;
var lastRateT = Date.now();
var lastAxisStab = 0;

var norm = [];
var smoothAct = [];
var spotW = [];          // スポットライト重み w (なめらか)
var habit = [];          // 慣れトレース: 最近どれだけ表出されたか
var recentTgt = [];      // 最近ターゲットにしたか (再選ペナルティ)
var novMean = [];        // 「普段の動き」の走行平均
var novVar = [];         // 同 分散
for (var _i = 0; _i < 10; _i++) {
	norm.push({ min: null, max: null });
	smoothAct.push(0);
	spotW.push(0);
	habit.push(0);
	recentTgt.push(0);
	novMean.push(0);
	novVar.push(0.01);
}
var spotManual = -1;     // -1 = 自動 (ドリフト方策)、0-9 = 固定
var spotIdx = 9;         // 現在のスポットライト (初期: stillness)
var lastSpotOut = -1;
var driftT = Date.now(); // 最後にドリフトした時刻
var solvedAt = 0;        // 「解けた」時刻 (0 = 未解決)
var solveAccum = 0;      // ターゲット表出の累積秒
var lastNovOut = 0;
var mapTried = false;

var updateTask = new Task(update, this);
updateTask.interval = UPDATE_MS;
updateTask.repeat();

// ---- OSC 受信 ----
function anything() {
	var seg = String(messagename).split("/");
	var name = seg[seg.length - 1];
	var args = arrayfromargs(arguments);
	if (name === "gravity" && args.length >= 3) {
		lastGravity = [args[0], args[1], args[2]];
	} else if (name === "gyro" && args.length >= 3) {
		var s = GYRO_DEG ? Math.PI / 180 : 1;
		lastGyro = [args[0] * s, args[1] * s, args[2] * s];
	} else if (name === "accel" && args.length >= 3) {
		msgCount++;
		ingestAccel(args[0], args[1], args[2]);
	}
	// quaternion 等は Phase 2 以降で使用
}

function ingestAccel(x, y, z) {
	if (st) return; // selftest 中は実機入力を無視
	if (!accelModeKnown) {
		detectBuf.push(Math.sqrt(x * x + y * y + z * z));
		if (detectBuf.length >= 100) {
			var m = 0;
			for (var i = 0; i < detectBuf.length; i++) m += detectBuf[i];
			m /= detectBuf.length;
			accelIncludesGravity = (m > 0.5);
			accelModeKnown = true;
			detectBuf = [];
			outlet(1, "accelmode", accelIncludesGravity ? "includes-gravity" : "user-accel");
		}
		return;
	}
	var u;
	if (accelIncludesGravity) {
		if (!lastGravity) { warnNoGravity(); return; }
		u = [x - lastGravity[0], y - lastGravity[1], z - lastGravity[2]];
	} else {
		u = [x, y, z];
	}
	addSample(u);
}

function addSample(u) {
	var w = lastGyro || [0, 0, 0];
	var now = Date.now();
	samples.push({
		t: now,
		ux: u[0], uy: u[1], uz: u[2],
		g: lastGravity ? [lastGravity[0], lastGravity[1], lastGravity[2]] : null,
		wx: w[0], wy: w[1], wz: w[2]
	});
	// 符号つきで保持 (大きさにすると整流で周波数が2倍に化けるため)
	specBuf.push({ t: now, x: u[0] * G2MS2, y: u[1] * G2MS2, z: u[2] * G2MS2 });
	while (specBuf.length && now - specBuf[0].t > SPEC_MS) specBuf.shift();
}

function warnNoGravity() {
	if (warnedNoGravity) return;
	warnedNoGravity = true;
	outlet(1, "warn", "gravityセンサーが届いていない (ZIG SIMでGravityを有効に)");
}

// ---- 周期処理 ----
function update() {
	var now = Date.now();
	while (samples.length && now - samples[0].t > WIN_MS) samples.shift();

	if (now - lastRateT >= 1000) {
		outlet(1, "rate", Math.round(msgCount * 1000 / (now - lastRateT) * 10) / 10);
		msgCount = 0;
		lastRateT = now;
	}

	if (samples.length < 4) return;

	var raw = computeRaw();
	raw[2] = updateArc(now, lastAxisStab);

	if (now - lastSlowT >= SLOW_HOP_MS) {
		slow.push(curLinRMS);
		if (slow.length > SLOW_LEN) slow.shift();
		lastSlowT = now;
	}

	var sdt = UPDATE_MS / 1000;
	// 動きが激しいほどスムージングを縮めて即時反応に
	var speed = clamp(curLinRMS / FAST_LIN + curRotRMS / FAST_ROT, 0, 1);
	var attT = ATTACK_TAU * (1 - (1 - FAST_ATT) * speed);
	var relT = RELEASE_TAU * (1 - (1 - FAST_REL) * speed);
	var act = [];
	for (var i = 0; i < 10; i++) {
		var v = normalize(i, raw[i]);
		var tau = v > smoothAct[i] ? attT : relT;
		smoothAct[i] += (v - smoothAct[i]) * (1 - Math.exp(-sdt / tau));
		act.push(smoothAct[i]);
	}
	outlet(0, act);

	// Phase 3: スポットライト更新 → シンセパラメータ出力
	if (!mapTried) loadmap();
	updateSpot(act, now, sdt);
	emitControl(act, sdt);
	detectOnset(now);

	// selftest 中はセグメントごとに活性度を蓄積 (冒頭1.5秒の過渡は捨てる)
	if (st && stSegLast >= 0 && (stT % 5) > 1.5) {
		for (var k = 0; k < 10; k++) stAcc[k] += act[k];
		stAccN++;
	}
}

// ---- 特徴抽出 ----
function computeRaw() {
	var n = samples.length;
	var linMag = [], rotMag = [];
	var i, s;
	for (i = 0; i < n; i++) {
		s = samples[i];
		linMag.push(Math.sqrt(s.ux * s.ux + s.uy * s.uy + s.uz * s.uz) * G2MS2);
		rotMag.push(Math.sqrt(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz));
	}
	var linRMS = rms(linMag);
	var rotRMS = rms(rotMag);
	curLinRMS = linRMS;
	curRotRMS = rotRMS;

	// 支配回転軸の推定 (向きの符号を折り返して平均) と、その軸まわりの符号つき角速度
	var ax = 0, ay = 0, az = 0, nAxis = 0, ref = null;
	for (i = 0; i < n; i++) {
		if (rotMag[i] < 0.02) continue;
		s = samples[i];
		var ux = s.wx / rotMag[i], uy = s.wy / rotMag[i], uz = s.wz / rotMag[i];
		if (!ref) ref = [ux, uy, uz];
		if (ux * ref[0] + uy * ref[1] + uz * ref[2] < 0) { ux = -ux; uy = -uy; uz = -uz; }
		ax += ux; ay += uy; az += uz; nAxis++;
	}
	var axisStability = 0;
	var axLen = Math.sqrt(ax * ax + ay * ay + az * az);
	if (nAxis > 0 && axLen > 1e-9) {
		axisStability = axLen / nAxis;
		ax /= axLen; ay /= axLen; az /= axLen;
	}
	lastAxisStab = axisStability; // updateArc (関節) が参照する
	var sArr = [];
	for (i = 0; i < n; i++) {
		s = samples[i];
		sArr.push(s.wx * ax + s.wy * ay + s.wz * az);
	}

	// 加速/減速: 平滑化した |a| 包絡線 (約150ms 移動平均) の増減。
	// 生の Δ|a| だと速い震えが最大値を叩いてしまうため、持続的な変化=慣性感のみ拾う
	var K = Math.max(1, Math.round(n * 0.3));
	var env = [], runsum = 0;
	for (i = 0; i < n; i++) {
		runsum += linMag[i];
		if (i >= K) runsum -= linMag[i - K];
		env.push(runsum / Math.min(i + 1, K));
	}
	var acc = 0, dec = 0, nd = 0;
	for (i = 1; i < n; i++) {
		var dv = env[i] - env[i - 1];
		if (dv > 0) acc += dv; else dec -= dv;
		nd++;
	}
	if (nd) { acc /= nd; dec /= nd; }

	// 傾き: スマホの傾き角そのもの (gravity ベクトルから直接)
	var tilt = 0;
	var g = samples[n - 1].g;
	if (g) {
		var gm = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
		if (gm > 1e-6) tilt = Math.acos(clamp(-g[2] / gm, -1, 1));
	}
	var balance = tilt / Math.PI;

	// 重力: 重力方向への移動と重力に抗う移動の両方。
	// 加速度の鉛直成分の大きさ × 動きの鉛直性 (どれだけ鉛直に向いた動きか)。
	// 自由落下は鉛直成分 9.8 m/s² として自然に最大級になる
	var vertSq = 0, vertCnt = 0;
	for (i = 0; i < n; i++) {
		s = samples[i];
		if (!s.g) continue;
		var gm2 = Math.sqrt(s.g[0] * s.g[0] + s.g[1] * s.g[1] + s.g[2] * s.g[2]);
		if (gm2 < 1e-6) continue;
		var vp = (s.ux * s.g[0] + s.uy * s.g[1] + s.uz * s.g[2]) / gm2 * G2MS2;
		vertSq += vp * vp;
		vertCnt++;
	}
	var grav = 0;
	if (vertCnt && linRMS > 1e-6) {
		var vertRMS = Math.sqrt(vertSq / vertCnt);
		var vertShare = Math.min(1, vertRMS / linRMS);
		grav = vertRMS * (0.3 + 0.7 * vertShare);
	}

	// 回転: 軸が安定し方向が持続する回転 × 遠心力の証拠 (|a| と ω² の共変)
	var sMean = 0;
	for (i = 0; i < n; i++) sMean += sArr[i];
	sMean /= n;
	var sRms = rms(sArr);
	var dirConsist = sRms > 1e-6 ? Math.abs(sMean) / sRms : 0;
	var w2 = [];
	for (i = 0; i < n; i++) w2.push(sArr[i] * sArr[i]);
	// 遠心力の証拠は控えめなボーナスに留める (半径ゼロ付近で回すと遠心加速度が
	// 出ないため、乗数を強くすると平面回転が沈んでしまう)
	var corrP = Math.max(0, pearson(linMag, w2));
	var rotation = rotRMS * axisStability * dirConsist * (0.7 + 0.3 * corrP);

	// 軌道回転: スマホの姿勢は変わらず (ジャイロ≈0)、腕で円周上を回る動き。
	// 向心加速度ベクトルが一定の向きに回り続けること (a × ȧ の向きの一貫性) で
	// 検出する。往復 (振り子的な弧) は外積の向きが反転して打ち消される
	var aPrev = null, tPrev = 0;
	var ccx = 0, ccy = 0, ccz = 0, cAbs = 0, a2Sum = 0;
	for (i = 0; i < n; i++) {
		s = samples[i];
		var pax = s.ux * G2MS2, pay = s.uy * G2MS2, paz = s.uz * G2MS2;
		a2Sum += pax * pax + pay * pay + paz * paz;
		if (aPrev) {
			var dts = (s.t - tPrev) / 1000;
			if (dts > 0) {
				var dax = (pax - aPrev[0]) / dts;
				var day = (pay - aPrev[1]) / dts;
				var daz = (paz - aPrev[2]) / dts;
				var kx = aPrev[1] * daz - aPrev[2] * day;
				var ky = aPrev[2] * dax - aPrev[0] * daz;
				var kz = aPrev[0] * day - aPrev[1] * dax;
				ccx += kx; ccy += ky; ccz += kz;
				cAbs += Math.sqrt(kx * kx + ky * ky + kz * kz);
			}
		}
		aPrev = [pax, pay, paz];
		tPrev = s.t;
	}
	// ノイズ対策: |a| が小さいと ω=|a×ȧ|/|a|² の分母が小さく推定が暴れるため、
	// 振幅ゲート・一貫性の下限・推定値の上限で頑健化する
	var a2Mean = a2Sum / n;
	if (n > 4 && a2Mean > 1.0 && cAbs > 1e-9) {
		var cMag = Math.sqrt(ccx * ccx + ccy * ccy + ccz * ccz);
		var circConsist = cMag / cAbs;
		if (circConsist > 0.4) {
			var omegaEst = Math.min(15, (cMag / (n - 1)) / a2Mean); // 公転角速度 (rad/s)
			var ampW = clamp(Math.sqrt(a2Mean) / 2, 0, 1);
			// 0.5 は自転側 (rotRMS·0.7~) とのスケール合わせ
			rotation = Math.max(rotation,
				omegaEst * ((circConsist - 0.4) / 0.6) * ampW * 0.5);
		}
	}

	// 関節は updateArc() でイベント検出 (円弧→停止)。ここでは 0 を置き
	// update() 側で上書きする
	var artic = 0;

	var rhythm = autocorrPeak(slow);

	// 振動/張力: 揺れのエネルギーを周波数ごとに、SPLIT_HZ を中心とした
	// ゆるやかなシグモイドで両者にクロスフェード按分する
	var spec = spectralSplit();
	var vibration = spec.high;
	// 張力 = しなやかな低域の揺れ + 静けさの中の微細な震え (アイソメトリックな緊張)。
	// 大きく激しい震えは振動のみ、止まったままの震えは張力にも配分される
	var tension = spec.low + spec.high * TREMOR_GAIN * Math.max(0, 1 - spec.rms * TREMOR_SUPP);

	var stillness = Math.max(0, 1 - (linRMS + rotRMS) * 0.8);

	return [balance, rotation, artic, acc, dec, grav, vibration, rhythm, tension, stillness];
}

// ---- 関節: 円弧への確信の漸増 + 停止での完結 ----
// 「円弧的な動きだと分かってきたら関節と言える」— 円弧が続くほど確信度が
// 徐々に上がり (爆発しない)、停止した瞬間に円弧の完結として穏やかなボーナス。
// 止まらずに回り続ける場合は回転なので、1.5秒を超えると確信が薄れる。
var arcActive = false;
var arcAngle = 0;
var arcPeak = 0;
var arcDecelT = 0;
var arcStartT = 0;
var arcLastT = 0;
var articEnv = 0;

function updateArc(now, axisStab) {
	var n = samples.length;
	if (!n) return articEnv;
	// 直近 ~150ms の平均角速度 (瞬時値のノイズを均す)
	var w = 0, c = 0;
	for (var i = n - 1; i >= 0 && samples[n - 1].t - samples[i].t <= 150; i--) {
		var s = samples[i];
		w += Math.sqrt(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz);
		c++;
	}
	w /= c;
	var dt = arcLastT ? Math.min(0.5, (now - arcLastT) / 1000) : 0.05;
	arcLastT = now;

	// 停止判定はピーク角速度に対する相対値も併用 (人間は「止めた」あとも
	// 残留の揺れでジャイロが完全には静まらないため、絶対閾値だけだと終わらない)
	var arcEnd = Math.max(ARC_OFF, 0.2 * arcPeak);
	if (w > ARC_ON || (arcActive && w > arcEnd)) {
		if (!arcActive) {
			arcActive = true;
			arcAngle = 0;
			arcPeak = 0;
			arcDecelT = now;
			arcStartT = now;
		}
		arcAngle += w * dt;
		if (w > arcPeak) arcPeak = w;
		if (w >= 0.7 * arcPeak) arcDecelT = now; // まだ減速が始まっていない
		// 確信度: 掃引角が積み上がるほど上がる (最大 0.6、残りは停止の完結で)。
		// 長く回り続けると回転とみなし durW で薄れる
		var arcDur = (now - arcStartT) / 1000;
		var durW = arcDur < 1.0 ? 1 : clamp(1 - (arcDur - 1.0), 0, 1);
		var target = 0.6 * clamp(arcAngle / ARC_FULL, 0, 1) * (0.4 + 0.6 * axisStab) * durW;
		var tau = target > articEnv ? 0.25 : 0.8;
		articEnv += (target - articEnv) * (1 - Math.exp(-dt / tau));
	} else {
		if (arcActive) {
			arcActive = false;
			if (arcAngle > MIN_ARC) {
				var stopDur = Math.max(0.05, (now - arcDecelT) / 1000);
				var sharp = clamp(ARC_STOP_REF / stopDur, 0, 1);
				// 停止 = 円弧の完結。積み上げた確信への仕上げのボーナス
				articEnv = Math.min(1,
					articEnv + 0.4 * sharp * clamp(arcAngle / ARC_FULL, 0, 1));
				// 円弧の完結は離散イベントとしても出す (打撃系の音のトリガ用)
				outlet(2, "event", "arc-stop", Math.round(sharp * 100) / 100);
			}
		}
		articEnv *= Math.exp(-dt / ARC_DECAY);
	}
	return articEnv;
}

// |linear accel| の 1.5 秒窓を Goertzel で周波数分解し、低域 (張力寄り) と
// 高域 (振動寄り) にゆるやかに按分する。最後の (0.3+0.7·share) は、帯域の
// 純度に応じた穏やかな強調 (混在時は両方に出る)。
function spectralSplit() {
	var N = specBuf.length;
	if (N < 16) return { low: 0, high: 0, rms: 0 };
	var span = (specBuf[N - 1].t - specBuf[0].t) / 1000;
	if (span <= 0) return { low: 0, high: 0, rms: 0 };
	var fs = (N - 1) / span;
	var xs = [], ys = [], zs = [];
	var mx = 0, my = 0, mz = 0, i;
	for (i = 0; i < N; i++) {
		var b = specBuf[i];
		xs.push(b.x); ys.push(b.y); zs.push(b.z);
		mx += b.x; my += b.y; mz += b.z;
	}
	mx /= N; my /= N; mz /= N;
	var lowE = 0, highE = 0;
	for (var k = 0; k < SPEC_FREQS.length; k++) {
		var f = SPEC_FREQS[k];
		if (f > fs * 0.45) break;
		var p = goertzelPow(xs, mx, fs, f) + goertzelPow(ys, my, fs, f) + goertzelPow(zs, mz, fs, f);
		var wHigh = 1 / (1 + Math.exp(-(f - SPLIT_HZ) / SPLIT_W));
		lowE += p * (1 - wHigh);
		highE += p * wHigh;
	}
	var tot = lowE + highE;
	var lowShare = tot > 1e-12 ? lowE / tot : 0;
	// スペクトル窓と同じ 1.5 秒での揺れの RMS (張力の震え項の抑制に使う。
	// 500ms の linRMS だと激しい動きの直後にスペクトルより先に静まり、誤発火する)
	var devSq = 0;
	for (i = 0; i < N; i++) {
		var dx = specBuf[i].x - mx, dy = specBuf[i].y - my, dz = specBuf[i].z - mz;
		devSq += dx * dx + dy * dy + dz * dz;
	}
	return {
		low: Math.sqrt(lowE) * (0.3 + 0.7 * lowShare),
		high: Math.sqrt(highE) * (0.3 + 0.7 * (1 - lowShare)),
		rms: Math.sqrt(devSq / N)
	};
}

function goertzelPow(v, mean, fs, f) {
	var N = v.length;
	var c = 2 * Math.cos(2 * Math.PI * f / fs);
	var s0, s1 = 0, s2 = 0;
	for (var i = 0; i < N; i++) {
		s0 = (v[i] - mean) + c * s1 - s2;
		s2 = s1;
		s1 = s0;
	}
	return (s1 * s1 + s2 * s2 - c * s1 * s2) / (N * N);
}

function pearson(a, b) {
	var n = Math.min(a.length, b.length);
	if (n < 4) return 0;
	var ma = 0, mb = 0, i;
	for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
	ma /= n; mb /= n;
	var sab = 0, saa = 0, sbb = 0;
	for (i = 0; i < n; i++) {
		var da = a[i] - ma, db = b[i] - mb;
		sab += da * db; saa += da * da; sbb += db * db;
	}
	var den = Math.sqrt(saa * sbb);
	return den > 1e-9 ? sab / den : 0;
}

function autocorrPeak(buf) {
	var len = buf.length;
	if (len < 10) return 0;
	var mean = 0, i;
	for (i = 0; i < len; i++) mean += buf[i];
	mean /= len;
	var c = [];
	for (i = 0; i < len; i++) c.push(buf[i] - mean);
	var r0 = 0;
	for (i = 0; i < len; i++) r0 += c[i] * c[i];
	if (r0 < 1e-9) return 0;
	var best = 0;
	var maxLag = Math.min(20, len - 2);
	for (var lag = 2; lag <= maxLag; lag++) {
		var r = 0;
		for (i = 0; i + lag < len; i++) r += c[i] * c[i + lag];
		if (r > best) best = r;
	}
	// ノイズでも短系列の自己相関ピークは ~0.5 出るため、有意分のみ残す
	return clamp((best / r0 - 0.5) * 2, 0, 1);
}

// ---- Phase 4 段階1: ドリフト方策 ----
// 追いかけない。ターゲットを表出し「解けて」踊りきったら (または時間切れで)
// まだやっていない・今の動きから届く要素へ逃げる。
function updateSpot(act, now, sdt) {
	var i;
	// 慣れトレースと「普段の動き」の走行統計はモードに関わらず更新
	var kH = sdt / HABIT_TAU;
	var kR = sdt / RECENT_TAU;
	var kN = sdt / NOVELTY_TAU;
	var novSq = 0;
	for (i = 0; i < 10; i++) {
		habit[i] += (act[i] - habit[i]) * kH;
		recentTgt[i] -= recentTgt[i] * kR;
		var d = act[i] - novMean[i];
		novMean[i] += d * kN;
		novVar[i] += (d * d - novVar[i]) * kN;
		var z = d / Math.sqrt(novVar[i] + 1e-4);
		novSq += z * z;
	}
	// 新奇性 =「普段」からのずれ (1秒ごとにログ。評価と将来の学習の報酬に使う)
	if (now - lastNovOut >= 1000) {
		lastNovOut = now;
		outlet(1, "novelty", Math.round(Math.sqrt(novSq / 10) * 100) / 100);
	}

	if (spotManual >= 0) {
		if (spotIdx !== spotManual) { spotIdx = spotManual; announceSpot(); }
		return;
	}

	// 解け判定: ターゲット表出の累積 (出せていない時間はゆっくり戻す)
	if (act[spotIdx] > SOLVE_ACT) solveAccum += sdt;
	else solveAccum = Math.max(0, solveAccum - sdt * 0.5);
	if (!solvedAt && solveAccum > SOLVE_S) {
		solvedAt = now;
		outlet(1, "drift", "solved", NAMES[spotIdx]);
	}
	var dwellDone = solvedAt && (now - solvedAt > DWELL_S * 1000);
	var gaveUp = (now - driftT > GIVEUP_S * 1000);
	if (dwellDone || gaveUp) pickNext(now, dwellDone ? "dwell-end" : "giveup");
}

function pickNext(now, reason) {
	// score = まだやっていない × 今の動きから届く × 最近選んでいない
	var best = -1, bestScore = -1;
	for (var i = 0; i < 10; i++) {
		if (i === spotIdx) continue;
		var s = (1 - habit[i]) * REACH[spotIdx][i] * (1 - 0.7 * recentTgt[i]);
		if (s > bestScore) { bestScore = s; best = i; }
	}
	outlet(1, "drift", reason, NAMES[spotIdx], "->", NAMES[best]);
	spotIdx = best;
	recentTgt[best] = 1;
	driftT = now;
	solvedAt = 0;
	solveAccum = 0;
	announceSpot();
}

function announceSpot() {
	if (spotIdx !== lastSpotOut) {
		lastSpotOut = spotIdx;
		outlet(2, "spot", spotIdx, NAMES[spotIdx]);
	}
}

// 重み w = ターゲット中心 + 温度リーク: 迷子 (ターゲット活性が低い) のときは
// REACH に応じて周辺の要素ボイスもうっすら混ざり、手がかりを残す。
// master gain ∝ Σw·a — 表出しないと鳴らない (作品の心臓部)
function emitControl(act, sdt) {
	var k = 1 - Math.exp(-sdt / SPOT_TAU);
	var i;
	var temp = spotManual >= 0 ? 0
		: TEMP_MAX * (1 - clamp(act[spotIdx] / SOLVE_ACT, 0, 1));
	var wT = [], wSum = 0;
	for (i = 0; i < 10; i++) {
		wT.push(i === spotIdx ? 1 : temp * REACH[spotIdx][i]);
		wSum += wT[i];
	}
	var aSpot = 0;
	var msg = ["weights"];
	for (i = 0; i < 10; i++) {
		spotW[i] += (wT[i] / wSum - spotW[i]) * k;
		aSpot += spotW[i] * act[i];
		msg.push(Math.round(spotW[i] * 1000) / 1000);
	}
	outlet(2, msg);
	outlet(2, "gain", Math.pow(clamp(aSpot, 0, 1), GAIN_CURVE));
}

function spotlight(v) {
	v = Math.floor(v);
	spotManual = (v >= 0 && v < 10) ? v : -1;
	if (spotManual < 0) { driftT = Date.now(); solvedAt = 0; solveAccum = 0; }
	outlet(1, "spotmode", spotManual < 0 ? "auto(drift)" : NAMES[spotManual]);
}

// dict "elementmap" (mapping.json) から M と base を読む。無ければ既定値。
// mapping.json を編集したら、dict に import → js に loadmap で反映
function loadmap() {
	mapTried = true;
	var reach = null;
	try {
		var d = new Dict("elementmap");
		if (d.getkeys()) {
			var rr = [];
			for (var ri = 0; ri < 10; ri++) {
				var rv = d.get("reach_" + NAMES[ri]);
				if (rv && rv.length === 10) {
					var r2 = [];
					for (var rj = 0; rj < 10; rj++) r2.push(Number(rv[rj]));
					rr.push(r2);
				} else { rr = null; break; }
			}
			reach = rr;
		}
	} catch (e) { reach = null; }
	if (reach) {
		REACH = reach;
		outlet(1, "map", "reach loaded (dict elementmap)");
	} else {
		REACH = REACH_DEFAULT;
		outlet(1, "map", "builtin reach defaults");
	}
}

// 加速のオンセット: |a| の包絡が立ち上がった瞬間 (打撃系の音のトリガ用)
var ONSET_THRESH = 2.5;  // m/s²
var ONSET_REFRACT = 250; // ms (連射防止)
var prevLin = 0;
var lastOnsetT = 0;
function detectOnset(now) {
	if (curLinRMS > ONSET_THRESH && prevLin <= ONSET_THRESH &&
		now - lastOnsetT > ONSET_REFRACT) {
		lastOnsetT = now;
		outlet(2, "event", "onset", Math.round(clamp(curLinRMS / 10, 0, 1) * 100) / 100);
	}
	prevLin = curLinRMS;
}

// ---- 走行正規化 (インスタレーション形式: 減衰つき min/max) ----
function normalize(idx, v) {
	var m = norm[idx];
	if (m.min === null) { m.min = v; m.max = v; return 0; }
	m.min += (m.max - m.min) * NORM_DECAY;
	m.max -= (m.max - m.min) * NORM_DECAY;
	if (v < m.min) m.min = v;
	if (v > m.max) m.max = v;
	var range = m.max - m.min;
	return range > 1e-9 ? clamp((v - m.min) / range, 0, 1) : 0;
}

// ---- ユーティリティ ----
function rms(arr) {
	if (!arr.length) return 0;
	var s = 0;
	for (var i = 0; i < arr.length; i++) s += arr[i] * arr[i];
	return Math.sqrt(s / arr.length);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ---- メッセージ ----
function reset() {
	for (var i = 0; i < 10; i++) { norm[i].min = null; norm[i].max = null; smoothAct[i] = 0; }
	samples = [];
	specBuf = [];
	slow = [];
	arcActive = false;
	articEnv = 0;
	arcLastT = 0;
	for (i = 0; i < 10; i++) {
		spotW[i] = 0;
		habit[i] = 0;
		recentTgt[i] = 0;
		novMean[i] = 0;
		novVar[i] = 0.01;
	}
	driftT = Date.now();
	solvedAt = 0;
	solveAccum = 0;
	outlet(1, "reset", "done");
}

function accelmode(v) {
	accelModeKnown = true;
	accelIncludesGravity = v ? true : false;
	outlet(1, "accelmode", accelIncludesGravity ? "includes-gravity (manual)" : "user-accel (manual)");
}

// ---- セルフテスト: 電話なしで全パイプラインを検証 ----
// 5秒ごとに 静止→傾き→振動→リズム→回転→加減速 を巡回。対応する要素の
// バーが順に立てばパイプラインは正常。
var st = 0;
var stT = 0;
var stSegLast = -1;
var ST_LABELS = ["stillness", "balance(tilt)", "vibration(12Hz)", "rhythm(1Hz)", "rotation(flat-spin)", "accel/decel", "articulation(arc-stop)", "tension(sway2.5Hz)", "tension(tremor10Hz)", "gravity(vertical)", "rotation(orbital)"];
// 各セグメントで期待する要素 (act のインデックス)。top-3 に入れば PASS。
var ST_EXPECT = [[9], [0], [6], [7], [1], [3, 4], [2], [8], [8], [5], [1]];
var stAcc = [];
var stAccN = 0;
var stTask = new Task(selfstep, this);
stTask.interval = 16;

function stResetAcc() {
	stAcc = [];
	for (var i = 0; i < 10; i++) stAcc.push(0);
	stAccN = 0;
}
stResetAcc();

// セグメント終了時の自動採点。1周目は正規化レンジの学習中で信頼できないため
// 2周目 (stT > 30) 以降のみ判定する。
function stJudge(seg) {
	if (stAccN < 5) { stResetAcc(); return; }
	var mean = [], i;
	for (i = 0; i < 10; i++) mean.push({ idx: i, v: stAcc[i] / stAccN });
	stResetAcc();
	if (stT < 5 * ST_LABELS.length + 2) return; // 1周目は正規化学習中のためスキップ
	mean.sort(function (a, b) { return b.v - a.v; });
	var exp = ST_EXPECT[seg];
	var pass = false;
	for (i = 0; i < 3; i++) {
		for (var j = 0; j < exp.length; j++) {
			if (mean[i].idx === exp[j]) pass = true;
		}
	}
	outlet(1, "check", ST_LABELS[seg], pass ? "PASS" : "FAIL",
		"top3:",
		NAMES[mean[0].idx], Math.round(mean[0].v * 100) / 100,
		NAMES[mean[1].idx], Math.round(mean[1].v * 100) / 100,
		NAMES[mean[2].idx], Math.round(mean[2].v * 100) / 100);
}

function selftest(v) {
	st = v ? 1 : 0;
	if (st) {
		accelModeKnown = true;
		accelIncludesGravity = false;
		samples = [];
		specBuf = [];
		slow = [];
		arcActive = false;
		articEnv = 0;
		arcLastT = 0;
		stT = 0;
		stSegLast = -1;
		stResetAcc();
		stTask.repeat();
		outlet(1, "selftest", "on");
	} else {
		stTask.cancel();
		accelModeKnown = false;
		detectBuf = [];
		outlet(1, "selftest", "off");
	}
}

function selfstep() {
	stT += 0.016;
	var seg = Math.floor(stT / 5) % ST_LABELS.length;
	if (seg !== stSegLast) {
		if (stSegLast >= 0) stJudge(stSegLast);
		stSegLast = seg;
		outlet(1, "selftest", "segment", ST_LABELS[seg]);
	}
	var g = [0, 0, -1], u = [0, 0, 0], w = [0, 0, 0];
	if (seg === 0) {
		u = [nz(0.005), nz(0.005), nz(0.005)];
	} else if (seg === 1) {
		var th = ((stT % 5) / 5) * 1.2;
		g = [Math.sin(th), 0, -Math.cos(th)];
		u = [nz(0.01), nz(0.01), nz(0.01)];
	} else if (seg === 2) {
		u = [0.4 * Math.sin(2 * Math.PI * 12 * stT) + nz(0.05), nz(0.05), nz(0.05)];
	} else if (seg === 3) {
		u = [0.3 * Math.sin(2 * Math.PI * 1.0 * stT), 0, 0];
	} else if (seg === 4) {
		// 平面スピン: 傾きを変えず自身を中心に回転 (半径≈0で遠心加速度なし)。
		// 実機で沈んでいたケースなので、遠心力ゼロでも立つことを検証する
		var wz = 3 + 1.5 * Math.sin(2 * Math.PI * 0.5 * stT);
		w = [0, 0, wz];
		u = [nz(0.02), nz(0.02), nz(0.02)];
	} else if (seg === 5) {
		// ゆっくり加速して減速 (周期3秒: 張力・リズムの帯域より遅い)
		var ph = stT % 3;
		var mag = ph < 1.5 ? ph * 0.8 : (3 - ph) * 0.8;
		u = [mag, 0, 0];
	} else if (seg === 6) {
		// 関節: 大きな円弧を描いて止まる (0.7秒スイング + 0.5秒停止、向きは交互)
		var pc = stT % 1.2;
		var dir = (Math.floor(stT / 1.2) % 2) ? -1 : 1;
		var hz = pc < 0.7 ? dir * 2.5 * Math.sin(Math.PI * pc / 0.7) : 0;
		w = [0, 0, hz + nz(0.03)];
		u = [nz(0.03), nz(0.03), 0];
	} else if (seg === 7) {
		// しなやかな揺れ: 2.5Hz の滑らかな正弦波 (張力帯域)
		u = [0.3 * Math.sin(2 * Math.PI * 2.5 * stT) + nz(0.02), nz(0.02), 0];
	} else if (seg === 8) {
		// 微細な震え: 高周波だが小振幅 (静けさの中の緊張 → 張力)
		u = [0.05 * Math.sin(2 * Math.PI * 10 * stT) + nz(0.01), nz(0.01), nz(0.01)];
	} else if (seg === 9) {
		// 鉛直方向の上下動 (重力方向への移動と抗う移動)
		u = [nz(0.02), nz(0.02), 0.4 * Math.sin(2 * Math.PI * 1.0 * stT)];
	} else {
		// 公転: 姿勢は固定 (ジャイロ≈0) のまま腕で円を描く。
		// 向心加速度ベクトルがデバイス座標系内で回り続ける
		var oph = 2 * Math.PI * 1.5 * stT;
		u = [0.3 * Math.cos(oph) + nz(0.02), 0.3 * Math.sin(oph) + nz(0.02), nz(0.02)];
	}
	// セグメント境界を 0.3 秒でクロスフェード (階段状の切替は現実の動きに無い
	// 振幅ジャンプとなり、加速/減速の正規化レンジを人工的に汚すため)
	var ts = stT % 5;
	var ae = Math.min(1, ts / 0.6, (5 - ts) / 0.6);
	u = [u[0] * ae, u[1] * ae, u[2] * ae];
	w = [w[0] * ae, w[1] * ae, w[2] * ae];
	lastGravity = g;
	lastGyro = w;
	msgCount++;
	addSample(u);
}

function nz(a) { return (Math.random() * 2 - 1) * a; }
