// elements.js を Max なしで検証するハーネス:
//   node tools/harness.js max/elements.js
// Max グローバルをスタブし、selftest をシミュレートして
// (1) 特徴抽出の check PASS/FAIL、(2) 制御ストリーム (weights/gain/event)、
// (3) ドリフト方策 を検証する。
var fs = require('fs');

var simNow = 0;
global.Date = { now: function () { return simNow; } };
global.Task = function (fn, ctx) {
	this.interval = 0;
	this.repeat = function () {};
	this.cancel = function () {};
};
var logs = [];
var lastCtl = {};             // 直近の制御値 (gain, w0..w9, spot)
var events = [];              // {t, type, seg}
global.outlet = function (o) {
	var args = Array.prototype.slice.call(arguments, 1);
	if (o === 1) logs.push(args.join(' '));
	if (o === 2) {
		if (Array.isArray(args[0]) && args[0][0] === 'weights') {
			for (var wi = 0; wi < 10; wi++) lastCtl['w' + wi] = args[0][wi + 1];
		} else if (args[0] === 'gain') lastCtl.gain = args[1];
		else if (args[0] === 'spot') lastCtl.spot = args[2];
		else if (args[0] === 'event') events.push({ t: simNow, type: args[1] });
	}
};
global.arrayfromargs = function (a) { return Array.prototype.slice.call(a); };
global.messagename = '';
// Dict スタブ: mapping.json を読む (Max の dict elementmap 相当)
global.Dict = function (name) {
	var data = {};
	try { data = JSON.parse(fs.readFileSync(__dirname + '/../max/mapping.json', 'utf8')); } catch (e) {}
	this.getkeys = function () { var k = Object.keys(data); return k.length ? k : null; };
	this.get = function (key) { return data[key]; };
};

eval(fs.readFileSync(process.argv[2], 'utf8'));

selftest(1);
var lastUpdate = 0;
var NSEG = ST_LABELS.length;
var segCtl = {};              // seg → {key: [values]} (2周目以降・定常部)
var segEvents = {};           // seg → {type: count}
for (var i = 0; i < Math.floor(5000 * NSEG * 3 / 16); i++) {
	simNow += 16;
	var evBefore = events.length;
	selfstep();
	if (simNow - lastUpdate >= 50) { update(); lastUpdate = simNow; }
	var seg = Math.floor(stT / 5) % NSEG;
	for (var e = evBefore; e < events.length; e++) {
		if (!segEvents[seg]) segEvents[seg] = {};
		segEvents[seg][events[e].type] = (segEvents[seg][events[e].type] || 0) + 1;
	}
	if (stT > 5 * NSEG && (stT % 5) > 2 && simNow === lastUpdate) {
		if (!segCtl[seg]) segCtl[seg] = {};
		for (var k in lastCtl) {
			if (typeof lastCtl[k] !== 'number') continue;
			if (!segCtl[seg][k]) segCtl[seg][k] = [];
			segCtl[seg][k].push(lastCtl[k]);
		}
	}
}

var fails = 0;
for (var j = 0; j < logs.length; j++) {
	if (logs[j].indexOf('check') === 0) {
		console.log(logs[j]);
		if (logs[j].indexOf('FAIL') >= 0) fails++;
	}
}
function pcheck(label, ok) {
	console.log('pcheck ' + label + ' ' + (ok ? 'PASS' : 'FAIL'));
	if (!ok) fails++;
}
function meanOf(rec, name) {
	var a = (rec || {})[name] || [];
	if (!a.length) return NaN;
	var s = 0;
	for (var i = 0; i < a.length; i++) s += a[i];
	return s / a.length;
}

console.log('--- 制御ストリーム (2周目以降, セグメント定常部の平均 gain) ---');
for (var s = 0; s < NSEG; s++) {
	console.log(ST_LABELS[s] + '\tgain ' + meanOf(segCtl[s], 'gain').toFixed(2) +
		'\tevents ' + JSON.stringify(segEvents[s] || {}));
}

// イベント検出: 関節セグメントで arc-stop、加減速セグメントで onset が出ること
pcheck('関節セグメントで arc-stop イベント', ((segEvents[6] || {})['arc-stop'] || 0) >= 3);
pcheck('onset イベントが出る', events.some(function (e) { return e.type === 'onset'; }));
pcheck('reach読込', logs.join('\n').indexOf('reach loaded') >= 0);

// ---- スポットライト固定での検証 (gain∝表出、重みの絞り) ----
function runFixed(spotIdxFix, targetSeg) {
	spotlight(spotIdxFix);
	var rec = {};
	for (var i = 0; i < Math.floor(5000 * NSEG / 16); i++) {
		simNow += 16;
		selfstep();
		if (simNow - lastUpdate >= 50) {
			update();
			lastUpdate = simNow;
			var seg = Math.floor(stT / 5) % NSEG;
			if (seg === targetSeg && (stT % 5) > 2) {
				for (var k in lastCtl) {
					if (typeof lastCtl[k] !== 'number') continue;
					if (!rec[k]) rec[k] = [];
					rec[k].push(lastCtl[k]);
				}
			}
		}
	}
	var out = {};
	for (var k2 in rec) out[k2] = meanOf(rec, k2);
	return out;
}
var pVib = runFixed(6, 2);        // vibration固定 × 12Hz振動セグメント
var pGrav = runFixed(5, 9);       // gravity固定 × 鉛直バウンス
var pStill = runFixed(9, 0);      // stillness固定 × 静止
var pStillMove = runFixed(9, 2);  // stillness固定 × 激しい動き → 鳴らないはず
pcheck('vibration固定+振動→鳴る(gain>0.5)', pVib.gain > 0.5);
pcheck('vibration固定→重みが絞られる(w6>0.9)', pVib.w6 > 0.9);
pcheck('gravity固定+鉛直→鳴る(gain>0.5)', pGrav.gain > 0.5);
pcheck('stillness固定+静止→鳴る(gain>0.5)', pStill.gain > 0.5);
pcheck('stillness固定+激しい動き→鳴らない(gain<0.3)', pStillMove.gain < 0.3);

// ---- 追跡方策の検証 ----
spotlight(-1);
var pursuitLogStart = logs.length;
var gains2 = [];
var wSumOk = true, wNegOk = true;
for (var d = 0; d < Math.floor(5000 * NSEG * 2 / 16); d++) {
	simNow += 16;
	selfstep();
	if (simNow - lastUpdate >= 50) {
		update();
		lastUpdate = simNow;
		if (typeof lastCtl.gain === 'number') gains2.push(lastCtl.gain);
		var wsum = 0, neg = false;
		for (var wk = 0; wk < 10; wk++) {
			var wv = lastCtl['w' + wk];
			if (typeof wv === 'number') {
				wsum += wv;
				if (wv < -1e-6) neg = true;
			}
		}
		if (Math.abs(wsum - 1) > 0.05) wSumOk = false;
		if (neg) wNegOk = false;
	}
}
var preyLogs = [], preyTargets = {};
for (var pl = pursuitLogStart; pl < logs.length; pl++) {
	if (logs[pl].indexOf('prey') === 0) {
		preyLogs.push(logs[pl]);
		preyTargets[logs[pl].split(' ')[1]] = 1;
	}
}
console.log('--- prey log (' + preyLogs.length + ' 変化) ---');
for (var pp = 0; pp < preyLogs.length; pp++) console.log(preyLogs[pp]);
var gMin = Infinity, gMax = -Infinity, gFloorOk = true;
for (var g2 = 0; g2 < gains2.length; g2++) {
	if (gains2[g2] < gMin) gMin = gains2[g2];
	if (gains2[g2] > gMax) gMax = gains2[g2];
	if (gains2[g2] < GAIN_FLOOR - 1e-6) gFloorOk = false;
}
console.log('gain min/max (auto/pursuit):', gMin.toFixed(3), gMax.toFixed(3));
pcheck('weights が単体上(Σw≈1, 負値なし)', wSumOk && wNegOk);
pcheck('獲物が動く(argmaxが3要素以上、またはprey変化2回以上)', Object.keys(preyTargets).length >= 3 || preyLogs.length >= 2);
pcheck('gainが動的(min<0.3 かつ max>0.5)', gMin < 0.3 && gMax > 0.5);
pcheck('gainがGAIN_FLOORを下回らない', gFloorOk);

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAIL(S)');
process.exit(fails === 0 ? 0 : 1);
