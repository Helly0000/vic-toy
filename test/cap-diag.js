/* 天花板诊断：量清楚 levelCap 到底咬在哪里、咬掉多少
 * 用法：node test/cap-diag.js
 */
'use strict';
var path = require('path'), ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js')); require(path.join(ROOT, 'js/mapgen.js')); require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;
var GOODS = SIM.GOODS.map(function (g) { return g.name; });

function diag(seed, ticks) {
  var map = MG.generate({ width: 1600, height: 1000, seed: seed, provinces: 260, countries: 8 });
  var w = SIM.createWorld(map, { seed: seed + 7 });
  var P = w.P, G = w.G;

  function snap(label) {
    // 每个 (省,商品) 的 等级/天花板 比值
    var ratios = [];
    var cappedByGood = new Array(G).fill(0);
    var totalByGood = new Array(G).fill(0);
    var sumLv = new Array(G).fill(0), sumCap = new Array(G).fill(0);
    for (var p = 0; p < P; p++) {
      for (var g = 0; g < G; g++) {
        var lv = w.level[g * P + p], cap = w.levelCap[g * P + p];
        var r = cap > 0 ? lv / cap : 0;
        ratios.push(r);
        totalByGood[g]++;
        if (lv + 1 > cap) cappedByGood[g]++;      // 已经顶住，不能再建
        sumLv[g] += lv; sumCap[g] += cap;
      }
    }
    ratios.sort(function (a, b) { return a - b; });
    var q = function (f) { return ratios[Math.floor(ratios.length * f)]; };
    var cappedTotal = cappedByGood.reduce(function (a, b) { return a + b; }, 0);
    console.log('  [' + label + '] 等级/天花板 比值：p10=' + q(0.10).toFixed(2) +
      ' p50=' + q(0.50).toFixed(2) + ' p90=' + q(0.90).toFixed(2) +
      ' p99=' + q(0.99).toFixed(2) +
      '   顶住不能建的比例 ' + (cappedTotal / (P * G) * 100).toFixed(0) + '%');
    console.log('      商品        已建/天花板    顶住占比   最缺的省（天花板最低）');
    for (var g2 = 0; g2 < G; g2++) {
      var worst = 9, worstP = -1;
      for (var p2 = 0; p2 < P; p2++) {
        if (w.levelCap[g2 * P + p2] < worst) { worst = w.levelCap[g2 * P + p2]; worstP = p2; }
      }
      console.log('      ' + GOODS[g2].padEnd(7) +
        (sumLv[g2].toFixed(0) + ' / ' + sumCap[g2].toFixed(0)).padStart(14) +
        ((cappedByGood[g2] / totalByGood[g2] * 100).toFixed(0) + '%').padStart(11) +
        ('  最低 ' + worst.toFixed(2) + '（省 ' + worstP + '）').padStart(8));
    }
  }

  console.log('种子 ' + seed + '：');
  snap('开局');
  for (var i = 0; i < ticks; i++) SIM.tick(w);
  snap(ticks + ' tick 后（玩家/系统都开自动投资）');
  console.log('');
}

console.log('══════ 有限要素天花板诊断 ══════\n');
diag(8888, 300);
console.log('对照：没有天花板时，300 tick 后总人口 47.3M、均收支 1.053、均不满 0.057');
console.log('     接入天花板后：总人口 33.1M、均收支 0.993、均不满 0.171 —— 咬太狠了\n');
