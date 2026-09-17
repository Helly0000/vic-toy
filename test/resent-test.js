/* 「永久后果」性质测试
 *
 * 用法：node test/resent-test.js
 *
 * ── 这台是怎么来的（重要，别删这段）──
 * 2026-09-11 曾实现一个"怨愤"（疤痕）机制，动机是修一个被设计文档点名三次的毛病：
 *   「不满是唯一有正反馈的量，但它是目标值模型 —— 冲击过去就干净地衰减回 0，
 *     地图上留不下东西」（vic-toy-好玩化设计.md 实验 2 / 3）
 *
 * 实测把这个动机推翻了。**现有模型早就有永久后果**（resentShare 全关时）：
 *
 *   t=0     均不满 0.2494  p50 0.241  p90 0.322  max 0.364   >0.30: 51/214
 *   t=60    均不满 0.0950  p50 0.000  p90 0.451  max 0.800   >0.30: 26/214
 *   t=1200  均不满 0.1038  p50 0.000  p90 0.800  max 0.800   >0.30: 27/214
 *
 * p50 = 0.000（一半省份确实干净归零）但 p90 在 t=60 之后就**钉死在 0.800** ——
 * 约 26 个省永久停在革命上限。文档里"不满自愈回 0.057"的观察在当前代码下不成立。
 * 于是那个机制被**撤销**（在重新实现一个已经存在的东西）。
 *
 * 这台因此改名换姓：它不再测"怨愤"，它守**「模型必须有永久后果」这条性质**。
 * 撤销机制时它曾被用来证明"新机制没有可测效果"（P1 报 +0.4%，等于零）；
 * 现在它守护既有的那层后果，任何人把地板改回纯自愈，它都会红。
 *
 * ⚠ 若将来有人要重做"永久后果"，先跑这台：P1/P2 已经绿了，
 * 说明空间已被现有地板占满，**不必再叠一层**。
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
var MAX_UNREST = 0.80;      // sim 里封死的上限（"唯一正反馈，上限必须封死"）

var pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + name + (detail ? '   ' + detail : ''));
  if (ok) pass++; else fail++;
}
function group(t) { console.log('\n' + t); }

var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: SEED }));
function mk(o) { return SIM.createWorld(map, Object.assign({ seed: SEED + 7 }, o || {})); }
function run(w, n) { for (var i = 0; i < n; i++) SIM.tick(w); }

function unrestStats(w) {
  var P = w.P, q = [], sum = 0, max = 0, over30 = 0, over60 = 0;
  for (var p = 0; p < P; p++) {
    var u = w.unrest[p];
    q.push(u); sum += u;
    if (u > max) max = u;
    if (u > 0.30) over30++;
    if (u > 0.60) over60++;
  }
  q.sort(function (a, b) { return a - b; });
  return {
    mean: sum / P, p50: q[Math.floor(P * 0.5)], p90: q[Math.floor(P * 0.9)],
    max: max, over30: over30, over60: over60, P: P
  };
}
function show(label, s) {
  console.log('   ' + label.padEnd(12) + '均 ' + s.mean.toFixed(4) +
    '  p50 ' + s.p50.toFixed(3) + '  p90 ' + s.p90.toFixed(3) +
    '  max ' + s.max.toFixed(3) +
    '   >0.30: ' + String(s.over30).padStart(3) + '/' + s.P +
    '   >0.60: ' + String(s.over60).padStart(3));
}

group('P1 永久性：受重创之后，不满在 200 tick 后没有回到基线');
(function () {
  var w = mk({});
  run(w, 120);
  var before = unrestStats(w);

  /* 走真实 famine 通道：摧毁 35% 农场等级 + 当月产出乘数 0.55
   * （与 sim 的 FAMINE_DESTROY / FAMINE_SHOCK 同参数） */
  var P = w.P, c0 = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== c0) continue;
    var lv = w.level[0 * P + p];
    if (lv > 1) w.level[0 * P + p] = Math.max(1, Math.round(lv * 0.65));
  }
  w.harvestShock[c0] = 0.55;

  run(w, 200);
  var after = unrestStats(w);
  show('冲击前', before);
  show('+200 tick', after);

  /* 永久性的判据：重创之后仍有一批省停在远高于基线的高位。
   * 这不是"均值抬高"（均值会回归），而是**分布的右尾没有塌回来**。 */
  check('重创后仍有省份停在革命上限附近（p90 ≥ 0.30）', after.p90 >= 0.30,
    'p90 = ' + after.p90.toFixed(3));
  check('≥ 20 个省处于 0.30 以上的持续不满', after.over30 >= 20,
    after.over30 + ' / ' + after.P);

  /* 同时：它必须是**局部的**，不是把所有省都拖下水 */
  check('不满是局部的而非全局（p50 仍接近 0）', after.p50 < 0.10,
    'p50 = ' + after.p50.toFixed(3));
  check('均值没有被永久抬高（回归到基线附近）', after.mean < before.mean * 1.5,
    after.mean.toFixed(4) + ' vs ' + before.mean.toFixed(4));
})();

group('P2 上限封死：唯一正反馈量不许冲破天花板');
(function () {
  var w = mk({});
  run(w, 300);
  /* 人为把所有省推到天花板之上，看下一 tick 会不会被夹回来 */
  for (var p = 0; p < w.P; p++) w.unrest[p] = 2.0;
  run(w, 1);
  var s = unrestStats(w);
  check('任何省的不满都不超过上限 ' + MAX_UNREST, s.max <= MAX_UNREST + 1e-6,
    'max = ' + s.max.toFixed(4));
})();

group('P3 长期稳定：1200 tick（一局）后不至于全线爆表');
(function () {
  var w = mk({});
  run(w, 1200);
  var s = unrestStats(w);
  show('t=1200', s);
  check('不是所有省都在革命（>0.60 的省 < 40%）', s.over60 < s.P * 0.40,
    s.over60 + ' / ' + s.P);
  check('地图仍有区分度（p50 与 p90 拉开了距离）', s.p90 - s.p50 > 0.30,
    'p90-p50 = ' + (s.p90 - s.p50).toFixed(3));
})();

console.log('\n' + '\u2500'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
