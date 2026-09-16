/* 标定台 / 校验台：真实要素 → 模拟层的四条禀赋通道
 *
 * 这个台子干两件事，第二件比第一件重要：
 *
 *   1) **量出随机地图上四条通道的实际分布**，并打印成可以直接粘进
 *      `data/scenario.js` 的 ENDOW.TARGET 表格。
 *      什么时候要重跑：改了 `js/sim.js` 里那四行 fbm 噪声（频率、幅度、截断）之后。
 *
 *   2) **校验剧本世界的分布和它同形**。这是承重墙：
 *      sim 的全部常数（基建成本、商路衰减、天花板余量、投资曲线）都是在随机地图上
 *      标定的，而它们全都间接依赖这四条通道的分布形状。分布不同形 → 那些常数
 *      对剧本世界就没有理由成立。所以判据是分位数，不是"看起来合理"。
 *
 * 曾经的失败方案（留在这里免得有人再试）：
 *   第一版用幂压缩 `perCapita ^ BETA`，只压离散度、不搬中心。实测发现随机地图上
 *   通道的**均值只有 0.50~0.63**（是 `fbm × 1.7 − 0.25` 再截断的产物，不是 1），
 *   于是剧本世界整体悬在 1.85，90 分位全部顶在截断上限上，上半段没有区分度。
 *   现在的方案是分位数锚定的仿射映射（见 data/scenario.js 的 fitChannel）。
 *
 * 用法：node test/endow-calib.js
 */
'use strict';
var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
require(path.join(ROOT, 'data/scenario.js'));
require(path.join(ROOT, 'data/earth1945.js'));
var VIC = globalThis.VIC;
var SIM = VIC.sim, MG = VIC.mapgen, SC = VIC.scenario;

var CH = ['fert', 'timber', 'mineral', 'urban'];
var CH_NAME = { fert: '耕地', timber: '森林', mineral: '矿产', urban: '工业' };
var SEEDS = [8888, 777, 2718, 20260823, 991177];

function quantile(sorted, q) {
  var i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}
function stats(arr) {
  var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
  var s = 0;
  for (var i = 0; i < a.length; i++) s += a[i];
  return { mean: s / a.length, min: a[0], max: a[a.length - 1],
    p10: quantile(a, 0.10), p50: quantile(a, 0.50), p90: quantile(a, 0.90) };
}
function line(tag, st) {
  return '  ' + tag.padEnd(12) +
    ' 均值 ' + st.mean.toFixed(3) +
    '  p10 ' + st.p10.toFixed(3) +
    '  p50 ' + st.p50.toFixed(3) +
    '  p90 ' + st.p90.toFixed(3) +
    '  极值 ' + st.min.toFixed(2) + '~' + st.max.toFixed(2) +
    '  p90/p10 ' + (st.p10 > 0 ? (st.p90 / st.p10).toFixed(2) : '—');
}

/* ── 随机世界 ── */
function randomWorlds(seeds) {
  var acc = {}; CH.forEach(function (k) { acc[k] = []; });
  var pops = [], gdps = [], provs = 0;
  seeds.forEach(function (sd) {
    var map = MG.generate({ width: 1600, height: 1000, seed: sd, provinces: 190, countries: 8 });
    var w = SIM.createWorld(map, { seed: sd + 7 });
    for (var i = 0; i < 12; i++) SIM.tick(w);
    provs += w.P;
    var tp = 0;
    for (var s = 0; s < w.S; s++) for (var p = 0; p < w.P; p++) tp += w.pop[s * w.P + p];
    pops.push(tp);
    var tg = 0;
    for (var c = 0; c < w.C; c++) tg += w.gdp[c];
    gdps.push(tg);
    for (var p2 = 0; p2 < w.P; p2++) {
      acc.fert.push(w.fert[p2]); acc.timber.push(w.timber[p2]);
      acc.mineral.push(w.mineral[p2]); acc.urban.push(w.urban[p2]);
    }
  });
  return { ch: acc, pops: pops, gdps: gdps, tokens: seeds.length, provs: provs };
}

/* ── 剧本世界 ── */
function earthWorld() {
  var map = SC.build(SC.get('earth1945'), { seed: 1945 });
  var w = SIM.createWorld(map, { seed: 8888, startYear: 1945 });
  var acc = {}; CH.forEach(function (k) { acc[k] = []; });
  for (var p = 0; p < w.P; p++) {
    acc.fert.push(w.fert[p]); acc.timber.push(w.timber[p]);
    acc.mineral.push(w.mineral[p]); acc.urban.push(w.urban[p]);
  }
  var tp = 0;
  for (var s = 0; s < w.S; s++) for (var p2 = 0; p2 < w.P; p2++) tp += w.pop[s * w.P + p2];
  var tg = 0;
  for (var c = 0; c < w.C; c++) tg += w.gdp[c];
  return { ch: acc, pop: tp, gdp: tg, w: w, map: map };
}

var R = randomWorlds(SEEDS);
var rStat = {}; CH.forEach(function (k) { rStat[k] = stats(R.ch[k]); });
var rPop = R.pops.reduce(function (a, b) { return a + b; }, 0) / R.tokens;
var rGdp = R.gdps.reduce(function (a, b) { return a + b; }, 0) / R.tokens;

console.log('══════════ 禀赋通道：随机世界 vs 真实 1945 ══════════\n');
console.log('【随机世界】' + SEEDS.length + ' 个种子 × 190 省 = ' + R.provs + ' 个省样本');
CH.forEach(function (k) { console.log(line(CH_NAME[k], rStat[k])); });
console.log('\n  开局总人口 ' + (rPop / 1e6).toFixed(1) + 'M    开局总国力 ' + (rGdp / 1e6).toFixed(3) + 'M');
console.log('  平均每省人口 ' + (rPop / R.provs).toFixed(0) + ' 人');

console.log('\n  ↓ 若噪声层改动过，把下面这张表粘回 data/scenario.js 的 ENDOW.TARGET');
CH.forEach(function (k) {
  var s = rStat[k];
  console.log('      ' + (k + ':').padEnd(9) +
    '{ p10: ' + s.p10.toFixed(3) + ', p50: ' + s.p50.toFixed(3) + ', p90: ' + s.p90.toFixed(3) +
    ', lo: ' + (Math.floor(s.min * 100) / 100).toFixed(2) + ', hi: ' + (Math.ceil(s.max * 100) / 100).toFixed(2) + ' },');
});

var E = earthWorld();
var eStat = {}; CH.forEach(function (k) { eStat[k] = stats(E.ch[k]); });

console.log('\n【真实 1945】' + E.map.provinces.length + ' 省 / ' + E.map.countries.length + ' 国');
CH.forEach(function (k) {
  console.log(line(CH_NAME[k], eStat[k]));
  console.log(line('  目标', rStat[k]));
});
console.log('\n  开局总人口 ' + (E.pop / 1e6).toFixed(1) + 'M（随机世界 ' + (rPop / 1e6).toFixed(1) +
  'M，比值 ' + (E.pop / rPop).toFixed(2) + '）');
console.log('  开局总国力 ' + (E.gdp / 1e6).toFixed(3) + 'M（随机世界 ' + (rGdp / 1e6).toFixed(3) +
  'M，比值 ' + (E.gdp / rGdp).toFixed(2) + '）');
console.log('  平均每省人口 ' + (E.pop / E.map.provinces.length).toFixed(0) + ' 人');

/* ── 判据：p10/p50/p90 三点的平均对数偏差 ── */
console.log('\n【同形判定】每通道 p10/p50/p90 与随机世界的平均对数偏差（0 = 完全一致）\n');
var worst = 0, sum = 0;
CH.forEach(function (k) {
  var e = 0, n = 0;
  ['p10', 'p50', 'p90'].forEach(function (q) {
    var a = rStat[k][q], b = eStat[k][q];
    if (a > 0 && b > 0) { e += Math.abs(Math.log(b / a)); n++; }
  });
  e /= n;
  sum += e; if (e > worst) worst = e;
  console.log('  ' + CH_NAME[k] + '  ' + e.toFixed(4) + (e < 0.02 ? '   ✓' : '   ← 偏了'));
});
console.log('\n  平均 ' + (sum / CH.length).toFixed(4) + '   最差 ' + worst.toFixed(4));
console.log(worst < 0.02
  ? '  ✅ 四条通道与随机世界同形，sim 的标定常数继续有效。'
  : '  ⚠ 有通道偏离目标 —— 检查 ENDOW.TARGET 是否与上面打印的表一致。');
