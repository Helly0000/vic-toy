/* 先验量：跨国市场之前，先量清楚「专业化到底赚不赚钱」
 *
 * 用法：node test/trade-probe.js [seed]
 *
 * 为什么要先量：
 *   「封闭市场下专业化赚不到额外收益」这句话一直是**论断**，不是数字。
 *   接入跨国市场会大改价格形成，如果手里没有接入前的量，改完就无法判断
 *   「变好」还是「只是变了」。
 *
 * 判据只有一个，而且它必须由模型自己算出来，不能靠公式推：
 *   **收入对自身产出的弹性  e = dln(收入) / dln(产出)**
 *     e = 1.0  → 多产一倍就多赚一倍（世界市场无限大，你是价格接受者）
 *     e = 0.32 → 多产一倍只多赚 25%（价格被自己砸下来）
 *   现状（封闭市场）必然 e ≈ 1 − PRICE_ELASTIC = 0.32：这就是「专业化不划算」的根。
 *   第一次跑只等 1 tick，量出 0.734 —— 那是**假象**：价格有 PRICE_SMOOTH=0.42 的
 *   平滑，一个 tick 只走完 42% 的调整。所以必须让冲击收敛（关掉自动投资，只让价格跑完），
 *   否则量到的是「价格调整速度」而不是「价格调整幅度」。
 *
 *
 * 测量手法：同一张地图造两个世界，同种子同步跑 N tick 后：
 *   ① 两边都关掉自动投资（否则 AI 的补建会污染「我的产出」这个自变量）
 *   ② 只把其中一个世界里某国某商品的等级乘以 k
 *   ③ 再各跑 CONVERGE tick 让价格收敛
 *   ④ 比收入
 * 不用新的 API，也不依赖任何内部状态。
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
var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };
var TICKS = 240;     // 20 年：等经济收敛到有结构差异、又还没被天花板封死
var K = 2.0;         // 产出翻倍
var CONVERGE = 60;   // 冲击后让价格跑完的 tick 数（5 年）

var map = VIC.mapgen.generate({
  width: MAP_OPTS.width, height: MAP_OPTS.height,
  seed: SEED, provinces: MAP_OPTS.provinces, countries: MAP_OPTS.countries
});

function makeTwin() {
  var w = SIM.createWorld(map, { seed: SEED + 7 });
  return w;
}

/* 把某国某商品的等级乘以 k（受 MAX_LEVEL 与地理天花板约束，和玩家/AI 同一条规则） */
function scaleLevels(w, country, good, k) {
  var P = w.P, changed = 0, before = 0, after = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== country) continue;
    var idx = good * P + p;
    var lv = w.level[idx];
    before += lv;
    var want = Math.min(14, Math.round(lv * k), Math.floor(w.levelCap[idx]));
    if (want < lv) want = lv;
    w.level[idx] = want;
    after += want;
    changed++;
  }
  return { before: before, after: after, provinces: changed };
}

function revenueOf(w, country, good) {
  var P = w.P, out = 0, q = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== country) continue;
    var o = w.output[good * P + p];
    q += o;
    out += o;
  }
  return { value: out * w.price[good * w.C + country], qty: q, price: w.price[good * w.C + country] };
}

console.log('════════ 跨国市场先验量 · seed ' + SEED + ' ════════');
console.log('跑 ' + TICKS + ' tick 后把某国某商品的产能翻 ' + K + ' 倍，' +
  '关掉自动投资再跑 ' + CONVERGE + ' tick 让价格收敛，比较收入变化\n');

var ref = makeTwin();
for (var t = 0; t < TICKS; t++) SIM.tick(ref);

/* ───── A. 收入弹性 ───── */
console.log('A) 收入对自身产出的弹性');
console.log('   国家            商品    等级→     产出×   价格×   收入×    弹性');
var elasticities = [];
for (var c = 0; c < ref.C; c++) {
  for (var g = 0; g < ref.G; g++) {
    /* 两个平行世界：唯一的差别就是「这个国家这个商品的产能翻了一倍」。
     * 关掉自动投资是必须的 —— 否则 AI 会在两个世界里补不同的厂，
     * 自变量就不再是「我的产出」了。 */
    var wa = makeTwin();
    for (var t2 = 0; t2 < TICKS; t2++) SIM.tick(wa);
    var wb = makeTwin();
    for (var t3 = 0; t3 < TICKS; t3++) SIM.tick(wb);

    var before = revenueOf(wa, c, g);
    if (before.qty < 1) continue;
    var sc = scaleLevels(wb, c, g, K);
    if (sc.after <= sc.before) continue;      // 天花板封死，做不了这个实验

    wa.autoInvest = 0; wb.autoInvest = 0;
    for (var tc = 0; tc < CONVERGE; tc++) { SIM.tick(wa); SIM.tick(wb); }
    var after = revenueOf(wb, c, g);

    var eQ = Math.log(after.qty / before.qty);
    var eV = Math.log(after.value / before.value);
    var e = eQ > 0.01 ? eV / eQ : NaN;
    elasticities.push({ country: c, good: g, e: e });
    console.log('   ' + pad(ref.map.countries[c].name, 14) + pad(SIM.GOODS[g].name, 8) +
      pad(sc.before + '→' + sc.after, 10) +
      pad((after.qty / before.qty).toFixed(2), 8) +
      pad((after.price / before.price).toFixed(2), 8) +
      pad((after.value / before.value).toFixed(2), 8) +
      (isNaN(e) ? '  —' : e.toFixed(3)));
  }
}
var meanE = elasticities.reduce(function (a, b) { return a + b.e; }, 0) / Math.max(1, elasticities.length);
console.log('\n   平均弹性 = ' + meanE.toFixed(3) +
  '   （封闭市场的理论极限 1 − PRICE_ELASTIC = 0.32；世界市场无限大时应趋近 1.0）');

/* ───── A2. 国家层面：专业化让这个国家更富了吗 ───── */
console.log('\nA2) 专业化之后，本国人均产值 / 人口 / 不满 怎么变（同上两个世界）');
console.log('   国家            人均产值×  人口×    不满(前→后)');
for (var c4 = 0; c4 < ref.C; c4++) {
  var wa2 = makeTwin();
  for (var t4 = 0; t4 < TICKS; t4++) SIM.tick(wa2);
  var wb2 = makeTwin();
  for (var t5 = 0; t5 < TICKS; t5++) SIM.tick(wb2);
  /* 「专业化」= 把这个国家禀赋最好的那个商品翻倍 */
  var best = bestFitGood(wb2, c4);
  var sc2 = scaleLevels(wb2, c4, best, K);
  if (sc2.after <= sc2.before) continue;
  wa2.autoInvest = 0; wb2.autoInvest = 0;
  var g0a = perCapitaOutput(wa2, c4);
  for (var tc2 = 0; tc2 < CONVERGE; tc2++) { SIM.tick(wa2); SIM.tick(wb2); }
  console.log('   ' + pad(ref.map.countries[c4].name, 14) +
    pad((perCapitaOutput(wb2, c4) / g0a).toFixed(3), 11) +
    pad((popOf(wb2, c4) / popOf(wa2, c4)).toFixed(3), 9) +
    (unrestOf(wa2, c4).toFixed(3) + ' → ' + unrestOf(wb2, c4).toFixed(3)));
}

function popOf(w, c) { var t = 0; for (var p = 0; p < w.P; p++) if (w.map.provinces[p].country === c) t += w.pop[p] + w.pop[w.P + p] + w.pop[2 * w.P + p]; return t; }
function perCapitaOutput(w, c) {
  var P = w.P, v = 0, t = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== c) continue;
    for (var g = 0; g < w.G; g++) v += w.output[g * P + p] * w.price[g * w.C + c];
    t += w.pop[p] + w.pop[P + p] + w.pop[2 * P + p];
  }
  return t > 0 ? v / t : 0;
}
function unrestOf(w, c) {
  var s = 0, n = 0;
  for (var p = 0; p < w.P; p++) if (w.map.provinces[p].country === c) { s += w.unrest[p]; n++; }
  return n > 0 ? s / n : 0;
}
/* 禀赋最好 = 该国人口加权禀赋 / 世界均值 最高的那个商品 */
function bestFitGood(w, c) {
  var factor = [w.fert, w.urban, w.timber, w.mineral, w.urban];
  var best = 0, bestV = -Infinity;
  for (var g = 0; g < w.G; g++) {
    var s = 0, pop = 0, world = 0, wp = 0;
    for (var p = 0; p < w.P; p++) {
      var n = w.pop[p] + w.pop[w.P + p] + w.pop[2 * w.P + p];
      world += factor[g][p] * n; wp += n;
      if (w.map.provinces[p].country === c) { s += factor[g][p] * n; pop += n; }
    }
    var v = (pop > 0 && wp > 0) ? (s / pop) / (world / wp) : 0;
    if (v > bestV) { bestV = v; best = g; }
  }
  return best;
}

/* ───── B. 跨国价差：套利空间有多大 ───── */
console.log('\nB) 各国价格比（相对基准）—— 同一个商品在不同国家差多少');
console.log('   商品     最低国(比值)          最高国(比值)          极差');
var spreads = [];
for (var g2 = 0; g2 < ref.G; g2++) {
  var lo = Infinity, hi = -Infinity, loC = -1, hiC = -1;
  for (var c2 = 0; c2 < ref.C; c2++) {
    var rel = ref.price[g2 * ref.C + c2] / SIM.GOODS[g2].base;
    if (rel < lo) { lo = rel; loC = c2; }
    if (rel > hi) { hi = rel; hiC = c2; }
  }
  spreads.push(hi - lo);
  console.log('   ' + pad(SIM.GOODS[g2].name, 8) +
    pad(ref.map.countries[loC].name + ' ' + lo.toFixed(2), 22) +
    pad(ref.map.countries[hiC].name + ' ' + hi.toFixed(2), 22) +
    (hi - lo).toFixed(2));
}
console.log('   平均极差 = ' + (spreads.reduce(function (a, b) { return a + b; }, 0) / spreads.length).toFixed(3));

/* ───── C. 禀赋好 != 赚钱多（封闭市场的病） ───── */
console.log('\nC) 禀赋优势与收入的相关系数（封闭市场里，地理该不该决定国运）');
function corr(xs, ys) {
  var n = xs.length, mx = 0, my = 0, i;
  for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  var sxy = 0, sxx = 0, syy = 0;
  for (i = 0; i < n; i++) {
    var a = xs[i] - mx, b = ys[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
}
for (var g3 = 0; g3 < ref.G; g3++) {
  var fitArr = [], revArr = [];
  var factor = [ref.fert, ref.urban, ref.timber, ref.mineral, ref.urban][g3];
  for (var c3 = 0; c3 < ref.C; c3++) {
    var sumFit = 0, sumPop = 0, rev = 0;
    for (var p3 = 0; p3 < ref.P; p3++) {
      if (ref.map.provinces[p3].country !== c3) continue;
      var pop = ref.pop[p3] + ref.pop[ref.P + p3] + ref.pop[2 * ref.P + p3];
      sumFit += factor[p3] * pop; sumPop += pop;
      rev += ref.output[g3 * ref.P + p3];
    }
    if (sumPop <= 0) continue;
    fitArr.push(sumFit / sumPop);
    revArr.push(rev * ref.price[g3 * ref.C + c3] / sumPop);   // 人均产值
  }
  console.log('   ' + pad(SIM.GOODS[g3].name, 8) + ' corr(人均禀赋, 人均产值) = ' + corr(fitArr, revArr).toFixed(3));
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
