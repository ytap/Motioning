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
	{ air: { chord: [392, 494, 587], q: 30, level: 0.4, style: 'balance' } }, // balance
	{ air: { chord: [294, 441], q: 20, level: 0.5, style: 'rotation' } }, // rotation
	{ air: { chord: [523, 784], q: 40, level: 0.5, style: 'articulation' }, swell: { ev: 0, shape: 'joint' } }, // articulation (arc-stop)
	{ air: { chord: [1319, 1976], q: 15, level: 0.5, style: 'acceleration' }, swell: { ev: 1, shape: 'onset' } }, // acceleration (onset)
	{ air: { chord: [220, 277, 330], q: 25, level: 0.6, style: 'deceleration' } }, // deceleration
	{ air: { chord: [65, 98, 131], q: 35, level: 1.0, style: 'gravity' } }, // gravity
	{ air: { chord: [1568, 2093, 2637], q: 25, level: 0.8, style: 'vibration' } }, // vibration
	{ air: { chord: [330, 392], q: 60, level: 0.8, style: 'rhythm' } }, // rhythm
	{ air: { chord: [466, 699], q: 120, level: 0.7, style: 'tension' } }, // tension
	{ air: { chord: [262, 330, 392], q: 18, level: 0.7, style: 'stillness' } } // stillness
];
function knob(V, x, y, label, val, dstId, dstIn) {
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x, y: y, w: 90, text: label });
	var lm = box(V, { text: 'loadmess ' + val, ins: 1, outs: 1, x: x, y: y + 20, w: 90 });
	var nb = box(V, { maxclass: 'flonum', ins: 1, outs: 2, x: x, y: y + 50, w: 70, types: ['', 'bang'], extra: { parameter_enable: 0 } });
	conn(V, lm, 0, nb, 0);
	conn(V, nb, 0, dstId, dstIn);
	return nb;
}
// 空気 (noise~ → 要素固有加工 → reson~ 並列コード → +~ 合流) エンジンを生成。
// 全要素共通の上昇スイープは置かない。同じ動きが毎回同じ「ひゅるる」になるのを防ぐ。
// swellId (line~ signal, optional): イベント由来の4秒膨らみを駆動段に合流させる
function buildAir(V, cfg, x, y, driveId, actId, actOutlet, swellId, motionId) {
	var noise = box(V, { text: 'noise~', ins: 1, outs: 1, x: x, y: y, w: 60, types: sig(1) });
	var freqCtl = null;
	if (cfg.style === 'acceleration') {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x + 340, y: y - 20, w: 300, text: '加速: 活性で高域が鋭く開く (この要素だけ)' });
		freqCtl = box(V, { text: 'scale 0. 1. 0.75 2.2', ins: 6, outs: 1, x: x + 340, y: y, w: 140, types: [''] });
		conn(V, actId, actOutlet, freqCtl, 0);
	} else if (cfg.style === 'deceleration' || cfg.style === 'gravity') {
		var isGravity = cfg.style === 'gravity';
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x + 340, y: y - 20, w: 300, text: isGravity ? '重力: 活性で風が低く重く沈む' : '減速: 活性に沿って風が下へ沈む' });
		freqCtl = box(V, { text: isGravity ? 'scale 0. 1. 1.05 0.58' : 'scale 0. 1. 1.25 0.62', ins: 6, outs: 1, x: x + 340, y: y, w: 145, types: [''] });
		conn(V, actId, actOutlet, freqCtl, 0);
	}
	var resons = [];
	for (var ri = 0; ri < cfg.chord.length; ri++) {
		var rz = box(V, { text: 'reson~ 2. ' + cfg.chord[ri] + ' ' + cfg.q, ins: 4, outs: 1, x: x + ri * 140, y: y + 96, w: 130, types: sig(1) });
		conn(V, noise, 0, rz, 0);
		if (freqCtl) {
			var fmul = box(V, { text: '* ' + cfg.chord[ri] + '.', ins: 2, outs: 1, x: x + 340 + ri * 100, y: y + 32, w: 80 });
			conn(V, freqCtl, 0, fmul, 0);
			conn(V, fmul, 0, rz, 2);
		}
		resons.push(rz);
	}
	if (cfg.style === 'stillness') {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x + 340, y: y - 20, w: 300, text: '静止: 静まるほど細く安定した共鳴になる' });
		var stillQ = box(V, { text: 'scale 0. 1. 12. 140.', ins: 6, outs: 1, x: x + 340, y: y, w: 140, types: [''] });
		conn(V, actId, actOutlet, stillQ, 0);
		for (var sq = 0; sq < resons.length; sq++) conn(V, stillQ, 0, resons[sq], 3);
	} else if (cfg.style === 'tension') {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x + 340, y: y - 20, w: 300, text: '張力: 活性で共鳴が締まり、圧が集中する' });
		var tensionQ = box(V, { text: 'scale 0. 1. 28. 190.', ins: 6, outs: 1, x: x + 340, y: y, w: 145, types: [''] });
		conn(V, actId, actOutlet, tensionQ, 0);
		for (var tq = 0; tq < resons.length; tq++) conn(V, tensionQ, 0, resons[tq], 3);
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
	var shaped = drv;
	if (cfg.style === 'rotation' || cfg.style === 'vibration' || cfg.style === 'balance' || cfg.style === 'rhythm') {
		var tx = x + 340, ty = y + 180;
		var isRot = cfg.style === 'rotation';
		var isVib = cfg.style === 'vibration';
		var isBalance = cfg.style === 'balance';
		var label = isRot ? '回転: rotで風が周期的に回る' : isVib ? '振動: 活性で風が高速に粗く刻まれる' : isBalance ? '傾き: 風がゆっくり均衡を揺れ動く' : 'リズム: 活性で風の拍動が速くなる';
		var rateText = isRot ? 'scale 0. 1. 1.5 9.' : isVib ? 'scale 0. 1. 12. 55.' : isBalance ? 'scale 0. 1. 0.12 0.7' : 'scale 0. 1. 1. 3.2';
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: tx, y: ty - 20, w: 300, text: label });
		var rateSc = box(V, { text: rateText, ins: 6, outs: 1, x: tx, y: ty, w: 145, types: [''] });
		conn(V, isRot ? motionId : actId, isRot ? 1 : actOutlet, rateSc, 0);
		var ratePk = box(V, { text: 'pack 0. 80', ins: 2, outs: 1, x: tx, y: ty + 30, w: 70 });
		conn(V, rateSc, 0, ratePk, 0);
		var rateLn = box(V, { text: 'line~', ins: 1, outs: 2, x: tx, y: ty + 60, w: 45, types: ['signal', 'bang'] });
		conn(V, ratePk, 0, rateLn, 0);
		var cyc = box(V, { text: 'cycle~', ins: 2, outs: 1, x: tx, y: ty + 90, w: 60, types: sig(1) });
		conn(V, rateLn, 0, cyc, 0);
		var half = box(V, { text: '*~ 0.5', ins: 2, outs: 1, x: tx, y: ty + 120, w: 55, types: sig(1) });
		conn(V, cyc, 0, half, 0);
		var uni = box(V, { text: '+~ 0.5', ins: 2, outs: 1, x: tx, y: ty + 150, w: 55, types: sig(1) });
		conn(V, half, 0, uni, 0);
		var amFloor = box(V, { text: isRot ? '*~ 0.75' : isVib ? '*~ 0.9' : isBalance ? '*~ 0.35' : '*~ 0.85', ins: 2, outs: 1, x: tx, y: ty + 180, w: 65, types: sig(1) });
		conn(V, uni, 0, amFloor, 0);
		var amBias = box(V, { text: isRot ? '+~ 0.25' : isVib ? '+~ 0.1' : isBalance ? '+~ 0.65' : '+~ 0.15', ins: 2, outs: 1, x: tx, y: ty + 210, w: 65, types: sig(1) });
		conn(V, amFloor, 0, amBias, 0);
		shaped = box(V, { text: '*~', ins: 2, outs: 1, x: x, y: y + 224, w: 50, types: sig(1) });
		conn(V, drv, 0, shaped, 0);
		conn(V, amBias, 0, shaped, 1);
	}
	var lvl = box(V, { text: '*~ ' + cfg.level, ins: 2, outs: 1, x: x, y: y + 256, w: 60, types: sig(1) });
	conn(V, shaped, 0, lvl, 0);
	// ツマミ: 空気音量 (lvl 右インレット), レゾQ (各 reson~ inlet 3)
	var volNb = knob(V, x, y + 296, '空気音量', cfg.level, lvl, 1);
	if (cfg.style !== 'stillness' && cfg.style !== 'tension') {
		var qNb = knob(V, x + 130, y + 296, 'レゾQ', cfg.q, resons[0], 3);
		for (var rk = 1; rk < resons.length; rk++) conn(V, qNb, 0, resons[rk], 3);
	}
	return lvl;
}
// にょろん: 連続グライド (駆動量float → scale → pack → line~ → cycle~ → *~駆動量line~ → *~レベル)
function buildNyoGlide(V, cfg, x, y, mulId, driveId, motionId) {
	var lo = Math.round(cfg.f0 * 0.5);
	var hi = Math.round(cfg.f0 * 2.0);
	var sc = box(V, { text: 'scale 0. 1. ' + lo + '. ' + hi + '.', ins: 6, outs: 1, x: x, y: y, w: 150, types: [''] });
	conn(V, mulId, 0, sc, 0);
	var pk = box(V, { text: 'pack 0. 200', ins: 2, outs: 1, x: x, y: y + 32, w: 70 });
	conn(V, sc, 0, pk, 0);
	var ln = box(V, { text: 'line~', ins: 1, outs: 2, x: x, y: y + 64, w: 45, types: ['signal', 'bang'] });
	conn(V, pk, 0, ln, 0);
	// rot → ビブラート (回転でピッチが震える): vibDepth(Hz) = rot→scale 0..25 → *(ツマミ,初期1.) → pack → line~
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x + 200, y: y - 20, w: 220, text: '回転でピッチが震える' });
	var vibSc = box(V, { text: 'scale 0. 1. 0. 25.', ins: 6, outs: 1, x: x + 200, y: y, w: 130, types: [''] });
	if (motionId) conn(V, motionId, 1, vibSc, 0);
	var vibMul = box(V, { text: '* 1.', ins: 2, outs: 1, x: x + 200, y: y + 32, w: 50 });
	conn(V, vibSc, 0, vibMul, 0);
	knob(V, x + 260, y + 64, 'ビブラート量', 1, vibMul, 1);
	var vibPk = box(V, { text: 'pack 0. 100', ins: 2, outs: 1, x: x + 200, y: y + 190, w: 70 });
	conn(V, vibMul, 0, vibPk, 0);
	var vibLn = box(V, { text: 'line~', ins: 1, outs: 2, x: x + 200, y: y + 222, w: 45, types: ['signal', 'bang'] });
	conn(V, vibPk, 0, vibLn, 0);
	var vibCyc = box(V, { text: 'cycle~ 5.5', ins: 2, outs: 1, x: x + 200, y: y + 254, w: 70, types: sig(1) });
	var vibScaled = box(V, { text: '*~', ins: 2, outs: 1, x: x + 200, y: y + 286, w: 50, types: sig(1) });
	conn(V, vibCyc, 0, vibScaled, 0);
	conn(V, vibLn, 0, vibScaled, 1);
	var freqSum = box(V, { text: '+~', ins: 2, outs: 1, x: x, y: y + 96 - 16, w: 45, types: sig(1) });
	conn(V, ln, 0, freqSum, 0);
	conn(V, vibScaled, 0, freqSum, 1);
	var cyc = box(V, { text: 'cycle~', ins: 2, outs: 1, x: x, y: y + 96, w: 60, types: sig(1) });
	conn(V, freqSum, 0, cyc, 0);
	var drv = box(V, { text: '*~', ins: 2, outs: 1, x: x, y: y + 128, w: 50, types: sig(1) });
	conn(V, cyc, 0, drv, 0);
	conn(V, driveId, 0, drv, 1);
	var lvl = box(V, { text: '*~ ' + cfg.level, ins: 2, outs: 1, x: x, y: y + 160, w: 60, types: sig(1) });
	conn(V, drv, 0, lvl, 0);
	var volNb = knob(V, x, y + 200, 'にょろん音量', cfg.level, lvl, 1);
	return { out: lvl, volNb: volNb };
}
// 離散イベントの風エンベロープ。関節は短い切れ目、加速は鋭く開いて余韻を残す。
function buildSwell(V, cfg, x, y, rtId) {
	var joint = cfg.shape === 'joint';
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x, y: y - 20, w: 360, text: joint ? '関節: 円弧完結→短く折れる風 (30ms / 650ms)' : '加速: onset→鋭く開く風 (40ms / 1.4s)' });
	var tf = box(V, { text: 't f', ins: 1, outs: 1, x: x, y: y, w: 40, types: ['float'] });
	conn(V, rtId, cfg.ev, tf, 0);
	var msg = box(V, { maxclass: 'message', text: joint ? '0., $1 30 0. 650' : '0., $1 40 $1 120 0. 1400', ins: 2, outs: 1, x: x, y: y + 32, w: 190 });
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
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 130, w: 650, text: '↓ 近さゲート = w × (0.04 + 0.96a^1.35)。遠い=薄い気配 / 近い=少し開く / 一致=全開' });
	var aCurve = box(V, { text: 'expr 0.04 + 0.96*pow($f1, 1.35)', ins: 1, outs: 1, x: 20, y: 155, w: 205 });
	var mul = box(V, { text: '* 0.', ins: 2, outs: 1, x: 20, y: 185, w: 50 });
	var pk = box(V, { text: 'pack 0. 90', ins: 2, outs: 1, x: 20, y: 215, w: 70 });
	var ln = box(V, { text: 'line~', ins: 1, outs: 2, x: 20, y: 245, w: 45, types: ['signal', 'bang'] });
	conn(V, rA, 0, upA, 0);
	conn(V, rW, 0, upW, 0);
	conn(V, upA, vi, aCurve, 0);
	conn(V, aCurve, 0, mul, 0);
	conn(V, upW, vi, mul, 1);
	conn(V, mul, 0, pk, 0);
	conn(V, pk, 0, ln, 0);
	var rE = box(V, { text: 'r ed-events', ins: 0, outs: 1, x: 540, y: 70, w: 85 });
	var rtE = box(V, { text: 'route arc-stop onset', ins: 1, outs: 3, x: 540, y: 100, w: 130 });
	conn(V, rE, 0, rtE, 0);
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 540, y: 130, w: 250, text: '↑ 円弧の完結 / 動き出し (打撃系のトリガ)' });

	// ---- 動きの生の激しさ。要素固有加工だけが必要な軸を使う ----
	var upMotion = null;
	if (c.air) {
		var rMotion = box(V, { text: 'r ed-motion', ins: 0, outs: 1, x: 800, y: 70, w: 90 });
		upMotion = box(V, { text: 'unpack 0. 0. 0.', ins: 1, outs: 3, x: 800, y: 100, w: 130 });
		conn(V, rMotion, 0, upMotion, 0);
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 800, y: 130, w: 300, text: '↑ lin / rot / speed (全ボイス共通変調にはしない)' });
	}

	// ---- 音の本体 (AIR / NYORON エンジン) ----
	var Y = 380;
	var branches = [];
	var bx = 20;

	var swellOut = null;
	if (c.swell) {
		var rawSwell = buildSwell(V, c.swell, bx, Y - 260, rtE);
		var swellWPk = box(V, { text: 'pack 0. 70', ins: 2, outs: 1, x: bx + 210, y: Y - 228, w: 70 });
		var swellWLine = box(V, { text: 'line~', ins: 1, outs: 2, x: bx + 210, y: Y - 196, w: 45, types: ['signal', 'bang'] });
		var swellGate = box(V, { text: '*~', ins: 2, outs: 1, x: bx + 210, y: Y - 164, w: 50, types: sig(1) });
		conn(V, upW, vi, swellWPk, 0);
		conn(V, swellWPk, 0, swellWLine, 0);
		conn(V, rawSwell, 0, swellGate, 0);
		conn(V, swellWLine, 0, swellGate, 1);
		swellOut = swellGate;
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: bx + 270, y: Y - 164, w: 260, text: 'イベントも獲物重みでゲート' });
		bx += 340;
	}
	if (c.air) {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: bx, y: Y - 20, w: 300, text: '空気: noise→reson コード' });
		var airOut = buildAir(V, c.air, bx, Y, ln, upA, vi, swellOut, upMotion);
		branches.push(airOut);
		bx += 620;
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

	// Granulator はマッピング外の動きを知らせない。速度によるグローバル変調はしない。
	box(G, { maxclass: 'comment', ins: 1, outs: 0, x: 420, y: 12, w: 420, text: '固定した薄い残像: マッピング外の動きでは変化しない' });
	var motionScales = [];
	var scaleRanges = [[90, 45], [130, 65], [170, 85]];
	for (var mi = 0; mi < 3; mi++) {
		var msc = box(G, { text: 'loadmess ' + scaleRanges[mi][0], ins: 1, outs: 1, x: 420 + mi * 150, y: 80, w: 110 });
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
	var wlm = box(G, { text: 'loadmess 0.08', ins: 1, outs: 1, x: 700, y: 70, w: 90 });
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
var rRate = box(P, { text: 'route rate battery', ins: 1, outs: 3, x: 160, y: 125, w: 110 });
var numRate = box(P, { maxclass: 'flonum', ins: 1, outs: 2, x: 160, y: 155, w: 60, types: ['', 'bang'], extra: { parameter_enable: 0 } });
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 225, y: 157, w: 60, text: '受信Hz' });
var numBattery = box(P, { maxclass: 'number', ins: 1, outs: 2, x: 300, y: 155, w: 60, types: ['', 'bang'], extra: { parameter_enable: 0 } });
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 365, y: 157, w: 80, text: 'バッテリー%' });
var prn = box(P, { text: 'print status', ins: 1, outs: 0, x: 450, y: 155, w: 80 });

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
conn(P, rRate, 0, numRate, 0); conn(P, rRate, 1, numBattery, 0); conn(P, rRate, 2, prn, 0);

// 制御ストリームの分配
var route = box(P, { text: 'route weights gain spot event motion distance', ins: 1, outs: 7, x: 30, y: 380, w: 260 });
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

// 距離感: 放置すると音が遠ざかる (こもる・ドライ減・残響増)、動くと戻る
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 30, y: 950, w: 500, text: '距離感: 放置すると音が遠ざかる (こもる・ドライ減・残響増)、動くと戻る' });
var pkCut = box(P, { text: 'pack 0. 200', ins: 2, outs: 1, x: 30, y: 1010, w: 70 });
var scCut = box(P, { text: 'scale 0. 1. 8000. 700.', ins: 6, outs: 1, x: 30, y: 980, w: 140 });
conn(P, route, 5, scCut, 0);
conn(P, scCut, 0, pkCut, 0);
var lnCut = box(P, { text: 'line~', ins: 1, outs: 2, x: 30, y: 1040, w: 45, types: ['signal', 'bang'] });
conn(P, pkCut, 0, lnCut, 0);

var scDry = box(P, { text: 'scale 0. 1. 1. 0.3', ins: 6, outs: 1, x: 220, y: 980, w: 140 });
conn(P, route, 5, scDry, 0);
var pkDry = box(P, { text: 'pack 0. 200', ins: 2, outs: 1, x: 220, y: 1010, w: 70 });
conn(P, scDry, 0, pkDry, 0);
var lnDry = box(P, { text: 'line~', ins: 1, outs: 2, x: 220, y: 1040, w: 45, types: ['signal', 'bang'] });
conn(P, pkDry, 0, lnDry, 0);

var scWet = box(P, { text: 'scale 0. 1. 0.3 0.8', ins: 6, outs: 1, x: 410, y: 980, w: 140 });
conn(P, route, 5, scWet, 0);
var pkWet = box(P, { text: 'pack 0. 200', ins: 2, outs: 1, x: 410, y: 1010, w: 70 });
conn(P, scWet, 0, pkWet, 0);
var lnWet = box(P, { text: 'line~', ins: 1, outs: 2, x: 410, y: 1040, w: 45, types: ['signal', 'bang'] });
conn(P, pkWet, 0, lnWet, 0);

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
// 距離感: 去るほどこもる (cutoff が下がる)。lores~ を gran の直後に挿入
var loresDist = box(P, { text: 'lores~ 8000. 0.2', ins: 3, outs: 1, x: 30, y: 690, w: 110, types: sig(1) });
conn(P, gran, 0, loresDist, 0);
conn(P, lnCut, 0, loresDist, 1);
// 去るほどドライが痩せる
var dryAtt = box(P, { text: '*~', ins: 2, outs: 1, x: 30, y: 720, w: 50, types: sig(1) });
conn(P, loresDist, 0, dryAtt, 0);
conn(P, lnDry, 0, dryAtt, 1);
conn(P, loresDist, 0, fbIn, 0); conn(P, damp, 0, fbIn, 1);
conn(P, lnWet, 0, wet, 1);
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
conn(P, dryAtt, 0, outSum, 0); conn(P, wet, 0, outSum, 1);
conn(P, outSum, 0, outAtt, 0);
conn(P, outAtt, 0, dac, 0); conn(P, outAtt, 0, dac, 1);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 85, y: 815, w: 220, text: '← クリックでオーディオ ON/OFF' });

writePatch(P, path.join(outDir, 'ElementDrift.maxpat'));
