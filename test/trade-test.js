/* 跨国市场的性质测试
 *
 * 用法：node test/trade-test.js [seed]
 *
 * 这个文件回答的是**性质**问题，不是数值问题：
 *   P1 世界价真的反映世界供需吗（还是只在看着像）
 *   P2 整合度 λ 的两端对不对（λ=0 必须精确退回封闭价）
 *   P3 这本账平不平（逐商品出口=进口；全球贸易余额按世界价合计=0）
 *   P4 专业化到底赚不赚钱（弹性；对照组是接入前的 0.54）
 *   P5 地理上产不了的东西，能不能靠贸易补上 —— 这条就是**封锁有没有牙齿**
 *   P6 一国的歉收会不会传到别国去
 *
 * 为什么 P5 要用人工制造的不对称：
 * 随机地图的八个国家禀赋接近（大数定律把省级差异在国家级摊平了），
 * 于是贸易的收益本来就只有百分之几 —— 那是**正确**的结果，不是 bug。
 * 真正该看的是极端情形：一个地理上根本产不了粮的国家。
 * 那也正是 1945–2045 这条真实世界线上天天发生的事（英国要吃饭、日本要石油）。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));

var VIC = globalThis.VIC;
var SIM = VIC.sim;

/* 探针（默认不生效）：VIC_UNREST_DEBUG=1 时把不满的分布打出来。
 * 注意：这里**没有**覆盖 sim 参数的钩子了 —— 曾经有过一个（用来 A/B 一个
 * 后来被撤销的"怨愤"机制）。撤销后那个钩子会让"关掉机制"的对照变成假对照
 * （参数照收、机制已不存在），所以一并删掉，只留只读探针。 */
(function () {
  if (!process.env.VIC_UNREST_DEBUG) return;
  globalThis.VIC_UNREST_DEBUG = true;
})();

var SEED = parseInt(process.argv[2], 10) || 8888;
var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };

var pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  \u2713 ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '   ' + detail : '')); }
}
function group(t) { console.log('\n' + t); }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

var map = VIC.mapgen.generate({
  width: MAP_OPTS.width, height: MAP_OPTS.height,
  seed: SEED, provinces: MAP_OPTS.provinces, countries: MAP_OPTS.countries
});

function mk(opts) {
  var o = { seed: SEED + 7 };
  if (opts) for (var k in opts) o[k] = opts[k];
  return SIM.createWorld(map, o);}
function run(w, n) { for (var i = 0; i < n; i++) SIM.tick(w); }

function perCapitaOutput(w, c) {
  var P = w.P, v = 0, t = 0;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== c) continue;
    for (var g = 0; g < w.G; g++) v += w.output[g * P + p] * w.price[g * w.C + c];
    t += w.pop[p] + w.pop[P + p] + w.pop[2 * P + p];
  }
  return t > 0 ? v / t : 0;
}
function grainPriceIndex(w, c) { return w.price[0 * w.C + c] / SIM.GOODS[0].base; }

/* ───────── P1 · 世界价反映世界供需 ───────── */
group('P1 世界价反映世界供需');
(function () {
  /* autoInvest 必须关掉。
   * 踩过的坑：第一版开着自动投资跑，全世界耕地砍掉 40% 之后世界粮价只涨了 1.0% ——
   * 不是价格机制失灵，是 AI 在那 40 tick 里把农场又建回来了（经济自愈）。
   * 那是**另一个**要测的性质（韧劲），不该混进「世界价反不反映供需」这一条里。
   * 关掉之后：产出 51.8% → 价格 143%，和 (1/0.518)^0.68 = 1.55 同量级（差额是需求反馈）。 */
  var a = mk({ autoInvest: false }); run(a, 60);
  var b = mk({ autoInvest: false }); run(b, 60);
  /* 把全世界的农场等级砍掉 40%（受天花板与硬上限约束，和 AI 同一条规则） */
  for (var p = 0; p < b.P; p++) {
    b.level[0 * b.P + p] = Math.floor(b.level[0 * b.P + p] * 0.6);
  }
  run(a, 40); run(b, 40);
  var up = b.worldPrice[0] / a.worldPrice[0];
  check('全世界耕地减少 → 世界粮价上涨', up > 1.15,
    '×' + up.toFixed(3));
  /* 反向：产能增加 → 跌 */
  var c = mk({ autoInvest: false }); run(c, 60);
  for (var p2 = 0; p2 < c.P; p2++) {
    var cap = Math.floor(c.levelCap[0 * c.P + p2]);
    c.level[0 * c.P + p2] = Math.min(14, cap, Math.floor(c.level[0 * c.P + p2] * 1.6) + 1);
  }
  run(c, 40);
  var down = c.worldPrice[0] / a.worldPrice[0];
  check('全世界耕地增加 → 世界粮价下跌', down < 0.85, '×' + down.toFixed(3));

  /* 方向对称性：涨的幅度与跌的幅度应当是同一量级（价格是幂函数，不是线性函数） */
  var logUp = Math.log(up), logDown = -Math.log(down);
  check('涨与跌的幅度同量级（不是单边失灵）',
    logUp > 0 && logDown > 0 && Math.abs(logUp - logDown) < 0.35 * Math.max(logUp, logDown),
    'ln 幅度 ' + logUp.toFixed(3) + ' / ' + logDown.toFixed(3));

  /* 全世界同时歉收（模型自带的灾情通道）也要推高世界价 */
  var d = mk({ autoInvest: false }); run(d, 60);
  for (var t = 0; t < 40; t++) {
    for (var cc = 0; cc < d.C; cc++) d.harvestShock[cc] = 0.6;
    SIM.tick(d);
  }
  check('全世界同时歉收 → 世界粮价上涨', d.worldPrice[0] / a.worldPrice[0] > 1.15,
    '×' + (d.worldPrice[0] / a.worldPrice[0]).toFixed(3));
})();

/* ───────── P2 · λ 的两端 ───────── */
group('P2 整合度 λ 的两端必须是精确的');
(function () {
  var shut = mk({ tradeLambda: 0 }); run(shut, 120);
  /* λ=0 的判据不能写成「price 逐点等于 autarky」。
   * 踩过的坑：第一版就是这么写的，量到最大偏离 0.37 就判失败 —— 其实模型是对的。
   * price 是**平滑过**的量（PRICE_SMOOTH），而 autarky 每个 tick 都在动，
   * 平滑值必然滞后于目标值。要求它们相等，等于要求平滑器不存在。
   *
   * 正确的判据是相对的：λ=0 时价格只跟自己的封闭价走（偏离远小于开放世界），
   * 而 λ>0 时价格被世界价拽走。下面用同一个统计量比较两种世界，才是有意义的对照。 */
  function autarkyDeviation(lambda) {
    var w = mk({ tradeLambda: lambda }); run(w, 120);
    var dev = 0, n = 0;
    for (var c = 0; c < w.C; c++) {
      for (var g = 0; g < w.G; g++) {
        dev += Math.abs(w.price[g * w.C + c] / w.autarky[g * w.C + c] - 1);
        n++;
      }
    }
    return dev / n;
  }
  var shut = mk({ tradeLambda: 0 }); run(shut, 120);
  var devShut = autarkyDeviation(0), devOpen = autarkyDeviation(1.3);
  check('λ=0 时价格只跟自己的封闭价走', devShut < 0.06,
    '平均偏离封闭价 ' + (devShut * 100).toFixed(2) + '%');
  check('λ>0 时价格被世界价拽离封闭价（同尺子对照）', devOpen > devShut * 3,
    (devShut * 100).toFixed(2) + '% → ' + (devOpen * 100).toFixed(2) + '%');


  var open = mk(); run(open, 120);
  var dev = 0, n = 0;
  for (var c2 = 0; c2 < open.C; c2++) {
    for (var g2 = 0; g2 < open.G; g2++) {
      dev += Math.abs(open.price[g2 * open.C + c2] / open.worldPrice[g2] - 1);
      n++;
    }
  }
  check('λ>0 时本国价向世界价靠拢（但不必相等）', dev / n < 0.05,
    '平均偏离世界价 ' + (dev / n * 100).toFixed(2) + '%');

  /* 通关税率：开放度 0 的关税收入必然为 0（没有进口可抽） */
  var closed = mk(); run(closed, 60);
  for (var c3 = 0; c3 < closed.C; c3++) SIM.pushCommand(closed, SIM.CMD_TRADE, -1, 0, 0, c3);
  run(closed, 60);
  var gross = 0;
  for (var c4 = 0; c4 < closed.C; c4++) gross += closed.tradeGross[c4] + closed.tariffPaid[c4];
  check('全世界闭关 → 不再有贸易与关税', gross < 1e-6, '合计 ' + gross.toExponential(2));
})();

/* ───────── P3 · 这本账是平的 ───────── */
group('P3 贸易账必须是平的（不平就是凭空造钱）');
(function () {
  var w = mk(); run(w, 240);
  var worstGood = 0;
  for (var g = 0; g < w.G; g++) {
    var e = 0, m = 0;
    for (var c = 0; c < w.C; c++) { e += w.expo[g * w.C + c]; m += w.impo[g * w.C + c]; }
    var rel = (e + m) > 0 ? Math.abs(e - m) / (e + m) : 0;
    if (rel > worstGood) worstGood = rel;
  }
  check('逐商品：全世界出口量 == 进口量', worstGood < 1e-5,
    '最大相对偏差 ' + worstGood.toExponential(2));

  var bal = 0, balAbs = 0;
  for (var c2 = 0; c2 < w.C; c2++) { bal += w.tradeBalance[c2]; balAbs += Math.abs(w.tradeBalance[c2]); }
  check('全球贸易余额（按世界价）合计 == 0', balAbs > 0 && Math.abs(bal) / balAbs < 1e-3,
    '合计 ' + bal.toFixed(4) + '，绝对规模 ' + balAbs.toFixed(1));

  /* 浮点累加会有残差，但不能有系统性的正偏差 */
  check('贸易余额不是凭空的正数', Math.abs(bal) < balAbs * 1e-3,
    '相对残差 ' + (Math.abs(bal) / balAbs).toExponential(2));
})();

/* ───────── P4 · 专业化赚不赚钱 ───────── */
group('P4 专业化回报：收入对自身产出的弹性');
(function () {
  var REF = mk(); run(REF, 240);
  function elasticity(lambda) {
    var es = [];
    for (var c = 0; c < REF.C; c++) {
      for (var g = 0; g < REF.G; g++) {
        var wa = mk({ tradeLambda: lambda }); run(wa, 240);
        var wb = mk({ tradeLambda: lambda }); run(wb, 240);
        var q0 = 0, v0 = 0, p;
        for (p = 0; p < wa.P; p++) {
          if (wa.map.provinces[p].country !== c) continue;
          q0 += wa.output[g * wa.P + p];
        }
        if (q0 < 1) continue;
        v0 = q0 * wa.price[g * wa.C + c];
        var changed = 0;
        for (p = 0; p < wb.P; p++) {
          if (wb.map.provinces[p].country !== c) continue;
          var idx = g * wb.P + p, lv = wb.level[idx];
          var want = Math.min(14, Math.round(lv * 2), Math.floor(wb.levelCap[idx]));
          if (want > lv) { wb.level[idx] = want; changed++; }
        }
        if (!changed) continue;
        wa.autoInvest = 0; wb.autoInvest = 0;
        for (var t = 0; t < 60; t++) { SIM.tick(wa); SIM.tick(wb); }
        var q1 = 0;
        for (p = 0; p < wb.P; p++) if (wb.map.provinces[p].country === c) q1 += wb.output[g * wb.P + p];
        if (q1 / q0 < 1.05) continue;
        es.push(Math.log((q1 * wb.price[g * wb.C + c]) / v0) / Math.log(q1 / q0));
      }
    }
    return es.length ? es.reduce(function (a, b) { return a + b; }, 0) / es.length : NaN;
  }
  var eShut = elasticity(0);
  var eOpen = elasticity(1.3);
  check('封闭世界里专业化回报很低（弹性 ≈ 0.54）', eShut < 0.62, '弹性 ' + eShut.toFixed(3));
  check('接入世界市场后专业化回报显著提高（弹性 > 0.80）', eOpen > 0.80, '弹性 ' + eOpen.toFixed(3));
  check('提高幅度明显', eOpen - eShut > 0.2,
    '+' + (eOpen - eShut).toFixed(3) + '（' + eShut.toFixed(2) + ' → ' + eOpen.toFixed(2) + '）');
})();

/* ───────── P5 · 产不了的东西能不能买回来 —— 封锁有没有牙齿 ───────── */
group('P5 「地理上产不了」的国家：贸易 vs 闭关（= 封锁有没有牙齿）');
(function () {
  /* 人工制造一个极端不对称：挑最大的国家，把它的农场天花板压到 1 级。
   * 这模拟的是「英国没有足够的耕地」这类真实处境。 */
  function makeCrippled(lambda) {
    var w = mk({ tradeLambda: lambda });
    var big = 0;
    for (var c = 1; c < w.C; c++) if (w.popTotal[c] > w.popTotal[big]) big = c;
    for (var p = 0; p < w.P; p++) {
      if (w.map.provinces[p].country !== big) continue;
      w.levelCapUnit[0 * w.P + p] = 1 / Math.max(1, w.pop[0 * w.P + p] + w.pop[w.P + p] + w.pop[2 * w.P + p]);
      w.level[0 * w.P + p] = Math.min(w.level[0 * w.P + p], 1);
    }
    return { w: w, big: big };
  }
  var open = makeCrippled(1.3);
  var shut = makeCrippled(0);
  run(open.w, 180); run(shut.w, 180);
  var c0 = open.big;
  var grainOpen = grainPriceIndex(open.w, c0), grainShut = grainPriceIndex(shut.w, c0);
  var pcOpen = perCapitaOutput(open.w, c0), pcShut = perCapitaOutput(shut.w, c0);
  var imp = 0;
  for (var g = 0; g < open.w.G; g++) imp += open.w.impo[g * open.w.C + c0];

  console.log('   缺粮国：' + open.w.map.countries[c0].name +
    '   贸易下 λ=' + open.w.tradeWeight[c0].toFixed(3));
  console.log('   粮价指数    贸易 ' + grainOpen.toFixed(3) + '   闭关 ' + grainShut.toFixed(3));
  console.log('   人均产值    贸易 ' + (pcOpen * 1e6).toFixed(1) + '   闭关 ' + (pcShut * 1e6).toFixed(1) +
    '   （贸易高出 ' + ((pcOpen / pcShut - 1) * 100).toFixed(1) + '%）');
  console.log('   人口        贸易 ' + (open.w.popTotal[c0] / 1e6).toFixed(2) + 'M   闭关 ' +
    (shut.w.popTotal[c0] / 1e6).toFixed(2) + 'M');
  console.log('   不满        贸易 ' + open.w.unrestAvg[c0].toFixed(3) + '   闭关 ' +
    shut.w.unrestAvg[c0].toFixed(3));

  check('它确实在进口', imp > 0, '进口总量 ' + imp.toFixed(0));
  check('闭关时本国粮价明显更高（买不到便宜的粮）', grainShut > grainOpen * 1.05,
    '×' + (grainShut / grainOpen).toFixed(3));
  check('贸易让这个缺粮国明显更好过', pcOpen > pcShut * 1.02,
    '人均产值 +' + ((pcOpen / pcShut - 1) * 100).toFixed(1) + '%');
  check('贸易也压住了它的不满', open.w.unrestAvg[c0] < shut.w.unrestAvg[c0],
    open.w.unrestAvg[c0].toFixed(3) + ' < ' + shut.w.unrestAvg[c0].toFixed(3));
})();

/* ───────── P6 · 一国歉收会传到别国 ───────── */
group('P6 冲击传导：一国的歉收会不会变成全世界的粮价');
(function () {
  function build(lambda, shockOn) {
    var w = mk({ tradeLambda: lambda });
    run(w, 120);
    if (shockOn) {
      /* 找最大的产粮国，持续把它的谷物产出压在 60%（真实灾情通道就是这个乘数） */
      var best = 0, bestLv = -1;
      for (var c = 0; c < w.C; c++) {
        var lv = 0;
        for (var p = 0; p < w.P; p++) if (w.map.provinces[p].country === c) lv += w.level[p];
        if (lv > bestLv) { bestLv = lv; best = c; }
      }
      w._famineCountry = best;
    }
    return w;
  }
  var aO = build(1.3, false), bO = build(1.3, true);
  var aS = build(0, false), bS = build(0, true);
  for (var t = 0; t < 60; t++) {
    bO.harvestShock[bO._famineCountry] = 0.6;
    bS.harvestShock[bS._famineCountry] = 0.6;
    SIM.tick(aO); SIM.tick(bO); SIM.tick(aS); SIM.tick(bS);
  }
  var fc = bO._famineCountry;
  /* 别国：距离受灾国最远的那个 */
  var far = -1, farD = -1;
  for (var c2 = 0; c2 < aO.C; c2++) {
    var d = aO.dist[fc * aO.C + c2];
    if (c2 !== fc && d > farD) { farD = d; far = c2; }
  }
  var openJump = bO.price[0 * aO.C + far] / aO.price[0 * aO.C + far] - 1;
  var shutJump = bS.price[0 * aS.C + far] / aS.price[0 * aS.C + far] - 1;
  /* 探针：把不满分布打出来（只读，默认不生效） */
  if (globalThis.VIC_UNREST_DEBUG) {
    [['贸易世界', bO], ['封闭世界', bS]].forEach(function (pr) {
      var w = pr[1], P = w.P, mx = 0, sum = 0, over30 = 0, q = [];
      for (var p = 0; p < P; p++) {
        if (w.unrest[p] > mx) mx = w.unrest[p];
        if (w.unrest[p] > 0.30) over30++;
        sum += w.unrest[p]; q.push(w.unrest[p]);
      }
      q.sort(function (x, y) { return x - y; });
      console.log('   [探针] ' + pr[0] + ' 不满 均 ' + (sum / P).toFixed(4) +
        '  p50 ' + q[Math.floor(P * 0.5)].toFixed(3) +
        '  p90 ' + q[Math.floor(P * 0.9)].toFixed(3) +
        '  max ' + mx.toFixed(3) + '  >0.30: ' + over30 + '/' + P);
    });
  }
  console.log('   受灾国 ' + aO.map.countries[fc].name + '，观察最远的 ' +
    aO.map.countries[far].name + '（商路距离 ' + farD.toFixed(0) + '）');
  console.log('   该国粮价变动：贸易世界 ' + (openJump * 100).toFixed(2) + '%   封闭世界 ' +
    (shutJump * 100).toFixed(2) + '%');
  check('贸易世界里，远处的国家也会被别人的歉收抬高粮价', openJump > 0.005,
    '+' + (openJump * 100).toFixed(2) + '%');
  check('封闭世界里这层传导不存在（对照）', Math.abs(shutJump) < 0.001,
    (shutJump * 100).toFixed(3) + '%');
  check('传导确实来自贸易', openJump - shutJump > 0.004,
    '差值 ' + ((openJump - shutJump) * 100).toFixed(2) + ' 个百分点');
})();

console.log('\n────────────────────────────────────────────────────');
if (fail === 0) console.log('全部通过：' + pass + ' 项');
else console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
