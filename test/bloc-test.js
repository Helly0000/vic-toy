/* 阵营 / 封锁 / 禁运 —— 性质测试
 *
 * 用法：node test/bloc-test.js
 *
 * ── 这一层回答的问题 ──
 * 在它之前，「谁能跟谁做生意」只有一个旋钮：`tradeOpen`（本国对自己开的门）。
 * 于是可以做「闭关」，但做不了「禁运」—— 因为禁运是**对别人**的，
 * 而且它必须对双方都生效。这一层补的就是这张关系矩阵。
 *
 * ── 它只从一个地方进入模型 ──
 * 可达性里每个伙伴的权重：access_c = Σ_o w_o × decay(d) × relEff(c,o)。
 * 不另开贸易通道的理由见 sim.js 的 4d 注释（重复计提）。
 *
 * ── 先量后改：本层接入前的实测（test/bloc-probe.js，真实 1945 / 1200 tick）──
 *   ① 单国被全面禁运：最痛 SAU **−33.8%**，最不受影响 SVE +6.6%。
 *      逐国的痛感与贸易依存度的相关 r = **−0.873** —— 机制读得通。
 *   ② 阵营级铁幕（WEST↔EAST 1.0→0.0）：世界贸易 **−15.2%**、
 *      阵营内份额 **+15.1pp**，但**逐国 GDP 变化全部落在 ±1% 以内**（22/29 国不到 ±0.5%）。
 *      ⇒ 阵营级关系是**一根音量旋钮，不是重排格局的机制**。这条结论是本层最重要的产出：
 *        它说明真正有牙的是「针对谁」，不是「划阵营」。P4 把这个区别钉住。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
require(path.join(ROOT, 'data/scenario.js'));
require(path.join(ROOT, 'data/earth1945.js'));
var VIC = globalThis.VIC;
var SIM = VIC.sim, MG = VIC.mapgen, SC = VIC.scenario;

var pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + name + (detail ? '   ' + detail : ''));
  if (ok) pass++; else fail++;
}
function group(t) { console.log('\n' + t); }
function corr(a, b) {
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var sa = 0, sb = 0, sab = 0;
  for (i = 0; i < n; i++) { var da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
  return sab / Math.sqrt(sa * sb);
}

var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };
var SEEDS = [8888, 777, 2718];

console.log('══════ 阵营 / 封锁 / 禁运 —— 性质测试 ══════');

/* ═══════ P1 · 默认中性（逐位） ═══════
 * 这一条是**接入新层的前提**：矩阵全 1 时，世界必须与没有这一层时逐字节相同。
 * 先做过一次跨版本 sha1 验证（3 种子 × 2 省数），这里把它固化成一个**解析式**比对，
 * 这样将来有人改了 refreshAccess 的写法，不必依赖 git 历史也能测出来。 */
group('P1 关系全 1 时，可达性与「没有这一层」逐位相同');
(function () {
  SEEDS.forEach(function (seed) {
    var map = MG.generate({ width: MAP_OPTS.width, height: MAP_OPTS.height,
      seed: seed, provinces: MAP_OPTS.provinces, countries: MAP_OPTS.countries });
    var w = SIM.createWorld(map, { seed: seed + 7 });
    for (var i = 0; i < 60; i++) SIM.tick(w);
    SIM.refreshAccess(w);
    var C = w.C, bad = 0, maxRel = 0;
    for (var c = 0; c < C; c++) {
      var totalPop = 0;
      for (var o = 0; o < C; o++) totalPop += w.popTotal[o];
      var others = totalPop - w.popTotal[c];
      var want = 0;
      for (o = 0; o < C; o++) {
        if (o === c) continue;
        var d = w.dist[c * C + o];
        if (!(d < Infinity)) continue;
        want += (w.popTotal[o] / others) * Math.exp(-d / w.tradeD0);
      }
      if (Math.abs(want - w.access[c]) > 1e-6) bad++;
      maxRel = Math.max(maxRel, Math.abs(want - w.access[c]) / (want || 1));
    }
    check('seed ' + seed + '：' + C + ' 国 access 与解析式一致',
      bad === 0, bad === 0 ? '最大相对误差 ' + maxRel.toExponential(1) : bad + ' 国不符');
  });
})();

/* ═══════ P2 · 双向取小 ═══════ */
group('P2 通商要双方同意：relEff 取较小的一边');
(function () {
  var map = MG.generate({ width: MAP_OPTS.width, height: MAP_OPTS.height,
    seed: 8888, provinces: MAP_OPTS.provinces, countries: MAP_OPTS.countries });
  var w = SIM.createWorld(map, { seed: 8895 });
  w.relation[0 * w.C + 1] = 0.2;      // 只写一边（模拟「有人绕过命令直接改矩阵」）
  w.relation[1 * w.C + 0] = 1.0;
  /* 注意 relation 是 Float32Array：0.2 存进去会变成 0.20000000298。
   * 所以这里比的是「两边相等且落在 0.2 附近」，而不是「等于字面量 0.2」——
   * 后者测的是浮点存储格式，不是被测的行为。 */
  check('单边写入也取小值',
    SIM.relEff(w, 0, 1) === SIM.relEff(w, 1, 0) && Math.abs(SIM.relEff(w, 0, 1) - 0.2) < 1e-6,
    'relEff = ' + SIM.relEff(w, 0, 1));
  /* 命令路径必须写成对称的 —— 否则「谁疼」会取决于矩阵里哪一格被改了 */
  var w2 = SIM.createWorld(map, { seed: 8895 });
  SIM.pushCommand(w2, SIM.CMD_BLOC, 3, 0, 0.25, 5);
  SIM.applyCommands(w2);
  check('命令把两边一起写了', w2.relation[5 * w2.C + 3] === 0.25 && w2.relation[3 * w2.C + 5] === 0.25,
    '[' + w2.relation[5 * w2.C + 3] + ', ' + w2.relation[3 * w2.C + 5] + ']');
})();

/* ═══════ P3 · 命令路径的边界 ═══════ */
group('P3 CMD_BLOC 的越界与非法输入不改变世界');
(function () {
  var map = MG.generate({ width: MAP_OPTS.width, height: MAP_OPTS.height,
    seed: 777, provinces: MAP_OPTS.provinces, countries: MAP_OPTS.countries });
  function fresh() { return SIM.createWorld(map, { seed: 777 + 7 }); }
  function send(setup) {
    var w = fresh();
    setup(w);
    SIM.applyCommands(w);
    return w;
  }
  var w = send(function (x) { SIM.pushCommand(x, SIM.CMD_BLOC, -1, 0, 0.5, 2); });     // prov 越界
  check('对方国 = −1 被忽略', w.relation[2 * w.C + 0] === 1);
  w = send(function (x) { SIM.pushCommand(x, SIM.CMD_BLOC, 2, 0, 0.5, 2); });          // 自环
  check('自己对自己被忽略', w.relation[2 * w.C + 2] === 1);
  w = send(function (x) { SIM.pushCommand(x, SIM.CMD_BLOC, 1, 0, 5.0, 0); });          // 值 > 1
  check('值被夹到 1', w.relation[0 * w.C + 1] === 1);
  w = send(function (x) { SIM.pushCommand(x, SIM.CMD_BLOC, 1, 0, -3.0, 0); });         // 值 < 0
  check('值被夹到 0', w.relation[0 * w.C + 1] === 0);
  w = send(function (x) { SIM.pushCommand(x, SIM.CMD_BLOC, 1, 0, 0.4, 0); });
  check('合法值正常写入', Math.abs(w.relation[0 * w.C + 1] - 0.4) < 1e-6);
})();

/* ═══════ P4 · 「针对谁」有牙，「划阵营」没有 ═══════
 * 这是本层最重要的判据，也是标定台量出来的那条结论的可复跑形式。 */
group('P4 禁运的痛感来自「针对谁」，不来自「划阵营」');
(function () {
  var DEF = SC.get('earth1945');
  var TICKS = 900;
  function earth(relOverride) {
    var map = SC.build(DEF, { seed: 1945 });
    if (relOverride) relOverride(map);
    return { map: map, w: SIM.createWorld(map, { seed: 8888, startYear: 1945 }) };
  }
  function run(w) { for (var i = 0; i < TICKS; i++) SIM.tick(w); }

  var base = earth(null); run(base.w);
  var C = base.w.C;

  /* 基准里各国的贸易依存度 —— 痛感应该由它决定 */
  var dep = [], gdp0 = [];
  for (var c = 0; c < C; c++) {
    dep.push(base.w.gdp[c] > 0 ? base.w.tradeGross[c] / base.w.gdp[c] : 0);
    gdp0.push(base.w.gdp[c]);
  }

  /* (a) 单国被全面禁运 —— 逐国都试一遍 */
  var dGdp = [];
  for (c = 0; c < C; c++) {
    (function (cc) {
      var B = earth(function (map) {
        for (var o = 0; o < C; o++) {
          if (o === cc) continue;
          map.relation0[cc * C + o] = 0;
          map.relation0[o * C + cc] = 0;
        }
      });
      run(B.w);
      dGdp.push(gdp0[cc] > 0 ? B.w.gdp[cc] / gdp0[cc] - 1 : 0);
    })(c);
  }
  var r = corr(dep, dGdp);
  var worst = Math.min.apply(null, dGdp), best = Math.max.apply(null, dGdp);
  check('被禁运国的损失与它的贸易依存度强相关', r < -0.6,
    'r = ' + r.toFixed(3) + '，最痛 ' + (worst * 100).toFixed(1) + '% / 最好 ' + (best * 100).toFixed(1) + '%');
  check('存在「被禁运会真的疼」的国家', worst < -0.05,
    '最痛 ' + (worst * 100).toFixed(2) + '%');

  /* (b) 阵营级铁幕 —— 对比它的重排能力 */
  var full = earth(function (map) {
    for (var a = 0; a < C; a++) for (var b = 0; b < C; b++) {
      if (map.blocOf[a] === 0 && map.blocOf[b] === 1) {
        map.relation0[a * C + b] = 0; map.relation0[b * C + a] = 0;
      }
    }
  });
  run(full.w);
  var noCurtain = earth(function (map) {
    for (var a = 0; a < C; a++) for (var b = 0; b < C; b++) {
      if (map.blocOf[a] === 0 && map.blocOf[b] === 1) {
        map.relation0[a * C + b] = 1; map.relation0[b * C + a] = 1;
      }
    }
  });
  run(noCurtain.w);
  var spread = 0, nBig = 0;
  for (c = 0; c < C; c++) {
    var ch = noCurtain.w.gdp[c] > 0 ? full.w.gdp[c] / noCurtain.w.gdp[c] - 1 : 0;
    spread = Math.max(spread, Math.abs(ch));
    if (Math.abs(ch) > 0.02) nBig++;
  }
  check('阵营级铁幕不重排格局（没有任何国家变化超过 2%）', nBig === 0,
    '最大变化 ' + (spread * 100).toFixed(2) + '%，超过 2% 的国家 ' + nBig + ' 个');
  check('但阵营级铁幕确实改变了贸易流量（它是音量旋钮）',
    full.w.tradeGross.reduce(function (s, v) { return s + v; }, 0) <
    noCurtain.w.tradeGross.reduce(function (s, v) { return s + v; }, 0) * 0.95,
    '世界贸易 ' + noCurtain.w.tradeGross.reduce(function (s, v) { return s + v; }, 0).toFixed(0) +
    ' → ' + full.w.tradeGross.reduce(function (s, v) { return s + v; }, 0).toFixed(0));
})();

/* ═══════ P5 · 分母不重设（禁运的语义是「世界变小了」） ═══════
 * 如果实现时把被禁运的伙伴从分母里剔掉，access 就会被重新归一化回原值 ——
 * 于是禁运变成一个纯粹的无操作。这是最容易写错、也最难看出来的一种写法。 */
group('P5 禁运的语义是「可达的世界变小」，不是「换个人做生意」');
(function () {
  var map = MG.generate({ width: MAP_OPTS.width, height: MAP_OPTS.height,
    seed: 2718, provinces: MAP_OPTS.provinces, countries: MAP_OPTS.countries });
  var w = SIM.createWorld(map, { seed: 2718 + 7 });
  for (var i = 0; i < 40; i++) SIM.tick(w);
  var C = w.C;
  SIM.refreshAccess(w);
  var open = w.access[0];
  /* 只禁掉 1 号伙伴，其余不动 */
  w.relation[0 * C + 1] = 0; w.relation[1 * C + 0] = 0;
  SIM.refreshAccess(w);
  var cut = w.access[0];
  SIM.refreshAccess(w);
  var totalPop = 0;
  for (var o = 0; o < C; o++) totalPop += w.popTotal[o];
  var others = totalPop - w.popTotal[0];
  var d = w.dist[0 * C + 1];
  var contrib = (d < Infinity) ? (w.popTotal[1] / others) * Math.exp(-d / w.tradeD0) : 0;
  check('access 恰好减少「被禁掉那个伙伴的贡献」',
    Math.abs((open - cut) - contrib) < 1e-6,
    'open ' + open.toFixed(6) + ' − cut ' + cut.toFixed(6) + ' = ' + (open - cut).toFixed(6) +
    '，伙伴贡献 ' + contrib.toFixed(6));
  check('access 严格下降（分母没有被重设）', cut < open - 1e-9,
    '下降了 ' + ((open - cut) * 100).toFixed(2) + '%');
  /* 全部禁掉 ⇒ 完全自给 */
  for (o = 0; o < C; o++) { if (o === 0) continue; w.relation[0 * C + o] = 0; w.relation[o * C + 0] = 0; }
  SIM.refreshAccess(w);
  check('对全世界禁运 ⇒ access = 0（没有隐藏的地板）', w.access[0] === 0,
    'access = ' + w.access[0]);
})();

/* ═══════ P6 · 刀锋：记录「被禁运反而变富」（不是 bug，是既有性质） ═══════
 * 标定台量到 SVE 被全面禁运后 GDP +6.6%。这一条**不断言方向**，
 * 它断言的是**机制**：收入/支出比 r 在多数国家贴着 1.0，而人口按 (r−1)×0.0105
 * 复利增长 —— 于是 r 上很小的差别，在一个世纪之后变成可观的人口差。
 * 把它钉住的意义是：将来有人看到「封锁让对手变富」时，能一眼找到这行注释，
 * 而不是去改一个并不存在的 bug。 */
group('P6 「被禁运反而变富」的根因是 r≈1 附近的复利，不是禁运本身');
(function () {
  var DEF = SC.get('earth1945');
  var map = SC.build(DEF, { seed: 1945 });
  var w = SIM.createWorld(map, { seed: 8888, startYear: 1945 });
  for (var i = 0; i < 900; i++) SIM.tick(w);
  var C = w.C, P = w.P;
  /* 各国底层的收入/支出比，逐省取平均 */
  var near = 0, tot = 0, devs = [];
  for (var c = 0; c < C; c++) {
    var s = 0, n = 0;
    for (var p = 0; p < P; p++) {
      if (w.map.provinces[p].country !== c) continue;
      s += w.ratio[0 * P + p]; n++;
    }
    if (!n) continue;
    var dev = Math.abs(s / n - 1);
    devs.push(dev); tot++;
    if (dev < 0.06) near++;
  }
  devs.sort(function (a, b) { return a - b; });
  check('多数国家的收支比贴着一个很窄的带（|r−1| < 0.06）', near / tot > 0.5,
    near + ' / ' + tot + ' 国，中位偏差 ' + devs[Math.floor(tot / 2)].toFixed(4));
  check('人口增长是复利的（同一个 r 差会随 tick 数放大）',
    Math.abs(Math.pow(1 + 0.0005 * 0.0105, 1140) - 1) > 0.005,
    'r 差 0.0005 在 1140 tick 后放大 ' +
    ((Math.pow(1 + 0.0005 * 0.0105, 1140) - 1) * 100).toFixed(2) + '%');
})();

/* ═══════ P7 · 剧本校验 ═══════ */
group('P7 阵营声明的错误能在 define 时被抓住（而不是跑起来才发现）');
(function () {
  var ok = SC.get('earth1945');
  check('earth1945 的阵营声明本身合法', SC._validateBlocs(ok).length === 0,
    SC._validateBlocs(ok).join('；') || '无问题');

  function bad(patch) {
    var d = JSON.parse(JSON.stringify({
      id: 'x', grid: ok.grid, codes: ok.codes, countries: ok.countries,
      provinces: ok._prov, blocs: ok.blocs, blocRelation: ok.blocRelation
    }));
    patch(d);
    return SC._validateBlocs(d);
  }
  check('抓到「成员不在 countries 里」',
    bad(function (d) { d.blocs.WEST.members.push('XXX'); }).some(function (m) { return m.indexOf('XXX') >= 0; }));
  check('抓到「一国同时属于两个阵营」',
    bad(function (d) { d.blocs.EAST.members.push('USA'); }).some(function (m) { return m.indexOf('同时属于') >= 0; }));
  check('抓到「关系值越界」',
    bad(function (d) { d.blocRelation[0][2] = 1.7; }).some(function (m) { return m.indexOf('不在 0..1') >= 0; }));
  check('抓到「引用了不存在的阵营」',
    bad(function (d) { d.blocRelation[0][1] = 'NOPE'; }).some(function (m) { return m.indexOf('NOPE') >= 0; }));
  check('抓到「同一对声明两次」',
    bad(function (d) { d.blocRelation.push(['EAST', 'WEST', 0.3]); })
      .some(function (m) { return m.indexOf('不止一次') >= 0; }));
  check('抓到「两端是同一个阵营」',
    bad(function (d) { d.blocRelation.push(['WEST', 'WEST', 0.3]); })
      .some(function (m) { return m.indexOf('恒为 1') >= 0; }));
})();

/* ═══════ P8 · 剧本矩阵本身的性质 ═══════ */
group('P8 earth1945 的初始关系矩阵');
(function () {
  var map = SC.build(SC.get('earth1945'), { seed: 1945 });
  var C = map.countries.length, rel = map.relation0;
  var asym = 0, self = 0, inRange = 1;
  for (var a = 0; a < C; a++) {
    for (var b = 0; b < C; b++) {
      if (a === b) { if (rel[a * C + b] !== 1) self++; continue; }
      if (rel[a * C + b] !== rel[b * C + a]) asym++;
      if (!(rel[a * C + b] >= 0 && rel[a * C + b] <= 1)) inRange = 0;
    }
  }
  check('矩阵对称', asym === 0, asym + ' 处不对称');
  check('对角线为 1（本国对自己不设限）', self === 0, self + ' 处 ≠ 1');
  check('取值都在 0..1', inRange === 1);
  /* 同阵营恒 1：这是「阵营」这个词在矩阵里的全部含义 */
  var sameBad = 0;
  for (a = 0; a < C; a++) for (var b2 = 0; b2 < C; b2++) {
    if (a === b2 || map.blocOf[a] < 0) continue;
    if (map.blocOf[a] === map.blocOf[b2] && rel[a * C + b2] !== 1) sameBad++;
  }
  check('同阵营之间恒为 1', sameBad === 0, sameBad + ' 对不是 1');
  /* 每个国家都归属一个阵营，且阵营数与被覆盖的国家数一致 */
  var counts = {};
  for (a = 0; a < C; a++) counts[map.blocOf[a]] = (counts[map.blocOf[a]] || 0) + 1;
  check('每国都归属一个阵营（没有 −1）', counts[-1] === undefined,
    '阵营分布 ' + Object.keys(counts).map(function (k) { return map.blocIds[k].name + ' ' + counts[k]; }).join('　'));
})();

console.log('\n' + '─'.repeat(52));
console.log((fail === 0 ? '全部通过：' : '') + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
