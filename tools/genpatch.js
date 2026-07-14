// ElementDrift.maxpat + 要素ボイス10ファイルを生成する (配線ミス防止のためスクリプトで組む)
var fs = require('fs');
var path = require('path');
var outDir = process.argv[2]; // max/ フォルダ

var NAMES = ['balance', 'rotation', 'articulation', 'acceleration', 'deceleration',
	'gravity', 'vibration', 'rhythm', 'tension', 'stillness'];
var JP = ['傾き', '回転', '関節', '加速', '減速', '重力', '振動', 'リズム', '張力', '静止'];
// 既定ボイスの音高 (聴き分け用に散らしただけ。中身は自由に作り替える前提)
var FREQ = [392, 294, 523, 659, 220, 65, 1046, 330, 466, 262];
// 運動プロファイル類型 (Godøy: impulsive / sustained / iterative) — コメント用
var ARCH = ['sustained', 'iterative', 'impulsive', 'impulsive', 'sustained',
	'sustained', 'iterative', 'iterative', 'sustained', 'sustained'];

function newPatcher(w, h) {
	return {
		state: { boxes: [], lines: [], nid: 0 },
		patcher: {
			fileversion: 1,
			appversion: { major: 8, minor: 5, revision: 0, architecture: 'x64', modernui: 1 },
			classnamespace: 'box',
			rect: [60.0, 60.0, w, h],
			bglocked: 0, openinpresentation: 0,
			default_fontsize: 12.0, default_fontface: 0, default_fontname: 'Arial',
			gridonopen: 1, gridsize: [15.0, 15.0], gridsnaponopen: 1, objectsnaponopen: 1,
			statusbarvisible: 2, toolbarvisible: 1,
			boxes: null, lines: null
		}
	};
}
function box(P, spec) {
	P.state.nid++;
	var id = 'obj-' + P.state.nid;
	var b = { id: id, maxclass: spec.maxclass || 'newobj', numinlets: spec.ins, numoutlets: spec.outs, patching_rect: [spec.x, spec.y, spec.w || 100, spec.h || 22] };
	if (spec.text !== undefined) b.text = spec.text;
	if (spec.outs > 0) b.outlettype = spec.types || Array(spec.outs).fill('');
	if (spec.extra) for (var k in spec.extra) b[k] = spec.extra[k];
	P.state.boxes.push({ box: b });
	return id;
}
function conn(P, srcId, srcOut, dstId, dstIn) {
	P.state.lines.push({ patchline: { source: [srcId, srcOut], destination: [dstId, dstIn] } });
}
function sig(n) { return Array(n).fill('signal'); }
function writePatch(P, file) {
	P.patcher.boxes = P.state.boxes;
	P.patcher.lines = P.state.lines;
	var out = { patcher: P.patcher };
	delete P.patcher.state;
	fs.writeFileSync(file, JSON.stringify(out, null, '\t'));
	console.log(path.basename(file) + ': ' + P.state.boxes.length + ' boxes, ' + P.state.lines.length + ' lines');
}

// ================= 要素ボイス (10ファイル) =================
// 契約: r ed-acts (10要素の活性リスト) / r ed-weights (スポットライト重み) /
//       r ed-events (arc-stop, onset) を受け、outlet 1 (signal) に音を出す。
//       既定音は運動プロファイル準拠 (sus=持続 / am=反復 / imp=打撃)。
//       ツマミ (number box) で音高・明るさ・レゾ・AM速度・音量を調整できる
var VOICE = [
	{ air: { chord: [392, 494, 587], q: 30, level: 0.4 }, nyoGlide: { f0: 392, level: 0.5 } }, // balance
	{ nyoGlide: { f0: 294, level: 0.6 }, air: { chord: [294, 441], q: 20, level: 0.3 } }, // rotation
	{ air: { chord: [523, 784], q: 40, level: 0.5 }, swell: { ev: 0 }, nyoGlide: { f0: 523, level: 0.25 } }, // articulation (arc-stop)
	{ air: { chord: [1319, 1976], q: 15, level: 0.5 }, swell: { ev: 1 } }, // acceleration (onset)
	{ air: { chord: [220, 277, 330], q: 25, level: 0.6 }, nyoGlide: { f0: 220, level: 0.3 } }, // deceleration
	{ air: { chord: [65, 98, 131], q: 35, level: 1.0 } }, // gravity
	{ air: { chord: [1568, 2093, 2637], q: 25, level: 0.8 } }, // vibration
	{ air: { chord: [330, 392], q: 60, level: 0.8 } }, // rhythm
	{ air: { chord: [466, 699], q: 120, level: 0.7 } }, // tension
	{ air: { chord: [262, 330, 392], q: 18, level: 0.7 } } // stillness
];
function knob(V, x, y, label, val, dstId, dstIn) {
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x, y: y, w: 90, text: label });
	var lm = box(V, { text: 'loadmess ' + val, ins: 1, outs: 1, x: x, y: y + 20, w: 90 });
	var nb = box(V, { maxclass: 'flonum', ins: 1, outs: 2, x: x, y: y + 50, w: 70, types: ['', 'bang'], extra: { parameter_enable: 0 } });
	conn(V, lm, 0, nb, 0);
	conn(V, nb, 0, dstId, dstIn);
	return nb;
}
// 空気 (noise~ → ガスト変調 → reson~ 並列コード (動きでスイープ) → +~ 合流) エンジンを生成
// swellId (line~ signal, optional): イベント由来の4秒膨らみを駆動段に合流させる
function buildAir(V, cfg, x, y, driveId, mulId, swellId) {
	var noise = box(V, { text: 'noise~', ins: 1, outs: 1, x: x, y: y, w: 60, types: sig(1) });
	// 動き→レゾナンス周波数スイープ: 駆動量float → scale 0. 1. 1. 1.8 → 各コード音に乗算
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x + 340, y: y - 20, w: 260, text: '動きでレゾナンスが上にスイープ' });
	var sweepSc = box(V, { text: 'scale 0. 1. 1. 1.8', ins: 6, outs: 1, x: x + 340, y: y, w: 130, types: [''] });
	if (mulId) conn(V, mulId, 0, sweepSc, 0);
	var resons = [];
	for (var ri = 0; ri < cfg.chord.length; ri++) {
		var rz = box(V, { text: 'reson~ 2. ' + cfg.chord[ri] + ' ' + cfg.q, ins: 4, outs: 1, x: x + ri * 140, y: y + 96, w: 130, types: sig(1) });
		conn(V, noise, 0, rz, 0);
		var fmul = box(V, { text: '* ' + cfg.chord[ri] + '.', ins: 2, outs: 1, x: x + 340 + ri * 100, y: y + 32, w: 70 });
		conn(V, sweepSc, 0, fmul, 0);
		conn(V, fmul, 0, rz, 2);
		resons.push(rz);
	}
	var sum = resons[0];
	for (var rj = 1; rj < resons.length; rj++) {
		var add = box(V, { text: '+~', ins: 2, outs: 1, x: x + rj * 140, y: y + 128, w: 45, types: sig(1) });
		conn(V, sum, 0, add, 0);
		conn(V, resons[rj], 0, add, 1);
		sum = add;
	}
	var norm = box(V, { text: '*~ 0.5', ins: 2, outs: 1, x: x, y: y + 160, w: 60, types: sig(1) });
	conn(V, sum, 0, norm, 0);
	var drv = box(V, { text: '*~', ins: 2, outs: 1, x: x, y: y + 192, w: 50, types: sig(1) });
	conn(V, norm, 0, drv, 0);
	if (swellId) {
		var swAdd = box(V, { text: '+~', ins: 2, outs: 1, x: x, y: y + 192 - 32, w: 45, types: sig(1) });
		conn(V, driveId, 0, swAdd, 0);
		conn(V, swellId, 0, swAdd, 1);
		conn(V, swAdd, 0, drv, 1);
	} else {
		conn(V, driveId, 0, drv, 1);
	}
	var lvl = box(V, { text: '*~ ' + cfg.level, ins: 2, outs: 1, x: x, y: y + 224, w: 60, types: sig(1) });
	conn(V, drv, 0, lvl, 0);
	// ツマミ: 空気音量 (lvl 右インレット), レゾQ (各 reson~ inlet 3)
	var volNb = knob(V, x, y + 264, '空気音量', cfg.level, lvl, 1);
	var qNb = knob(V, x + 130, y + 264, 'レゾQ', cfg.q, resons[0], 3);
	for (var rk = 1; rk < resons.length; rk++) conn(V, qNb, 0, resons[rk], 3);
	return lvl;
}
// にょろん: 連続グライド (駆動量float → scale → pack → line~ → cycle~ → *~駆動量line~ → *~レベル)
function buildNyoGlide(V, cfg, x, y, mulId, driveId) {
	var lo = Math.round(cfg.f0 * 0.7);
	var hi = Math.round(cfg.f0 * 1.4);
	var sc = box(V, { text: 'scale 0. 1. ' + lo + '. ' + hi + '.', ins: 6, outs: 1, x: x, y: y, w: 150, types: [''] });
	conn(V, mulId, 0, sc, 0);
	var pk = box(V, { text: 'pack 0. 200', ins: 2, outs: 1, x: x, y: y + 32, w: 70 });
	conn(V, sc, 0, pk, 0);
	var ln = box(V, { text: 'line~', ins: 1, outs: 2, x: x, y: y + 64, w: 45, types: ['signal', 'bang'] });
	conn(V, pk, 0, ln, 0);
	var cyc = box(V, { text: 'cycle~', ins: 2, outs: 1, x: x, y: y + 96, w: 60, types: sig(1) });
	conn(V, ln, 0, cyc, 0);
	var drv = box(V, { text: '*~', ins: 2, outs: 1, x: x, y: y + 128, w: 50, types: sig(1) });
	conn(V, cyc, 0, drv, 0);
	conn(V, driveId, 0, drv, 1);
	var lvl = box(V, { text: '*~ ' + cfg.level, ins: 2, outs: 1, x: x, y: y + 160, w: 60, types: sig(1) });
	conn(V, drv, 0, lvl, 0);
	var volNb = knob(V, x, y + 200, 'にょろん音量', cfg.level, lvl, 1);
	return { out: lvl, volNb: volNb };
}
// イベント→4秒の膨らみ (attack 0.8s / hold 0.5s / release 3.5s) — AIRの駆動段に合流するline~を返す
function buildSwell(V, cfg, x, y, rtId) {
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x, y: y - 20, w: 320, text: 'イベント→4秒の膨らみ (attack 0.8s / hold 0.5s / release 3.5s)' });
	var tf = box(V, { text: 't f', ins: 1, outs: 1, x: x, y: y, w: 40, types: ['float'] });
	conn(V, rtId, cfg.ev, tf, 0);
	var msg = box(V, { maxclass: 'message', text: '0., $1 800 $1 500 0. 3500', ins: 2, outs: 1, x: x, y: y + 32, w: 180 });
	conn(V, tf, 0, msg, 0);
	var env = box(V, { text: 'line~', ins: 1, outs: 2, x: x, y: y + 64, w: 45, types: ['signal', 'bang'] });
	conn(V, msg, 0, env, 0);
	return env;
}
for (var vi = 0; vi < 10; vi++) {
	var c = VOICE[vi];
	var V = newPatcher(1000, 900);
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 12, w: 780, text: '要素ボイス: ' + NAMES[vi] + ' (' + JP[vi] + ') — 運動プロファイル: ' + ARCH[vi] + '。ツマミで調整、中身は自由に作り替えてよい' });
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 32, w: 800, text: '契約: ed-acts=活性(0..1)リスト / ed-weights=スポットライト重み / ed-events=arc-stop・onset。出力は outlet (signal) へ' });
	var rA = box(V, { text: 'r ed-acts', ins: 0, outs: 1, x: 20, y: 70, w: 70 });
	var upA = box(V, { text: 'unpack 0. 0. 0. 0. 0. 0. 0. 0. 0. 0.', ins: 1, outs: 10, x: 20, y: 100, w: 230 });
	var rW = box(V, { text: 'r ed-weights', ins: 0, outs: 1, x: 280, y: 70, w: 85 });
	var upW = box(V, { text: 'unpack 0. 0. 0. 0. 0. 0. 0. 0. 0. 0.', ins: 1, outs: 10, x: 280, y: 100, w: 230 });
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 130, w: 320, text: '↓ 駆動量 = w × (0.3 + 0.7a): 獲物の声は薄く常時、表出で開く' });
	var aOpen = box(V, { text: '* 0.7', ins: 2, outs: 1, x: 20, y: 155, w: 55 });
	var aFloor = box(V, { text: '+ 0.3', ins: 2, outs: 1, x: 20, y: 178, w: 55 });
	var mul = box(V, { text: '* 0.', ins: 2, outs: 1, x: 20, y: 201, w: 50 });
	var pk = box(V, { text: 'pack 0. 50', ins: 2, outs: 1, x: 20, y: 231, w: 70 });
	var ln = box(V, { text: 'line~', ins: 1, outs: 2, x: 20, y: 261, w: 45, types: ['signal', 'bang'] });
	conn(V, rA, 0, upA, 0);
	conn(V, rW, 0, upW, 0);
	conn(V, upA, vi, aOpen, 0);
	conn(V, aOpen, 0, aFloor, 0);
	conn(V, aFloor, 0, mul, 0);
	conn(V, upW, vi, mul, 1);
	conn(V, mul, 0, pk, 0);
	conn(V, pk, 0, ln, 0);
	var rE = box(V, { text: 'r ed-events', ins: 0, outs: 1, x: 540, y: 70, w: 85 });
	var rtE = box(V, { text: 'route arc-stop onset', ins: 1, outs: 3, x: 540, y: 100, w: 130 });
	conn(V, rE, 0, rtE, 0);
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 540, y: 130, w: 250, text: '↑ 円弧の完結 / 動き出し (打撃系のトリガ)' });

	// ---- 動きの生の激しさ (音色のミクロ変調用): 駆動量 float と linN の大きい方でスイープ ----
	var maxi = null;
	if (c.air || c.nyoGlide) {
		var rMotion = box(V, { text: 'r ed-motion', ins: 0, outs: 1, x: 800, y: 70, w: 90 });
		var upMotion = box(V, { text: 'unpack 0. 0. 0.', ins: 1, outs: 3, x: 800, y: 100, w: 130 });
		conn(V, rMotion, 0, upMotion, 0);
		maxi = box(V, { text: 'maximum 0.', ins: 2, outs: 1, x: 800, y: 130, w: 80 });
		conn(V, mul, 0, maxi, 0);
		conn(V, upMotion, 0, maxi, 1);
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 800, y: 160, w: 260, text: '↑ 細かく動くと音色/ピッチも揺れる (linN vs 駆動量の大きい方)' });
	}

	// ---- 音の本体 (AIR / NYORON エンジン) ----
	var Y = 380;
	var branches = [];
	var bx = 20;

	var swellOut = null;
	if (c.swell) {
		swellOut = buildSwell(V, c.swell, bx, Y - 260, rtE);
		bx += 340;
	}
	if (c.air) {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: bx, y: Y - 20, w: 300, text: '空気: noise→reson コード' });
		var airOut = buildAir(V, c.air, bx, Y, ln, maxi, swellOut);
		branches.push(airOut);
		bx += 620;
	}
	if (c.nyoGlide) {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: bx, y: Y - 20, w: 260, text: 'にょろん: 連続グライド' });
		var glide = buildNyoGlide(V, c.nyoGlide, bx, Y, maxi, ln);
		branches.push(glide.out);
		bx += 260;
	}

	// 全エンジンを +~ で合流 → outlet
	var sumId = branches[0];
	var sumY = Y + 420;
	for (var bi = 1; bi < branches.length; bi++) {
		var addB = box(V, { text: '+~', ins: 2, outs: 1, x: 20 + bi * 60, y: sumY, w: 45, types: sig(1) });
		conn(V, sumId, 0, addB, 0);
		conn(V, branches[bi], 0, addB, 1);
		sumId = addB;
	}
	var outl = box(V, { maxclass: 'outlet', ins: 1, outs: 0, x: 20, y: sumY + 40, w: 30, h: 30, extra: { comment: 'audio out' } });
	conn(V, sumId, 0, outl, 0);

	writePatch(V, path.join(outDir, 'elem.' + NAMES[vi] + '~.maxpat'));
}

// ================= Granulator エフェクト (fx.granular~.maxpat) =================
// 直近2秒をバッファに常時録音し、3声のグレインで粒読みする。wet=0でバイパス相当
function buildGranularFx(outDir) {
	var G = newPatcher(1000, 760);
	box(G, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 12, w: 600, text: 'Granulator: 直近2秒を粒で再生 (wet 0=バイパス)' });
	var inl = box(G, { maxclass: 'inlet', ins: 0, outs: 1, x: 20, y: 50, w: 30, h: 30, types: sig(1) });
	var buf = box(G, { text: 'buffer~ granbuf 2000', ins: 0, outs: 0, x: 200, y: 50, w: 160 });
	var rec = box(G, { text: 'record~ granbuf @loop 1', ins: 2, outs: 0, x: 20, y: 90, w: 170 });
	conn(G, inl, 0, rec, 0);
	var lb = box(G, { text: 'loadbang', ins: 0, outs: 1, x: 20, y: 130, w: 70 });
	var msgRecOn = box(G, { maxclass: 'message', text: '1', ins: 2, outs: 1, x: 20, y: 160, w: 30 });
	conn(G, lb, 0, msgRecOn, 0);
	conn(G, msgRecOn, 0, rec, 0);

	// 動きの生の激しさ (linN) でグレイン速度を変調 (動くほど粒が細かく速い)
	box(G, { maxclass: 'comment', ins: 1, outs: 0, x: 420, y: 12, w: 300, text: '動きでグレイン速度を変調 (linN)' });
	var rMotionG = box(G, { text: 'r ed-motion', ins: 0, outs: 1, x: 420, y: 50, w: 90 });
	var upMotionG = box(G, { text: 'unpack 0. 0. 0.', ins: 1, outs: 3, x: 420, y: 80, w: 130 });
	conn(G, rMotionG, 0, upMotionG, 0);
	var motionScales = [];
	var scaleRanges = [[90, 45], [130, 65], [170, 85]];
	for (var mi = 0; mi < 3; mi++) {
		var msc = box(G, { text: 'scale 0. 1. ' + scaleRanges[mi][0] + ' ' + scaleRanges[mi][1], ins: 6, outs: 1, x: 420 + mi * 150, y: 110, w: 140 });
		conn(G, upMotionG, 0, msc, 0);
		motionScales.push(msc);
	}

	// グレイン声部 x3 (metro period 90/130/170ms)
	var periods = [90, 130, 170];
	var grainOuts = [];
	for (var gi = 0; gi < 3; gi++) {
		var gx = 20 + gi * 260;
		var gy = 220;
		box(G, { maxclass: 'comment', ins: 1, outs: 0, x: gx, y: gy - 20, w: 240, text: 'グレイン声部 ' + (gi + 1) + ' (period ' + periods[gi] + 'ms)' });
		var glb = box(G, { text: 'loadbang', ins: 0, outs: 1, x: gx, y: gy, w: 70 });
		var msgOn = box(G, { maxclass: 'message', text: '1', ins: 2, outs: 1, x: gx, y: gy + 30, w: 30 });
		conn(G, glb, 0, msgOn, 0);
		var met = box(G, { text: 'metro ' + periods[gi], ins: 2, outs: 1, x: gx, y: gy + 60, w: 80 });
		conn(G, msgOn, 0, met, 0);
		conn(G, motionScales[gi], 0, met, 1);
		var rnd = box(G, { text: 'random 1900', ins: 1, outs: 1, x: gx, y: gy + 90, w: 80 });
		conn(G, met, 0, rnd, 0);
		var tff = box(G, { text: 't f f', ins: 1, outs: 2, x: gx, y: gy + 120, w: 50, types: ['float', 'float'] });
		conn(G, rnd, 0, tff, 0);

		// 位置エンベロープ: outlet1(f) → expr で終端位置算出 → pack → message → line~ → play~ 左
		var ex = box(G, { text: 'expr $f1+100.', ins: 1, outs: 1, x: gx, y: gy + 150, w: 90 });
		conn(G, tff, 1, ex, 0);
		var pk2 = box(G, { text: 'pack f f', ins: 2, outs: 1, x: gx, y: gy + 180, w: 70 });
		conn(G, tff, 0, pk2, 0);
		conn(G, ex, 0, pk2, 1);
		var msgPos = box(G, { maxclass: 'message', text: '$1, $2 120', ins: 2, outs: 1, x: gx, y: gy + 210, w: 100 });
		conn(G, pk2, 0, msgPos, 0);
		var posLn = box(G, { text: 'line~', ins: 1, outs: 2, x: gx, y: gy + 240, w: 45, types: ['signal', 'bang'] });
		conn(G, msgPos, 0, posLn, 0);
		var play = box(G, { text: 'play~ granbuf', ins: 1, outs: 1, x: gx, y: gy + 270, w: 90, types: sig(1) });
		conn(G, posLn, 0, play, 0);

		// 窓エンベロープ: outlet0(b) → 三角窓message → line~ → *~ play~出力
		var msgWin = box(G, { maxclass: 'message', text: '0., 1. 30 1. 60 0. 30', ins: 2, outs: 1, x: gx + 130, y: gy + 120, w: 150 });
		conn(G, tff, 0, msgWin, 0);
		var winLn = box(G, { text: 'line~', ins: 1, outs: 2, x: gx + 130, y: gy + 150, w: 45, types: ['signal', 'bang'] });
		conn(G, msgWin, 0, winLn, 0);
		var windowed = box(G, { text: '*~', ins: 2, outs: 1, x: gx, y: gy + 300, w: 50, types: sig(1) });
		conn(G, play, 0, windowed, 0);
		conn(G, winLn, 0, windowed, 1);
		grainOuts.push(windowed);
	}
	// 3声合流 → *~ 0.5
	var gsum = grainOuts[0];
	for (var gj = 1; gj < grainOuts.length; gj++) {
		var gadd = box(G, { text: '+~', ins: 2, outs: 1, x: 20 + gj * 260, y: 560, w: 45, types: sig(1) });
		conn(G, gsum, 0, gadd, 0);
		conn(G, grainOuts[gj], 0, gadd, 1);
		gsum = gadd;
	}
	var grainLvl = box(G, { text: '*~ 0.5', ins: 2, outs: 1, x: 20, y: 592, w: 55, types: sig(1) });
	conn(G, gsum, 0, grainLvl, 0);

	// wet ツマミ: flonum → expr 1.-$f1 (ドライ係数) / flonum直 (ウェット係数)
	box(G, { maxclass: 'comment', ins: 1, outs: 0, x: 700, y: 50, w: 90, text: 'wet' });
	var wlm = box(G, { text: 'loadmess 0.35', ins: 1, outs: 1, x: 700, y: 70, w: 90 });
	var wnb = box(G, { maxclass: 'flonum', ins: 1, outs: 2, x: 700, y: 100, w: 70, types: ['', 'bang'], extra: { parameter_enable: 0 } });
	conn(G, wlm, 0, wnb, 0);
	var dryExpr = box(G, { text: 'expr 1.-$f1', ins: 1, outs: 1, x: 700, y: 130, w: 90 });
	conn(G, wnb, 0, dryExpr, 0);

	var dryMul = box(G, { text: '*~', ins: 2, outs: 1, x: 20, y: 630, w: 50, types: sig(1) });
	conn(G, inl, 0, dryMul, 0);
	conn(G, dryExpr, 0, dryMul, 1);
	var wetMul = box(G, { text: '*~', ins: 2, outs: 1, x: 700, y: 630, w: 50, types: sig(1) });
	conn(G, grainLvl, 0, wetMul, 0);
	conn(G, wnb, 0, wetMul, 1);
	var mixSum = box(G, { text: '+~', ins: 2, outs: 1, x: 20, y: 662, w: 45, types: sig(1) });
	conn(G, dryMul, 0, mixSum, 0);
	conn(G, wetMul, 0, mixSum, 1);
	var outl = box(G, { maxclass: 'outlet', ins: 1, outs: 0, x: 20, y: 700, w: 30, h: 30, extra: { comment: 'audio out' } });
	conn(G, mixSum, 0, outl, 0);

	writePatch(G, path.join(outDir, 'fx.granular~.maxpat'));
}
buildGranularFx(outDir);

// ================= メインパッチ =================
var P = newPatcher(1200, 900);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 30, y: 15, w: 800, text: 'Element Drift — ZIG SIM PRO (UDP/OSC 9600) → 10要素活性 → ドリフト → 要素ボイス (elem.<名前>~.maxpat)。音の設計は各ボイスの中で' });
var udp = box(P, { text: 'udpreceive 9600', ins: 1, outs: 1, x: 30, y: 60, w: 110 });
var mSelf1 = box(P, { maxclass: 'message', text: 'selftest 1', ins: 2, outs: 1, x: 160, y: 60, w: 65 });
var mSelf0 = box(P, { maxclass: 'message', text: 'selftest 0', ins: 2, outs: 1, x: 232, y: 60, w: 65 });
var mReset = box(P, { maxclass: 'message', text: 'reset', ins: 2, outs: 1, x: 304, y: 60, w: 42 });
var mLoad = box(P, { maxclass: 'message', text: 'loadmap', ins: 2, outs: 1, x: 352, y: 60, w: 58 });
var numSpot = box(P, { maxclass: 'number', ins: 1, outs: 2, x: 470, y: 60, w: 45, types: ['', 'bang'], extra: { parameter_enable: 0 } });
var prSpot = box(P, { text: 'prepend spotlight', ins: 1, outs: 1, x: 470, y: 90, w: 110 });
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 520, y: 62, w: 200, text: '← スポットライト (-1=自動, 0-9=固定)' });
var dict = box(P, { text: 'dict elementmap mapping.json', ins: 2, outs: 4, x: 740, y: 60, w: 180, types: ['dictionary', '', '', ''] });
var mImport = box(P, { maxclass: 'message', text: 'import mapping.json', ins: 2, outs: 1, x: 740, y: 30, w: 125 });
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 870, y: 32, w: 300, text: '← reach (ドリフトの近さ) 編集後: これ → loadmap' });

var js = box(P, { text: 'js elements.js', ins: 1, outs: 3, x: 30, y: 125, w: 100, extra: { saved_object_attributes: { filename: 'elements.js', parameter_enable: 0 } } });
var rRate = box(P, { text: 'route rate', ins: 1, outs: 2, x: 160, y: 125, w: 70 });
var numRate = box(P, { maxclass: 'flonum', ins: 1, outs: 2, x: 160, y: 155, w: 60, types: ['', 'bang'], extra: { parameter_enable: 0 } });
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 225, y: 157, w: 60, text: '受信Hz' });
var prn = box(P, { text: 'print status', ins: 1, outs: 0, x: 290, y: 155, w: 80 });

var msl = box(P, { maxclass: 'multislider', ins: 1, outs: 2, x: 30, y: 195, w: 500, h: 140, extra: { setminmax: [0.0, 1.0], size: 10, parameter_enable: 0 } });
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 30, y: 340, w: 560, text: '傾き    回転    関節    加速    減速    重力    振動    リズム    張力    静止' });
var sActs = box(P, { text: 's ed-acts', ins: 1, outs: 0, x: 560, y: 195, w: 70 });

conn(P, udp, 0, js, 0);
conn(P, mSelf1, 0, js, 0); conn(P, mSelf0, 0, js, 0); conn(P, mReset, 0, js, 0); conn(P, mLoad, 0, js, 0);
conn(P, numSpot, 0, prSpot, 0); conn(P, prSpot, 0, js, 0);
conn(P, mImport, 0, dict, 0);
conn(P, js, 0, msl, 0);
conn(P, js, 0, sActs, 0);
conn(P, js, 1, rRate, 0);
conn(P, rRate, 0, numRate, 0); conn(P, rRate, 1, prn, 0);

// 制御ストリームの分配
var route = box(P, { text: 'route weights gain spot event motion', ins: 1, outs: 6, x: 30, y: 380, w: 240 });
conn(P, js, 2, route, 0);
var sW = box(P, { text: 's ed-weights', ins: 1, outs: 0, x: 30, y: 420, w: 90 });
conn(P, route, 0, sW, 0);
var pkG = box(P, { text: 'pack 0. 60', ins: 2, outs: 1, x: 140, y: 420, w: 70 });
var lnG = box(P, { text: 'line~', ins: 1, outs: 2, x: 140, y: 450, w: 45, types: ['signal', 'bang'] });
conn(P, route, 1, pkG, 0); conn(P, pkG, 0, lnG, 0);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 190, y: 452, w: 220, text: '← master gain (表出しないと鳴らない)' });
var prSet = box(P, { text: 'prepend set', ins: 1, outs: 1, x: 420, y: 420, w: 78 });
var msgSpot = box(P, { maxclass: 'message', text: 'spot', ins: 2, outs: 1, x: 420, y: 450, w: 140 });
conn(P, route, 2, prSet, 0); conn(P, prSet, 0, msgSpot, 0);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 565, y: 452, w: 130, text: '← 今のスポットライト' });
var sE = box(P, { text: 's ed-events', ins: 1, outs: 0, x: 720, y: 420, w: 85 });
conn(P, route, 3, sE, 0);
var sMotion = box(P, { text: 's ed-motion', ins: 1, outs: 0, x: 840, y: 420, w: 90 });
conn(P, route, 4, sMotion, 0);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 840, y: 452, w: 200, text: '← 動きの生の激しさ (lin/rot/speed)' });

// 要素ボイス 10個 → 合流
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 30, y: 500, w: 700, text: '要素ボイス (それぞれ elem.<名前>~.maxpat を開いて音を設計する)' });
var voices = [];
for (var i = 0; i < 10; i++) {
	var x = 30 + (i % 5) * 190;
	var y = 530 + Math.floor(i / 5) * 60;
	box(P, { maxclass: 'comment', ins: 1, outs: 0, x: x, y: y - 18, w: 120, text: JP[i] });
	voices.push(box(P, { text: 'elem.' + NAMES[i] + '~', ins: 0, outs: 1, x: x, y: y, w: 150, types: sig(1) }));
}
// +~ チェーンで合流
var sum = voices[0];
for (var s2 = 1; s2 < 10; s2++) {
	var add = box(P, { text: '+~', ins: 2, outs: 1, x: 30 + s2 * 60, y: 660, w: 45, types: sig(1) });
	conn(P, sum, 0, add, 0);
	conn(P, voices[s2], 0, add, 1);
	sum = add;
}
// master gain → リバーブ → 出力
var mg = box(P, { text: '*~', ins: 2, outs: 1, x: 30, y: 700, w: 50, types: sig(1) });
conn(P, sum, 0, mg, 0);
conn(P, lnG, 0, mg, 1);
var fbIn = box(P, { text: '+~', ins: 2, outs: 1, x: 700, y: 660, w: 45, types: sig(1) });
var tin = box(P, { text: 'tapin~ 500', ins: 1, outs: 1, x: 700, y: 692, w: 80, types: ['tapconnect'] });
var tout = box(P, { text: 'tapout~ 149 211 271 353', ins: 1, outs: 4, x: 700, y: 724, w: 150, types: sig(4) });
var t1 = box(P, { text: '*~ 0.18', ins: 2, outs: 1, x: 700, y: 756, w: 55, types: sig(1) });
var t2 = box(P, { text: '*~ 0.18', ins: 2, outs: 1, x: 760, y: 756, w: 55, types: sig(1) });
var t3 = box(P, { text: '*~ 0.18', ins: 2, outs: 1, x: 820, y: 756, w: 55, types: sig(1) });
var t4 = box(P, { text: '*~ 0.18', ins: 2, outs: 1, x: 880, y: 756, w: 55, types: sig(1) });
var ts1 = box(P, { text: '+~', ins: 2, outs: 1, x: 700, y: 788, w: 45, types: sig(1) });
var ts2 = box(P, { text: '+~', ins: 2, outs: 1, x: 820, y: 788, w: 45, types: sig(1) });
var tsum = box(P, { text: '+~', ins: 2, outs: 1, x: 700, y: 820, w: 45, types: sig(1) });
var damp = box(P, { text: 'onepole~ 4000', ins: 2, outs: 1, x: 700, y: 852, w: 95, types: sig(1) });
var wet = box(P, { text: '*~ 0.3', ins: 2, outs: 1, x: 700, y: 884, w: 55, types: sig(1) });
var gran = box(P, { text: 'fx.granular~', ins: 1, outs: 1, x: 30, y: 660, w: 130, types: sig(1) });
conn(P, mg, 0, gran, 0);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 170, y: 662, w: 260, text: '← Granulator (直近2秒を粒で再生)' });
conn(P, gran, 0, fbIn, 0); conn(P, damp, 0, fbIn, 1);
conn(P, fbIn, 0, tin, 0);
conn(P, tin, 0, tout, 0);
conn(P, tout, 0, t1, 0); conn(P, tout, 1, t2, 0); conn(P, tout, 2, t3, 0); conn(P, tout, 3, t4, 0);
conn(P, t1, 0, ts1, 0); conn(P, t2, 0, ts1, 1);
conn(P, t3, 0, ts2, 0); conn(P, t4, 0, ts2, 1);
conn(P, ts1, 0, tsum, 0); conn(P, ts2, 0, tsum, 1);
conn(P, tsum, 0, damp, 0);
conn(P, damp, 0, wet, 0);
var outSum = box(P, { text: '+~', ins: 2, outs: 1, x: 30, y: 740, w: 45, types: sig(1) });
var outAtt = box(P, { text: '*~ 0.5', ins: 2, outs: 1, x: 30, y: 772, w: 55, types: sig(1) });
var dac = box(P, { ins: 2, outs: 0, x: 30, y: 806, w: 45, h: 45, maxclass: 'ezdac~' });
conn(P, gran, 0, outSum, 0); conn(P, wet, 0, outSum, 1);
conn(P, outSum, 0, outAtt, 0);
conn(P, outAtt, 0, dac, 0); conn(P, outAtt, 0, dac, 1);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 85, y: 815, w: 220, text: '← クリックでオーディオ ON/OFF' });

writePatch(P, path.join(outDir, 'ElementDrift.maxpat'));
