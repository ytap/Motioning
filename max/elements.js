// elements.js — 運動共感エレメント抽出 (ZIG SIM PRO OSC → 10要素の活性度)
// Max [js] 用 (ES5)。入力: udpreceive からの OSC メッセージ。
// outlet 0: 10要素の活性度リスト (0..1) を UPDATE_MS 毎に出力
// outlet 1: ステータス ("rate <Hz>", "accelmode ...", selftest ログ等)
//
// メッセージ:
//   selftest 1 / 0   … 合成データで全パイプラインを検証 (電話不要)
//   reset            … 正規化 min/max とバッファをリセット
//   accelmode 1 / 0  … accel が重力込み(1)/重力抜き(0) を手動指定 (通常は自動判定)

autowatch = 1;
inlets = 1;
outlets = 2;

// ---- 設定 ----
var WIN_MS = 500;        // 特徴抽出窓 (ms)
var UPDATE_MS = 50;      // 特徴計算・出力周期 (20Hz)。センサー取り込みは受信レートそのまま
var SLOW_HOP_MS = 100;   // rhythm 用バッファの hop
var SLOW_LEN = 30;       // rhythm 用バッファ長 (約3秒)
var NORM_DECAY = 0.0015; // 走行 min/max の減衰 (update 毎)
var GYRO_DEG = 0;        // ZIG SIM の gyro が deg/s なら 1 (通常 CoreMotion 準拠で rad/s)
var G2MS2 = 9.80665;     // accel/gravity は G 単位で届く前提

var NAMES = ["balance", "rotation", "articulation", "acceleration", "deceleration",
             "gravity", "vibration", "rhythm", "tension", "stillness"];

// ---- 状態 ----
var samples = [];        // {t, ux,uy,uz (user accel, G), g:[gx,gy,gz]|null (G), wx,wy,wz (rad/s)}
var slow = [];           // rhythm 用 linRMS 列
var lastSlowT = 0;
var curLinRMS = 0;

var lastGravity = null;
var lastGyro = null;

var accelModeKnown = false;
var accelIncludesGravity = false;
var detectBuf = [];
var warnedNoGravity = false;

var msgCount = 0;
var lastRateT = Date.now();

var norm = [];
for (var _i = 0; _i < 10; _i++) norm.push({ min: null, max: null });

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
	samples.push({
		t: Date.now(),
		ux: u[0], uy: u[1], uz: u[2],
		g: lastGravity ? [lastGravity[0], lastGravity[1], lastGravity[2]] : null,
		wx: w[0], wy: w[1], wz: w[2]
	});
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

	if (now - lastSlowT >= SLOW_HOP_MS) {
		slow.push(curLinRMS);
		if (slow.length > SLOW_LEN) slow.shift();
		lastSlowT = now;
	}

	var act = [];
	for (var i = 0; i < 10; i++) act.push(normalize(i, raw[i]));
	outlet(0, act);
}

// ---- 特徴抽出 (v2 の式 + gravity要素に「抗い」側を追加) ----
function computeRaw() {
	var n = samples.length;
	var linMag = [], rotMag = [];
	var mw = [0, 0, 0];
	var i, s;
	for (i = 0; i < n; i++) {
		s = samples[i];
		linMag.push(Math.sqrt(s.ux * s.ux + s.uy * s.uy + s.uz * s.uz) * G2MS2);
		rotMag.push(Math.sqrt(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz));
		mw[0] += s.wx; mw[1] += s.wy; mw[2] += s.wz;
	}
	var linRMS = rms(linMag);
	var rotRMS = rms(rotMag);
	curLinRMS = linRMS;
	mw[0] /= n; mw[1] /= n; mw[2] /= n;
	var consist = rotRMS > 1e-6
		? Math.sqrt(mw[0] * mw[0] + mw[1] * mw[1] + mw[2] * mw[2]) / rotRMS : 0;

	var d = [];
	for (i = 1; i < n; i++) d.push(linMag[i] - linMag[i - 1]);
	var hf = rms(d);
	var acc = 0, dec = 0;
	for (i = 0; i < d.length; i++) { if (d[i] > 0) acc += d[i]; else dec -= d[i]; }
	if (d.length) { acc /= d.length; dec /= d.length; }

	// 傾き: CoreMotion の gravity ベクトルから直接 (窓平均ハック廃止)
	var tilt = 0;
	var g = samples[n - 1].g;
	if (g) {
		var gm = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
		if (gm > 1e-6) tilt = Math.acos(clamp(-g[2] / gm, -1, 1));
	}
	var balance = (tilt / Math.PI) * Math.max(0, 1 - linRMS * 0.5);

	// 重力: 自由落下 (|total|→0) と 抗い (重力と逆向きの持続加速) の両面
	var fall = 0, rise = 0, cnt = 0;
	for (i = 0; i < n; i++) {
		s = samples[i];
		if (!s.g) continue;
		var gm2 = Math.sqrt(s.g[0] * s.g[0] + s.g[1] * s.g[1] + s.g[2] * s.g[2]);
		if (gm2 < 1e-6) continue;
		var tx = s.ux + s.g[0], ty = s.uy + s.g[1], tz = s.uz + s.g[2];
		fall += Math.max(0, 1 - Math.sqrt(tx * tx + ty * ty + tz * tz));
		var up = -(s.ux * s.g[0] + s.uy * s.g[1] + s.uz * s.g[2]) / gm2;
		rise += Math.max(0, up - 0.05);
		cnt++;
	}
	if (cnt) { fall /= cnt; rise /= cnt; }
	var grav = Math.max(fall, rise * 0.8);

	// 関節: 角速度成分の符号反転レート (v2 準拠、Phase 2 でハードストップ検出を検討)
	var rev = 0;
	for (i = 1; i < n; i++) {
		var p = samples[i - 1], q = samples[i];
		if (sgnRev(p.wx, q.wx)) rev++;
		if (sgnRev(p.wy, q.wy)) rev++;
		if (sgnRev(p.wz, q.wz)) rev++;
	}
	var dt = (samples[n - 1].t - samples[0].t) / 1000;
	var artic = dt > 0 ? (rev / dt) * (rotRMS > 0.05 ? 1 : 0.2) : 0;

	var rhythm = autocorrPeak(slow);
	var rotation = rotRMS * (0.3 + 0.7 * consist);
	var vibration = hf;
	var tension = hf * Math.max(0, 1 - linRMS * 0.6);
	var stillness = Math.max(0, 1 - (linRMS + rotRMS) * 0.8);

	return [balance, rotation, artic, acc, dec, grav, vibration, rhythm, tension, stillness];
}

function sgnRev(a, b) {
	return (a * b < 0) && Math.abs(a) > 0.05 && Math.abs(b) > 0.05;
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
	return clamp(best / r0, 0, 1);
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
	for (var i = 0; i < 10; i++) { norm[i].min = null; norm[i].max = null; }
	samples = [];
	slow = [];
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
var ST_LABELS = ["stillness", "balance(tilt)", "vibration", "rhythm(1Hz)", "rotation", "accel/decel"];
var stTask = new Task(selfstep, this);
stTask.interval = 16;

function selftest(v) {
	st = v ? 1 : 0;
	if (st) {
		accelModeKnown = true;
		accelIncludesGravity = false;
		samples = [];
		slow = [];
		stT = 0;
		stSegLast = -1;
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
	var seg = Math.floor(stT / 5) % 6;
	if (seg !== stSegLast) {
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
		u = [nz(0.5), nz(0.5), nz(0.5)];
	} else if (seg === 3) {
		u = [0.3 * Math.sin(2 * Math.PI * 1.0 * stT), 0, 0];
	} else if (seg === 4) {
		w = [0, 0, 4];
		u = [nz(0.05), nz(0.05), 0];
	} else {
		var ph = stT % 2;
		var mag = ph < 1 ? ph * 0.8 : (2 - ph) * 0.8;
		u = [mag, 0, 0];
	}
	lastGravity = g;
	lastGyro = w;
	msgCount++;
	addSample(u);
}

function nz(a) { return (Math.random() * 2 - 1) * a; }
