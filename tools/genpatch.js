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
	{ air: { chord: [392, 494, 587], q: 30, level: 0.25 }, nyoGlide: { f0: 392, level: 0.5 } }, // balance
	{ nyoGlide: { f0: 294, level: 0.6 }, air: { chord: [294, 441], q: 20, level: 0.15 } }, // rotation
	{ nyoSwoop: { ev: 0, fStart: 785, f0: 523, swoopMs: 350, ampMs: 500, level: 0.7 }, air: { chord: [523, 784], q: 40, level: 0.12 } }, // articulation (arc-stop)
	{ nyoSwoop: { ev: 1, fStart: 330, f0: 659, swoopMs: 200, ampMs: 300, level: 0.7 }, air: { chord: [1319, 1976], q: 15, level: 0.2 } }, // acceleration (onset)
	{ air: { chord: [220, 277, 330], q: 25, level: 0.4 }, nyoGlide: { f0: 220, level: 0.3 } }, // deceleration
	{ air: { chord: [65, 98, 131], q: 35, level: 0.8 } }, // gravity
	{ air: { chord: [1568, 2093, 2637], q: 25, level: 0.5 } }, // vibration
	{ air: { chord: [330, 392], q: 60, level: 0.5 } }, // rhythm
	{ air: { chord: [466, 699], q: 120, level: 0.45 } }, // tension
	{ air: { chord: [262, 330, 392], q: 18, level: 0.5 } } // stillness
];
function knob(V, x, y, label, val, dstId, dstIn) {
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: x, y: y, w: 90, text: label });
	var lm = box(V, { text: 'loadmess ' + val, ins: 1, outs: 1, x: x, y: y + 20, w: 90 });
	var nb = box(V, { maxclass: 'flonum', ins: 1, outs: 2, x: x, y: y + 50, w: 70, types: ['', 'bang'], extra: { parameter_enable: 0 } });
	conn(V, lm, 0, nb, 0);
	conn(V, nb, 0, dstId, dstIn);
	return nb;
}
// 空気 (noise~ → reson~ 並列コード → +~ 合流) エンジンを生成
function buildAir(V, cfg, x, y, driveId) {
	var noise = box(V, { text: 'noise~', ins: 1, outs: 1, x: x, y: y, w: 60, types: sig(1) });
	var resons = [];
	for (var ri = 0; ri < cfg.chord.length; ri++) {
		var rz = box(V, { text: 'reson~ 1. ' + cfg.chord[ri] + ' ' + cfg.q, ins: 4, outs: 1, x: x + ri * 140, y: y + 32, w: 130, types: sig(1) });
		conn(V, noise, 0, rz, 0);
		resons.push(rz);
	}
	var sum = resons[0];
	for (var rj = 1; rj < resons.length; rj++) {
		var add = box(V, { text: '+~', ins: 2, outs: 1, x: x + rj * 140, y: y + 64, w: 45, types: sig(1) });
		conn(V, sum, 0, add, 0);
		conn(V, resons[rj], 0, add, 1);
		sum = add;
	}
	var norm = box(V, { text: '*~ 0.33', ins: 2, outs: 1, x: x, y: y + 96, w: 60, types: sig(1) });
	conn(V, sum, 0, norm, 0);
	var drv = box(V, { text: '*~', ins: 2, outs: 1, x: x, y: y + 128, w: 50, types: sig(1) });
	conn(V, norm, 0, drv, 0);
	conn(V, driveId, 0, drv, 1);
	var lvl = box(V, { text: '*~ ' + cfg.level, ins: 2, outs: 1, x: x, y: y + 160, w: 60, types: sig(1) });
	conn(V, drv, 0, lvl, 0);
	// ツマミ: 空気音量 (lvl 右インレット), レゾQ (各 reson~ inlet 3)
	var volNb = knob(V, x, y + 200, '空気音量', cfg.level, lvl, 1);
	var qNb = knob(V, x + 130, y + 200, 'レゾQ', cfg.q, resons[0], 3);
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
// にょろん: イベントスウープ (route出力 → t b f → 振幅env / 周波数envでcycle~グライド)
function buildNyoSwoop(V, cfg, x, y, rtId) {
	var tbf = box(V, { text: 't b f', ins: 1, outs: 2, x: x, y: y, w: 50, types: ['bang', 'float'] });
	conn(V, rtId, cfg.ev, tbf, 0);
	// f (outlet 1) → 振幅エンベロープ
	var msgAmp = box(V, { maxclass: 'message', text: '$1, 0. ' + cfg.ampMs, ins: 2, outs: 1, x: x, y: y + 32, w: 110 });
	conn(V, tbf, 1, msgAmp, 0);
	var envAmp = box(V, { text: 'line~', ins: 1, outs: 2, x: x, y: y + 64, w: 45, types: ['signal', 'bang'] });
	conn(V, msgAmp, 0, envAmp, 0);
	// b (outlet 0) → 周波数エンベロープ
	var msgFreq = box(V, { maxclass: 'message', text: cfg.fStart + ', ' + cfg.f0 + ' ' + cfg.swoopMs, ins: 2, outs: 1, x: x + 150, y: y + 32, w: 130 });
	conn(V, tbf, 0, msgFreq, 0);
	var envFreq = box(V, { text: 'line~', ins: 1, outs: 2, x: x + 150, y: y + 64, w: 45, types: ['signal', 'bang'] });
	conn(V, msgFreq, 0, envFreq, 0);
	var cyc = box(V, { text: 'cycle~', ins: 2, outs: 1, x: x + 150, y: y + 96, w: 60, types: sig(1) });
	conn(V, envFreq, 0, cyc, 0);
	var mulAmp = box(V, { text: '*~', ins: 2, outs: 1, x: x, y: y + 128, w: 50, types: sig(1) });
	conn(V, cyc, 0, mulAmp, 0);
	conn(V, envAmp, 0, mulAmp, 1);
	var lvl = box(V, { text: '*~ ' + cfg.level, ins: 2, outs: 1, x: x, y: y + 160, w: 60, types: sig(1) });
	conn(V, mulAmp, 0, lvl, 0);
	var volNb = knob(V, x, y + 200, 'にょろん音量', cfg.level, lvl, 1);
	return { out: lvl, volNb: volNb };
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
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 130, w: 320, text: '↓ この要素の活性 a × 重み w = 駆動量 (入力必須の心臓部)' });
	var mul = box(V, { text: '* 0.', ins: 2, outs: 1, x: 20, y: 160, w: 50 });
	var pk = box(V, { text: 'pack 0. 50', ins: 2, outs: 1, x: 20, y: 190, w: 70 });
	var ln = box(V, { text: 'line~', ins: 1, outs: 2, x: 20, y: 220, w: 45, types: ['signal', 'bang'] });
	conn(V, rA, 0, upA, 0);
	conn(V, rW, 0, upW, 0);
	conn(V, upA, vi, mul, 0);
	conn(V, upW, vi, mul, 1);
	conn(V, mul, 0, pk, 0);
	conn(V, pk, 0, ln, 0);
	var rE = box(V, { text: 'r ed-events', ins: 0, outs: 1, x: 540, y: 70, w: 85 });
	var rtE = box(V, { text: 'route arc-stop onset', ins: 1, outs: 3, x: 540, y: 100, w: 130 });
	conn(V, rE, 0, rtE, 0);
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 540, y: 130, w: 250, text: '↑ 円弧の完結 / 動き出し (打撃系のトリガ)' });

	// ---- 音の本体 (AIR / NYORON エンジン) ----
	var Y = 380;
	var branches = [];
	var bx = 20;

	if (c.air) {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: bx, y: Y - 20, w: 300, text: '空気: noise→reson コード' });
		var airOut = buildAir(V, c.air, bx, Y, ln);
		branches.push(airOut);
		bx += 460;
	}
	if (c.nyoGlide) {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: bx, y: Y - 20, w: 260, text: 'にょろん: 連続グライド' });
		var glide = buildNyoGlide(V, c.nyoGlide, bx, Y, mul, ln);
		branches.push(glide.out);
		bx += 260;
	}
	if (c.nyoSwoop) {
		box(V, { maxclass: 'comment', ins: 1, outs: 0, x: bx, y: Y - 20, w: 300, text: 'にょろん: イベントスウープ' });
		var swoop = buildNyoSwoop(V, c.nyoSwoop, bx, Y, rtE);
		branches.push(swoop.out);
		bx += 300;
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
var route = box(P, { text: 'route weights gain spot event', ins: 1, outs: 5, x: 30, y: 380, w: 200 });
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
conn(P, mg, 0, fbIn, 0); conn(P, damp, 0, fbIn, 1);
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
conn(P, mg, 0, outSum, 0); conn(P, wet, 0, outSum, 1);
conn(P, outSum, 0, outAtt, 0);
conn(P, outAtt, 0, dac, 0); conn(P, outAtt, 0, dac, 1);
box(P, { maxclass: 'comment', ins: 1, outs: 0, x: 85, y: 815, w: 220, text: '← クリックでオーディオ ON/OFF' });

writePatch(P, path.join(outDir, 'ElementDrift.maxpat'));
