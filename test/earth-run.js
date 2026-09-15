/* 判定实验：真实世界线 + 要素上限
 *
 * 用法：node test/earth1945.js
 *
 * 要回答的问题（三个，缺一不可）：
 *   Q1 真实世界的资源不平衡，够不够强？（用同一把尺子和随机地图比）
 *   Q2 不设「要素上限」时，模型会不会把这份不平衡**重新摊平**？
 *   Q3 只有换了资源表（1945 → 1973），稀缺的东西会不会换人？——「时代解锁」是否内生
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var E = require(path.join(__dirname, 'earth1945.js'));
var SIM = VIC.sim;

var GOODS = SIM.GOODS.map(function (g) { return g.name; });
var FACTORS = ['farm', 'oil', 'mine', 'wood', 'ind'];

/* ───────── 把真实资源翻译成「要素上限下的初始产能」 ─────────
 * 规则（这就是设计假设的落点）：
 *   某国某商品的建筑总级 ∝ 该国该要素占世界的份额 ÷ 该国人口占世界的份额
 * 即：**人均要素禀赋决定你能建多少产能**。
 * 沙特：石油份额极高、人口极少 → 上限很高；印度：耕地多但人口更多 → 每人均摊很低。
 * 上限 = 人均份额 × 2.5（2.5 ≈ 现模型 BASE_LEVEL 总量 15.7 与"人均均衡"的比值）。
 */
var CAP_MULT = 2.5;
/* 每个商品的"人均产能"上限，由该商品对应的真实要素决定。
 *   perCapita_i(省) = 省要素份额 / 省人口份额     （1 = 世界平均）
 *   上限倍数       = clamp(perCapita_i × CAP_MULT, 0.35, CAP_MULT)
 * 关键：**逐商品分别算** —— 沙特的石油上限高、耕地上限低，这就是它的国家性格。 */
function buildLevels(earth, useCap) {
  var G = 5, P = earth.provinces.length;
  var worldPop = 0;
  for (var p = 0; p < P; p++) worldPop += earth.provinces[p].popShare;

  // 每种商品的世界总需求（单位：级），标定到与现模型开局相近的总量
  var WORLD_TOTAL_LEVELS = 15.7 * 8;          // ≈ 8 国 × 15.7 级，与随机地图同量级
  var targetTotal = [0, 0, 0, 0, 0];
  for (var g0 = 0; g0 < G; g0++) targetTotal[g0] = WORLD_TOTAL_LEVELS / G;

  // 每个省的"人口份额"决定它该消费多少
  var levels = [];
  for (var c = 0; c < earth.countries.length; c++) levels.push(new Float64Array(G));

  for (var p2 = 0; p2 < P; p2++) {
    var prov = earth.provinces[p2];
    var popShare = prov.popShare / worldPop;                    // 该省占世界人口
    for (var g = 0; g < G; g++) {
      var need = targetTotal[g] * popShare;                     // 按人口该配多少
      if (!useCap) { levels[prov.country][g] += need; continue; }
      var fkey = E.GOOD_TO_FACTOR[g];
      var fsum = E.sumOf(fkey, earth._meta.era);
      var facShare = (fsum > 0 ? prov._factor[fkey] / fsum : 0);
      var perCapita = facShare / Math.max(1e-9, popShare);
      var cap = Math.min(CAP_MULT, Math.max(0.35, perCapita * CAP_MULT));
      levels[prov.country][g] += need * cap;
    }
  }
  return levels;
}

/* 逐国把 levels 汇总成"结构"用的矩阵 */
function levelsByCountry(earth, useCap) {
  var C = earth.countries.length, G = 5;
  var levels = buildLevels(earth, useCap);
  var out = [];
  for (var c = 0; c < C; c++) out.push(Array.prototype.slice.call(levels[c]));
  return out;
}

/* ───────── 随机地图对照组（同一把尺子） ───────── */
var MG = VIC.mapgen;
function randomMapDistance(seed) {
  var map = MG.generate({ width: 1600, height: 1000, seed: seed, provinces: 260, countries: 8 });
  var w = SIM.createWorld(map, { seed: seed + 7 });
  for (var i = 0; i < 12; i++) SIM.tick(w);
  var C = w.C, G = w.G, P = w.P;
  var levels = [];
  for (var c = 0; c < C; c++) levels.push(new Array(G).fill(0));
  for (var p = 0; p < P; p++) {
    var cc = w.map.provinces[p].country;
    for (var g = 0; g < G; g++) levels[cc][g] += w.level[g * P + p];
  }
  return levels;
}

console.log('══════════ 判定实验：真实 1945 世界线 vs 随机地图 ══════════\n');

var earth45 = E.buildEarth(1945);
var earth73 = E.buildEarth(1973);
console.log('真实世界线：' + earth45.countries.length + ' 国 / ' + earth45.provinces.length +
  ' 省，世界人口 ' + (earth45._meta.worldPop / 100).toFixed(1) + ' 亿（1945 年量级）\n');

/* ── Q1 + Q2：不平衡够不够强？上限有没有用？ ── */
console.log('【Q1/Q2】产业结构不对称（尺子与随机地图相同：0 = 与世界平均一致）\n');
var noCap = E.summarize(E.structuralDistance(levelsByCountry(earth45, false), 16, 5));
var cap = E.summarize(E.structuralDistance(levelsByCountry(earth45, true), 16, 5));
var rand = [8888, 777, 2718].map(function (s) {
  return E.summarize(E.structuralDistance(randomMapDistance(s), 8, 5));
});
var randAvg = rand.reduce(function (a, r) { return a + r.avg; }, 0) / rand.length;

console.log('  方案                          均值     最大    最偏国家的过剩倍数');
console.log('  随机地图（对照组，3 种子均值）    ' + randAvg.toFixed(3) + '   ' +
  (rand.reduce(function (a, r) { return a + r.max; }, 0) / rand.length).toFixed(3) + '   ×' +
  (rand.reduce(function (a, r) { return a + r.maxRatio; }, 0) / rand.length).toFixed(2));
console.log('  真实资源 + 不设上限            ' + noCap.avg.toFixed(3) + '   ' + noCap.max.toFixed(3) + '   ×' + noCap.maxRatio.toFixed(2));
console.log('  真实资源 + 要素上限            ' + cap.avg.toFixed(3) + '   ' + cap.max.toFixed(3) + '   ×' + cap.maxRatio.toFixed(2));
console.log('');
console.log('  → 「不设上限」= 所有国家都按人口配产能，真实资源完全没被用上，结构差异为 0');
console.log('  → 要素上限再把它抬到 ' + cap.avg.toFixed(3) + '（是随机地图的 ' + (cap.avg / randAvg).toFixed(1) + ' 倍）');

/* ── 谁过剩、谁短缺：涌现出来的地缘格局 ── */
console.log('\n【涌现格局】1945 年，各国的过剩/短缺品类（要素上限方案）\n');
var lv45 = levelsByCountry(earth45, true);
var rows45 = E.structuralDistance(lv45, 16, 5);
var byCountry = {};
rows45.forEach(function (r) { byCountry[r.c] = r; });
var worldTotal = [0, 0, 0, 0, 0], wsum = 0;
lv45.forEach(function (l) { for (var g = 0; g < 5; g++) { worldTotal[g] += l[g]; wsum += l[g]; } });
var ref = worldTotal.map(function (v) { return v / wsum; });

console.log('  国家        最过剩        倍数     最短缺        倍数');
earth45.countries.forEach(function (c, i) {
  var l = lv45[i], tot = 0;
  for (var g = 0; g < 5; g++) tot += l[g];
  var hi = 0, lo = 0, hv = -1, lvv = 9;
  for (var g2 = 0; g2 < 5; g2++) {
    var sh = l[g2] / tot, rr = sh / Math.max(1e-9, ref[g2]);
    if (rr > hv) { hv = rr; hi = g2; }
    if (rr < lvv) { lvv = rr; lo = g2; }
  }
  console.log('  ' + c.tag + ' ' + c.name.padEnd(8) +
    GOODS[hi].padEnd(6) + '×' + hv.toFixed(2).padEnd(8) +
    GOODS[lo].padEnd(6) + '×' + lvv.toFixed(2));
});

/* ── Q3：换资源表（1945 → 1973），谁过剩会换人吗？ ── */
console.log('\n【Q3】时代解锁：同一机制，只换一张资源表（1945 → 1973）\n');
var lv73 = levelsByCountry(earth73, true);
var worldTotal73 = [0, 0, 0, 0, 0], wsum73 = 0;
lv73.forEach(function (l) { for (var g = 0; g < 5; g++) { worldTotal73[g] += l[g]; wsum73 += l[g]; } });
var ref73 = worldTotal73.map(function (v) { return v / wsum73; });

/* 直接量「人均要素倍数」——这正是要素上限的驱动量：
 *   人均倍数 = 该国该要素占世界比 ÷ 该国人口占世界比
 * 1.0 = 世界平均；2.0 = 每人是世界平均的 2 倍（资源出口国的性格） */
function perCapitaRank(key, era) {
  var worldShare = E.sumOf(key, era);
  var worldPop = 0;
  for (var i = 0; i < E.COUNTRIES.length; i++) worldPop += E.COUNTRIES[i].pop;
  var arr = [];
  for (var i2 = 0; i2 < E.COUNTRIES.length; i2++) {
    var c = E.COUNTRIES[i2];
    var e = (era === 1973 && c._73) ? c._73 : c;
    arr.push({ tag: c.tag, name: c.name, r: (e[key] / worldShare) / (c.pop / worldPop) });
  }
  arr.sort(function (a, b) { return b.r - a.r; });
  return arr;
}
var pairs = [['oil', '石油'], ['farm', '耕地'], ['ind', '工业']];
pairs.forEach(function (pr) {
  var a = perCapitaRank(pr[0], 1945), b = perCapitaRank(pr[0], 1973);
  console.log('  ' + pr[1] + '（人均倍数）：');
  console.log('    1945 前三：' + a.slice(0, 3).map(function (x) { return x.tag + ' ×' + x.r.toFixed(1); }).join('  '));
  console.log('    1973 前三：' + b.slice(0, 3).map(function (x) { return x.tag + ' ×' + x.r.toFixed(1); }).join('  '));
  var moved = a.map(function (x, i) {
    var j = b.findIndex(function (y) { return y.tag === x.tag; });
    return { tag: x.tag, d: i - j };
  }).sort(function (u, v) { return Math.abs(v.d) - Math.abs(u.d); }).slice(0, 3);
  console.log('    位次变动最大：' + moved.map(function (x) {
    return x.tag + (x.d > 0 ? ' ↑' + x.d : (x.d < 0 ? ' ↓' + (-x.d) : ' —'));
  }).join('  '));
});
console.log('\n  → 机制一行没改，只是把资源表从 1945 换成 1973，过剩格局就换人了 = 时代解锁是内生的');
