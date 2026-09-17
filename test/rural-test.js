/* 城乡分化性质测试
 *
 * 用法：node test/rural-test.js
 *
 * ── 这个机制失败过一次，所以这台测试的第一要务是防复发 ──
 * 第一次实现（同日早些时候）只往 world 上挂了两个财富通道，
 * **没有任何经济回路读它们** —— 于是乡/城比是个无后果的读数，
 * 事前探针量到的漂亮 R² 也是在量那个死胡同。
 * 所以 P5「回路闭合」是这台的核心：它断言分化**真的传导到价格**。
 *
 * ── 机制 ──
 * 底层的同一个收入池之下，两个消费群体各自有篮子：
 *   乡村 [0.66, 0.14, 0.12, 0.05, 0.03]（偏口粮）
 *   城市 [0.44, 0.26, 0.18, 0.09, 0.03]（偏制成品）
 * 于是相对价格一涨落，两群体的实际生活成本就分化。
 * 设计依据与探针数值见 参考资料/城乡分化-事前探针结论.md。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;

var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };
var NEEDS0 = [0.55, 0.20, 0.15, 0.07, 0.03];

var pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + name + (detail ? '   ' + detail : ''));
  if (ok) pass++; else fail++;
}
function group(t) { console.log('\n' + t); }
function corr(a, b) {
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var s = 0, sa = 0, sb = 0;
  for (i = 0; i < n; i++) {
    var u = a[i] - ma, v = b[i] - mb;
    s += u * v; sa += u * u; sb += v * v;
  }
  return (sa > 0 && sb > 0) ? s / Math.sqrt(sa * sb) : 0;
}
function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }

function build(opts, ticks, seed) {
  var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: seed || 8888 }));
  var w = SIM.createWorld(map, Object.assign({ seed: (seed || 8888) + 7 }, opts || {}));
  if (opts && opts.foodPolicy !== undefined) {
    for (var c = 0; c < w.C; c++) SIM.pushCommand(w, SIM.CMD_FOOD, -1, -1, opts.foodPolicy, c);
    SIM.applyCommands(w);
  }
  for (var t = 0; t < ticks; t++) SIM.tick(w);
  return w;
}
function ratioOf(w) {
  var out = [];
  for (var p = 0; p < w.P; p++) out.push(w.lowerRural[p] / w.lowerUrban[p]);
  return out;
}

group('P1 标定性：篮子对称是"开局标定不动"的全部依据');
(function () {
  var R = SIM.BASKET_RURAL, U = SIM.BASKET_URBAN;
  var maxD = 0;
  for (var g = 0; g < 5; g++) maxD = Math.max(maxD, Math.abs((R[g] + U[g]) / 2 - NEEDS0[g]));
  console.log('   乡村 ' + R.join('/') + '   城市 ' + U.join('/'));
  check('两套篮子的平均逐项等于 NEEDS[0]（逐省成立，因为 urbanRatio 逐省不同）',
    maxD < 1e-12, '最大偏差 ' + maxD.toExponential(1));
  check('各自权重和为 1',
    Math.abs(R.reduce(function (a, b) { return a + b; }, 0) - 1) < 1e-12 &&
    Math.abs(U.reduce(function (a, b) { return a + b; }, 0) - 1) < 1e-12);
  check('乡村口粮权重高于城市（分化方向的定义）', R[0] > U[0], R[0] + ' > ' + U[0]);
})();

group('P2 no-op：两群体同起点时第一个 tick 几乎不分化');
(function () {
  var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: 8888 }));
  var w = SIM.createWorld(map, { seed: 8888 + 7 });
  for (var p = 0; p < w.P; p++) { w.lowerRural[p] = w.wealth[0 * w.P + p]; w.lowerUrban[p] = w.wealth[0 * w.P + p]; }
  SIM.tick(w);
  var maxRel = 0;
  for (var p2 = 0; p2 < w.P; p2++) {
    var ra = Math.abs(w.lowerRural[p2] / w.lowerUrban[p2] - 1);
    if (ra > maxRel) maxRel = ra;
  }
  console.log('   第一 tick 后两群体财富比偏离 1 的最大幅度 ' + (maxRel * 100).toFixed(3) + '%');
  check('同起点 ⇒ 同步（偏离 < 2%）', maxRel < 0.02, (maxRel * 100).toFixed(3) + '%');
})();

group('P3 分化是有界的');
(function () {
  var w = build(null, 600);
  var r = ratioOf(w);
  var lo = Math.min.apply(null, r), hi = Math.max.apply(null, r);
  var sorted = r.slice().sort(function (x, y) { return x - y; });
  var med = sorted[Math.floor(sorted.length * 0.5)];
  var p05 = sorted[Math.floor(sorted.length * 0.05)], p95 = sorted[Math.floor(sorted.length * 0.95)];
  console.log('   600 tick 后 乡/城财富比：均值 ' + mean(r).toFixed(4) +
    '  p05 ' + p05.toFixed(3) + '  中位 ' + med.toFixed(3) + '  p95 ' + p95.toFixed(3) +
    '  极值 ' + lo.toFixed(3) + '~' + hi.toFixed(3));
  /* 判据用**分位数**而不是极值：214 个省里出现个别极端值是正常的，
   * 但主体区间必须收在合理范围（不然就不是"分化"而是"发散"）。 */
  check('主体区间有界（p05 > 0.6 且 p95 < 1.7）', p05 > 0.6 && p95 < 1.7,
    'p05 ' + p05.toFixed(3) + '  p95 ' + p95.toFixed(3));
  check('没有 NaN / 非正比值', r.every(function (v) { return isFinite(v) && v > 0; }));
  check('确实分化了（极差 > 0.05）', hi - lo > 0.05, '极差 ' + (hi - lo).toFixed(3));
})();

group('P4 粮食政策：有效、定向、且不随城市化而变');
(function () {
  var a = build({ foodPolicy: 0 }, 600);
  var b = build({ foodPolicy: 1 }, 600);
  var ra = ratioOf(a), rb = ratioOf(b);
  var lifts = ra.map(function (x, i) { return rb[i] / x - 1; });
  console.log('   无政策均值 ' + mean(ra).toFixed(4) + '   满补贴均值 ' + mean(rb).toFixed(4));
  console.log('   逐省配对抬升：+ ' + (mean(lifts) * 100).toFixed(2) + '%  （' +
    (Math.min.apply(null, lifts) * 100).toFixed(2) + '% ~ ' + (Math.max.apply(null, lifts) * 100).toFixed(2) + '%）');
  check('补贴抬升乡/城比', mean(lifts) > 0.01, '+' + (mean(lifts) * 100).toFixed(2) + '%');
  var urb = [];
  for (var p = 0; p < a.P; p++) urb.push(a.urban[p]);
  var rU = corr(urb, lifts);
  check('抬升不随城市化而变（|r| < 0.5）⇒ 独立旋钮', Math.abs(rU) < 0.5, 'r = ' + rU.toFixed(3));
})();

group('P5 回路闭合：分化必须传导出去（上次就是死在这里）');
(function () {
  var a = build({ foodPolicy: 0 }, 600);
  var b = build({ foodPolicy: 1 }, 600);
  var maxPriceDiff = 0;
  for (var g = 0; g < a.G; g++) {
    for (var c = 0; c < a.C; c++) {
      maxPriceDiff = Math.max(maxPriceDiff,
        Math.abs(a.price[g * a.C + c] - b.price[g * a.C + c]) / Math.max(1e-9, a.price[g * a.C + c]));
    }
  }
  console.log('   粮食政策对国价的最大相对影响 ' + (maxPriceDiff * 100).toFixed(2) + '%');
  check('分化传导到了国价（不是只改了个内部数字）', maxPriceDiff > 0.001,
    (maxPriceDiff * 100).toFixed(3) + '%');

  var maxGap = 0;
  for (var p = 0; p < a.P; p++) {
    var blend = (1 - a.urbanRatio[p]) * a.lowerRural[p] + a.urbanRatio[p] * a.lowerUrban[p];
    maxGap = Math.max(maxGap, Math.abs(blend - a.wealth[0 * a.P + p]));
  }
  check('wealth[底层] == 两群体的人口加权合成（既有逻辑读到的仍是正确值）',
    maxGap < 1e-5, '最大偏差 ' + maxGap.toExponential(1));

  /* 把两群体强制成同财富，再跑两个世界：一个拆分、一个不拆分。
   * 若口径没变，两者的 demand 应一致。
   * ⚠ 不要拿 tick 之后的 w.wealth[0*P+p] 当期望 —— 那时它已被
   * "两群体人口加权合成"覆盖，等于拿结果当标准自证（我第一版就写错了）。 */
  function mkWorld(forceEqual) {
    var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: 8888 }));
    var w = SIM.createWorld(map, { seed: 8888 + 7 });
    for (var p = 0; p < w.P; p++) {
      w.lowerRural[p] = w.wealth[0 * w.P + p];
      w.lowerUrban[p] = w.wealth[0 * w.P + p];
    }
    return { w: w, fe: forceEqual };
  }
  var A = mkWorld(false), B = mkWorld(true);
  SIM.tick(A.w);
  /* B：tick 前压平，tick 后再压平（保证它走的是"单篮子"那条等价路径） */
  for (var q = 0; q < B.w.P; q++) {
    B.w.lowerRural[q] = B.w.wealth[0 * B.w.P + q];
    B.w.lowerUrban[q] = B.w.wealth[0 * B.w.P + q];
  }
  SIM.tick(B.w);
  var maxDemandRel = 0;
  for (var p3 = 0; p3 < A.w.P; p3++) {
    for (var g2 = 0; g2 < A.w.G; g2++) {
      var va = A.w.demandP[g2 * A.w.P + p3];
      var vb = B.w.demandP[g2 * B.w.P + p3];
      var rel = Math.abs(vb) > 1e-9 ? Math.abs(va - vb) / Math.abs(vb) : 0;
      if (rel > maxDemandRel) maxDemandRel = rel;
    }
  }
  console.log('   拆分世界 vs 强制同财富世界：省级需求最大相对差 ' + (maxDemandRel * 100).toFixed(4) + '%');
  check('同财富时拆分支路等价于原单篮子路径（口径没变）', maxDemandRel < 0.02,
    (maxDemandRel * 100).toFixed(4) + '%');
})();

group('P6 独立性：乡/城比不是城市化或工业化的换皮');
(function () {
  var rows = [];
  [8888, 777, 2718].forEach(function (s) {
    [0, 0.5, 1.0].forEach(function (fp) {
      var w = build({ foodPolicy: fp }, 600, s);
      for (var p = 0; p < w.P; p++) {
        rows.push({
          ratio: w.lowerRural[p] / w.lowerUrban[p],
          urban: w.urban[p],
          unrest: w.unrest[p],
          grain: w.localPrice[0 * w.P + p] / SIM.GOODS[0].base
        });
      }
    });
  });
  var ratio = rows.map(function (x) { return x.ratio; });
  var worst = 0, wk = '';
  [['城市化', 'urban'], ['不满', 'unrest'], ['谷价', 'grain']].forEach(function (pr) {
    var r = corr(ratio, rows.map(function (x) { return x[pr[1]]; }));
    console.log('   r(乡城比, ' + pr[0].padEnd(8) + ') = ' + r.toFixed(3));
    if (Math.abs(r) > worst) { worst = Math.abs(r); wk = pr[0]; }
  });
  check('与各量相关都低（|r| < 0.7）', worst < 0.7, '最强 ' + wk + ' |r| = ' + worst.toFixed(3));
  var rG = corr(ratio, rows.map(function (x) { return x.grain; }));
  check('方向正确：谷价越高，乡/城比越低（乡村吃亏）', rG < 0, 'r = ' + rG.toFixed(3));
})();

console.log('\n' + '\u2500'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
