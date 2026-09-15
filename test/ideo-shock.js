/* 判别实验：这个世界的意识形态到底有几个**独立**维度？
 *
 * 用法：node test/ideo-shock.js
 *
 * 背景：ideo-derive.js 把六根轴都做"活"了（方差正常），但六对轴仍然高相关。
 *   漂移轨迹显示：等级/来世/公有 全都沿着同一条工业化曲线在动。
 *
 * 问题：这种相关性是**公式的锅**，还是**这个世界本身就只有一个自由度的锅**？
 * 判别方法：给一个国家一次「量的冲击」（摧毁一半农场），看它的轴向量
 *   是**继续沿原轨迹走**（说明耦合是世界的性质），还是**拐向新方向**（说明公式耦合过紧）。
 *
 * 为什么用"量的冲击"：主项目已经证明过——价的冲击会被财富反馈自愈，量的冲击才留疤。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;

var AXES = ['①公有↔私有', '②个人↔集体', '③等级↔平等', '④体力↔脑力', '⑤现世↔来世', '⑥扩张↔内敛'];

function clamp01(v) { return !isFinite(v) ? 0 : (v < 0 ? 0 : (v > 1 ? 1 : v)); }

function derive(w, c) {
  var P = w.P, S = w.S, G = w.G;
  var prov = [];
  for (var p = 0; p < P; p++) if (w.map.provinces[p].country === c) prov.push(p);
  var strata = [], pop = 0, wealthNum = 0;
  for (var s = 0; s < S; s++) {
    var sp = 0, sw = 0;
    for (var k = 0; k < prov.length; k++) { var i1 = s * P + prov[k]; sp += w.pop[i1]; sw += w.wealth[i1] * w.pop[i1]; }
    strata.push({ pop: sp, wealthMean: sp > 0 ? sw / sp : 0 });
    pop += sp; wealthNum += sw;
  }
  var meanW = pop > 0 ? wealthNum / pop : 1;
  var indLv = 0, allLv = 0, urbanSum = 0, urbanPop = 0, unrestSum = 0;
  for (var k2 = 0; k2 < prov.length; k2++) {
    var pp = prov[k2];
    for (var g = 0; g < G; g++) { var lv = w.level[g * P + pp]; allLv += lv; if (g === 3 || g === 4) indLv += lv; }
    urbanSum += w.urban[pp] * w.pop[0 * P + pp]; urbanPop += w.pop[0 * P + pp];
    unrestSum += w.unrest[pp];
  }
  var needTotal = 0, gapTotal = 0;
  for (var g3 = 0; g3 < G; g3++) {
    var sup = w.supply[g3 * w.C + c], dem = w.demand[g3 * w.C + c];
    needTotal += dem; if (dem > sup) gapTotal += dem - sup;
  }
  var wealthRatio = meanW > 0 ? strata[0].wealthMean / meanW : 1;
  var gap = strata[0].wealthMean > 0 ? strata[2].wealthMean / strata[0].wealthMean : 1;
  var urban = urbanPop > 0 ? urbanSum / urbanPop : 0;
  return [
    clamp01(unrestSum / Math.max(1, prov.length) / 0.35),
    clamp01(1 - (wealthRatio - 0.85) / 0.3),
    clamp01(1 - (gap - 0.9) / 0.9),
    clamp01(urban / 1.1),
    clamp01((allLv > 0 ? indLv / allLv : 0) / 0.5),
    clamp01(1 - (needTotal > 0 ? gapTotal / needTotal : 0) / 0.5)
  ];
}

function run(seed, shockAt, shockTicks, total) {
  var map = MG.generate({ width: 1600, height: 1000, seed: seed, provinces: 260, countries: 8 });
  var w = SIM.createWorld(map, { seed: seed + 7 });
  var traj = [];
  for (var t = 0; t < total; t++) {
    if (shockAt !== null && t >= shockAt && t < shockAt + shockTicks) {
      // 量的冲击：0 号国的农场等级被砍掉一半（模拟占领/天灾/去殖民化）
      for (var p = 0; p < w.P; p++) {
        if (w.map.provinces[p].country !== 0) continue;
        var lv = w.level[0 * w.P + p];
        if (lv > 1) w.level[0 * w.P + p] = Math.max(1, Math.round(lv * 0.5));
      }
    }
    SIM.tick(w);
    if ((t + 1) % 60 === 0) traj.push({ m: t + 1, v: derive(w, 0) });
  }
  return traj;
}

function cos(a, b) {
  var d = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / Math.sqrt(Math.max(1e-12, na * nb));
}

console.log('══════ 判别实验：这个世界有几个独立的意识形态维度？ ══════\n');
var SEED = 8888;
var base = run(SEED, null, 0, 900);
var shock = run(SEED, 600, 120, 900);          // 第 600 tick 起，连续 120 个月砍农场

console.log('对照组（无冲击）与实验组（第 600-720 tick 砍掉一半农场）的向量轨迹：\n');
console.log('  月份   对照：① ② ③ ④ ⑤ ⑥            实验：① ② ③ ④ ⑤ ⑥');
for (var i = 0; i < base.length; i++) {
  var mark = (base[i].m > 600) ? '  ← 冲击期后' : '';
  console.log('  ' + String(base[i].m).padStart(5) + '   ' +
    base[i].v.map(function (x) { return x.toFixed(2); }).join(' ') + '        ' +
    shock[i].v.map(function (x) { return x.toFixed(2); }).join(' ') + mark);
}

/* 关键指标：冲击前后，向量**运动方向**有没有变 */
function direction(traj, from, to) {
  var a = traj.filter(function (x) { return x.m === from; })[0].v;
  var b = traj.filter(function (x) { return x.m === to; })[0].v;
  return b.map(function (v, j) { return v - a[j]; });
}
var dirBase = direction(base, 600, 900);
var dirShock = direction(shock, 600, 900);
console.log('\n  600→900 月的运动方向：');
console.log('    对照：[' + dirBase.map(function (x) { return (x >= 0 ? '+' : '') + x.toFixed(3); }).join(' ') + ']');
console.log('    实验：[' + dirShock.map(function (x) { return (x >= 0 ? '+' : '') + x.toFixed(3); }).join(' ') + ']');
console.log('    方向余弦 = ' + cos(dirBase, dirShock).toFixed(3) +
  '   （1 = 完全同向＝同一个自由度；<0.5 = 拐向了新方向）');

var dist = Math.sqrt(dirBase.reduce(function (a, v, j) { return a + (v - dirShock[j]) * (v - dirShock[j]); }, 0));
console.log('    两个方向的欧氏距离 = ' + dist.toFixed(3));

console.log('\n══════ 结论 ══════\n');
console.log('  · 如果方向余弦接近 1：说明**向量只能沿一条轨道跑**，');
console.log('    那就是这个世界只有**一个自由度**（工业化），而不是公式写得不好。');
console.log('  · 要多几个独立维度，就必须先给世界多几个**独立驱动**：');
console.log('    贸易/封锁、技术换挡、外部冲击、制度差异 —— 这些不是"内容"，是**维度**。');
console.log('  · 这也解释了为什么把轴砍到 3~4 根是诚实的：**轴数不能超过世界的自由度。**');
