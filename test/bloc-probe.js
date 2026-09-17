/* 标定台：阵营关系的取值 —— 1 = 正常通商，0 = 全面禁运
 *
 * 用法：node test/bloc-probe.js [ticks] [seed]
 *
 * ── 它为什么必须先于实现跑 ──
 * 「封锁要有牙」这句话在接入之前是**论断**。这个项目的规矩是：
 * 先把分布量出来，再决定公式和常数长什么样。所以这台仪器先量三件事：
 *
 *   ① 世界贸易总量随关系下降多少   —— 机制有没有真的接上
 *   ② 阵营内贸易份额上升多少       —— 「阵营」是否成为一个**真实的结构**，
 *                                      而不只是标签（这是本台的主判据）
 *   ③ 谁赢谁输                     —— 格局有没有被重排，还是只是等比缩水
 *
 * ③ 是关键：如果各方只是等比缩水，那阵营就只是一个"把世界变小"的旋钮，
 * 玩家不会关心。只有当**排名**会变，它才是一个决策。
 *
 * ── 已知的一个反直觉结果（先写在这里，免得后人当成 bug 去改）──
 * 被完全切断的国家里，**有一部分会变富**（实测 SVE +7.7%）。根因不是新机制：
 * 收入/支出比 r 在多数国家都贴着 1.0，而人口按 (r−1)×0.0105 复利增长 ——
 * 于是 r 上 0.003 的差别，在 1140 个 tick 之后变成 6~7% 的人口差。
 * 也就是说：**这是一条本来就存在的刀锋，阵营层只是把国家推到了刀锋的另一侧。**
 * 见 test/bloc-test.js 的 P6（它把这件事量出来并钉住，而不是假装没有）。
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
var SIM = VIC.sim, SC = VIC.scenario;

var TICKS = parseInt(process.argv[2], 10) || 600;
var SEED = parseInt(process.argv[3], 10) || 8888;
var DEF = SC.get('earth1945');

/* 结构分化度：各国建筑结构（归一化等级向量）两两之间的 L1 距离均值。
 * 与 test/trade-sweep.js 用的是同一把尺子 —— 换台子不该换尺子。 */
function structureDivergence(w) {
  var C = w.C, G = w.G, P = w.P, vecs = [];
  for (var c = 0; c < C; c++) {
    var v = [], tot = 0;
    for (var g = 0; g < G; g++) {
      var s = 0;
      for (var p = 0; p < P; p++) if (w.map.provinces[p].country === c) s += w.level[g * P + p];
      v.push(s); tot += s;
    }
    if (tot <= 0) return 0;
    for (var g2 = 0; g2 < G; g2++) v[g2] /= tot;
    vecs.push(v);
  }
  var acc = 0, n = 0;
  for (var a = 0; a < C; a++) {
    for (var b = a + 1; b < C; b++) {
      var d = 0;
      for (var g3 = 0; g3 < G; g3++) d += Math.abs(vecs[a][g3] - vecs[b][g3]);
      acc += d; n++;
    }
  }
  return n ? acc / n : 0;
}

function build(relOverride) {
  var map = SC.build(DEF, { seed: 1945 });
  if (relOverride) relOverride(map);
  return { map: map, w: SIM.createWorld(map, { seed: SEED, startYear: 1945 }) };
}

function run(w, ticks) { for (var i = 0; i < ticks; i++) SIM.tick(w); }

function measure(w) {
  var C = w.C, G = w.G, tot = 0, pop = 0;
  for (var c = 0; c < C; c++) { tot += w.tradeGross[c]; pop += w.popTotal[c]; }
  /* 阵营内贸易份额。用商品级流量而不是 tradeGross：
   * tradeGross 是国家层面的合计，分不出这一笔是跟谁做的。
   * 这里用「该国与同阵营伙伴的贸易量」占「该国全部贸易量」的比重，
   * 而伙伴层面的贸易量用 pop 权重的可达性份额近似 —— 也就是模型自己用的那套权重。
   * 刻意不去反推流量（那需要改 sim 记更多账），因为这里要的是**结构性信号**，
   * 不是会计精度。 */
  var blocOf = w.map.blocOf;
  var sameW = 0, allW = 0;
  for (var a = 0; a < C; a++) {
    for (var b = 0; b < C; b++) {
      if (a === b) continue;
      var rel = SIM.relEff(w, a, b);
      var base = Math.exp(-w.dist[a * C + b] / w.tradeD0);
      var share = w.popTotal[b] * base;
      var flow = share * rel;
      allW += flow;
      if (blocOf[a] >= 0 && blocOf[a] === blocOf[b]) sameW += flow;
    }
  }
  var gdps = [], pcg = [];
  for (c = 0; c < C; c++) {
    gdps.push(w.gdp[c]);
    pcg.push(w.popTotal[c] > 0 ? w.gdp[c] / w.popTotal[c] : 0);
  }
  gdps.sort(function (x, y) { return y - x; });
  pcg.sort(function (x, y) { return y - x; });
  var sumGdp = gdps.reduce(function (s, v) { return s + v; }, 0);
  return {
    trade: tot,
    worldGdp: sumGdp,
    pop: pop,
    sameShare: allW > 0 ? sameW / allW : 0,
    div: structureDivergence(w),
    /* 人均 GDP 极差：最强的与最弱的差几倍 —— 「贸易在制造赢家还是拉平」 */
    pcTop: pcg[0] / (pcg[pcg.length - 1] || 1e-9),
    /* 头部集中度：第一大国占世界 GDP 的比重 —— 排名是否被重排 */
    lead: sumGdp > 0 ? gdps[0] / sumGdp : 0,
    gdpRank: gdps
  };
}

function pct(x) { return (x * 100).toFixed(2) + '%'; }
function fixed(x, n) { return x.toFixed(n === undefined ? 4 : n); }

console.log('══════ 阵营关系标定台（bloc-probe）══════');
console.log('真实 1945，' + TICKS + ' tick，seed ' + SEED + '，29 国 / 199 省\n');

/* ═══════ 扫描 1：西 ↔ 东 的关系 ═══════ */
console.log('【1】扫描 WEST ↔ EAST 的关系（WEST↔NEU 固定 0.90，EAST↔NEU 固定 0.75）');
console.log('    取 1.00 = 没有铁幕。看的是「关系从 1 降下来，世界被改了多少」\n');
console.log('    关系    世界贸易     阵营内份额   结构分化   人均极差   头号国占比');

var SWEEP = [1.00, 0.85, 0.65, 0.45, 0.25, 0.10, 0.00];
var base = null, rows = [];
SWEEP.forEach(function (v) {
  var B = build(function (map) {
    var C = map.countries.length;
    var rel = map.relation0;
    /* ⚠ relation0 是**国家×国家**的矩阵，不是阵营×阵营的。
     * 第一版这里写成 rel[0*C+1] = v，只改了 USA↔SUN 一对，
     * 于是量出来「铁幕对世界毫无影响」—— 量的是自己写错的下标。
     * 阵营级的改动必须落到**每一对国家**上。 */
    for (var a = 0; a < C; a++) {
      for (var b = 0; b < C; b++) {
        if (map.blocOf[a] === 0 && map.blocOf[b] === 1) {
          rel[a * C + b] = v; rel[b * C + a] = v;
        }
      }
    }

  });
  run(B.w, TICKS);
  var m = measure(B.w);
  m.rel = v;
  rows.push(m);
  if (base === null) base = m;
  console.log('    ' + fixed(v, 2).padStart(4) + '   ' +
    m.trade.toFixed(0).padStart(9) + '   ' + pct(m.sameShare).padStart(9) + '   ' +
    fixed(m.div, 4).padStart(8) + '   ' + fixed(m.pcTop, 2).padStart(7) + '   ' +
    pct(m.lead).padStart(9));
});

console.log('\n    相对「没有铁幕」的变化：');
console.log('    关系    Δ贸易       Δ阵营内份额   Δ结构分化   Δ人均极差   Δ头号国占比');
rows.forEach(function (m) {
  var dt = m.trade / base.trade - 1;
  var ds = m.sameShare / base.sameShare - 1;
  var dv = m.div / base.div - 1;
  var dp = m.pcTop / base.pcTop - 1;
  var dl = m.lead / base.lead - 1;
  console.log('    ' + fixed(m.rel, 2).padStart(4) + '  ' +
    (dt * 100).toFixed(2).padStart(7) + 'pp  ' +
    (ds * 100).toFixed(2).padStart(9) + 'pp  ' +
    (dv * 100).toFixed(2).padStart(8) + 'pp  ' +
    (dp * 100).toFixed(2).padStart(8) + 'pp  ' +
    (dl * 100).toFixed(2).padStart(9) + 'pp');
});

/* ═══════ 扫描 2：单国被全面禁运 ═══════ */
console.log('\n\n【2】单国被全面禁运（该国对全世界的关系置 0）—— 谁最痛');
var baseRun = build(null);
run(baseRun.w, TICKS);
var B0 = measure(baseRun.w);
console.log('    基准：世界贸易 ' + B0.trade.toFixed(0) + '，世界 GDP ' + B0.worldGdp.toFixed(0) + '\n');
console.log('    tag   该国GDP变化   该国贸易变化   世界贸易变化   排名变化');

var hurts = [];
for (var c = 0; c < baseRun.w.C; c++) {
  var B = build(function (map) {
    var C = map.countries.length;
    for (var o = 0; o < C; o++) {
      if (o === c) continue;
      map.relation0[c * C + o] = 0;
      map.relation0[o * C + c] = 0;
    }
  });
  run(B.w, TICKS);
  var m = measure(B.w);
  var rankBase = B0.gdpRank.indexOf(baseRun.w.gdp[c]);
  hurts.push({
    c: c, tag: B.map.countries[c].tag,
    dGdp: baseRun.w.gdp[c] > 0 ? B.w.gdp[c] / baseRun.w.gdp[c] - 1 : 0,
    dTrade: baseRun.w.tradeGross[c] > 0 ? B.w.tradeGross[c] / baseRun.w.tradeGross[c] - 1 : -1,
    dWorld: m.trade / B0.trade - 1,
    rank: rankBase
  });
}
hurts.sort(function (a, b) { return a.dGdp - b.dGdp; });
hurts.slice(0, 6).concat(hurts.slice(-3)).forEach(function (h) {
  console.log('    ' + h.tag.padEnd(5) + '  ' +
    (h.dGdp * 100).toFixed(2).padStart(9) + '%  ' +
    (h.dTrade * 100).toFixed(1).padStart(11) + '%  ' +
    (h.dWorld * 100).toFixed(3).padStart(11) + '%' +
    '   (基准第 ' + (h.rank + 1) + ' 位)');
});
var worst = hurts[0], best = hurts[hurts.length - 1];
console.log('\n    最痛 ' + worst.tag + ' ' + (worst.dGdp * 100).toFixed(2) + '%' +
  '　最不受影响（甚至受益）' + best.tag + ' ' + (best.dGdp * 100).toFixed(2) + '%');

/* ═══════ 扫描 3：阵营结构是「重排格局」还是「等比缩水」？ ═══════
 * 这一节是本台最该看的。上表的 人均极差 / 头号国占比 都是**总量指标** ——
 * 它们对「A 赚的正好是 B 亏的」这种重排完全不敏感（互相抵消）。
 * 所以必须逐国比：如果每国的变化都朝同一个方向、幅度也差不多，
 * 那阵营就只是一根「把世界变小」的旋钮，玩家没有理由关心它。 */
console.log('\n\n【3】铁幕是「重排格局」还是「等比缩水」？');
var noCurtain = build(function (map) {
  var C = map.countries.length;
  for (var a = 0; a < C; a++) for (var b = 0; b < C; b++) {
    if (map.blocOf[a] === 0 && map.blocOf[b] === 1) { map.relation0[a * C + b] = 1; map.relation0[b * C + a] = 1; }
  }
});
run(noCurtain.w, TICKS);
var fullCurtain = build(function (map) {
  var C = map.countries.length;
  for (var a = 0; a < C; a++) for (var b = 0; b < C; b++) {
    if (map.blocOf[a] === 0 && map.blocOf[b] === 1) { map.relation0[a * C + b] = 0; map.relation0[b * C + a] = 0; }
  }
});
run(fullCurtain.w, TICKS);

var ratios = [];
for (var ci = 0; ci < noCurtain.w.C; ci++) {
  ratios.push({
    tag: noCurtain.w.map.countries[ci].tag,
    bloc: noCurtain.w.map.blocIds[noCurtain.w.map.blocOf[ci]].name,
    r: noCurtain.w.gdp[ci] > 0 ? fullCurtain.w.gdp[ci] / noCurtain.w.gdp[ci] - 1 : 0
  });
}
ratios.sort(function (x, y) { return x.r - y.r; });
function rq(p) {
  var a = ratios.map(function (z) { return z.r; }).sort(function (x, y) { return x - y; });
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}
console.log('    逐国 GDP 变化  最惨 ' + (rq(0) * 100).toFixed(2) + '%  p25 ' + (rq(0.25) * 100).toFixed(2) +
  '%  中位 ' + (rq(0.5) * 100).toFixed(2) + '%  p75 ' + (rq(0.75) * 100).toFixed(2) +
  '%  最好 ' + (rq(0.999) * 100).toFixed(2) + '%');
var pos = ratios.filter(function (z) { return z.r > 0.005; }).length;
var neg = ratios.filter(function (z) { return z.r < -0.005; }).length;
console.log('    受益国 ' + pos + ' / 受损国 ' + neg + ' / 几乎不动 ' +
  (ratios.length - pos - neg) + '（阈值 ±0.5%）');
console.log('    最惨三国 ' + ratios.slice(0, 3).map(function (z) { return z.tag + ' ' + (z.r * 100).toFixed(1) + '%'; }).join('　'));
console.log('    最好三国 ' + ratios.slice(-3).reverse().map(function (z) { return z.tag + ' +' + (z.r * 100).toFixed(1) + '%'; }).join('　'));

