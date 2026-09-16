/* 省 ↔ 国的接入层（基建）性质测试
 *
 * 用法：node test/infra-test.js [seed]
 *
 * 要回答的问题：
 *   P1 地理有没有真的拉开差距（conn 的分布，而不是一团 0.5）
 *   P2 低 conn 省的省价偏离国家价多少 —— 这条路走不通到底值多少钱
 *   P3 玩家修基建有没有用（这是新杠杆，不能又是"看起来能动、其实没用"）
 *   P4 **关键**：同样一场歉收，落在低 conn 省和落在高 conn 省，后果差多少
 *      （低 conn 省调不到外面的货，本地稀缺只能自己扛）
 *   P5 价格天花板在这一层之后还死不死（对照 test/price-ceiling.js 的诊断）
 *   P6 它有没有把"建什么不重要"这个老毛病治好一点
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

var pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  \u2713 ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '   ' + detail : '')); }
}
function group(t) { console.log('\n' + t); }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function f(x, d) { return (x === undefined || isNaN(x)) ? '—' : x.toFixed(d === undefined ? 3 : d); }

var map = VIC.mapgen.generate({
  width: MAP_OPTS.width, height: MAP_OPTS.height,
  seed: SEED, provinces: MAP_OPTS.provinces, countries: MAP_OPTS.countries
});
function mk(opts) {
  var o = { seed: SEED + 7 };
  if (opts) for (var k in opts) o[k] = opts[k];
  return SIM.createWorld(map, o);
}
function run(w, n) { for (var i = 0; i < n; i++) SIM.tick(w); }
function popOf(w, p) { return w.pop[p] + w.pop[w.P + p] + w.pop[2 * w.P + p]; }
function provIncome(w, p) {
  var v = 0;
  for (var g = 0; g < w.G; g++) v += w.output[g * w.P + p] * w.localPrice[g * w.P + p];
  return v;
}
/* 省价偏离国家价的平均幅度（加权：按这个省对这个商品的供需规模） */
function priceGap(w, p) {
  var s = 0, n = 0, c = w.map.provinces[p].country;
  for (var g = 0; g < w.G; g++) {
    var nat = w.price[g * w.C + c];
    if (nat <= 0) continue;
    s += Math.abs(w.localPrice[g * w.P + p] / nat - 1);
    n++;
  }
  return n > 0 ? s / n : 0;
}

/* ───────── P1 · 地理有没有拉开差距 ───────── */
group('P1 连通度的分布 —— 地理有没有真的拉开差距');
var ref = mk();
run(ref, 240);
(function () {
  var lo = 9, hi = -1, sum = 0, caps = [];
  for (var p = 0; p < ref.P; p++) {
    var c = ref.conn[p];
    if (c < lo) lo = c; if (c > hi) hi = c; sum += c;
    caps.push(ref.infraCap[p]);
  }
  caps.sort(function (a, b) { return a - b; });
  console.log('   conn  最低 ' + f(lo) + '   最高 ' + f(hi) + '   均值 ' + f(sum / ref.P) +
    '   极差 ' + f(hi - lo));
  console.log('   基建天花板  最低 ' + f(caps[0]) + '   中位 ' + f(caps[(caps.length / 2) | 0]) +
    '   最高 ' + f(caps[caps.length - 1]));
  /* 阈值 0.15 是设计意图而不是拟合出来的：最好的省至少要比最差的省
   * 多接进国家市场 15 个百分点，否则"地理决定可达性"就只是说法。
   * （理论上限约 0.25 —— 天花板最高 17.7 → conn 0.80，最低 5.1 → 0.55。） */
  check('连通度真的拉开了（极差 > 0.15）', hi - lo > 0.15, '极差 ' + f(hi - lo));
  check('天花板真的是地理给的（不是常数）', caps[caps.length - 1] - caps[0] > 6,
    f(caps[0]) + ' ~ ' + f(caps[caps.length - 1]));
})();

/* ───────── P2 · 路不通值多少钱 ───────── */
group('P2 省价偏离国家价：路不通到底值多少钱');
(function () {
  /* 这里要量的其实是**两个**数，第一版只量了后一个就判失败，是判据错了：
   *   原始偏离 = 这个省如果完全封闭，它的价会离国家价多远（基建要压缩的东西）
   *   混合之后 = 它实际离国家价多远（conn 压缩完的结果）
   * 原始偏离大、压缩比小，才说明这一层真的在干活。 */
  var meanRaw = 0, meanComp = 0, n = 0;
  for (var p = 0; p < ref.P; p++) {
    var c = ref.map.provinces[p].country;
    for (var g = 0; g < ref.G; g++) {
      var dp = ref.demandP[g * ref.P + p];
      if (dp < 0.001) continue;
      var nat = ref.price[g * ref.C + c];
      if (nat <= 0) continue;
      var sp = Math.max(ref.output[g * ref.P + p], 0.001);
      var pp = SIM.GOODS[g].base *
        Math.min(ref.priceCeil, Math.max(ref.priceFloor, Math.pow(dp / sp, 0.68)));
      if (pp > nat * 2.2) pp = nat * 2.2; else if (pp < nat / 2.2) pp = nat / 2.2;
      meanRaw += Math.abs(pp / nat - 1);
      meanComp += Math.abs(ref.localPrice[g * ref.P + p] / nat - 1);
      n++;
    }
  }
  meanRaw /= n; meanComp /= n;
  console.log('   全省×全商品：原始偏离 均值 ' + pctF(meanRaw) + '   混合之后 均值 ' + pctF(meanComp) +
    '   压缩到 ' + pctF(meanComp / meanRaw));
  check('省级封闭价的原始偏离很大（> 15%）', meanRaw > 0.15, pctF(meanRaw));
  check('conn 把它压掉了大半（压缩到 < 50%）', meanComp / meanRaw < 0.5,
    pctF(meanComp / meanRaw));
  check('压缩之后仍留有真实的省际价差（> 3%）', meanComp > 0.03, pctF(meanComp));

  /* 按连通度分位看：conn 越高，实际偏离越小 */
  var idx = [];
  for (var p2 = 0; p2 < ref.P; p2++) idx.push(p2);
  idx.sort(function (a, b) { return ref.conn[a] - ref.conn[b]; });
  var q = idx.length / 4 | 0;
  var groups = [[0, q], [q, 2 * q], [2 * q, 3 * q], [3 * q, idx.length]];
  var names = ['最差 1/4', '次差', '次好', '最好 1/4'];
  console.log('   ' + pad('连通度分位', 14) + pad('平均conn', 11) + pad('实际偏离', 12) + pad('人均产值', 12));
  var gaps = [];
  for (var i = 0; i < groups.length; i++) {
    var gs = 0, cs = 0, is = 0, m = 0;
    for (var j = groups[i][0]; j < groups[i][1]; j++) {
      var pp2 = idx[j];
      gs += priceGap(ref, pp2); cs += ref.conn[pp2];
      is += provIncome(ref, pp2) / Math.max(1, popOf(ref, pp2));
      m++;
    }
    gaps.push(gs / m);
    console.log('   ' + pad(names[i], 14) + pad(f(cs / m), 11) + pad(pctF(gs / m), 12) +
      pad(f(is / m * 1e6, 1), 12));
  }
  check('连通度最低的 1/4 偏离最大', gaps[0] > gaps[3], pctF(gaps[0]) + ' vs ' + pctF(gaps[3]));

  /* 截面上的「低 conn ⇒ 更穷」是个**混淆**的判据，第一版就是这么写的然后失败了：
   * 沿海省的 conn 高，但它同时更城市化、人口更多，人均产值反而被稀释。
   * 正确口径是 VIC3 的 MAPI 损失 —— 同一个省的产出，
   * 按省价卖 vs 按国家价卖，差了多少钱。这是纯价格渠道，不掺其他省的特征。 */
  function mapiLoss(w, p) {
    var c = w.map.provinces[p].country, vL = 0, vN = 0;
    for (var g = 0; g < w.G; g++) {
      var q = w.output[g * w.P + p];
      vL += q * w.localPrice[g * w.P + p];
      vN += q * w.price[g * w.C + c];
    }
    return vN > 0 ? 1 - vL / vN : 0;
  }
  var lossSum = [0, 0, 0, 0];
  for (var ii = 0; ii < groups.length; ii++) {
    var m2 = 0;
    for (var jj = groups[ii][0]; jj < groups[ii][1]; jj++) { lossSum[ii] += mapiLoss(ref, idx[jj]); m2++; }
    lossSum[ii] /= m2;
  }
  console.log('   MAPI 损失（产出按省价卖 vs 按国家价卖）：' +
    names.map(function (nm, k) { return nm + ' ' + pctF(lossSum[k]); }).join('   '));
  /* 开局（AI 还没修路）才是这个故事的开头：1836 年的内陆省摊到的折价最大。
   * 上面那张表是 240 tick 之后的，那时补贴已经把差距抹掉一部分了。 */
  var fresh = mk();
  var freshLoss = 0, freshLow = 0, freshHigh = 0, nLow = 0, nHigh = 0;
  for (var p3 = 0; p3 < fresh.P; p3++) {
    var l3 = mapiLoss(fresh, p3);
    freshLoss += l3;
    if (fresh.conn[p3] < 0.30) { freshLow += l3; nLow++; }
    if (fresh.conn[p3] > 0.40) { freshHigh += l3; nHigh++; }
  }
  freshLoss /= fresh.P;
  freshLow = nLow > 0 ? freshLow / nLow : 0;
  freshHigh = nHigh > 0 ? freshHigh / nHigh : 0;
  console.log('   开局（未修路）平均 MAPI 损失 ' + pctF(freshLoss) +
    '   conn<0.30 的省 ' + pctF(freshLow) + '（' + nLow + ' 个）' +
    '   conn>0.40 的省 ' + pctF(freshHigh) + '（' + nHigh + ' 个）');
  /* 我在这条上连着栽了两次，值得把结论写下来：
   *   ① 截面口径「路不通 ⇒ 更穷」是混淆的 —— 沿海省 conn 高，但它同时更城市化、
   *      人口更多，人均产值反而被稀释。
   *   ② 换成省内因果口径「同一个省把 conn 顶到天花板能少亏多少」，结果 ≈ 0，
   *      甚至略负。原因：产出侧的折价是**双向**的 ——
   *      效率高的省现在被低估（修路能赚回来），效率低的省现在被高估（修路反而暴露它）。
   *      两边的均值互相抵消，所以"修路让产出卖得更贵"这句话本身是空的。
   * 修路的真实收益不在这里，而在 **消费侧**（买进来的东西便宜了）和
   * **专业化能力**（可以放心把产能压在擅长的那一样上，不怕砸自己的本地市场）。
   * 后者就是 P3 量到的 +8.4% 人均产值、P4 量到的抗灾能力。
   * 所以 P2 只该断言**价格结构**本身，福利结论交给 P3/P4，不要在这里重复计提。 */
  function localDev(w, p) {
    var c = w.map.provinces[p].country, worst = 0;
    for (var g = 0; g < w.G; g++) {
      var nat = w.price[g * w.C + c];
      if (nat <= 0) continue;
      var d = Math.abs(w.localPrice[g * w.P + p] / nat - 1);
      if (d > worst) worst = d;
    }
    return worst;
  }
  var out10 = 0, up = 0, down = 0;
  for (var p5 = 0; p5 < fresh.P; p5++) {
    if (localDev(fresh, p5) > 0.10) out10++;
    var c5 = fresh.map.provinces[p5].country;
    for (var g5 = 0; g5 < fresh.G; g5++) {
      var d5 = fresh.localPrice[g5 * fresh.P + p5] - fresh.price[g5 * fresh.C + c5];
      if (d5 > 0.02) up++; else if (d5 < -0.02) down++;
    }
  }
  console.log('   开局：' + out10 + '/' + fresh.P + ' 个省至少有一项商品的省价偏离国家价 >10%' +
    '（' + pctF(out10 / fresh.P) + '）');
  console.log('   偏离是**双向**的：贵于国家价的格子 ' + up + ' 个，便宜的 ' + down + ' 个');
  check('开局有相当一部分省实际上不在国家市场里（> 50% 至少一项偏离 >10%）',
    out10 / fresh.P > 0.5, pctF(out10 / fresh.P));
  check('省价偏离是双向的（既有局部过剩也有局部短缺）', up > 0 && down > 0,
    up + ' 贵 / ' + down + ' 便宜');
  check('路越通折价越小（240 tick 后的截面，单调）', lossSum[3] < lossSum[0],
    pctF(lossSum[0]) + ' → ' + pctF(lossSum[3]));
})();
function pctF(v) { return (v * 100).toFixed(1) + '%'; }

/* ───────── P3 · 玩家修基建有没有用 ───────── */
group('P3 玩家修基建有没有用（新杠杆不能是死的）');
(function () {
  var base = mk(); run(base, 120);
  var me = 0;
  for (var c = 1; c < base.C; c++) if (base.popTotal[c] > base.popTotal[me]) me = c;
  /* 把本国最差的 5 个省拿出来 */
  var mine = [];
  for (var p = 0; p < base.P; p++) if (base.map.provinces[p].country === me) mine.push(p);
  mine.sort(function (a, b) { return base.conn[a] - base.conn[b]; });
  var worst = mine.slice(0, 5);

  /* 从 tick 0 开始比，不能等 120 tick 之后 —— 那时 AI 已经把能修的省都修完了，
   * 玩家再修就是零效果（第一版就是这么跑出 0.0% 的，那是测试的错不是模型的错）。
   * 这个杠杆问的是"你比 AI 更早、更集中地投"，所以必须从起点开始。 */
  var idle = mk(), built = mk();

  function snapshot(w) {
    var o = {};
    for (var i = 0; i < worst.length; i++) {
      o[worst[i]] = { inc: provIncome(w, worst[i]) / Math.max(1, popOf(w, worst[i])), pop: popOf(w, worst[i]) };
    }
    return o;
  }
  /* 玩家一路給这 5 个省修路（每 tick 都试，工期到了自动接着修） */
  for (var t = 0; t < 240; t++) {
    for (var i = 0; i < worst.length; i++) {
      var pp = worst[i];
      if (built.infraBuild[pp]) continue;
      if (built.infra[pp] >= Math.floor(built.infraCap[pp])) continue;
      if (built.treasury[me] < SIM.infraCost(built.infra[pp])) continue;
      SIM.pushCommand(built, SIM.CMD_INFRA, pp, 0, 0, me);
    }
    SIM.tick(idle); SIM.tick(built);
  }
  var incIdle = 0, incBuilt = 0, popIdle = 0, popBuilt = 0, connIdle = 0, connBuilt = 0;
  for (var k = 0; k < worst.length; k++) {
    var pk = worst[k];
    incIdle += provIncome(idle, pk) / Math.max(1, popOf(idle, pk));
    incBuilt += provIncome(built, pk) / Math.max(1, popOf(built, pk));
    popIdle += popOf(idle, pk); popBuilt += popOf(built, pk);
    connIdle += idle.conn[pk]; connBuilt += built.conn[pk];
  }
  console.log('   盯着本国最穷的 5 个省，连修 240 tick 基建：');
  console.log('   ' + pad('', 12) + pad('平均conn', 11) + pad('人均产值', 12) + pad('人口', 12));
  console.log('   ' + pad('不管它', 12) + pad(f(connIdle / 5), 11) +
    pad(f(incIdle / 5 * 1e6, 1), 12) + pad((popIdle / 1e6).toFixed(3) + 'M', 12));
  console.log('   ' + pad('修基建', 12) + pad(f(connBuilt / 5), 11) +
    pad(f(incBuilt / 5 * 1e6, 1), 12) + pad((popBuilt / 1e6).toFixed(3) + 'M', 12));
  var gain = incBuilt / incIdle - 1;
  console.log('   人均产值提升 ' + pctF(gain) + '   人口提升 ' + pctF(popBuilt / popIdle - 1));
  check('基建真的抬高了连通度', connBuilt > connIdle + 0.1,
    f(connIdle / 5) + ' → ' + f(connBuilt / 5));
  check('基建真的让这些省更富（人均产值 > +5%）', gain > 0.05, pctF(gain));
  check('基建也留住了人', popBuilt > popIdle, pctF(popBuilt / popIdle - 1));
})();

/* ───────── P4 · 同一场歉收，落在穷省和富省不一样 ───────── */
group('P4 同样一场歉收，落在"路不通"的省和"路通"的省，后果差多少');
(function () {
  function famineAt(pick) {
    var w = mk();
    run(w, 180);
    var p = pick(w);
    if (p < 0) return null;
    var lv0 = w.level[0 * w.P + p];
    var pop0 = popOf(w, p);
    var c = w.map.provinces[p].country;
    var nat0 = w.price[0 * w.C + c];
    var loc0 = w.localPrice[0 * w.P + p];   // 灾前省价 —— 分子分母要用同一个基准
    /* 摧毁这个省 70% 的农场等级 —— 相当于一场落在它头上的重灾 */
    w.level[0 * w.P + p] = lv0 - Math.max(1, Math.round(lv0 * 0.7));
    var peak = 0, peakNat = 0;
    for (var t = 0; t < 60; t++) {
      SIM.tick(w);
      var lp = w.localPrice[0 * w.P + p];
      if (lp > peak) peak = lp;
      if (w.price[0 * w.C + c] > peakNat) peakNat = w.price[0 * w.C + c];
    }
    return {
      p: p, conn: w.conn[p], lv0: lv0,
      localJump: peak / Math.max(1e-6, loc0) - 1,
      natRel: peakNat / nat0 - 1,
      popRatio: popOf(w, p) / pop0
    };
  }
  /* 挑一个 conn 最低的省，和一个 conn 最高、农场等级接近的省，做对照 */
  function pickLow(w) {
    var best = -1, bestC = 9;
    for (var p = 0; p < w.P; p++) if (w.level[p] >= 3 && w.conn[p] < bestC) { bestC = w.conn[p]; best = p; }
    return best;
  }
  /* 对照组必须**同国、农场等级接近**，否则比的是两个不同的省而不是连通度。
   * 第一版随便挑了个高 conn 的省，结果它的农场等级只有 4、低 conn 那个有 9，
   * 量出来的差值根本不能归因于基建。 */
  /* 注意过滤方向：要的是 conn **高于** connMin 的省。
   * 第一版写成 `conn > connMax → continue`，把高连通度的省全滤掉了，
   * 于是对照组挑回了实验组自己（两个 conn 都是 0.492，读数一模一样）。
   * 等级优先贴合、同等级里挑 conn 最高的。 */
  function pickHigh(w, lvTarget, country, connMin) {
    var best = -1, bestScore = 1e9;
    for (var p = 0; p < w.P; p++) {
      if (w.map.provinces[p].country !== country) continue;
      if (w.level[p] < 3 || w.conn[p] <= connMin) continue;
      var sc = Math.abs(w.level[p] - lvTarget);
      if (sc < bestScore || (sc === bestScore && best >= 0 && w.conn[p] > w.conn[best])) {
        bestScore = sc; best = p;
      }
    }
    return best;
  }
  /* 先跑一个参考世界，用它挑出"同一国、等级接近、连通度一低一高"的两个省 */
  var probe = mk(); run(probe, 180);
  var lowP = pickLow(probe);
  var lowC = probe.map.provinces[lowP].country;
  var highP = pickHigh(probe, probe.level[0 * probe.P + lowP], lowC, probe.conn[lowP] + 0.08);
  var low = famineAt(function () { return lowP; });
  var high = famineAt(function () { return highP; });
  if (low && high) {
    console.log('   ' + pad('', 12) + pad('conn', 8) + pad('农场等级', 10) + pad('本地粮价峰值', 14) +
      pad('国家粮价变动', 14) + pad('本省人口', 10));
    console.log('   ' + pad('路不通的省', 12) + pad(f(low.conn), 8) + pad(low.lv0, 10) +
      pad(f(low.localJump), 14) + pad(pctF(low.natRel), 14) + pad(f(low.popRatio), 10));
    console.log('   ' + pad('路通的省', 12) + pad(f(high.conn), 8) + pad(high.lv0, 10) +
      pad(f(high.localJump), 14) + pad(pctF(high.natRel), 14) + pad(f(high.popRatio), 10));
    check('路不通的省，本地粮价被这场灾推得更高', low.localJump > high.localJump,
      f(low.localJump) + ' vs ' + f(high.localJump));
    check('这场灾基本没动国家粮价（说明它是**地方性**的）', Math.abs(low.natRel) < 0.10,
      pctF(low.natRel));
  } else {
    check('灾情对照实验能跑起来', false, '没挑到合适的省');
  }
})();

/* ───────── P5 · 天花板还死不死 ───────── */
group('P5 价格天花板在这一层之后还死不死');
(function () {
  var w = mk();
  var hit = 0, tot = 0, maxLocal = 0, maxRatio = 0;
  for (var t = 0; t < 300; t++) {
    SIM.tick(w);
    if (t % 25 !== 0 || t < 50) continue;
    for (var p = 0; p < w.P; p++) {
      for (var g = 0; g < w.G; g++) {
        var sup = Math.max(w.output[g * w.P + p], 0.001);
        var raw = Math.pow(w.demandP[g * w.P + p] / sup, 0.68);
        tot++;
        if (raw > w.priceCeil || raw < w.priceFloor) hit++;
        if (raw > maxRatio) maxRatio = raw;
        var lp = w.localPrice[g * w.P + p] / SIM.GOODS[g].base;
        if (lp > maxLocal) maxLocal = lp;
      }
    }
  }
  console.log('   省级供需比对应的价格目标：最大 ' + f(maxRatio) + '（天花板 ' + f(w.priceCeil) + '）');
  console.log('   省级撞墙率 ' + pctF(hit / tot) + '   省价指数最高跑到 ' + f(maxLocal));
  check('省级层面天花板开始被撞到（对照：国家级是 0.00%）', hit / tot > 0.002,
    pctF(hit / tot));
})();

/* ───────── P6 · 结构分化度 ───────── */
group('P6 「建什么不重要」这个老毛病有没有好一点');
(function () {
  function divergence(w) {
    var C = w.C, G = w.G, P = w.P, vecs = [];
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
    for (var a = 0; a < C; a++) for (var b = a + 1; b < C; b++) {
      var d = 0;
      for (var g3 = 0; g3 < G; g3++) d += Math.abs(vecs[a][g3] - vecs[b][g3]);
      acc += d / 2; n++;
    }
    return n > 0 ? acc / n : 0;
  }
  var w = mk(); run(w, 240);
  var div = divergence(w);
  console.log('   国家间结构分化度 ' + f(div) + '（接入这一层之前是 0.059）');
  check('结构分化度没有塌掉', div > 0.04, f(div));
})();

console.log('\n────────────────────────────────────────────────────');
if (fail === 0) console.log('全部通过：' + pass + ' 项');
else console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
