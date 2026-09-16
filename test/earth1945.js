/* 真实世界线的**分析工具**（数据本身已经搬走了）
 *
 * ⚠ 这个文件现在只是一个薄适配层。真正的数据在 `data/earth1945.js`，
 *   那里的格式是"一个国家一行、一个省一行"，并且会被 `data/scenario.js` 的
 *   校验器逐条检查。这个文件保留下来，是因为 `test/earth-run.js` 与
 *   `test/factor-sweep.js` 用到的两把**尺子**（结构距离、汇总）与它们无关，
 *   换数据源不该让尺子也跟着重写。
 *
 * 曾经这里有一份 16 国的手写资源表。它已经被 29 国的数据层取代 ——
 * 而且不再是一张"国家 → 要素"的孤表：现在每个国家的人口由它的省份加总而来，
 * 每个省的禀赋会被映射成 sim 真正使用的四条通道（见 test/endow-calib.js）。
 * 也就是说，**这张表已经接进模拟了**，不再只用于判定实验。
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
var SC = VIC.scenario;
var DEF = SC.get('earth1945');

/* 五个真实要素 → 商品的映射（沿用设计文档里的那一版，不做改动）。
 *   谷物 ← 耕地   布料 ← 人口/轻工业   木材 ← 森林   工具 ← 矿产   奢侈品 ← 工业 */
var GOOD_TO_FACTOR_KEYS = ['farm', 'ind', 'wood', 'mine', 'ind'];

/* 国家表：补上 pop（由省份加总）与 id，保持老调用方的字段名 */
var COUNTRIES = (function () {
  var pop = {};
  DEF._prov.forEach(function (p) { pop[p.c] = (pop[p.c] || 0) + p.p; });
  return DEF.countries.map(function (c, i) {
    return {
      id: i, tag: c.tag, name: c.name, color: c.color, accent: c.accent,
      pop: pop[c.tag] || 0,
      farm: c.factors.farm, oil: c.factors.oil, mine: c.factors.mine,
      wood: c.factors.wood, ind: c.factors.ind,
      factors: c.factors, _73: (DEF.eras && DEF.eras[1973]) ? DEF.eras[1973][c.tag] : null
    };
  });
})();

/* 某要素的世界总量（把"占世界百分比"换成可比的绝对量） */
function sumOf(key, era) {
  var e = (era === 1973 && DEF.eras) ? DEF.eras[1973] : null;
  var s = 0;
  for (var i = 0; i < COUNTRIES.length; i++) {
    var f = (e && e[COUNTRIES[i].tag]) || COUNTRIES[i].factors;
    s += f[key] || 0;
  }
  return s;
}

/* 一个国家的要素表（带时代覆盖） */
function factorsOf(tag, era) {
  var e = (era === 1973 && DEF.eras) ? DEF.eras[1973] : null;
  var c = null;
  for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i].tag === tag) c = COUNTRIES[i];
  if (!c) return null;
  var f = (e && e[tag]) || c.factors;
  return { farm: f.farm || 0, oil: f.oil || 0, mine: f.mine || 0, wood: f.wood || 0, ind: f.ind || 0 };
}

/* ───────── 尺子：产业结构不对称 ─────────
 * 与随机地图用的是同一把：0 = 与世界平均一致，1 = 与世界平均完全不相交。
 * levels: [国家][商品] → 该国该商品的建筑总级（或任何"产能"代理量）
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

/* 从一张 map 建出真实地球世界（era 可以取 1973，用于「时代解锁」实验） */
function buildEarth(era, opts) {
  opts = opts || {};
  return SC.build(DEF, { seed: opts.seed || 1945, era: era });
}

/* 从跑过一段时间的 sim 世界里读出"各国各商品的建筑总级"——新的尺子读数方式。
 * 老版本读的是一张手工折算的 levels 表；现在直接读模拟自己的产出结构，
 * 因为禀赋已经真的接进模拟了。 */
function levelsByCountry(w) {
  var C = w.C, G = w.G, P = w.P;
  var out = [];
  for (var c = 0; c < C; c++) out.push(new Array(G).fill(0));
  for (var p = 0; p < P; p++) {
    var cc = w.map.provinces[p].country;
    for (var g = 0; g < G; g++) out[cc][g] += w.level[g * P + p];
  }
  return out;
}

module.exports = {
  DEF: DEF, COUNTRIES: COUNTRIES, buildEarth: buildEarth,
  GOOD_TO_FACTOR: GOOD_TO_FACTOR_KEYS, sumOf: sumOf, factorsOf: factorsOf,
  structuralDistance: structuralDistance, summarize: summarize,
  levelsByCountry: levelsByCountry,
  GOODS: VIC.sim.GOODS
};
