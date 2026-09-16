/* 标定台：跨国市场的两个参数，以及它们换来/换走的东西
 *
 * 用法：node test/trade-sweep.js [seed]
 *
 * 两个参数：
 *   TRADE_LAMBDA  运输技术 —— 把「可达份额」放大成市场整合度 λ 的总闸
 *   TRADE_D0      引力衰减尺度 —— 多远的伙伴还算伙伴
 *
 * 要看的不是一个数，而是一组此消彼长：
 *   ① 平均弹性    专业化到底赚不赚钱（封闭 0.546 / 完全一体化 → 1.0）
 *   ② 结构分化度   各国建筑结构还差多少（这是地图上还有没有信息的度量）
 *   ③ 人均 GDP 极差 贸易是在制造赢家/输家，还是把大家拉平
 *   ④ 人口 / 不满  宏观别被搞崩
 *
 * ②和①是**对立**的：市场一体化程度越高，各国的价格信号越像，
 * 于是大家越容易建同样的东西。标定要在这条曲线上挑一个点，
 * 而不是把①推到最大。这个标定台的存在，就是为了让这个取舍是量出来的，
 * 而不是拍脑袋「λ 取 0.8 吧」。
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
var TICKS = 240;
var CONVERGE = 60;
var K = 2.0;

var LAMBDAS = [0, 0.5, 0.8, 1.0, 1.3, 1.6];
var D0S = [150, 260, 450];

var map = VIC.mapgen.generate({ width: 1600, height: 1000, seed: SEED, provinces: 260, countries: 8 });

function mk(opts) {
  var o = { seed: SEED + 7 };
  if (opts) { o.tradeLambda = opts.lambda; o.tradeD0 = opts.d0; }
  return SIM.createWorld(map, o);
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function f(x, d) { return (x === undefined || isNaN(x)) ? '—' : x.toFixed(d === undefined ? 3 : d); }

/* 结构分化度：各国建筑结构（归一化后的等级向量）两两之间的 L1 距离均值。
 * 0 = 全世界建一样的东西；1 = 完全不同的经济结构。 */
function structureDivergence(w) {
  var C = w.C, G = w.G, P = w.P;
  var vecs = [];
  for (var c = 0; c < C; c++) {
    var v = [], tot = 0;
    for (var g = 0; g < G; g++) {
      var s = 0;
      for (var p = 0; p < P; p++) if (w.map.provinces[p].country === c) s += w.level[g * P + p];
      v.push(s); tot += s;
    }
    if (tot <= 0) return 0;
    for (var g2 = 0; g2 < G; g2++) v[g2] /= tot;
    vecs.push(v);
  }
  var acc = 0, n = 0;
  for (var a = 0; a < C; a++) {
    for (var b = a + 1; b < C; b++) {
      var d = 0;
      for (var g3 = 0; g3 < G; g3++) d += Math.abs(vecs[a][g3] - vecs[b][g3]);
      acc += d / 2; n++;    // 除以 2：L1 距离最大为 2
    }
  }
  return n > 0 ? acc / n : 0;
}

function perCapitaGDP(w, c) {
  var P = w.P, v = 0, t = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== c) continue;
    for (var g = 0; g < w.G; g++) v += w.output[g * P + p] * w.price[g * w.C + c];
    t += w.pop[p] + w.pop[P + p] + w.pop[2 * P + p];
  }
  return t > 0 ? v / t : 0;
}

function revenueOf(w, country, good) {
  var P = w.P, out = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== country) continue;
    out += w.output[good * P + p];
  }
  return { value: out * w.price[good * w.C + country], qty: out };
}

function scaleLevels(w, country, good, k) {
  var P = w.P, before = 0, after = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== country) continue;
    var idx = good * P + p, lv = w.level[idx];
    before += lv;
    var want = Math.min(14, Math.round(lv * k), Math.floor(w.levelCap[idx]));
    if (want < lv) want = lv;
    w.level[idx] = want; after += want;
  }
  return { before: before, after: after };
}

/* 在一个给定参数下量一组指标 */
function measure(lambda, d0) {
  var ref = mk({ lambda: lambda, d0: d0 });
  for (var t = 0; t < TICKS; t++) SIM.tick(ref);

  var lamSum = 0, lamLo = Infinity, lamHi = -Infinity;
  for (var c = 0; c < ref.C; c++) {
    var L = ref.tradeWeight[c];
    lamSum += L; if (L < lamLo) lamLo = L; if (L > lamHi) lamHi = L;
  }

  /* 市场一体化程度：本国价偏离世界价多少（0 = 完全一体化） */
  var dev = 0, devN = 0;
  for (var c1 = 0; c1 < ref.C; c1++) {
    for (var g1 = 0; g1 < ref.G; g1++) {
      dev += Math.abs(ref.price[g1 * ref.C + c1] / ref.worldPrice[g1] - 1);
      devN++;
    }
  }

  var gdp = [];
  for (var c2 = 0; c2 < ref.C; c2++) gdp.push(perCapitaGDP(ref, c2));
  var gLo = Math.min.apply(null, gdp), gHi = Math.max.apply(null, gdp);

  /* 弹性：抽三个国家（可达性最高 / 中 / 最低）× 全部商品 */
  var order = [];
  for (var c3 = 0; c3 < ref.C; c3++) order.push(c3);
  order.sort(function (a, b) { return ref.tradeWeight[b] - ref.tradeWeight[a]; });
  var probeCountries = [order[0], order[(ref.C / 2) | 0], order[ref.C - 1]];
  var es = [];
  for (var pi = 0; pi < probeCountries.length; pi++) {
    var c4 = probeCountries[pi];
    for (var g4 = 0; g4 < ref.G; g4++) {
      var wa = mk({ lambda: lambda, d0: d0 });
      for (var t2 = 0; t2 < TICKS; t2++) SIM.tick(wa);
      var wb = mk({ lambda: lambda, d0: d0 });
      for (var t3 = 0; t3 < TICKS; t3++) SIM.tick(wb);
      var before = revenueOf(wa, c4, g4);
      if (before.qty < 1) continue;
      var sc = scaleLevels(wb, c4, g4, K);
      if (sc.after <= sc.before) continue;
      wa.autoInvest = 0; wb.autoInvest = 0;
      for (var tc = 0; tc < CONVERGE; tc++) { SIM.tick(wa); SIM.tick(wb); }
      var after = revenueOf(wb, c4, g4);
      var eQ = Math.log(after.qty / before.qty);
      if (eQ > 0.01) es.push(Math.log(after.value / before.value) / eQ);
    }
  }
  var meanE = es.length ? es.reduce(function (a, b) { return a + b; }, 0) / es.length : NaN;

  return {
    lambda: lambda, d0: d0,
    lamMean: lamSum / ref.C, lamLo: lamLo, lamHi: lamHi,
    dev: dev / devN,
    e: meanE,
    div: structureDivergence(ref),
    gdpSpread: gLo > 0 ? gHi / gLo : NaN,
    pop: ref.popTotal.reduce(function (a, b) { return a + b; }, 0),
    unrest: ref.unrestAvg.reduce(function (a, b) { return a + b; }, 0) / ref.C
  };
}

console.log('════════ 跨国市场标定台 · seed ' + SEED + ' · ' + TICKS + ' tick ════════\n');
console.log(pad('λ 技术', 8) + pad('D0', 6) + pad('λ均值', 8) + pad('λ极差', 8) +
  pad('价偏离', 8) + pad('弹性', 8) + pad('结构分化', 10) + pad('人均极差', 10) +
  pad('人口(M)', 10) + pad('不满', 8));

var best = null;
for (var i = 0; i < D0S.length; i++) {
  for (var j = 0; j < LAMBDAS.length; j++) {
    var m = measure(LAMBDAS[j], D0S[i]);
    console.log(pad(m.lambda, 8) + pad(m.d0, 6) + pad(f(m.lamMean), 8) +
      pad(f(m.lamHi - m.lamLo), 8) + pad(f(m.dev), 8) + pad(f(m.e), 8) +
      pad(f(m.div), 10) + pad(f(m.gdpSpread, 2), 10) +
      pad(f(m.pop / 1e6, 1), 10) + pad(f(m.unrest), 8));
    if (!best || m.e > best.e) best = m;
  }
  console.log('');
}
console.log('弹性最高的一组：λ=' + best.lambda + ' D0=' + best.d0 +
  '  弹性 ' + f(best.e) + '  结构分化 ' + f(best.div));
