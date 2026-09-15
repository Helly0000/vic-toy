/* 蒸汽与账本 — 张力测试台（tension harness）
 *
 * 用法：  node test/tension.js [tick数]
 *
 * 为什么需要它：
 *   设计文档（vic-toy-好玩化设计.md）里的结论是实验跑出来的，不是拍脑袋——
 *   但那些实验是临时探针。这个文件把「玩家策略差异到底有多大」变成**每次改动都能复跑的指标**。
 *   没有它，后面每加一个机制都只能靠感觉判断有没有用。
 *
 * 它回答一个问题：**同一个世界、同一个种子，换一种打法，结果差多少？**
 *   差距大 → 玩家有真正的选择；差距小 → 又变成看着数字涨。
 *
 * 测什么：一个玩家国家（默认 0 号国，通常是最大的那个），四种打法，各跑 N 个月。
 *   全部关掉 autoInvest —— 玩家自己花钱建，这才是要考察的那条路。
 *   PLAY 模式额外开赈灾，用来量「花钱减灾」到底值不值。
 *
 * 纪律：完全不碰 DOM，只吃 js/sim.js。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));

var SIM = VIC.sim, MG = VIC.mapgen;

var SEED = 8888;
var TICKS = parseInt(process.argv[2], 10) || 1200;
var PLAYER = 0;                       // 玩家扮演的国家
var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };

/* ───────────── 世界探针：把关心的量一次性读出来 ───────────── */
function probe(w, c) {
  var P = w.P, S = w.S, G = w.G;
  var pop = 0, wealthNum = 0, wealthDen = 0, ratio = 0, unrest = 0, lvAll = 0, lowRatio = 9;
  var cPop = 0, cGdp = 0, cUnrest = 0, cProv = 0, cLv = 0, cFamineLoss = 0;

  for (var p = 0; p < P; p++) {
    var isMine = w.map.provinces[p].country === c;
    var lv = 0;
    for (var g = 0; g < G; g++) lv += w.level[g * P + p];
    lvAll += lv;
    if (isMine) { cLv += lv; cProv++; cUnrest += w.unrest[p]; }

    for (var s = 0; s < S; s++) {
      var n = w.pop[s * P + p];
      pop += n; wealthNum += n * w.wealth[s * P + p]; wealthDen += n;
      ratio += w.ratio[s * P + p];
    }
    unrest += w.unrest[p];
    if (w.ratio[0 * P + p] < lowRatio) lowRatio = w.ratio[0 * P + p];
    if (isMine) cPop += w.pop[0 * P + p] + w.pop[1 * P + p] + w.pop[2 * P + p];
  }
  for (var c2 = 0; c2 < w.C; c2++) cFamineLoss += w.famineLoss[c2];

  return {
    year: w.year,
    pop: pop, cPop: cPop,
    avgWealth: wealthDen ? wealthNum / wealthDen : 0,
    avgRatio: ratio / (S * P),
    worstLowRatio: lowRatio,
    avgUnrest: unrest / P,
    avgLv: lvAll / P,
    cLv: cLv,
    cGdp: w.gdp[c], cTreasury: w.treasury[c],
    cUnrest: cProv ? cUnrest / cProv : 0,
    worldGdp: w.gdp.reduce(function (a, b) { return a + b; }, 0),
    share: w.gdp.reduce(function (a, b) { return a + b; }, 0) > 0
      ? w.gdp[c] / w.gdp.reduce(function (a, b) { return a + b; }, 0) : 0,
    builds: w.constructionDone,
    famines: w.famineCount.reduce(function (a, b) { return a + b; }, 0),
    famineLoss: cFamineLoss,
    reliefPaid: w.reliefPaid[c],
    reliefReached: w.reliefReached[c],

  };
}

/* ───────────── 策略：每个 tick 决定「建什么」 ─────────────
 * 策略只通过 pushCommand 影响世界，绝不直接改状态 —— 和 UI 走同一条路。 */

/* A 不作为：既不建也不赈灾，只为对照 */
function stratIdle(w, c, tick) { /* 什么都不做 */ }

/* B 追高价：古典的「什么贵建什么」，不看地理禀赋 */
function stratPriceChase(w, c, tick) {
  buildOnce(w, c, function (p) {
    var best = -1, bestV = -1;
    for (var g = 0; g < w.G; g++) {
      if (w.level[g * w.P + p] >= 14) continue;
      var v = w.price[g * w.C + c] / SIM.GOODS[g].base;
      if (v > bestV) { bestV = v; best = g; }
    }
    return best;
  });
}

/* C 看禀赋：价格信号 × geoBonus —— 和 sim.js 内置自动投资同源的「正确」打法 */
function stratGeoAware(w, c, tick) {
  buildOnce(w, c, function (p) {
    var best = -1, bestV = -1;
    for (var g = 0; g < w.G; g++) {
      if (w.level[g * w.P + p] >= 14) continue;
      var v = (w.price[g * w.C + c] / SIM.GOODS[g].base) *
              Math.pow(w.geoBonus[g * w.P + p], 1.6);
      if (v > bestV) { bestV = v; best = g; }
    }
    return best;
  });
}

/* D 只种粮：一个刻意偏执的打法，用来检验「错误策略是否有代价」 */
function stratGrainOnly(w, c, tick) {
  buildOnce(w, c, function (p) {
    return w.level[0 * w.P + p] >= 14 ? -1 : 0;
  });
}


/* E 单点专业化：每省只建自己 geoBonus 最高的那一种，建满 14 级就停。
 * 这才是「比较优势→专业化」的真正考验：如果它显著优于或劣于均衡建设，
 * 玩家就必须看地图做取舍；如果差不多，那「建什么」在模型里其实无关紧要。 */
function stratSpecialize(w, c, tick) {
  buildOnce(w, c, function (p) {
    var best = -1, bestV = -1;
    for (var g = 0; g < w.G; g++) {
      var v = w.geoBonus[g * w.P + p];
      if (v > bestV) { bestV = v; best = g; }
    }
    return w.level[best * w.P + p] >= 14 ? -1 : best;
  });
}


/* 在玩家国里找一个「没有在建、且还没满级」的省开工，一次只开一个 */
function buildOnce(w, c, pickGood) {
  for (var p = 0; p < w.P; p++) {
    if (w.map.provinces[p].country !== c) continue;
    if (w.building[p]) continue;
    var g = pickGood(p);
    if (g < 0) continue;
    var lv = w.level[g * w.P + p];
    if (w.treasury[c] < SIM.buildCost(lv)) continue;   // 钱不够，等下一轮
    SIM.pushCommand(w, SIM.CMD_BUILD, p, g, 0);
    return true;
  }
  return false;
}

/* 赈灾：国库充裕就开，紧张就关 —— 代表「玩家会算这笔账」 */
function reliefPolicy(w, c) {
  var want = w.treasury[c] > w.provCount[c] * SIM.RELIEF_COST * 30 ? 1 : 0;
  if ((w.reliefOn[c] ? 1 : 0) !== want) SIM.pushCommand(w, SIM.CMD_RELIEF, -1, 0, want);
}

/* ───────────── 跑一种策略 ───────────── */
function run(name, strategy, opts) {
  opts = opts || {};
  var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: SEED }));
  var w = SIM.createWorld(map, { seed: SEED + 7, autoInvest: false });

  // 把玩家国换成一个真实存在的国家（0 号国不一定在地图上）
  var c = Math.min(PLAYER, w.C - 1);

  var t0 = Date.now();
  for (var t = 0; t < TICKS; t++) {
    if (strategy) strategy(w, c, t);
    if (opts.relief) reliefPolicy(w, c);
    SIM.tick(w);
  }
  var ms = Date.now() - t0;
  var r = probe(w, c);
  r.name = name;
  r.msPerTick = ms / TICKS;
  return r;
}

/* ───────────── 输出 ───────────── */
function fmt(n, d) { return Number(n).toFixed(d === undefined ? 2 : d); }
function pctS(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'; }

console.log('蒸汽与账本 · 张力测试台');
console.log('种子 ' + SEED + '，' + TICKS + ' tick（' + (TICKS / 12).toFixed(0) + ' 年），玩家国 = ' +
  '第 ' + PLAYER + ' 号，autoInvest 全部关闭');
console.log('问题：换一种打法，结果差多少？差得少 = 玩家没有真正的选择。\n');

var runs = [];
runs.push(run('A 不作为（既不建也不赈灾）', null, {}));
runs.push(run('B 追高价（不看禀赋）', stratPriceChase, {}));
runs.push(run('C 看禀赋（价格×地理）', stratGeoAware, {}));
runs.push(run('D 只种粮（偏执打法）', stratGrainOnly, {}));
runs.push(run('E 单点专业化（只建最擅长的）', stratSpecialize, {}));

runs.push(run('C+ 看禀赋 + 赈灾', stratGeoAware, { relief: true }));


var H = ['策略', '本国人口', '本国国力', '世界占比', '国库', '本国建筑', '均不满', '受赈省次', '完工/歉收'];

console.log(H[0].padEnd(22) + H.slice(1).map(function (h) { return h.padStart(11); }).join(''));
console.log('─'.repeat(22 + 11 * (H.length - 1)));
runs.forEach(function (r) {
  console.log(
    r.name.padEnd(22) +
    (fmt(r.cPop / 1e6, 1) + 'M').padStart(11) +
    (fmt(r.cGdp / 1e6, 2) + 'M').padStart(11) +
    pctS(r.share).padStart(11) +
    (fmt(r.cTreasury / 1e6, 1) + 'M').padStart(11) +
    fmt(r.cLv, 0).padStart(11) +
    pctS(r.cUnrest).padStart(11) +
    fmt(r.worstLowRatio, 2).padStart(11) +
    (r.builds + ' / ' + r.famines).padStart(11)
  );
});

/* ───────────── 判定：打法差异是否够大 ───────────── */
console.log('\n【张力判定】以「不作为」为基准，最好与最差的差距：');
var base = runs[0];
function spread(key) {
  var vals = runs.map(function (r) { return r[key]; });
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  return { lo: lo, hi: hi, rel: lo !== 0 ? (hi / lo - 1) : Infinity };
}
[['cGdp', '本国国力'], ['cPop', '本国人口'], ['cLv', '本国建筑总级'], ['worldGdp', '世界国力']].forEach(function (kv) {
  var s = spread(kv[0]);
  console.log('  ' + kv[1].padEnd(10) + ' 最差 ' + fmt(s.lo / 1e6, 2) + 'M  最好 ' + fmt(s.hi / 1e6, 2) +
    'M   差距 ' + (isFinite(s.rel) ? (s.rel * 100).toFixed(1) + '%' : 'n/a'));
});

var gdpSpread = spread('cGdp').rel;
console.log('\n结论：最好的打法比最差的强 ' + (gdpSpread * 100).toFixed(1) + '%。');
console.log(gdpSpread >= 0.30
  ? '  → 张力足够：不同的建法会明显改变结局，玩家值得为选择花时间。'
  : '  → 张力不足：怎么建都差不多，需要让「建错」有更长期、更不可逆的代价。');

var relief = runs[5], noRelief = runs[2];
console.log('\n【赈灾值不值】(C+ vs C)  国库花掉 ' + fmt((relief.reliefPaid) / 1e6, 2) + 'M，' +
  '受赈 ' + fmt(relief.reliefReached, 0) + ' 省次，换来人口 ' + pctS(relief.cPop / noRelief.cPop - 1) +
  '、国力 ' + pctS(relief.cGdp / noRelief.cGdp - 1) + '、本国不满 ' + pctS(relief.cUnrest / noRelief.cUnrest - 1));


console.log('\n单 tick 耗时 ' + fmt(runs[0].msPerTick, 3) + ' ms（' + TICKS + ' tick 全程关闭自动投资）');
console.log('注：本台只测「建造/赈灾」两类决策。价格类政策已被证明会被财富反馈自愈（见设计文档），故不在此测。');
