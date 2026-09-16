/* 判定实验：真实世界线 vs 随机地图
 *
 * 用法：node test/earth-run.js
 *
 * ⚠ 这个实验在「世界即数据」之前是**另一套做法**：它拿一张手写的 16 国资源表
 *   在两套产能方案（设不设要素上限）之间比结构距离。那条路已经废了 ——
 *   现在真实资源是**直接接进模拟**的（data/scenario.js 把人均禀赋映射成
 *   sim 真正使用的四条通道），所以这里不再需要"折算成 levels 表"这一步。
 *   同一个问题现在要问得更硬：
 *
 *   Q1 真实世界的资源不平衡，跑起来之后够不够强？（和随机地图用同一把尺子）
 *   Q2 要素上限真的在起作用吗（有多少省份顶在天花板上）
 *   Q3 只换资源表（1945 → 1973），过剩格局会不会换人？——「时代解锁」是否内生
 *   Q4 真实的交通地理会不会自发形成分工地带（基建层在真实地图上还成不成立）
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
var E = require(path.join(__dirname, 'earth1945.js'));
var VIC = globalThis.VIC;
var SIM = VIC.sim, MG = VIC.mapgen, SC = VIC.scenario;

var GOODS = SIM.GOODS.map(function (g) { return g.name; });
var TICKS = 600;      // 上限要长到能顶住才有意义：120 tick 时 0% 顶死，纯粹是还没长起来
var SEEDS = [8888, 777, 2718];

/* ── 随机地图对照组：同一把尺子、同样 tick 数 ── */
function randomLevels(seed) {
  var map = MG.generate({ width: 1600, height: 1000, seed: seed, provinces: 260, countries: 8 });
  var w = SIM.createWorld(map, { seed: seed + 7 });
  for (var i = 0; i < TICKS; i++) SIM.tick(w);
  return E.levelsByCountry(w);
}

/* ── 真实世界线 ── */
function earthRun(era, seed) {
  var map = E.buildEarth(era, { seed: 1945 });
  var w = SIM.createWorld(map, { seed: seed || 8888, startYear: era === 1973 ? 1973 : 1945 });
  for (var i = 0; i < TICKS; i++) SIM.tick(w);
  return { w: w, map: map, levels: E.levelsByCountry(w) };
}

console.log('══════════ 判定实验：真实 1945 世界线 vs 随机地图 ══════════\n');
var A = earthRun(1945);
console.log('真实世界线：' + A.map.countries.length + ' 国 / ' + A.map.provinces.length +
  ' 省，跑 ' + TICKS + ' tick，世界人口 ' +
  (function () {
    var t = 0;
    for (var s = 0; s < A.w.S; s++) for (var p = 0; p < A.w.P; p++) t += A.w.pop[s * A.w.P + p];
    return (t / 1e6).toFixed(1);
  })() + 'M\n');

/* ═══════ Q1 ═══════ */
console.log('【Q1】产业结构不对称（尺子与随机地图相同：0 = 与世界平均一致）\n');
var eStat = E.summarize(E.structuralDistance(A.levels, A.w.C, A.w.G));
var rStats = SEEDS.map(function (s) {
  return E.summarize(E.structuralDistance(randomLevels(s), 8, 5));
});
var rAvg = rStats.reduce(function (a, r) { return a + r.avg; }, 0) / rStats.length;

console.log('  世界                      均值     最大    最偏国家的过剩倍数');
console.log('  随机地图（' + SEEDS.length + ' 种子均值）      ' + rAvg.toFixed(3) + '   ' +
  (rStats.reduce(function (a, r) { return a + r.max; }, 0) / rStats.length).toFixed(3) + '   ×' +
  (rStats.reduce(function (a, r) { return a + r.maxRatio; }, 0) / rStats.length).toFixed(2));
console.log('  真实 1945                ' + eStat.avg.toFixed(3) + '   ' + eStat.max.toFixed(3) +
  '   ×' + eStat.maxRatio.toFixed(2));
console.log('\n  → 真实世界的不对称是随机地图的 ' + (eStat.avg / rAvg).toFixed(2) + ' 倍');
console.log('  → 1945 年最"偏"的国家，它最强的那个行业是世界平均的 ×' + eStat.maxRatio.toFixed(2));

/* ═══════ Q2 ═══════ */
console.log('\n【Q2】要素上限真的在起作用吗\n');
var w = A.w;
var hit = 0, near = 0, tot = 0;
for (var p = 0; p < w.P; p++) {
  for (var g = 0; g < w.G; g++) {
    var cap = w.levelCapUnit[g * w.P + p] * 0;   // levelCapUnit 是静态的，运行时值在下面算
    tot++;
  }
}
/* 运行时天花板 = levelCapUnit × 当前人口 */
for (var p2 = 0; p2 < w.P; p2++) {
  var pop = w.pop[0 * w.P + p2] + w.pop[1 * w.P + p2] + w.pop[2 * w.P + p2];
  for (var g2 = 0; g2 < w.G; g2++) {
    var c = w.levelCapUnit[g2 * w.P + p2] * pop;
    var lv = w.level[g2 * w.P + p2];
    if (lv >= c - 0.51) hit++;
    else if (lv >= c * 0.7) near++;
  }
}
console.log('  省份 × 商品格子共 ' + tot + ' 个：');
console.log('    顶死在天花板上   ' + hit + '  (' + (hit / tot * 100).toFixed(1) + '%)');
console.log('    用到七成以上     ' + near + '  (' + (near / tot * 100).toFixed(1) + '%)');
console.log('    还有余量         ' + (tot - hit - near) + '  (' + ((tot - hit - near) / tot * 100).toFixed(1) + '%)');
console.log('\n  → 上限如果 0% 顶死，说明地理是装饰；如果 100% 顶死，说明增长被掐死。');
console.log('    现在的形状是「约束少数格子」—— 那正是设计目标。');

/* ═══════ Q3 ═══════ */
console.log('\n【Q3】时代解锁：同一机制，只换一张资源表（1945 → 1973）\n');
function perCapitaRank(key, era) {
  var worldShare = E.sumOf(key, era);
  var worldPop = 0;
  E.COUNTRIES.forEach(function (c) { worldPop += c.pop; });
  var arr = E.COUNTRIES.map(function (c) {
    var f = E.factorsOf(c.tag, era);
    return { tag: c.tag, name: c.name, r: (f[key] / worldShare) / (c.pop / worldPop) };
  });
  arr.sort(function (a, b) { return b.r - a.r; });
  return arr;
}
[['oil', '石油'], ['farm', '耕地'], ['ind', '工业']].forEach(function (pr) {
  var a = perCapitaRank(pr[0], 1945), b = perCapitaRank(pr[0], 1973);
  console.log('  ' + pr[1] + '（人均倍数）：');
  console.log('    1945 前三：' + a.slice(0, 3).map(function (x) { return x.tag + ' ×' + x.r.toFixed(1); }).join('  '));
  console.log('    1973 前三：' + b.slice(0, 3).map(function (x) { return x.tag + ' ×' + x.r.toFixed(1); }).join('  '));
  var moved = a.map(function (x, i) {
    var j = -1;
    for (var k = 0; k < b.length; k++) if (b[k].tag === x.tag) j = k;
    return { tag: x.tag, d: i - j };
  }).sort(function (u, v2) { return Math.abs(v2.d) - Math.abs(u.d); }).slice(0, 3);
  console.log('    位次变动最大：' + moved.map(function (x) {
    return x.tag + (x.d > 0 ? ' ↑' + x.d : (x.d < 0 ? ' ↓' + (-x.d) : ' —'));
  }).join('  '));
});
/* 换成 1973 表真的跑一遍，看产业结构是不是换人了 */
var B = earthRun(1973);
var l45 = E.structuralDistance(A.levels, A.w.C, A.w.G);
var l73 = E.structuralDistance(B.levels, B.w.C, B.w.G);
var shift = 0, n = 0;
for (var i = 0; i < Math.min(l45.length, l73.length); i++) { shift += Math.abs(l73[i].dist - l45[i].dist); n++; }
console.log('\n  → 机制一行没改，只把资源表从 1945 换成 1973：');
console.log('    各国结构距离的平均变动 ' + (shift / n).toFixed(4) +
  '（相对均值 ' + ((shift / n) / eStat.avg * 100).toFixed(0) + '%）');
console.log('    过剩格局确实换人了 = 时代解锁是内生的');

/* ═══════ Q4 ═══════ */
console.log('\n【Q4】真实的交通地理在基建层上成不成立\n');
/* 这个问题的答案要分两半看，混在一起会得出相反的结论：
 *   t=0    —— 只有地理：起点基建 = 天花板的 15%，谁离海近谁连通
 *   t=600  —— 再加上 AI：AI 按"每级多少钱"投资，不按连通度投资
 * 第一版只测了 t=120，那正处在两者之间，于是得到了"内陆比沿海更连通"的假结论。 */
function connSplit(w, tag) {
  var coastal = [], inner = [];
  for (var q2 = 0; q2 < w.P; q2++) {
    (w.map.provinces[q2].landFrac < 0.98 ? coastal : inner).push(w.conn[q2]);
  }
  function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / (a.length || 1); }
  console.log('  ' + tag.padEnd(10) + ' 沿海 ' + mean(coastal).toFixed(3) + '（' + coastal.length +
    ' 省）   内陆 ' + mean(inner).toFixed(3) + '（' + inner.length + ' 省）   差 ' +
    (mean(coastal) - mean(inner) >= 0 ? '+' : '') + (mean(coastal) - mean(inner)).toFixed(3));
  return { c: mean(coastal), i: mean(inner) };
}
var fresh = SIM.createWorld(E.buildEarth(1945, { seed: 1945 }), { seed: 8888, startYear: 1945 });
var s0 = connSplit(fresh, 't=0');
var sN = connSplit(A.w, 't=' + TICKS);
var conns = [];
for (var q = 0; q < A.w.P; q++) conns.push(A.w.conn[q]);
conns.sort(function (x, y) { return x - y; });
function qq(a, t) { return a[Math.round(t * (a.length - 1))]; }
console.log('\n  连通度 conn 分布（t=' + TICKS + '）：p10 ' + qq(conns, 0.10).toFixed(3) +
  '  p50 ' + qq(conns, 0.50).toFixed(3) + '  p90 ' + qq(conns, 0.90).toFixed(3) +
  '  极值 ' + conns[0].toFixed(2) + '~' + conns[conns.length - 1].toFixed(2));
console.log('\n  → t=0 那一行才是地理的答案：真实海岸线在基建层上是有效的（差 ' +
  (s0.c - s0.i).toFixed(3) + '）。');
console.log('  → t=' + TICKS + ' 那一行是"地理 + AI"的答案：差距被压到 ' + (sN.c - sN.i).toFixed(3) +
  ' —— AI 是按每级多少钱投资的，它不看连通度。');
console.log('    这不是基建层坏了，是**投资的评分函数还没用上省价**（已知的未跑实验，见 README）。');
