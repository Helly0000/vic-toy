/* 意识形态推导的"原料清单"：先量清楚 world 里哪些观测量是彼此独立的
 *
 * 用法：node test/ideo-observables.js
 *
 * 为什么要这一步（踩坑记录）：
 *   第一版 ideo-derive.js 直接凭直觉写了六个公式，结果——
 *     ① 公有↔私有、⑤ 现世↔来世 两个轴的方差**恰好为 0**（公式撞死在边界上）
 *     ② 个人↔集体 极差只有 0.04（几乎不动）
 *     并把坏轴的相关噪声传染成了"三轴高相关"的假信号。
 *   教训：**不要凭直觉设计推导公式**。先把原料量清楚，
 *   看清哪些观测量真的彼此独立、哪些的方差是够的，再谈把它们组合成轴。
 *
 * 本台输出一张"观测量 × 观测量"的相关矩阵 + 各自的方差，供设计时挑料。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;
var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };

/* ── 候选观测量：全部来自 world 现有字段，不做任何加工 ── */
var OBS = [
  ['国资汲取率',   '税收占收入的比重（= TAX_RATE，当前为常量）'],
  ['投资池规模',   'invest 累计 / 月度 GDP（会随 tick 增长）'],
  ['底层/均值财富', '底层人均财富 ÷ 全国人均财富'],
  ['中层/均值财富', '中层人均财富 ÷ 全国人均财富'],
  ['上层/底层财富', '上层人均财富 ÷ 底层人均财富'],
  ['底层人口占比',  '底层人口 ÷ 全国人口'],
  ['中层人口占比',  '中层人口 ÷ 全国人口'],
  ['底层收支比',   '底层的收入 ÷ 支出'],
  ['工业建筑占比',  '工具+奢侈品建筑级 ÷ 全部建筑级'],
  ['谷物建筑占比',  '农场级 ÷ 全部建筑级'],
  ['城市化',      '该国省份 urban 禀赋的人口加权均值'],
  ['禀赋偏科度',   '各省 geoBonus 在商品间的极差（人口加权）'],
  ['进口依赖度',   '需求超过本国供给的比例'],
  ['不安定均值',   '该国各省 unrest 的均值']
];

function observables(w, c) {
  var P = w.P, S = w.S, G = w.G;
  var prov = [];
  for (var p = 0; p < P; p++) if (w.map.provinces[p].country === c) prov.push(p);

  var pop = 0, wealthNum = 0, incomeSum = 0;
  var byStrata = [];
  for (var s = 0; s < S; s++) {
    var sp = 0, sw = 0, si = 0, sc = 0;
    for (var k = 0; k < prov.length; k++) {
      var i1 = s * P + prov[k];
      sp += w.pop[i1]; sw += w.wealth[i1] * w.pop[i1];
      si += w.income[i1]; sc += w.cost[i1];
    }
    byStrata.push({ pop: sp, wealthMean: sp > 0 ? sw / sp : 0, income: si, cost: sc });
    pop += sp; wealthNum += sw; incomeSum += si;
  }
  var meanW = pop > 0 ? wealthNum / pop : 1;

  var indLv = 0, grainLv = 0, allLv = 0;
  var urbanSum = 0, bonusSpreadSum = 0;
  for (var k2 = 0; k2 < prov.length; k2++) {
    var pp = prov[k2];
    for (var g = 0; g < G; g++) {
      var lv = w.level[g * P + pp];
      allLv += lv;
      if (g === 3 || g === 4) indLv += lv;
      if (g === 0) grainLv += lv;
    }
    urbanSum += w.urban[pp] * w.pop[0 * P + pp];
    var lo = 9, hi = -1;
    for (var g2 = 0; g2 < G; g2++) {
      var b = w.geoBonus[g2 * P + pp];
      if (b < lo) lo = b;
      if (b > hi) hi = b;
    }
    bonusSpreadSum += (hi - lo) * w.pop[0 * P + pp];
  }
  var lowPop = w.pop[0 * P + 0] ? 0 : 0;   // 占位，避免误用
  var denomPop = 0;
  for (var k3 = 0; k3 < prov.length; k3++) denomPop += w.pop[0 * P + prov[k3]];

  var needTotal = 0, gapTotal = 0;
  for (var g3 = 0; g3 < G; g3++) {
    var sup = w.supply[g3 * w.C + c], dem = w.demand[g3 * w.C + c];
    needTotal += dem;
    if (dem > sup) gapTotal += dem - sup;
  }

  var investSum = 0;
  for (var k4 = 0; k4 < prov.length; k4++) investSum += w.invest[prov[k4]];

  var unrestSum = 0;
  for (var k5 = 0; k5 < prov.length; k5++) unrestSum += w.unrest[prov[k5]];

  return [
    totalIncomeGuard(incomeSum) * 0.08 / Math.max(1e-9, incomeSum),        // 国资汲取率
    investSum / Math.max(1e-9, w.gdp[c]),                                  // 投资池规模
    byStrata[0].wealthMean / Math.max(1e-9, meanW),                        // 底层/均值
    byStrata[1].wealthMean / Math.max(1e-9, meanW),                        // 中层/均值
    byStrata[2].wealthMean / Math.max(1e-9, byStrata[0].wealthMean),       // 上层/底层
    byStrata[0].pop / Math.max(1e-9, pop),                                 // 底层人口占比
    byStrata[1].pop / Math.max(1e-9, pop),                                 // 中层人口占比
    byStrata[0].cost > 0 ? byStrata[0].income / byStrata[0].cost : 0,      // 底层收支比
    allLv > 0 ? indLv / allLv : 0,                                         // 工业建筑占比
    allLv > 0 ? grainLv / allLv : 0,                                       // 谷物建筑占比
    denomPop > 0 ? urbanSum / denomPop : 0,                                // 城市化
    denomPop > 0 ? bonusSpreadSum / denomPop : 0,                          // 禀赋偏科度
    needTotal > 0 ? gapTotal / needTotal : 0,                              // 进口依赖度
    prov.length > 0 ? unrestSum / prov.length : 0                          // 不安定均值
  ];
}
function totalIncomeGuard(v) { return v; }

function pearson(a, b) {
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var num = 0, da = 0, db = 0;
  for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(Math.max(1e-12, da * db));
}

console.log('══════ 原料清单：world 里可用的观测量 ══════\n');
var SEEDS = [8888, 777, 2718];
var rows = [];
SEEDS.forEach(function (seed) {
  var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: seed }));
  var w = SIM.createWorld(map, { seed: seed + 7 });
  var last = 0;
  [0, 60, 300, 600, 1200].forEach(function (t) {
    while (last < t) { SIM.tick(w); last++; }
    for (var c = 0; c < w.C; c++) rows.push(observables(w, c));
  });
});
console.log('样本：' + SEEDS.length + ' 种子 × 5 时点 × 8 国 = ' + rows.length + ' 条\n');

/* ── 每个观测量自己的方差 ── */
console.log('【1】各观测量自身的取值范围（方差太小 = 它承载不了信息）\n');
console.log('  #   观测量            最小     最大     极差    标准差   判定');
OBS.forEach(function (o, j) {
  var v = rows.map(function (r) { return r[j]; });
  var mn = Math.min.apply(null, v), mx = Math.max.apply(null, v);
  var mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
  var sd = Math.sqrt(v.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / v.length);
  var verdict = (mx - mn) < 0.02 ? '★ 死的（几乎不动）' : (sd / Math.max(1e-9, Math.abs(mean)) < 0.05 ? '偏死' : '可用');
  console.log('  ' + (j + 1) + '   ' + o[0].padEnd(14) +
    mn.toFixed(3).padStart(8) + mx.toFixed(3).padStart(9) +
    (mx - mn).toFixed(3).padStart(8) + sd.toFixed(3).padStart(9) + '   ' + verdict);
});

/* ── 相关性：挑独立的原料 ── */
console.log('\n【2】观测量之间的相关（|r|>0.7 = 它们其实是同一个东西，不要同时用来喂两根轴）\n');
var hi = [];
for (var a = 0; a < OBS.length; a++) for (var b = a + 1; b < OBS.length; b++) {
  var r = pearson(rows.map(function (x) { return x[a]; }), rows.map(function (x) { return x[b]; }));
  if (Math.abs(r) > 0.7) hi.push({ a: OBS[a][0], b: OBS[b][0], r: r });
}
hi.sort(function (x, y) { return Math.abs(y.r) - Math.abs(x.r); });
if (!hi.length) console.log('  （没有 |r|>0.7 的对）');
hi.forEach(function (h) {
  console.log('  r=' + (h.r >= 0 ? ' ' : '') + h.r.toFixed(2) + '   ' + h.a.padEnd(14) + ' × ' + h.b);
});
console.log('\n  高相关对数：' + hi.length + ' / ' + (OBS.length * (OBS.length - 1) / 2));

/* ── 建议：从哪些原料里挑轴 ── */
console.log('\n【3】设计建议：挑"活的、且彼此不同源"的原料来喂六根轴\n');
console.log('  要求：极差 > 0.05，且不与已选原料高相关。');
var dead = [];
OBS.forEach(function (o, j) {
  var v = rows.map(function (r) { return r[j]; });
  var mn = Math.min.apply(null, v), mx = Math.max.apply(null, v);
  if ((mx - mn) < 0.02) dead.push(o[0]);
});
console.log('  必须换掉的死原料：' + (dead.length ? dead.join('、') : '无'));
console.log('  已经好用的原料：' + OBS.filter(function (o, j) {
  var v = rows.map(function (r) { return r[j]; });
  return (Math.max.apply(null, v) - Math.min.apply(null, v)) >= 0.05;
}).map(function (o) { return o[0]; }).join('、'));
console.log('\n  注：本台只做诊断，不自动生成公式——公式设计需要人来判断"哪根轴该由什么驱动"。');
