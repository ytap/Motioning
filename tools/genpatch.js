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
//       中身は自由に作り替えてよい。既定は a×w で開く単純なドローン
for (var vi = 0; vi < 10; vi++) {
	var V = newPatcher(760, 560);
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 12, w: 700, text: '要素ボイス: ' + NAMES[vi] + ' (' + JP[vi] + ') — 運動プロファイル: ' + ARCH[vi] + '。中身は自由に作り替えてよい' });
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 32, w: 720, text: '契約: ed-acts=活性(0..1)リスト / ed-weights=スポットライト重み / ed-events=arc-stop・onset。出力は outlet (signal) へ' });
	var rA = box(V, { text: 'r ed-acts', ins: 0, outs: 1, x: 20, y: 70, w: 70 });
	var upA = box(V, { text: 'unpack 0. 0. 0. 0. 0. 0. 0. 0. 0. 0.', ins: 1, outs: 10, x: 20, y: 100, w: 230 });
	var rW = box(V, { text: 'r ed-weights', ins: 0, outs: 1, x: 280, y: 70, w: 85 });
	var upW = box(V, { text: 'unpack 0. 0. 0. 0. 0. 0. 0. 0. 0. 0.', ins: 1, outs: 10, x: 280, y: 100, w: 230 });
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 20, y: 130, w: 300, text: '↓ この要素の活性 a × 重み w = 駆動量' });
	var mul = box(V, { text: '* 0.', ins: 2, outs: 1, x: 20, y: 160, w: 50 });
	var pk = box(V, { text: 'pack 0. 50', ins: 2, outs: 1, x: 20, y: 190, w: 70 });
	var ln = box(V, { text: 'line~', ins: 1, outs: 2, x: 20, y: 220, w: 45, types: ['signal', 'bang'] });
	conn(V, rA, 0, upA, 0);
	conn(V, rW, 0, upW, 0);
	conn(V, upA, vi, mul, 0);
	conn(V, upW, vi, mul, 1);
	conn(V, mul, 0, pk, 0);
	conn(V, pk, 0, ln, 0);
	// イベント (未接続で置いておく — 打撃系の音を作るときに使う)
	var rE = box(V, { text: 'r ed-events', ins: 0, outs: 1, x: 540, y: 70, w: 85 });
	var rtE = box(V, { text: 'route arc-stop onset', ins: 1, outs: 3, x: 540, y: 100, w: 130 });
	conn(V, rE, 0, rtE, 0);
	box(V, { maxclass: 'comment', ins: 1, outs: 0, x: 540, y: 130, w: 200, text: '↑ 円弧の完結 / 動き出し (トリガ用)' });
	// 既定の音: saw~ → lores~ → *~ 駆動量
	var osc = box(V, { text: 'saw~ ' + FREQ[vi], ins: 2, outs: 1, x: 20, y: 270, w: 80, types: sig(1) });
	var flt = box(V, { text: 'lores~ 1800 0.2', ins: 3, outs: 1, x: 20, y: 302, w: 110, types: sig(1) });
	var amp = box(V, { text: '*~', ins: 2, outs: 1, x: 20, y: 334, w: 50, types: sig(1) });
	var att = box(V, { text: '*~ 0.5', ins: 2, outs: 1, x: 20, y: 366, w: 55, types: sig(1) });
	var outl = box(V, { maxclass: 'outlet', ins: 1, outs: 0, x: 20, y: 410, w: 30, h: 30, extra: { comment: 'audio out' } });
	conn(V, osc, 0, flt, 0);
	conn(V, flt, 0, amp, 0);
	conn(V, ln, 0, amp, 1);
	conn(V, amp, 0, att, 0);
	conn(V, att, 0, outl, 0);
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
