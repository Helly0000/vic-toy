/* 意识形态向量：从世界状态推导（六轴）
 *
 * 用法：node test/ideo-derive.js [种子] [tick数]
 *
 * 设计前提（已定稿）：**意识形态是果，不是因。**
 *   玩家不拨滑杆；向量从 world 里已经存在的物理量推导出来。
 *   玩家能改的是"产出意识形态的机器"（制度），不是读数本身。
 *
 * 六轴（0 = 左端，1 = 右端），每一轴的推导都必须指向**已存在的世界变量**：
 *   ① 公有 ↔ 私有     ← 不安定水平（动荡 → 国家接管经济的压力）
 *   ② 个人 ↔ 集体     ← 底层人均财富 / 全国人均财富（相对剥夺 → 集体行动）
 *   ③ 等级 ↔ 平等     ← 上层人均财富 / 底层人均财富（分层程度）
 *   ④ 体力 ↔ 脑力     ← 城市化（城市 → 技术官僚与知识分子）
 *   ⑤ 现世 ↔ 来世     ← 工业类建筑占全部建筑的比重（资本投向未来）
 *   ⑥ 扩张 ↔ 内敛     ← 进口依赖度（本国供给覆盖不了需求的比例）
 *
 * 原料选择不是拍脑袋的：先跑 test/ideo-observables.js 量出哪些观测量彼此独立，
 * 再给每根轴配一个**不同源**的驱动量。三个阶层财富比之间相关 ±0.96~0.99，
 * 说明它们只是同一个"分层"维度的投影 —— 只能当一根轴用。
 *
 * 本台做四件事：
 *   1) 逐国逐商品地把六轴算出来，并且**每个数字当场断言有限性**（踩过三次 NaN 的坑）
 *   2) 检验轴的伪相关：**同一个世界变量喂给多根轴，就会造出结构性相关**
 *   3) 看向量随时间的漂移像不像一段"意识形态史"
 *   4) 看不同种子是否给出不同的向量分布（决定"换地图是否换历史"）
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;

var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };
var AXES = ['①公有↔私有', '②个人↔集体', '③等级↔平等', '④体力↔脑力', '⑤现世↔来世', '⑥扩张↔内敛'];

function clamp01(v, what) {
  if (typeof v !== 'number' || !isFinite(v)) {
    throw new Error('推导值不是有限数：' + what + ' = ' + v);
  }
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/* ───────── 六轴推导 ─────────
 * 每一轴都只读 world，不写。返回 0~1。 */
function deriveAxes(w, c) {
  var P = w.P, S = w.S, G = w.G;
  var prov = [];
  for (var p = 0; p < P; p++) if (w.map.provinces[p].country === c) prov.push(p);

  /* 分层汇总 */
  var strata = [];
  var pop = 0, wealthNum = 0;
  for (var s = 0; s < S; s++) {
    var sp = 0, sw = 0, si = 0, sc = 0;
    for (var k = 0; k < prov.length; k++) {
      var i1 = s * P + prov[k];
      sp += w.pop[i1]; sw += w.wealth[i1] * w.pop[i1];
      si += w.income[i1]; sc += w.cost[i1];
    }
    strata.push({ pop: sp, wealthMean: sp > 0 ? sw / sp : 0, income: si, cost: sc });
    pop += sp; wealthNum += sw;
  }
  var meanW = pop > 0 ? wealthNum / pop : 1;

  /* 该国的三类汇总 */
  var indLv = 0, allLv = 0, urbanSum = 0, urbanPop = 0, spreadSum = 0;
  for (var k2 = 0; k2 < prov.length; k2++) {
    var pp = prov[k2];
    for (var g = 0; g < G; g++) {
      var lv = w.level[g * P + pp];
      allLv += lv;
      if (g === 3 || g === 4) indLv += lv;      // 机械工坊 + 奢侈品工坊 = 工业能力
    }
    var wgt = w.pop[0 * P + pp];
    urbanSum += w.urban[pp] * wgt; urbanPop += wgt;
    var lo = 9, hi = -1;
    for (var g2 = 0; g2 < G; g2++) {
      var b = w.geoBonus[g2 * P + pp];
      if (b < lo) lo = b;
      if (b > hi) hi = b;
    }
    spreadSum += (hi - lo) * wgt;
  }

  var needTotal = 0, gapTotal = 0;
  for (var g3 = 0; g3 < G; g3++) {
    var sup = w.supply[g3 * w.C + c], dem = w.demand[g3 * w.C + c];
    needTotal += dem;
    if (dem > sup) gapTotal += dem - sup;
  }
  var unrestSum = 0;
  for (var k3 = 0; k3 < prov.length; k3++) unrestSum += w.unrest[prov[k3]];

  /* ── 六轴：每根轴用**不同源**的原料，避免结构性伪相关 ──
   * 原料选择的依据来自 ideo-observables.js 的相关矩阵：
   *   三个阶层财富比之间相关 ±0.96~0.99 → 它们只是同一个"分层"维度的投影，**只能当一根轴用**
   *   独立可用的原料只有：不安定、城市化、进口依赖、禀赋偏科、工业占比、阶层财富比
   */
  var a1 = clamp01(unrestSum / Math.max(1, prov.length) / 0.35, '①不安定→公有化压力');
  var wealthRatio = meanW > 0 ? strata[0].wealthMean / meanW : 1;
  var a2 = clamp01(1 - (wealthRatio - 0.85) / 0.3, '②底层相对位置→集体化诉求');
  var gap = strata[0].wealthMean > 0 ? strata[2].wealthMean / strata[0].wealthMean : 1;
  var a3 = clamp01(1 - (gap - 0.9) / 0.9, '③上下层财富比→等级');
  var urban = urbanPop > 0 ? urbanSum / urbanPop : 0;
  var a4 = clamp01(urban / 1.1, '④城市化→脑力/技术官僚');
  var indShare = allLv > 0 ? indLv / allLv : 0;
  var a5 = clamp01(indShare / 0.5, '⑤未来导向资本占比→现世/来世');
  var dep = needTotal > 0 ? gapTotal / needTotal : 0;
  var a6 = clamp01(1 - dep / 0.5, '⑥进口依赖→扩张/内敛');

  return [a1, a2, a3, a4, a5, a6];
}

/* ───────── 采样 ─────────
 * 关键教训（踩过一次）：只采"和平工业化"这一条轨迹，会得到一堆同向变化的高相关轴 ——
 * 那不是轴的错，是**采样只覆盖了一条路径**。判别实验（test/ideo-shock.js）证明：
 * 给一次「量的冲击」，向量方向余弦立刻掉到 0.126（= 拐向新方向），
 * 说明这个世界有多个自由度，只是平时都沿着工业化那一条在走。
 *
 * 所以采样必须覆盖**多条轨迹**：不同种子 × 不同冲击 × 不同时间 × 不同国家。
 */
var SHOCKS = [
  null,                                                  // 基线轨道
  { at: 300, ticks: 60, kind: 'farm', tag: '耕地被毁' },      // 天灾/占领
  { at: 300, ticks: 60, kind: 'ind', tag: '工业被毁' },       // 战败/去工业化
  { at: 600, ticks: 60, kind: 'wealth', tag: '财富被抹平' },  // 革命/土改
  { at: 240, ticks: 120, kind: 'urban', tag: '城市化跃升' }   // 快速城市化
];

function applyShock(w, c, kind) {
  var P = w.P;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== c) continue;
    if (kind === 'farm') {
      var lv = w.level[0 * P + p];
      if (lv > 1) w.level[0 * P + p] = Math.max(1, Math.round(lv * 0.5));
    } else if (kind === 'ind') {
      for (var g = 3; g <= 4; g++) {
        var lv2 = w.level[g * P + p];
        if (lv2 > 0) w.level[g * P + p] = Math.max(1, Math.round(lv2 * 0.5));
      }
    } else if (kind === 'wealth') {
      for (var s = 0; s < w.S; s++) {
        var i1 = s * P + p;
        w.wealth[i1] = 1 + (w.wealth[i1] - 1) * 0.25;       // 财富差被强行抹平
      }
    } else if (kind === 'urban') {
      w.urban[p] = Math.min(1.8, w.urban[p] * 1.35);
    }
  }
}

function sample(seed, ticks, shock) {
  var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: seed }));
  var w = SIM.createWorld(map, { seed: seed + 7 });
  var checkpoints = [0, 60, 300, 600, 1200].filter(function (t) { return t <= ticks; });
  if (checkpoints[checkpoints.length - 1] !== ticks) checkpoints.push(ticks);
  var out = [], last = 0;
  checkpoints.forEach(function (t) {
    while (last < t) {
      if (shock && last >= shock.at && last < shock.at + shock.ticks) {
        for (var c2 = 0; c2 < w.C; c2++) applyShock(w, c2, shock.kind);   // 打所有国家，制造分化
      }
      SIM.tick(w); last++;
    }
    for (var c = 0; c < w.C; c++) {
      out.push({ seed: seed, tick: t, c: c, tag: w.map.countries[c].tag, axes: deriveAxes(w, c) });
    }
  });
  return out;
}

function pearson(a, b) {
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var num = 0, da = 0, db = 0;
  for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(Math.max(1e-12, da * db));
}

console.log('══════ 意识形态向量：从世界状态推导 ══════\n');
var SEEDS = [8888, 777, 2718];
var all = [];
SEEDS.forEach(function (sd) {
  SHOCKS.forEach(function (sh) { all = all.concat(sample(sd, 900, sh)); });
});
console.log('样本：' + SEEDS.length + ' 种子 × ' + SHOCKS.length + ' 条轨迹 × 4 个时点 × 8 国 = ' +
  all.length + ' 条向量');
console.log('（覆盖 1 条基线 + 4 种冲击轨迹：耕地被毁 / 工业被毁 / 财富被抹平 / 城市化跃升）\n');

/* 1) 覆盖面检查 */
console.log('【1】六轴的取值范围（越接近 0~1 两端，说明区分度越好）\n');
console.log('  轴                最小    最大    极差    标准差');
AXES.forEach(function (nm, j) {
  var v = all.map(function (x) { return x.axes[j]; });
  var mn = Math.min.apply(null, v), mx = Math.max.apply(null, v);
  var mean = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
  var sd = Math.sqrt(v.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / v.length);
  console.log('  ' + nm.padEnd(14) + mn.toFixed(3).padStart(7) + mx.toFixed(3).padStart(8) +
    (mx - mn).toFixed(3).padStart(8) + sd.toFixed(3).padStart(9));
});

/* 2) 伪相关检验 —— 这是本台最重要的产出 */
console.log('\n【2】伪相关检验：这些轴真的独立吗？\n');
console.log('  （同一个世界变量喂给多根轴，就会造出结构性相关。|r|>0.7 视为"其实是同一根轴"）\n');
var hits = [];
for (var i = 0; i < 6; i++) for (var j = i + 1; j < 6; j++) {
  var ca = all.map(function (x) { return x.axes[i]; });
  var cb = all.map(function (x) { return x.axes[j]; });
  var r = pearson(ca, cb);
  hits.push({ a: AXES[i], b: AXES[j], r: r });
}
hits.sort(function (x, y) { return Math.abs(y.r) - Math.abs(x.r); });
hits.slice(0, 6).forEach(function (h) {
  var flag = Math.abs(h.r) > 0.7 ? '  ★ 几乎同一根轴' : (Math.abs(h.r) > 0.5 ? '  ← 偏高' : '');
  console.log('  r=' + (h.r >= 0 ? ' ' : '') + h.r.toFixed(2) + '   ' + h.a + ' × ' + h.b + flag);
});
var bad = hits.filter(function (h) { return Math.abs(h.r) > 0.7; });
console.log('\n  高相关轴对：' + bad.length + ' / 15');

/* 3) 向量随时间的漂移 —— 像不像一段意识形态史 */
console.log('\n【3】时间漂移：挑一个国家（第 0 号）看它 100 年里的向量变化\n');
console.log('  月份    ' + AXES.map(function (n) { return n.slice(1, 5); }).join('   '));
[0, 60, 300, 600].forEach(function (t) {
  var row = all.filter(function (x) { return x.seed === 8888 && x.tick === t && x.c === 0; })[0];
  if (!row) return;
  console.log('  ' + String(t).padStart(5) + '   ' +
    row.axes.map(function (v) { return v.toFixed(2); }).join('   '));
});

/* 4) 不同种子是否给出不同分布 */
console.log('\n【4】换地图会不会换历史？（三个种子的向量分布对比）\n');
console.log('  轴              ' + SEEDS.map(function (s) { return ('种子' + s).padStart(10); }).join(''));
AXES.forEach(function (nm, j) {
  var line = '  ' + nm.padEnd(14);
  SEEDS.forEach(function (sd) {
    var v = all.filter(function (x) { return x.seed === sd; }).map(function (x) { return x.axes[j]; });
    var m = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    line += m.toFixed(3).padStart(10);
  });
  console.log(line);
});

console.log('\n══════ 结论 ══════\n');
console.log('  · 六轴推导全部成功，无 NaN（每个数字当场断言）');
console.log('  · 伪相关：' + (bad.length === 0
  ? '**没有发现 |r|>0.7 的轴对** —— 说明这组推导在结构上是可用的'
  : '发现 ' + bad.length + ' 对高相关轴，需要**重新设计推导公式**（换上游变量）'));
console.log('  · 这台的用法：**每次改推导公式就跑一次**，看伪相关有没有超标。');
console.log('    这与 factor-sweep.js 的六条史实断言是同一类东西：把"设计得好不好"变成可测量。');
