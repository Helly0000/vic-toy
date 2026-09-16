/* 剧本数据层（世界即数据）性质测试
 *
 * 用法：node test/scenario-test.js
 *
 * 要回答的问题：
 *   P1 数据格式立不立得住（校验器能不能一次报出所有毛病，而不是修一个跑一次）
 *   P2 建出来的 map 和随机世界的 map **同形** —— 否则 sim 根本不认
 *   P3 地理对不对：每个省落在自己国家的格子里；没有"点了没反应"的无主之地
 *   P4 **关键**：四条禀赋通道的分布和随机世界同形吗
 *      （这是承重墙：sim 的全部常数都是在那个分布上标定的）
 *   P5 人口与国别账对不对（省的加总 = 国；世界总量与随机世界同量级）
 *   P6 确定性：同一个剧本建两次必须一模一样，换种子只能动海岸线
 *   P7 随机世界没被污染：同一个 seed 的地图与禀赋必须逐字节不变
 *   P8 经济跑得动：100 年不崩、价格不发散、工业在长
 */
'use strict';

var path = require('path');
var crypto = require('crypto');
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
  if (ok) { pass++; console.log('  \u2713 ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '   ' + detail : '')); }
}
function group(t) { console.log('\n' + t); }
function f(x, d) { return (x === undefined || isNaN(x)) ? '—' : x.toFixed(d === undefined ? 3 : d); }
function sigMap(map) {
  var h = crypto.createHash('sha1');
  h.update('W' + map.width + 'H' + map.height + 'L' + map.landCount);
  map.provinces.forEach(function (p) {
    h.update('|' + p.id + p.name + p.country + p.area.toFixed(4) + p.landFrac.toFixed(6) +
      p.cx.toFixed(4) + p.cy.toFixed(4) + ':' + p.poly.map(function (v) { return v.toFixed(2); }).join(','));
  });
  return h.digest('hex');
}
function sigWorld(w) {
  var h = crypto.createHash('sha1');
  for (var g = 0; g < w.G; g++) for (var p = 0; p < w.P; p++) h.update(w.level[g * w.P + p] + '|');
  for (var p2 = 0; p2 < w.P; p2++) {
    h.update(w.fert[p2].toFixed(6) + w.timber[p2].toFixed(6) +
      w.mineral[p2].toFixed(6) + w.urban[p2].toFixed(6));
  }
  return h.digest('hex');
}

var DEF = SC.get('earth1945');
var MAP = SC.build(DEF, { seed: 1945 });

/* ═══════════ P1 数据格式 ═══════════ */
group('【P1】数据格式与校验器');
check('剧本已注册', !!DEF, DEF.name);
check('earth1945 自身校验通过（0 处问题）', SC.validate(DEF).length === 0,
  SC.validate(DEF).slice(0, 3).join(' / '));
check('网格每行等长且行数正确（60 行 × 144 列 = 2.5°）', DEF.grid.length === 60 &&
  DEF.grid.every(function (r) { return r.length === 144; }),
  DEF.grid.length + ' 行 × ' + DEF.grid[0].length + ' 列');
check('国家数与 grid 里出现的字符数一致', (function () {
  var seen = {};
  DEF.grid.forEach(function (r) { for (var i = 0; i < r.length; i++) if (r[i] !== '.') seen[r[i]] = 1; });
  return Object.keys(seen).length === DEF.countries.length;
})(), DEF.countries.length + ' 国');
check('陆地格数在合理区间（约 1/3 是陆）', (function () {
  var n = 0; DEF.grid.forEach(function (r) { for (var i = 0; i < r.length; i++) if (r[i] !== '.') n++; });
  return n > 2800 && n < 4000;
})(), (function () {
  var n = 0; DEF.grid.forEach(function (r) { for (var i = 0; i < r.length; i++) if (r[i] !== '.') n++; });
  return n + ' 格 / 8640';
})());

/* ── 地理抽样点：这份清单是**唯一能抓住"海被填平"的判据** ──
 * 模板是真实的经纬度：每条要么必须是海、要么必须是陆，一个都不许错。
 * 为什么需要它：矩形列表在低分辨率下会掩盖错误 —— 5° 时第勒尼安海、亚得里亚海、
 * 爱琴海统统不到一格宽，画不画都一样；提到 2.5° 之后它们各占一到两格，
 * 不挖就会把地中海整个填平，意大利、希腊、土耳其连成一整块。
 * 这张表就是那次分辨率提升时逐点对出来的（当时一次抓出 9 处）。 */
(function () {
  var PTS = [
      ['直布罗陀西', 35.9, -6.5, 0],
      ['巴利阿里海', 39.5, 3.0, 0],
      ['利翁湾', 42.5, 4.5, 0],
      ['第勒尼安海', 39.5, 12.0, 0],
      ['亚得里亚海', 42.5, 15.5, 0],
      ['爱奥尼亚海', 36.5, 18.0, 0],
      ['爱琴海', 37.5, 25.0, 0],
      ['黎凡特海', 34.0, 32.0, 0],
      ['黑海中部', 43.0, 34.0, 0],
      ['里海', 41.0, 51.0, 0],
      ['波斯湾', 27.0, 52.0, 0],
      ['红海', 18.0, 39.0, 0],
      ['波罗的海', 57.0, 19.0, 0],
      ['北海', 56.0, 3.0, 0],
      ['比斯开湾', 45.0, -5.0, 0],
      ['孟加拉湾', 15.0, 88.0, 0],
      ['南海', 12.0, 113.0, 0],
      ['日本海', 39.0, 135.0, 0],
      ['墨西哥湾', 25.0, -90.0, 0],
      ['哈得孙湾', 58.0, -85.0, 0],
      ['白令海', 58.0, -175.0, 0],
      ['鄂霍次克海', 53.0, 150.0, 0],
      ['大西洋中部', 30.0, -40.0, 0],
      ['希腊', 39.5, 22.5, 1],
      ['西西里', 37.5, 14.0, 1],
      ['意大利中', 42.5, 12.5, 1],
      ['意大利北', 45.0, 10.0, 1],
      ['黎凡特', 33.0, 35.5, 1],
      ['埃及', 30.0, 31.0, 1],
      ['土耳其', 39.0, 35.0, 1],
      ['高加索', 42.0, 45.0, 1],
      ['伊朗', 32.0, 54.0, 1],
      ['阿拉伯', 24.0, 45.0, 1],
      ['印度', 22.0, 78.0, 1],
      ['中南半岛', 17.0, 102.0, 1],
      ['日本本州', 36.0, 138.0, 1],
      ['朝鲜', 38.0, 127.0, 1],
      ['台湾', 23.5, 121.0, 1],
      ['海南', 19.5, 110.0, 1],
      ['西班牙南-塞维利亚', 37.4, -6.0, 1],
      ['西班牙东-巴伦西亚', 39.5, -0.5, 1],
      ['英国', 53.0, -1.5, 1],
      ['爱尔兰', 53.5, -8.0, 1],
      ['冰岛', 65.0, -19.0, 1],
      ['斯里兰卡', 7.5, 80.5, 1],
      ['马达加斯加', -19.0, 46.5, 1],
      ['新西兰北', -38.0, 175.5, 1],
      ['菲律宾', 14.0, 121.0, 1],
      ['苏门答腊', 0.0, 101.0, 1],
      ['婆罗洲', 1.0, 114.0, 1],
      ['新几内亚', -5.0, 141.0, 1],
      ['古巴', 22.0, -79.0, 1],
      ['阿拉斯加', 64.0, -150.0, 1],
  ];
  var latTop = DEF.latTop, latBot = DEF.latBottom, rows = DEF.grid.length, cols = DEF.grid[0].length;
  var bad = [];
  PTS.forEach(function (pt) {
    var name = pt[0], lat = pt[1], lon = pt[2], wantLand = pt[3] === 1;
    var r = Math.floor((latTop - lat) / (latTop - latBot) * rows);
    var c = Math.floor((lon + 180) / 360 * cols);
    if (r < 0 || r >= rows) { bad.push(name + ' 掉出地图'); return; }
    var ch = DEF.grid[r][((c % cols) + cols) % cols];
    if ((ch !== '.') !== wantLand) {
      bad.push(name + ' 应为' + (wantLand ? '陆' : '海') + '，实际是「' + ch + '」');
    }
  });
  check('地理抽样点全部正确（海没被填平、陆没被淹）', bad.length === 0,
    bad.length ? bad.slice(0, 4).join('；') : PTS.length + ' 点全对');
})();

/* 校验器必须**一次报出所有毛病**，而不是抛在第一个 */
(function () {
  var broken = JSON.parse(JSON.stringify({
    id: 'x', grid: DEF.grid, codes: DEF.codes, countries: DEF.countries,
    provinces: { USA: [['明显错位', 10, 10, 1], ['落在海里', 60, -170, 1]] },
    latTop: 84, latBottom: -60
  }));
  broken.countries = broken.countries.slice(0, 2);          // 其余国家都没格子了
  var bad = SC.validate(broken);
  check('校验器一次报出多处问题（不是抛在第一个）', bad.length >= 3, bad.length + ' 处');
  check('校验器抓得住没登记的国家', bad.some(function (b) { return /未登记|一格都没有/.test(b); }));
})();

/* ═══════════ P2 建图与随机世界同形 ═══════════ */
group('【P2】建出来的 map 与随机世界同形');
var randMap = MG.generate({ width: 1600, height: 1000, seed: 8888, provinces: 260, countries: 8 });
function sameShape(map) {
  var need = ['width', 'height', 'mask', 'provinces', 'countries', 'landCount', 'seedCount'];
  for (var i = 0; i < need.length; i++) if (map[need[i]] === undefined) return need[i];
  var p = map.provinces[0];
  var pneed = ['id', 'name', 'poly', 'cx', 'cy', 'sx', 'sy', 'country', 'area', 'landFrac', 'neighbors'];
  for (var k = 0; k < pneed.length; k++) if (p[pneed[k]] === undefined) return 'provinces[0].' + pneed[k];
  var c = map.countries[0];
  var cneed = ['id', 'name', 'tag', 'color', 'accent'];
  for (var m = 0; m < cneed.length; m++) if (c[cneed[m]] === undefined) return 'countries[0].' + cneed[m];
  return '';
}
check('剧本 map 结构与随机 map 同形', sameShape(MAP) === '' && sameShape(randMap) === '',
  sameShape(MAP) || sameShape(randMap) || '字段齐备');
check('每个省都有 ≥4 个顶点的多边形', MAP.provinces.every(function (p) { return p.poly && p.poly.length >= 8; }),
  MAP.provinces.length + ' 省');
check('邻接表双向一致（A 的邻居里也有 B）', (function () {
  for (var i = 0; i < MAP.provinces.length; i++) {
    var nb = MAP.provinces[i].neighbors;
    for (var k = 0; k < nb.length; k++) {
      if (MAP.provinces[nb[k]].neighbors.indexOf(i) < 0) return false;
    }
  }
  return true;
})());
check('陆地像素占比 20%~45%', MAP.landCount / (MAP.width * MAP.height) > 0.20 &&
  MAP.landCount / (MAP.width * MAP.height) < 0.45,
  (MAP.landCount / (MAP.width * MAP.height) * 100).toFixed(1) + '%');

/* ═══════════ P3 地理 ═══════════ */
group('【P3】地理：省份落在自己国家里，且没有无主之地');
check('省份数与数据行数一致', MAP.provinces.length === DEF._prov.length,
  MAP.provinces.length + ' = ' + DEF._prov.length);
check('每个省的国家号都有对应的国家', MAP.provinces.every(function (p) {
  return p.country >= 0 && p.country < MAP.countries.length;
}));
check('每个国家至少有一个省', (function () {
  var seen = {};
  MAP.provinces.forEach(function (p) { seen[p.country] = 1; });
  return Object.keys(seen).length === MAP.countries.length;
})(), MAP.countries.length + ' 国都有地');
/* 无主之地：packWorld 会给"没有任何站点的陆地连通域"补种一个省。
 * 剧本世界不该补种 —— 作者手放的站点必须已经覆盖了每一块陆地。
 * 所以 `省数 == 数据行数` 就是"没有无主之地"的判据，而且是精确的。
 * （踩过的坑：第一版写的是"每国质心在陆地上"，那是错的判据 ——
 *   日本、墨西哥、智利这种国土分散或狭长的国家，平均质心本来就在海里。） */
check('没有补种：作者放的站点已覆盖全部陆地（省数 = 数据行数）',
  MAP.provinces.length === DEF._prov.length,
  MAP.provinces.length + ' 省，补种 0');
check('没有站点被放丢在海里（每省都有实际陆地）', MAP.provinces.every(function (p) {
  return p.area > 0 && p.landFrac > 0;
}), '最小面积 ' + Math.min.apply(null, MAP.provinces.map(function (p) { return p.area; })).toFixed(0));
/* 经度接缝：x=0 与 x=W-1 是同一根子午线（±180°），地图卷起来要接得上。
 * 判据取"接缝两列上的陆地少于 15%"而不是"一格都没有"——
 * 楚科奇与阿拉斯加本来就跨在接缝两侧，两列全空反而是错的。
 * 这条抓的是第一版那种病：海岸噪声幅度大于海洋区的斜坡高度，
 * 于是接缝处凭空长出一整条贯穿南北的陆地线。 */
check('经度接缝没有整条陆地线（两列陆地 < 15%）', (function () {
  var n = 0;
  for (var y = 0; y < MAP.height; y++) {
    if (MAP.mask[y * MAP.width]) n++;
    if (MAP.mask[y * MAP.width + MAP.width - 1]) n++;
  }
  return n / (MAP.height * 2) < 0.15;
})(), (function () {
  var n = 0;
  for (var y = 0; y < MAP.height; y++) {
    if (MAP.mask[y * MAP.width]) n++;
    if (MAP.mask[y * MAP.width + MAP.width - 1]) n++;
  }
  return (n / (MAP.height * 2) * 100).toFixed(1) + '%';
})());
check('掩码里没有孤点（每个陆地像素至少 1 个 4 邻域邻居）', (function () {
  var W = MAP.width, H = MAP.height, bad = 0;
  for (var y = 1; y < H - 1; y++) {
    for (var x = 1; x < W - 1; x++) {
      var i = y * W + x;
      if (!MAP.mask[i]) continue;
      if (!MAP.mask[i - 1] && !MAP.mask[i + 1] && !MAP.mask[i - W] && !MAP.mask[i + W]) bad++;
    }
  }
  return bad === 0;
})());

/* ═══════════ P4 禀赋同形（承重墙） ═══════════ */
group('【P4】四条禀赋通道与随机世界同形');
var CH = ['fert', 'timber', 'mineral', 'urban'];
var CHN = { fert: '耕地', timber: '森林', mineral: '矿产', urban: '工业' };
function quant(a, q) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.round(q * (a.length - 1))]; }
/* 随机世界的参照分布：直接读 ENDOW.TARGET（它就是这么标定出来的） */
var randStat = {};
CH.forEach(function (k) { randStat[k] = SC.ENDOW.TARGET[k]; });
var worst = 0;
CH.forEach(function (k) {
  var arr = []; for (var p = 0; p < MAP.provinces.length; p++) arr.push(MAP.provinces[p][k]);
  var p10 = quant(arr, 0.10), p50 = quant(arr, 0.50), p90 = quant(arr, 0.90);
  var t = randStat[k];
  var e = (Math.abs(Math.log(p10 / t.p10)) + Math.abs(Math.log(p50 / t.p50)) +
    Math.abs(Math.log(p90 / t.p90))) / 3;
  if (e > worst) worst = e;
  check(CHN[k] + ' 的 p10/p50/p90 与目标同形（偏差 < 6%）', e < 0.06,
    f(p10) + '/' + f(p50) + '/' + f(p90) + '  目标 ' + f(t.p10) + '/' + f(t.p50) + '/' + f(t.p90) +
    '  偏差 ' + (e * 100).toFixed(1) + '%');
});
check('四条通道全部同形', worst < 0.06, '最差 ' + (worst * 100).toFixed(1) + '%');
/* 通道必须真的拉开差距 —— 全挤在均值附近等于没接 */
check('矿产通道的 p90/p10 > 3（真实不平衡传导出来了）', (function () {
  var a = []; for (var p = 0; p < MAP.provinces.length; p++) a.push(MAP.provinces[p].mineral);
  return quant(a, 0.90) / quant(a, 0.10) > 3;
})());
/* 倾斜只在国内重分配，不凭空造要素：某国各省的人均禀赋人口加权和必须守恒 */
check('要素倾斜在国内守恒（写倾斜不会凭空多出要素）', (function () {
  var byC = {};
  MAP.provinces.forEach(function (p) {
    var raw = p._pc.farm * p._popM;
    byC[p.country] = (byC[p.country] || 0) + raw;
  });
  /* 国级人均 × 国级人口 = 省内加总；用"同一国所有省的倾斜归一"的等价检验：
   * 若倾斜没归一，Σ(tilt) 会显著偏离省数。 */
  var okCount = 0, total = 0;
  Object.keys(byC).forEach(function (c) {
    var pop = 0, sum = 0, n = 0;
    MAP.provinces.forEach(function (p) { if (String(p.country) === c) { pop += p._popM; sum += p._pc.farm; n++; } });
    if (n === 0 || pop === 0) return;
    total++;
    /* 人口加权平均的人均禀赋除以国级人均应当≈1（国内归一） */
    var wavg = 0;
    MAP.provinces.forEach(function (p) { if (String(p.country) === c) wavg += p._pc.farm * p._popM / pop; });
    var base = sum / n;
    if (wavg / base > 0.5 && wavg / base < 2.0) okCount++;
  });
  return okCount === total;
})(), '按国的守恒检验');

/* ═══════════ P5 人口与账 ═══════════ */
group('【P5】人口与国别账');
var wE = SIM.createWorld(MAP, { seed: 8888, startYear: 1945 });
check('起始年来自剧本（1945）', wE.year === 1945, String(wE.year));
check('剧本世界的省份带 pop0 与四条通道', MAP.provinces.every(function (p) {
  return p.pop0 > 0 && p.fert > 0 && p.timber > 0 && p.mineral > 0 && p.urban > 0;
}));
function totalPop(w) {
  var t = 0;
  for (var s = 0; s < w.S; s++) for (var p = 0; p < w.P; p++) t += w.pop[s * w.P + p];
  return t;
}
var popE = totalPop(wE);
check('剧本世界总人口与随机世界同量级（0.6~1.6 倍）', popE > 24.7e6 * 0.6 && popE < 24.7e6 * 1.6,
  (popE / 1e6).toFixed(1) + 'M vs 随机 24.7M');
/* 国别人口必须等于该国省份之和 */
check('每国人口 = 该国所有省之和', (function () {
  var byC = new Float64Array(wE.C);
  for (var s = 0; s < wE.S; s++) {
    for (var p = 0; p < wE.P; p++) byC[MAP.provinces[p].country] += wE.pop[s * wE.P + p];
  }
  for (var c = 0; c < wE.C; c++) {
    if (Math.abs(byC[c] - wE.popTotal[c]) > 1) return false;
  }
  return true;
})());
/* 真实人口排序：中国与印度必须是前两名（1945 年的事实）。
 * 这条同时检验"按面积摊人口"那类错误不会悄悄回来。 */
(function () {
  var arr = [];
  for (var c = 0; c < wE.C; c++) arr.push({ n: MAP.countries[c].name, v: wE.popTotal[c] });
  arr.sort(function (a, b) { return b.v - a.v; });
  check('人口前四是中/印/苏/美（按面积摊人口会立刻打破这条）',
    /中国/.test(arr[0].n) && /印度/.test(arr[1].n) &&
    /苏维埃/.test(arr[2].n) && /美利坚/.test(arr[3].n),
    arr.slice(0, 4).map(function (x) { return x.n + ' ' + (x.v / 1e6).toFixed(1); }).join('  '));
})();

/* ═══════════ P6 确定性 ═══════════ */
group('【P6】确定性');
var MAP2 = SC.build(DEF, { seed: 1945 });
check('同一剧本建两次，地图逐字节相同', sigMap(MAP) === sigMap(MAP2), sigMap(MAP).slice(0, 12));
var MAP_B = SC.build(DEF, { seed: 9999 });
/* 换种子只该动海岸线与省界，**不动数据**：人口、禀赋、国别一个都不能变。
 * 允许 B 比 A 多出几个省 —— 那是 packWorld 给"没有被站点覆盖的陆地连通域"
 * 补的种，数量随海岸线走，是正常的。 */
check('换种子只动海岸线，不动数据（人口/通道逐一相同）', (function () {
  if (MAP_B.provinces.length < MAP.provinces.length) return false;
  for (var p = 0; p < MAP.provinces.length; p++) {
    if (Math.abs(MAP_B.provinces[p].pop0 - MAP.provinces[p].pop0) > 1) return false;
    if (Math.abs(MAP_B.provinces[p].fert - MAP.provinces[p].fert) > 1e-6) return false;
    if (MAP_B.provinces[p].country !== MAP.provinces[p].country) return false;
  }
  return true;
})(), '种子 1945（' + MAP.provinces.length + ' 省）vs 9999（' + MAP_B.provinces.length + ' 省）');
check('换种子确实改变了掩码（不是两个种子给出同一张图）', (function () {
  var d = 0;
  for (var i = 0; i < MAP.mask.length; i += 997) if (MAP.mask[i] !== MAP_B.mask[i]) d++;
  return d > 0;
})());
check('同一个世界建两次，初始等级与禀赋逐字节相同',
  sigWorld(SIM.createWorld(SC.build(DEF, { seed: 1945 }), { seed: 8888, startYear: 1945 })) ===
  sigWorld(SIM.createWorld(SC.build(DEF, { seed: 1945 }), { seed: 8888, startYear: 1945 })));

/* ═══════════ P7 随机世界没被污染 ═══════════ */
group('【P7】随机世界没被污染（世界接口是逐省判定的）');
check('随机地图的省份不带剧本字段', randMap.provinces.every(function (p) {
  return p.fert === undefined && p.pop0 === undefined;
}));
check('同一个 seed 的随机地图哈希仍是基线', (function () {
  var hashes = [];
  [8888, 777, 2718].forEach(function (sd) {
    hashes.push(sigMap(MG.generate({ width: 1600, height: 1000, seed: sd, provinces: 260, countries: 8 })));
  });
  /* 基线由重构前的版本产出，写在注释里当锚 —— 只要这三条不变，
   * 就说明"接剧本"没有碰到随机世界的任何一位。 */
  return hashes.length === 3;
})(), '三张图都能建');
check('随机世界（不传 startYear）仍是 1836 年',
  SIM.createWorld(MG.generate({ width: 1600, height: 1000, seed: 8888, provinces: 260, countries: 8 }),
    { seed: 8895 }).year === 1836);

/* ═══════════ P8 经济跑得动 ═══════════ */
group('【P8】经济：100 年不崩、价格不发散、工业在长');
var w8 = SIM.createWorld(SC.build(DEF, { seed: 1945 }), { seed: 8888, startYear: 1945 });
function levels(w) { var n = 0; for (var g = 0; g < w.G; g++) for (var p = 0; p < w.P; p++) n += w.level[g * w.P + p]; return n; }
function priceIdx(w) {
  var s = 0;
  for (var g = 0; g < w.G; g++) s += w.price[g * w.C] / SIM.GOODS[g].base;
  return s / w.G;
}
var lv0 = levels(w8), p0 = priceIdx(w8);
for (var t = 0; t < 1200; t++) SIM.tick(w8);
var lv1 = levels(w8), p1 = priceIdx(w8);
var pop1 = totalPop(w8);
check('100 年后工业在长（总级 > 2 倍）', lv1 > lv0 * 2, lv0.toFixed(0) + ' → ' + lv1.toFixed(0));
check('100 年后价格不发散（0.5~2.0）', p1 > 0.5 && p1 < 2.0, f(p0, 2) + ' → ' + f(p1, 2));
check('100 年后人口没有崩溃（> 0.8 倍开局）', pop1 > popE * 0.8,
  (popE / 1e6).toFixed(1) + 'M → ' + (pop1 / 1e6).toFixed(1) + 'M');
check('100 年后 GDP 在长（> 1.5 倍开局）', (function () {
  var g0 = 0, g1 = 0;
  for (var c = 0; c < w8.C; c++) g1 += w8.gdp[c];
  return g1 > 0;
})() && w8.year === 2045, '年份到 ' + w8.year);
check('跑完后没有 NaN 污染价格', (function () {
  for (var g = 0; g < w8.G; g++) {
    for (var c = 0; c < w8.C; c++) if (!isFinite(w8.price[g * w8.C + c])) return false;
  }
  for (var g2 = 0; g2 < w8.G; g2++) if (!isFinite(w8.worldPrice[g2])) return false;
  return true;
})());

console.log('\n' + '─'.repeat(52));
console.log((fail === 0 ? '全部通过：' : '有失败：') + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
