/* 识字率性质测试（含准入判据）
 *
 * 用法：node test/lit-test.js
 *
 * ── 它是唯一通过准入闸门的候选驱动 ──
 * 事前探针（已删）量到一件决定性的事：
 *   教育政策**全同**时  r(识字率, 城市化) = 1.000、R² = 1.000
 *   ——识字率 100% 只是城市化的影子，一根轴都加不了。
 * 所以识字率的独立性**不是天生的**，它来自"政策是外生的、城市化是内生的"。
 * test/ideo-dof.js 的采样因此必须把教育政策撒开，否则量到的是一个退化变量。
 *
 * 准入结果（ideo-dof，1800 样本）：
 *   R²(识字率 | 其余八驱动) = 0.564   < 0.90  ✓ 不冗余
 *   边际参与比 2.09 → 2.44 / 5        ✓ 真的抬高有效维数
 *   对照：基建/连通度 R² ≈ 0.98      ✗ 被闸门挡下
 *
 * 这台守四件事：独立性、慢（一代人的时间尺度）、单调、以及"它真的影响经济"。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;

var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };
var SEEDS = [8888, 777, 2718];

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

/* 建一局并把教育政策按国错开，返回逐国的 (识字率, 城市化, 工业占比, 底层/均值) */
function runEdu(seed, ticks, poliFor) {
  var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: seed }));
  var w = SIM.createWorld(map, { seed: seed + 7 });
  for (var c = 0; c < w.C; c++) {
    SIM.pushCommand(w, SIM.CMD_EDU, -1, -1, poliFor(c), c);
  }
  SIM.applyCommands(w);
  for (var t = 0; t < ticks; t++) SIM.tick(w);

  var P = w.P, rows = [];
  for (var c2 = 0; c2 < w.C; c2++) {
    var pop = 0, lit = 0, urb = 0, indLv = 0, allLv = 0, lw = 0, allW = 0;
    for (var p = 0; p < P; p++) {
      if (w.map.provinces[p].country !== c2) continue;
      var pw = w.pop[0 * P + p];
      pop += pw; lit += w.literacy[p] * pw; urb += w.urban[p] * pw;
      lw += w.wealth[0 * P + p] * pw;
      for (var s = 0; s < w.S; s++) allW += w.wealth[s * P + p] * w.pop[s * P + p];
      for (var g = 0; g < w.G; g++) {
        var lv = w.level[g * P + p];
        allLv += lv;
        if (g === 3 || g === 4) indLv += lv;
      }
    }
    rows.push({
      lit: pop > 0 ? lit / pop : 0,
      urban: pop > 0 ? urb / pop : 0,
      ind: allLv > 0 ? indLv / allLv : 0,
      low: (allW > 0) ? (lw / pop) / (allW / pop) : 1
    });
  }
  return { w: w, rows: rows };
}

group('P1 独立性（准入判据）：识字率不许是城市化的影子');
(function () {
  var all = [];
  SEEDS.forEach(function (seed) {
    var r = runEdu(seed, 600, function (c) { return (c % 5) / 4; });
    r.rows.forEach(function (x) { all.push(x); });
  });
  var rU = corr(all.map(function (x) { return x.lit; }), all.map(function (x) { return x.urban; }));
  var rI = corr(all.map(function (x) { return x.lit; }), all.map(function (x) { return x.ind; }));
  var rL = corr(all.map(function (x) { return x.lit; }), all.map(function (x) { return x.low; }));
  console.log('   政策错开（按国 0/.25/.5/.75/1）：r(识字率, 城市化) = ' + rU.toFixed(3) +
    '   r(工业占比) = ' + rI.toFixed(3) + '   r(底层/均值) = ' + rL.toFixed(3));
  check('r(识字率, 城市化) < 0.7', Math.abs(rU) < 0.7, rU.toFixed(3));
  check('r(识字率, 工业占比) < 0.7', Math.abs(rI) < 0.7, rI.toFixed(3));
  check('r(识字率, 底层/均值) < 0.7', Math.abs(rL) < 0.7, rL.toFixed(3));

  /* 反面：政策全同时它**应该**退化 —— 这不是 bug，是机制的定义，
   * 写下来是为了让后人知道"独立性来自政策，不是来自机制本身"。 */
  var same = [];
  SEEDS.forEach(function (seed) {
    var r = runEdu(seed, 600, function () { return 0.5; });
    r.rows.forEach(function (x) { same.push(x); });
  });
  var rSame = corr(same.map(function (x) { return x.lit; }), same.map(function (x) { return x.urban; }));
  console.log('   政策全同（都 0.5）：      r(识字率, 城市化) = ' + rSame.toFixed(3));
  check('政策全同时它会退化成城市化的函数（记录该性质，非缺陷）',
    Math.abs(rSame) > 0.9, rSame.toFixed(3));
})();

group('P2 慢：一代人的时间尺度，一局跑不到顶');
(function () {
  var profile = [];
  [0, 100, 300, 600, 1200].forEach(function (T) {
    var r = runEdu(8888, T || 1, function () { return 1.0; });
    var P = r.w.P, s = 0;
    for (var p = 0; p < P; p++) s += r.w.literacy[p];
    profile.push(s / P);
  });
  console.log('   全力办教育：t=0/' + profile[0].toFixed(3) +
    '  100/' + profile[1].toFixed(3) + '  300/' + profile[2].toFixed(3) +
    '  600/' + profile[3].toFixed(3) + '  1200/' + profile[4].toFixed(3));
  check('在爬升（不是常数）', profile[4] > profile[0] * 1.5,
    profile[0].toFixed(3) + ' → ' + profile[4].toFixed(3));
  check('一局（1200 tick）跑不到顶 —— 教育是长线投资', profile[4] < 0.6,
    't=1200 时 ' + profile[4].toFixed(3));
  check('但也不是纹丝不动（100 年内可见变化）', profile[4] - profile[0] > 0.15,
    '+' + (profile[4] - profile[0]).toFixed(3));
})();

group('P3 单调：教育投入越高，识字率越高');
(function () {
  var out = [];
  [0, 0.25, 0.5, 0.75, 1.0].forEach(function (p) {
    var r = runEdu(8888, 600, function () { return p; });
    var P = r.w.P, s = 0;
    for (var i = 0; i < P; i++) s += r.w.literacy[i];
    out.push(s / P);
  });
  console.log('   政策 0/.25/.5/.75/1  →  识字率 ' + out.map(function (v) { return v.toFixed(3); }).join(' / '));
  var mono = true;
  for (var i = 1; i < out.length; i++) if (out[i] < out[i - 1] - 1e-9) mono = false;
  check('单调递增', mono, out.map(function (v) { return v.toFixed(3); }).join(' → '));
  check('不办教育也有地板（不是 0）', out[0] > 0.05, out[0].toFixed(3));
})();

group('P4 它真的影响经济（不是个只读的装饰量）');
(function () {
  var lo = runEdu(8888, 1200, function () { return 0; });
  var hi = runEdu(8888, 1200, function () { return 1; });
  var gLo = 0, gHi = 0;
  for (var c = 0; c < lo.w.C; c++) { gLo += lo.w.gdp[c]; gHi += hi.w.gdp[c]; }
  console.log('   全国 GDP：不办教育 ' + (gLo / 1e6).toFixed(3) + 'M   全力办教育 ' + (gHi / 1e6).toFixed(3) + 'M');
  check('识字率带来可测的产出回报', gHi > gLo * 1.02,
    '+' + ((gHi / gLo - 1) * 100).toFixed(1) + '%');
})();

console.log('\n' + '\u2500'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
