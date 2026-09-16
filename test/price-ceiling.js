/* 标定台：价格上下限到底在撑着什么
 *
 * 用法：node test/price-ceiling.js [seed]
 *
 * 起因：跨国市场接完之后做了一次「我们 vs VIC3」的对表，发现两家的价格公式是同族的
 * （都是 base × 供需失衡的某个函数），但**上下限差了一倍**：
 *     VIC3  [0.25, 1.75] × 基准价      （公式是 base × (1 + 0.75 × 失衡比)）
 *     我们  [0.28, 3.40] × 基准价
 * 我当时给的假说是：「我们模型里的价格冲击会自愈，是被这个高上限撑着的」。
 *
 * 这个台子就是来验这个假说的 —— 而且**不预设它会成立**。
 * 量的四件事：
 *   ① 上限有没有真的被撞到（撞得多频繁）—— 不撞，它就是摆设，谈不上撑着什么
 *   ② 同一场歉收在不同上限下，价格峰值差多少
 *   ③ 同一场歉收下，**底层实际吃到的口粮量**差多少
 *      （这是关键：模型里没有任何"配给"，供给不足时价格涨、但没人被挤出去；
 *        唯一能让实际消费下降的机制是财富反馈把消费乘数压到 NEED_FLOOR。
 *        如果口粮量在各种上限下几乎不变，那"数量渠道"在我们这里根本不存在，
 *        假说就是错的。）
 *   ④ 100 年尺度上，上限会不会改变人口/不满/灾情留疤的深度
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));

var VIC = globalThis.VIC;
var SIM = VIC.sim;

var SEED = parseInt(process.argv[2], 10) || 8888;
var TICKS = 600;
var CEILS = [1.30, 1.75, 2.40, 3.40, 5.00];
var FLOORS = 0.28;

var map = VIC.mapgen.generate({ width: 1600, height: 1000, seed: SEED, provinces: 260, countries: 8 });

function mk(ceil, opts) {
  var o = { seed: SEED + 7, priceCeil: ceil, priceFloor: FLOORS };
  if (opts) for (var k in opts) o[k] = opts[k];
  return SIM.createWorld(map, o);
}
function run(w, n) { for (var i = 0; i < n; i++) SIM.tick(w); }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function f(x, d) { return (x === undefined || isNaN(x)) ? '—' : x.toFixed(d === undefined ? 3 : d); }

/* 全世界底层实际吃到的谷物量（物理量，不是花的钱）。
 * 这就是「数量渠道」的度量：模型里唯一能让它下降的是财富反馈把乘数压向 NEED_FLOOR。 */
function grainEaten(w) {
  var P = w.P, sum = 0;
  var floor = 0.85, sens = 0.35;   // NEED_FLOOR[0] / LUX_SENS[0]，与 sim.js 一致
  for (var p = 0; p < P; p++) {
    var n = w.pop[p] / 1000;
    var mult = Math.max(floor, 1 + (w.wealth[p] - 1) * sens);
    sum += n * SIM.NEEDS[0][0] * mult;
  }
  return sum;
}

/* 天花板被撞到的频率：逐国逐商品算原始目标值，看它有没有越界 */
function clampHitRate(w) {
  var hit = 0, tot = 0;
  for (var c = 0; c < w.C; c++) {
    for (var g = 0; g < w.G; g++) {
      var sup = Math.max(w.supply[g * w.C + c], 0.001);
      var raw = Math.pow(w.demand[g * w.C + c] / sup, 0.68);
      tot++;
      if (raw > w.priceCeil || raw < w.priceFloor) hit++;
    }
  }
  return tot > 0 ? hit / tot : 0;
}

/* ─────────── 前半：稳态性质 ─────────── */
console.log('════════ 价格上下限标定台 · seed ' + SEED + ' · ' + TICKS + ' tick ════════\n');
console.log(pad('上限', 7) + pad('撞顶率', 9) + pad('撞底率', 9) + pad('均价指数', 10) +
  pad('价格离散度', 11) + pad('人口(M)', 9) + pad('不满', 8) + pad('人均产值', 10));

var baselines = {};
for (var i = 0; i < CEILS.length; i++) {
  var ceil = CEILS[i];
  var w = mk(ceil);
  var hitSum = 0, samples = 0;
  for (var t = 0; t < TICKS; t++) {
    SIM.tick(w);
    if (t % 20 === 0 && t > 60) { hitSum += clampHitRate(w); samples++; }
  }
  var meanRel = 0, sd = 0, n2 = 0, vals = [];
  for (var c = 0; c < w.C; c++) {
    for (var g = 0; g < w.G; g++) {
      var rel = w.price[g * w.C + c] / SIM.GOODS[g].base;
      vals.push(rel); meanRel += rel; n2++;
    }
  }
  meanRel /= n2;
  for (var k = 0; k < vals.length; k++) sd += (vals[k] - meanRel) * (vals[k] - meanRel);
  sd = Math.sqrt(sd / vals.length);
  var pop = 0, gdp = 0, unrest = 0;
  for (var c2 = 0; c2 < w.C; c2++) {
    pop += w.popTotal[c2]; unrest += w.unrestAvg[c2] / w.C;
    for (var p = 0; p < w.P; p++) if (w.map.provinces[p].country === c2) gdp += w.output[3 * w.P + p] * w.price[3 * w.C + c2];
  }
  baselines[ceil] = { pop: pop, unrest: unrest, grain: grainEaten(w) };
  console.log(pad(ceil.toFixed(2), 7) + pad((hitSum / samples * 100).toFixed(1) + '%', 9) +
    pad('—', 9) + pad(meanRel.toFixed(3), 10) + pad(sd.toFixed(3), 11) +
    pad((pop / 1e6).toFixed(1), 9) + pad(unrest.toFixed(3), 8) + pad((gdp / 1e6).toFixed(2), 10));
}

/* ─────────── 后半：同一场歉收，不同上限 ─────────── */
console.log('\n【灾情对照】同一场歉收（每 8 个月摧毁受灾国 35% 农场等级）在不同上限下：');
console.log(pad('上限', 7) + pad('粮价峰值', 10) + pad('口粮最低', 10) + pad('口粮/基线', 11) +
  pad('人口/基线', 11) + pad('不满', 8) + pad('灾后10年人口', 13));

for (var j = 0; j < CEILS.length; j++) {
  var cl = CEILS[j];
  var b = baselines[cl];
  var w2 = mk(cl);
  var peak = 0, minGrain = Infinity;
  for (var t2 = 0; t2 < TICKS; t2++) {
    SIM.tick(w2);
    if (!w2.warmed) continue;
    /* 每年收获月来一次狠的：直接施加灾情（比随机事件密，为了让信号出得来） */
    if (w2.month === 8 && t2 > 60) {
      var fc = (t2 / 12 | 0) % w2.C;
      w2.harvestShock[fc] = 0.6;
      for (var p2 = 0; p2 < w2.P; p2++) {
        if (w2.map.provinces[p2].country !== fc) continue;
        var lv = w2.level[p2];
        w2.level[p2] = lv - Math.max(1, Math.round(lv * 0.35));
      }
    }
    var gp = w2.price[0 * w2.C + 0] / SIM.GOODS[0].base;
    if (gp > peak) peak = gp;
    var ge = grainEaten(w2);
    if (t2 > 60 && ge < minGrain) minGrain = ge;
  }
  var popEnd = 0;
  for (var c3 = 0; c3 < w2.C; c3++) popEnd += w2.popTotal[c3];
  console.log(pad(cl.toFixed(2), 7) + pad(peak.toFixed(2), 10) + pad(minGrain.toFixed(0), 10) +
    pad((minGrain / b.grain).toFixed(3), 11) +
    pad((popEnd / b.pop).toFixed(3), 11) + pad(w2.unrestAvg[0].toFixed(3), 8) +
    pad((popEnd / 1e6).toFixed(1), 13));
}

/* ─────────── 决定性的一问：极端持续的量的冲击下，上限管不管用 ───────────
 * 前一节的温和灾情测出来"上限完全不动结果"——但那是**压力不够**：
 * 每 8 年打一个国家、只摧毁 35%，粮价峰值才 1.20，离天花板远得很。
 * 设计文档里那个原始实验（"农场等级每次结算后砍 45%"）把谷物相对价打到了 3.34，
 * 那才是贴着天花板的量级。所以这里复刻那个强度，并且**逐 tick** 施加。 */
console.log('\n【决定性】极端持续的量的冲击：每 tick 摧毁全世界 45% 农场等级');
console.log(pad('上限', 7) + pad('粮价峰值', 10) + pad('撞顶率', 9) + pad('口粮最低', 10) +
  pad('口粮/基线', 11) + pad('人口/基线', 11) + pad('不满', 8));

for (var n = 0; n < CEILS.length; n++) {
  var cn = CEILS[n], bn = baselines[cn];
  var wc = mk(cn);
  var peakN = 0, minGN = Infinity, hitN = 0, sampN = 0;
  for (var tn = 0; tn < TICKS; tn++) {
    SIM.tick(wc);
    // 每 tick 砍全世界所有省的农场等级
    for (var pn = 0; pn < wc.P; pn++) {
      var lvn = wc.level[0 * wc.P + pn];
      if (lvn <= 0) continue;
      var cutn = Math.max(1, Math.round(lvn * 0.45));
      wc.level[0 * wc.P + pn] = lvn - cutn;
    }
    if (tn > 60) {
      var prn = wc.price[0 * wc.C + 0] / SIM.GOODS[0].base;
      if (prn > peakN) peakN = prn;
      var gen = grainEaten(wc);
      if (gen < minGN) minGN = gen;
      hitN += clampHitRate(wc); sampN++;
    }
  }
  var popN = 0;
  for (var c4 = 0; c4 < wc.C; c4++) popN += wc.popTotal[c4];
  console.log(pad(cn.toFixed(2), 7) + pad(peakN.toFixed(2), 10) +
    pad((hitN / sampN * 100).toFixed(1) + '%', 9) + pad(minGN.toFixed(0), 10) +
    pad((minGN / bn.grain).toFixed(3), 11) + pad((popN / bn.pop).toFixed(3), 11) +
    pad(wc.unrestAvg[0].toFixed(3), 8));
}

/* ─────────── 供需比到底能走多远（天花板有没有机会被撞到） ─────────── */
console.log('\n【诊断】常态下供需比与价格目标的分布（' + TICKS + ' tick，每 40 tick 采样一次）');
var wd = mk(3.40);
var maxRatio = 0, maxTarget = 0, sumRatio = 0, cnt = 0, over175 = 0;
for (var td = 0; td < TICKS; td++) {
  SIM.tick(wd);
  if (td % 40 === 0 && td > 60) {
    for (var cd = 0; cd < wd.C; cd++) {
      for (var gd = 0; gd < wd.G; gd++) {
        var sr = wd.demand[gd * wd.C + cd] / Math.max(wd.supply[gd * wd.C + cd], 0.001);
        var tg = Math.pow(sr, 0.68);
        sumRatio += sr; cnt++;
        if (sr > maxRatio) maxRatio = sr;
        if (tg > maxTarget) maxTarget = tg;
        if (tg > 1.75) over175++;
      }
    }
  }
}
console.log('   供需比  均值 ' + (sumRatio / cnt).toFixed(3) + '   最大 ' + maxRatio.toFixed(3) +
  '   → 价格目标最大 ' + maxTarget.toFixed(3));
console.log('   价格目标超过 1.75（VIC3 的天花板）的比例：' + (over175 / cnt * 100).toFixed(2) + '%');
console.log('   要撞到我们的 3.40，供需比需要达到 ' + Math.pow(3.40, 1 / 0.68).toFixed(2) + ' 倍');
