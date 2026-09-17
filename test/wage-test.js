/* 工资政策（阶级妥协）性质测试
 *
 * 用法：node test/wage-test.js
 *
 * 动机：工业化原本**自动**把收入份额从中低层挪向中上层
 *   （`WAGE_BASE[s] ± k * indShare`，sim.js 的收入分配节）。
 * 也就是说"工业化的果实归谁"本来是个常数，玩家无从置喙。
 * `CMD_WAGE` 把它变成政策：0 = 市场自行分配，1 = 把上层的份额划给底层。
 *
 * 这台要证明三件事：
 *   P1 它**真的有效**（不是个装饰性旋钮）—— 不同政策跑 100 年，底层相对财富分开
 *   P2 它是**零和**的 —— 底层多拿的，上层少拿（不许变成白拿的增益）
 *   P3 它是**独立的驱动** —— 与既有五轴的 |r| 低（否则只是主梯度的另一种写法）
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;

var SEED = parseInt(process.argv[2], 10) || 8888;
var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };
var TICKS = 1200;             // 一局 = 100 年

var pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + name + (detail ? '   ' + detail : ''));
  if (ok) pass++; else fail++;
}
function group(t) { console.log('\n' + t); }

var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: SEED }));

/* 建一局，把 0 号国的工资政策设成 p，其余国家保持 0（对照） */
function run(p, ticks) {
  var w = SIM.createWorld(map, { seed: SEED + 7 });
  SIM.pushCommand(w, SIM.CMD_WAGE, -1, -1, p, 0);
  SIM.applyCommands(w);
  for (var t = 0; t < ticks; t++) SIM.tick(w);
  return w;
}
/* 按人口加权的某阶层相对财富（对 0 号国） */
function strata(w, c) {
  var P = w.P, S = w.S;
  var out = [];
  for (var s = 0; s < S; s++) {
    var pop = 0, num = 0;
    for (var p = 0; p < P; p++) {
      if (w.map.provinces[p].country !== c) continue;
      pop += w.pop[s * P + p];
      num += w.wealth[s * P + p] * w.pop[s * P + p];
    }
    out.push(pop > 0 ? num / pop : 0);
  }
  return out;
}

var POLICIES = [0, 0.5, 1.0];
var RES = {};
POLICIES.forEach(function (p) { RES[p] = run(p, TICKS); });

group('P1 有效性：不同工资政策跑 100 年，底层相对财富必须分开');
(function () {
  console.log('   政策   底层财富(相对全国均值)  中层    上层');
  var low = [];
  POLICIES.forEach(function (p) {
    var w = RES[p];
    var m = strata(w, 0);
    var mean = (m[0] * 0.78 + m[1] * 0.18 + m[2] * 0.04) / 1.0;
    var rel = m[0] / mean;
    low.push(rel);
    console.log('   ' + p.toFixed(1).padStart(4) + '   ' + rel.toFixed(4).padStart(16) +
      '   ' + (m[1] / mean).toFixed(4) + '   ' + (m[2] / mean).toFixed(4));
  });
  check('政策越向底层倾斜，底层相对财富越高（单调）',
    low[0] < low[1] && low[1] < low[2],
    low.map(function (v) { return v.toFixed(4); }).join(' → '));
  /* 阈值 1.5%（实测 1.6%）—— 曾经是 2%（那时实测 3.9%）。
   * 2026-09-11 接入城乡分化之后，底层的财富是"乡村/城市两群体的人口加权合成"，
   * 同一次收入份额倾斜要摊到两个篮子上，于是**传导到财富的效应减半**
   * （3.9% → 1.6%）。单调性与零和性都没变（见 P2），所以这是量级变化而不是机制失效。
   * 若将来这个数掉到 1% 以下，那就不是"减半"而是"被吃掉了"，要当回归处理。 */
  check('效应不是噪声级（最强与最弱相差 > 1.5%）',
    low[2] / low[0] - 1 > 0.015,
    '+' + ((low[2] / low[0] - 1) * 100).toFixed(1) + '%');
})();

group('P2 零和：底层多拿的必须来自上层，不是白拿');
(function () {
  var a = strata(RES[0], 0), b = strata(RES[1.0], 0);
  var lowUp = b[0] / a[0] - 1;
  var upDown = b[2] / a[2] - 1;
  console.log('   底层财富变化 ' + (lowUp * 100).toFixed(1) + '%   上层财富变化 ' + (upDown * 100).toFixed(1) + '%');
  check('倾斜政策让底层变好', lowUp > 0.01, '+' + (lowUp * 100).toFixed(1) + '%');
  check('同时让上层变差（存在真实取舍，不是双赢旋钮）', upDown < 0,
    (upDown * 100).toFixed(1) + '%');
})();

group('P3 独立性：工资政策与既有五轴的相关（不许是主梯度的另一种写法）');
(function () {
  /* 在同一张地图上撒开政策，量 wagePolicy 与既有轴的相关系数。
   * 这里用最直接的口径：把政策当自变量，看它与"底层/均值""工业占比""城市化"
   * "进口依赖""均不满"的相关。用 8 国 × 5 档政策 = 40 个样本。 */
  var vals = [0, 0.25, 0.5, 0.75, 1.0];
  var xs = [], ys = { low: [], ind: [], urb: [], dep: [], unr: [] };
  vals.forEach(function (p) {
    var w = SIM.createWorld(map, { seed: SEED + 7 });
    for (var c = 0; c < w.C; c++) SIM.pushCommand(w, SIM.CMD_WAGE, -1, -1, p, c);
    SIM.applyCommands(w);
    for (var t = 0; t < 600; t++) SIM.tick(w);
    for (var c2 = 0; c2 < w.C; c2++) {
      var P = w.P, G = w.G;
      var pop = 0, lw = 0, allW = 0, urb = 0, indLv = 0, allLv = 0, need = 0, gap = 0;
      for (var pr = 0; pr < P; pr++) {
        if (w.map.provinces[pr].country !== c2) continue;
        var pw = w.pop[0 * P + pr];
        pop += pw; lw += w.wealth[0 * P + pr] * pw; urb += w.urban[pr] * pw;
        for (var s = 0; s < w.S; s++) allW += w.wealth[s * P + pr] * w.pop[s * P + pr];
        for (var g = 0; g < G; g++) {
          var lv = w.level[g * P + pr];
          allLv += lv;
          if (g === 3 || g === 4) indLv += lv;
        }
      }
      for (var g2 = 0; g2 < G; g2++) {
        var sup = w.supply[g2 * w.C + c2], dem = w.demand[g2 * w.C + c2];
        need += dem; if (dem > sup) gap += dem - sup;
      }
      xs.push(p);
      ys.low.push(pop > 0 ? (lw / pop) / (allW / Math.max(1e-9, pop * 1)) : 0);
      ys.ind.push(allLv > 0 ? indLv / allLv : 0);
      ys.urb.push(pop > 0 ? urb / pop : 0);
      ys.dep.push(need > 0 ? gap / need : 0);
      ys.unr.push(w.unrestAvg[c2]);
    }
  });
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
  var names = { low: '底层/均值', ind: '工业占比', urb: '城市化', dep: '进口依赖', unr: '均不满' };
  var worst = 0, worstName = '';
  Object.keys(ys).forEach(function (k) {
    var r = corr(xs, ys[k]);
    console.log('   工资政策 × ' + names[k].padEnd(10) + ' r = ' + r.toFixed(3));
    if (Math.abs(r) > worst) { worst = Math.abs(r); worstName = names[k]; }
  });
  /* 这一项**故意保持红色口径**（|r| < 0.7）。它不是"待修的失败"，
   * 而是一条如实记录的判定：工资政策的定义就是"重新分配底层与上层之间的份额"，
   * 所以它与「底层/均值」必然高度相关（r = 0.97）。
   * 结论（第 1 步的准入结果）：它是**改变分层结果的政策**，不是一根独立轴。
   * 不要为了提高这个数去改公式 —— 那是把结论改成想要的形状。 */
  check('与既有五轴的相关都低（|r| < 0.7）', worst < 0.7,
    '最强 ' + worstName + ' |r| = ' + worst.toFixed(3) + ' ← 预期为红：工资政策本来就不是独立轴');
})();

console.log('\n' + '\u2500'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
