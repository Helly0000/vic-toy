/* 真实 1945 世界线 —— 最小原型（用于检验"要素上限"这个设计假设）
 *
 * 这不是要替换地图生成器，而是一个**判定性实验**：
 *   问：把真实世界的资源分布接进模型之后，
 *       (a) 各国产业结构会不会真的变得高度不平衡？
 *       (b) 不设「要素上限」时，大数定律会不会把它重新摊平？
 *
 * 数据说明（诚实标注）：
 *   - 16 个主要国家，人口/耕地/石油/矿产/森林/工业六个维度，都是**1945 年前后的历史量级**。
 *   - 它们的绝对精度不高（凭历史常识给的数量级，不是数据库），但**相对不平衡是真实的**：
 *     1945 年美国占世界石油产量约 2/3、工业产能近一半；印度有巨量耕地和人口但几乎没有石油；
 *     沙特有世界级石油储量但当时尚未开发。这份粗糙度不影响本次判定——
 *     我们要测的是"不平衡能不能传导到模型输出"，不是复原史实。
 *   - 每个国家的 dimension 值有两条：`*45`（1945 年）与 `*73`（1973 年），
 *     用来验证"时代解锁"：同一个世界，只换一张资源表，稀缺的东西就该换人。
 *
 * 用法：node test/earth1945.js         （只吃 js/sim.js，不碰 DOM）
 */
'use strict';

/* ═══════════ 真实 1945 世界线：16 国 ═══════════
 * 每个数字是该国占**世界总量**的百分比（同一维度内可比）。
 * land = 国土面积（百万平方公里，真实值，用于省份大小与人口密度）
 * pop  = 1945 年人口（百万，真实量级）
 * farm = 耕地禀赋；oil = 石油禀赋；mine = 矿产禀赋；wood = 森林禀赋；ind = 工业产能
 * 后三行 *_73 是 1973 年的同一维度，用于「时代解锁」实验。
 */
var COUNTRIES = [
  { tag: 'USA', name: '美利坚合众国', lat: 39, lon: -98, land: 9.83, pop: 140, provs: 8,
    farm: 17, oil: 35, mine: 13, wood: 8, ind: 46,
    _73: { farm: 16, oil: 14, mine: 14, wood: 8, ind: 30 } },
  { tag: 'SUN', name: '苏维埃联盟', lat: 58, lon: 60, land: 22.4, pop: 170, provs: 10,
    farm: 15, oil: 9, mine: 20, wood: 24, ind: 18,
    _73: { farm: 15, oil: 14, mine: 18, wood: 24, ind: 20 } },
  { tag: 'GBR', name: '大英帝国', lat: 53, lon: -2, land: 0.24, pop: 49, provs: 4,
    farm: 2, oil: 1, mine: 5, wood: 1, ind: 9,
    _73: { farm: 2, oil: 1, mine: 4, wood: 1, ind: 5 } },
  { tag: 'FRA', name: '法兰西', lat: 47, lon: 2, land: 0.55, pop: 40, provs: 4,
    farm: 4, oil: 0.3, mine: 3, wood: 3, ind: 5,
    _73: { farm: 5, oil: 0.3, mine: 2, wood: 3, ind: 5 } },
  { tag: 'DEU', name: '德意志', lat: 51, lon: 10, land: 0.36, pop: 65, provs: 4,
    farm: 3, oil: 0.5, mine: 6, wood: 2, ind: 7,
    _73: { farm: 3, oil: 0.3, mine: 4, wood: 2, ind: 8 } },
  { tag: 'JPN', name: '日本', lat: 36, lon: 138, land: 0.38, pop: 72, provs: 3,
    farm: 1.5, oil: 0.1, mine: 1, wood: 2, ind: 3,
    _73: { farm: 1.5, oil: 0.1, mine: 1, wood: 2, ind: 9 } },
  { tag: 'CHN', name: '中国', lat: 35, lon: 105, land: 9.6, pop: 540, provs: 8,
    farm: 16, oil: 0.5, mine: 7, wood: 6, ind: 2,
    _73: { farm: 16, oil: 2, mine: 7, wood: 6, ind: 5 } },
  { tag: 'IND', name: '印度', lat: 21, lon: 78, land: 3.3, pop: 350, provs: 5,
    farm: 17, oil: 0.4, mine: 5, wood: 5, ind: 2,
    _73: { farm: 16, oil: 0.5, mine: 5, wood: 5, ind: 3 } },
  { tag: 'BRA', name: '巴西', lat: -10, lon: -52, land: 8.5, pop: 46, provs: 4,
    farm: 5, oil: 0.3, mine: 4, wood: 12, ind: 2,
    _73: { farm: 7, oil: 0.6, mine: 5, wood: 12, ind: 3 } },
  { tag: 'SAU', name: '沙特阿拉伯', lat: 24, lon: 45, land: 2.15, pop: 3, provs: 3,
    farm: 0.3, oil: 19, mine: 1, wood: 0, ind: 0.3,
    _73: { farm: 0.3, oil: 24, mine: 1, wood: 0, ind: 1 } },
  { tag: 'IRN', name: '伊朗', lat: 32, lon: 53, land: 1.65, pop: 15, provs: 3,
    farm: 2, oil: 6, mine: 2, wood: 0.5, ind: 0.5,
    _73: { farm: 2, oil: 11, mine: 2, wood: 0.5, ind: 1 } },
  { tag: 'VEN', name: '委内瑞拉', lat: 8, lon: -66, land: 0.92, pop: 5, provs: 2,
    farm: 1, oil: 9, mine: 1, wood: 2, ind: 0.5,
    _73: { farm: 1, oil: 3, mine: 1, wood: 2, ind: 1 } },
  { tag: 'CAN', name: '加拿大', lat: 56, lon: -106, land: 10, pop: 12, provs: 4,
    farm: 6, oil: 3, mine: 6, wood: 10, ind: 3,
    _73: { farm: 5, oil: 10, mine: 6, wood: 9, ind: 4 } },
  { tag: 'AUS', name: '澳大利亚', lat: -25, lon: 134, land: 7.7, pop: 7, provs: 3,
    farm: 5, oil: 0.2, mine: 5, wood: 3, ind: 1.5,
    _73: { farm: 5, oil: 0.5, mine: 6, wood: 3, ind: 2 } },
  { tag: 'IDN', name: '印度尼西亚', lat: -2, lon: 118, land: 1.9, pop: 70, provs: 3,
    farm: 5, oil: 3, mine: 3, wood: 8, ind: 0.3,
    _73: { farm: 5, oil: 4, mine: 3, wood: 8, ind: 0.8 } },
  { tag: 'EGY', name: '埃及', lat: 27, lon: 30, land: 1.0, pop: 19, provs: 2,
    farm: 2, oil: 0.5, mine: 1, wood: 0, ind: 0.4,
    _73: { farm: 2, oil: 1, mine: 1, wood: 0, ind: 0.7 } }
];

/* ═══════════ 商品 → 真实要素的映射 ═══════════
 * 现有 5 种商品各自挂到一个真实要素上（这就是"有限要素"的落点）：
 *   谷物 ← 耕地      布料 ← 人口/轻工业      木材 ← 森林      工具 ← 矿产      奢侈品 ← 工业
 * 1945 与 1973 的区别只在数据表（见 *_73），机制完全一样 —— 这就是"时代解锁"。
 */
var GOOD_TO_FACTOR = ['farm', 'ind', 'wood', 'mine', 'ind'];

function sumOf(key, era) {
  var s = 0;
  for (var i = 0; i < COUNTRIES.length; i++) {
    var c = COUNTRIES[i];
    s += (era === 1973 && c._73) ? c._73[key] : c[key];
  }
  return s;
}

/* ═══════════ 构建一个"真实地球"世界 ═══════════
 * 不需要多边形：sim 只用到 { area, cx, cy, country, neighbors }，
 * 所以这里给出一个无几何的纯逻辑世界（要显示时再补多边形即可）。
 */
function buildEarth(era) {
  var C = COUNTRIES.length;
  var provinces = [];
  var countries = [];
  var totalLand = 0, totalPop = 0;
  var i, c, p;

  // 世界总量（用于把"占世界百分比"换成绝对量）
  var world = {};
  ['farm', 'oil', 'mine', 'wood', 'ind'].forEach(function (k) { world[k] = sumOf(k, era); });
  var worldPop = 0, worldLand = 0;
  for (i = 0; i < C; i++) { worldPop += COUNTRIES[i].pop; worldLand += COUNTRIES[i].land; }

  for (i = 0; i < C; i++) {
    c = COUNTRIES[i];
    countries.push({ id: i, name: c.name, tag: c.tag,
      color: 'hsl(' + Math.round(i * 360 / C) + ' 42% 46%)', accent: 'hsl(' + Math.round(i * 360 / C) + ' 52% 68%)' });
    totalLand += c.land; totalPop += c.pop;

    var era4 = (era === 1973 && c._73) ? c._73 : c;
    // 省面积按人口 + 国土分担（真实人口密度差异巨大：印度 106 人/km² vs 加拿大 1.2）
    for (p = 0; p < c.provs; p++) {
      var share = 1 / c.provs;
      provinces.push({
        id: provinces.length,
        name: c.name + '-' + (p + 1),
        country: i,
        // 面积单位：百万平方公里 × 1000（只用于人口密度与权重，量级自洽即可）
        area: c.land * 1000 * share * (0.7 + 0.6 * ((p * 37) % 11) / 10),
        cx: 0, cy: 0, sx: 0, sy: 0,
        // 经纬度只用于显示：同国省份散开一点
        lat: c.lat + ((p % 3) - 1) * 6, lon: c.lon + (Math.floor(p / 3) - 1) * 9,
        neighbors: [],
        // —— 真实要素：先把国家层面的量按省均分，再给 ±40% 的省内差异 ——
        // 注意：popShare 在下面第二个循环里统一赋值，这里不写，避免"赋值两次"的坑
        popShare: 0,
        _factor: {},
        _factorShare: {}
      });
    }
  }

  /* 给每个省分配要素与人口的绝对值。
   * 抖动必须**按国家归一化**：第一版直接用 jitter/provs，平均值只有 0.879，
   * 于是全国人口少了 12%、要素也整体缩水 —— 自检当场抓住。
   * 归一化后：Σ(prov.popShare) 恰好等于全国人口，要素同理。 */
  var idx = 0;
  for (i = 0; i < C; i++) {
    c = COUNTRIES[i];
    var e = (era === 1973 && c._73) ? c._73 : c;
    // 1) 先把本国的 jitter 算出来并求和
    var jit = [], jsum = 0;
    for (p = 0; p < c.provs; p++) {
      var j = 0.65 + 0.7 * (((p * 53) % 17) / 16);        // 确定性抖动，不用 RNG
      jit.push(j); jsum += j;
    }
    // 2) 再按归一化后的比例摊到各省
    for (p = 0; p < c.provs; p++) {
      var prov = provinces[idx++];
      var k2 = jit[p] / jsum;                             // Σ k2 = 1
      prov.popShare = c.pop * k2;
      ['farm', 'oil', 'mine', 'wood', 'ind'].forEach(function (key) {
        prov._factor[key] = (e[key] || 0) * k2;
        prov._factorShare[key] = (e[key] || 0) / c.provs;
      });
    }
  }

  // 简单的环状邻接（同国相邻 + 跨国的少量接壤），只用于让 world 结构合法
  for (i = 0; i < provinces.length; i++) {
    provinces[i].neighbors = [provinces[(i + 1) % provinces.length].id];
  }

  // 自检：分摊后各国人口之和必须等于原始人口之和（踩过"popShare 被赋值两次"的坑）
  var checkPop = 0;
  for (i = 0; i < provinces.length; i++) checkPop += provinces[i].popShare;
  if (Math.abs(checkPop - worldPop) > 1) {
    throw new Error('人口分摊不一致：' + checkPop.toFixed(1) + ' vs ' + worldPop);
  }

  return {
    width: 1600, height: 1000,
    mask: new Uint8Array(1600 * 1000),     // 纯逻辑世界不需要陆地掩码
    provinces: provinces,
    countries: countries,
    landCount: 0, seedCount: provinces.length,
    _meta: { world: world, worldPop: worldPop, worldLand: worldLand, era: era }
  };
}

/* ═══════════ 测量：产业结构不对称 ═══════════
 * 与 /tmp/vt-coldwar2.cjs 里同一把尺子，便于和随机地图直接对比。
 * levels: [国家][商品] → 该国该商品的建筑总级
 */
function structuralDistance(levels, C, G) {
  var prod = new Float64Array(C * G), world = new Float64Array(G);
  for (var c = 0; c < C; c++) for (var g = 0; g < G; g++) {
    prod[c * G + g] = levels[c][g]; world[g] += levels[c][g];
  }
  var wt = 0; for (var g2 = 0; g2 < G; g2++) wt += world[g2];
  var ref = []; for (var g3 = 0; g3 < G; g3++) ref.push(world[g3] / (wt || 1));
  var rows = [];
  for (var c2 = 0; c2 < C; c2++) {
    var tot = 0; for (var g4 = 0; g4 < G; g4++) tot += prod[c2 * G + g4];
    if (tot <= 0) continue;
    var dist = 0, maxR = 0;
    for (var g5 = 0; g5 < G; g5++) {
      var sh = prod[c2 * G + g5] / tot;
      dist += Math.abs(sh - ref[g5]);
      maxR = Math.max(maxR, sh / Math.max(1e-9, ref[g5]));
    }
    rows.push({ c: c2, dist: dist / 2, maxR: maxR });
  }
  return rows;
}
function summarize(rows) {
  var d = rows.map(function (r) { return r.dist; });
  return {
    avg: d.reduce(function (a, b) { return a + b; }, 0) / d.length,
    max: Math.max.apply(null, d), min: Math.min.apply(null, d),
    maxRatio: Math.max.apply(null, rows.map(function (r) { return r.maxR; }))
  };
}

module.exports = {
  COUNTRIES: COUNTRIES, buildEarth: buildEarth, GOOD_TO_FACTOR: GOOD_TO_FACTOR,
  structuralDistance: structuralDistance, summarize: summarize, sumOf: sumOf
};
