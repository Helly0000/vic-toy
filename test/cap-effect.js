/* 天花板是否真的让"地理决定产业分布"？—— 与关闭天花板做对照
 * 用法：node test/cap-effect.js
 *
 * 判据：接入天花板后，各省的产业结构应该**更贴合自己的禀赋**，
 *      而不是所有省都长成一个样（那是接入前的行为）。
 * 指标：
 *   ① 产业-禀赋吻合度：每省"禀赋最高的商品"在该省建筑中的占比（越高越专业化）
 *   ② 结构分化度：各省产业向量两两之间的平均距离（越大越发散）
 */
'use strict';
var path = require('path'), ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js')); require(path.join(ROOT, 'js/mapgen.js')); require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;

function run(useCap, ticks, seed) {
  var map = MG.generate({ width: 1600, height: 1000, seed: seed, provinces: 260, countries: 8 });
  var opts = { seed: seed + 7 };
  // 关闭天花板 = 把余量开到极大（等效于不约束）
  if (!useCap) opts.capHeadroom = 1e6;
  var w = SIM.createWorld(map, opts);
  for (var i = 0; i < ticks; i++) SIM.tick(w);

  var P = w.P, G = w.G;
  var fitSum = 0, fitN = 0;
  var vectors = [];
  for (var p = 0; p < P; p++) {
    var best = 0, bestBonus = -1, tot = 0;
    var vec = [];
    for (var g = 0; g < G; g++) {
      var lv = w.level[g * P + p];
      tot += lv; vec.push(lv);
      if (w.geoBonus[g * P + p] > bestBonus) { bestBonus = w.geoBonus[g * P + p]; best = g; }
    }
    if (tot <= 0) continue;
    fitSum += w.level[best * P + p] / tot;
    fitN++;
    vectors.push(vec);
  }
  // 结构分化：两两 L1 距离的均值（归一化到 0~1）
  var distSum = 0, pairN = 0;
  for (var a = 0; a < vectors.length; a += 7) {
    for (var b = a + 1; b < vectors.length; b += 7) {
      var d = 0, na = 0, nb = 0;
      for (var g2 = 0; g2 < G; g2++) { d += Math.abs(vectors[a][g2] - vectors[b][g2]); na += vectors[a][g2]; nb += vectors[b][g2]; }
      distSum += d / Math.max(1, (na + nb) / 2); pairN++;
    }
  }
  return { fit: fitSum / Math.max(1, fitN), spread: distSum / Math.max(1, pairN) };
}

console.log('══════ 天花板效果对照（种子 8888，可传 tick 数，默认 1200）══════\n');
console.log('  指标                        无天花板     有天花板      变化');
var TICKS = parseInt(process.argv[2], 10) || 1200;
var off = run(false, TICKS, 8888), on = run(true, TICKS, 8888);
console.log('  ① 禀赋吻合度（越高越专业）   ' + off.fit.toFixed(3).padStart(8) +
  '     ' + on.fit.toFixed(3).padStart(8) + '     ' +
  ((on.fit / off.fit - 1) * 100 >= 0 ? '+' : '') + ((on.fit / off.fit - 1) * 100).toFixed(1) + '%');
console.log('  ② 结构分化度（越大越发散）   ' + off.spread.toFixed(3).padStart(8) +
  '     ' + on.spread.toFixed(3).padStart(8) + '     ' +
  ((on.spread / off.spread - 1) * 100 >= 0 ? '+' : '') + ((on.spread / off.spread - 1) * 100).toFixed(1) + '%');

console.log('\n  判读：');
console.log('  · ① 上升 = 各省更倾向发展自己禀赋高的商品（地理在起作用）');
console.log('  · ② 上升 = 各省产业结构差异变大（世界不再趋同）');
