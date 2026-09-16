/* 天花板余量标定扫描
 * 用法：node test/cap-sweep.js
 *
 * 目标：天花板既**有意义**（约束不合适的格子、让地理决定产业），又**不掐死世界**。
 * 判据（无天花板基线：人口 47.3M / 不满 0.057 / 玩家 100 年能建 1845 级）：
 *   - 总人口 > 44M，均不满 < 0.09        —— 世界别被掐死
 *   - 玩家 100 年能建的等级 > 1400        —— 中期决策空间还在（这是上次翻车的地方）
 *   - 开局顶住比例 15%~40%               —— 天花板真的在咬
 */
'use strict';
var path = require('path'), ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js')); require(path.join(ROOT, 'js/mapgen.js')); require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;
var OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };

function buildOnce(w, c) {
  for (var p = 0; p < w.P; p++) {
    if (w.map.provinces[p].country !== c) continue;
    if (w.building[p]) continue;
    var best = -1, bv = -1;
    for (var g = 0; g < w.G; g++) {
      if (w.level[g * w.P + p] >= 14) continue;
      if (w.level[g * w.P + p] + 1 > w.levelCap[g * w.P + p]) continue;
      var v = (w.price[g * w.C + c] / SIM.GOODS[g].base) * Math.pow(w.geoBonus[g * w.P + p], 1.6);
      if (v > bv) { bv = v; best = g; }
    }
    if (best < 0) continue;
    if (w.treasury[c] < SIM.buildCost(w.level[best * w.P + p])) continue;
    SIM.pushCommand(w, SIM.CMD_BUILD, p, best, 0);
    return true;
  }
  return false;
}

function trial(headroom, ticks) {
  var map = MG.generate(Object.assign({}, OPTS, { seed: 8888 }));
  var w = SIM.createWorld(map, { seed: 8895, capHeadroom: headroom, autoInvest: false });
  var c = 0;
  var capped0 = 0;
  for (var g = 0; g < w.G; g++) for (var p = 0; p < w.P; p++) {
    if (w.level[g * w.P + p] + 1 > w.levelCap[g * w.P + p]) capped0++;
  }
  for (var i = 0; i < ticks; i++) { buildOnce(w, c); SIM.tick(w); }
  var pop = 0, unrest = 0;
  for (var s = 0; s < w.S; s++) for (var p2 = 0; p2 < w.P; p2++) pop += w.pop[s * w.P + p2];
  for (var p3 = 0; p3 < w.P; p3++) unrest += w.unrest[p3];
  var playerLv = 0;
  for (var p4 = 0; p4 < w.P; p4++) {
    if (w.map.provinces[p4].country !== c) continue;
    for (var g2 = 0; g2 < w.G; g2++) playerLv += w.level[g2 * w.P + p4];
  }
  return { pop: pop / 1e6, unrest: unrest / w.P, capped0: capped0 / (w.P * w.G), playerLv: playerLv };
}

console.log('══════ 天花板余量扫描（seed 8888，1200 tick = 100 年，关闭自动投资）══════\n');
console.log('  余量    总人口    均不满   开局顶住   玩家百年可建   判定');
console.log('  （无天花板基线：47.3M / 0.057 / 0% / 1845 级）\n');
var best = null;
[3.5, 5, 7, 9, 12, 16].forEach(function (h) {
  var r = trial(h, 1200);
  var okPop = r.pop > 44, okUnrest = r.unrest < 0.09;
  var okSpace = r.playerLv > 1400, okBind = r.capped0 > 0.15 && r.capped0 < 0.40;
  var verdict = (okPop && okUnrest && okSpace && okBind) ? '★ 可用'
    : (!okSpace ? '决策空间被掐死' : (!okBind ? '形同虚设' : (!okPop ? '世界被掐死' : '不满偏高')));
  console.log('  ' + h.toFixed(1).padEnd(7) + r.pop.toFixed(1).padStart(5) + 'M' +
    r.unrest.toFixed(3).padStart(9) + (r.capped0 * 100).toFixed(0).padStart(9) + '%' +
    r.playerLv.toString().padStart(12) + '   ' + verdict);
  if (okPop && okUnrest && okSpace && okBind && !best) best = { h: h, r: r };
});
if (best) {
  console.log('\n  推荐余量 = ' + best.h + '（人口 ' + best.r.pop.toFixed(1) + 'M，' +
    '玩家百年可建 ' + best.r.playerLv + ' 级，开局顶住 ' + (best.r.capped0 * 100).toFixed(0) + '%）');
} else {
  console.log('\n  ⚠ 没有余量能同时满足全部判据 —— 说明"天花板"与"增长空间"存在结构性冲突，');
  console.log('     需要改的是天花板的**形状**（例如只约束相对结构、不约束绝对等级），而不是调参数。');
}
