/* 要素 → 商品 映射的标定台（v3：逐国逐商品直算，不做矩阵组装）
 *
 * 用法：node test/factor-sweep.js
 *
 * 走到这里的三次失败（每次都被数据打回来）：
 *   ① 1:1 平面表：沙特 ×115 的人均石油禀赋，传导到产能只剩 ×1.43（被平均稀释）
 *   ② 多要素取 min：中国谷物被 0.037 的工业卡死（×0.04）—— 20 世纪的粮食不需要工厂
 *   ③ 幂平均单侧：印度谷物仍被工业拖到 ×0.12
 *
 * v3 的结构：
 *     自给率 = min( 资源侧, 工业侧 )
 *       资源侧 = 该国该资源的份额 ÷ 该国人口的份额（世界平均 = 1）
 *       工业侧 = 1 + (工业份额/人口份额 − 1) × 敏感度      ← 敏感度 0 = 完全不需要工厂
 *     粮食：资源侧主导（敏感度低）；机械：两侧都要（敏感度高）
 *
 * 一条重要的工程教训（这次踩了三次）：**先把形状和有限性验掉，再谈结论**。
 *   前两版的 NaN/形状错误都是"累加器组装"环节引入的，而它发生在所有校验之后。
 *   所以这一版改成：每个数字当场算出来、当场断言，不经过任何中间容器。
 */
'use strict';

var path = require('path');
var E = require(path.join(__dirname, 'earth1945.js'));

var GOODS = ['谷物', '布料', '木材', '工具', '奢侈品'];
var GKEYS = ['farm', 'cloth', 'wood', 'tools', 'lux'];

/* 资源要素：谷物/布料←耕地，木材←森林，工具/奢侈品←矿产 */
var RES_OF = { farm: 'farm', cloth: 'farm', wood: 'wood', tools: 'mine', lux: 'mine' };
/* 工业敏感度：0 = 完全不需要工厂；1 = 完全靠工厂 */
var SENS = { farm: 0.15, cloth: 0.55, wood: 0.25, tools: 0.85, lux: 0.70 };

var MAX_MULT = 2.5, MIN_MULT = 0.35;

function num(v, what) {
  if (typeof v !== 'number' || !isFinite(v)) {
    throw new Error('不是有限数：' + what + ' = ' + v);
  }
  return v;
}

/* 预计算：世界总量 + 各国汇总（一次性，全部当场校验） */
function world(era) {
  var wf = {};
  ['farm', 'oil', 'wood', 'mine', 'ind'].forEach(function (f) {
    wf[f] = num(E.sumOf(f, era), '世界要素 ' + f);
  });
  var wp = 0;
  E.COUNTRIES.forEach(function (c) { wp += num(c.pop, '国家人口 ' + c.tag); });
  return { worldFactor: wf, worldPop: wp };
}

/* 把"份额"做成闭包，避免到处除零 */
function shareOf(amount, total, what) {
  return num(amount, what) / Math.max(1e-9, num(total, what + ' 总量'));
}

/* 核心：算出某国某商品的自给率（1.0 = 正好自给） */
function selfSufficiency(era, countryIdx, gkey) {
  var W = world(era);
  var c = E.COUNTRIES[countryIdx];
  var era4 = (era === 1973 && c._73) ? c._73 : c;

  var popShare = shareOf(c.pop, W.worldPop, c.tag + ' 人口');
  var resKey = RES_OF[gkey];

  // 资源侧：该国该资源占世界比 ÷ 该国人口占世界比
  var resSide = shareOf(era4[resKey] || 0, W.worldFactor[resKey], c.tag + ' ' + resKey) / popShare;
  resSide = Math.min(MAX_MULT, Math.max(MIN_MULT, resSide));

  // 工业侧：工业份额相对人口份额的偏离，按敏感度打折
  var indRaw = shareOf(era4.ind || 0, W.worldFactor.ind, c.tag + ' 工业') / popShare;
  var indSide = 1 + (indRaw - 1) * SENS[gkey];
  indSide = Math.min(MAX_MULT, Math.max(MIN_MULT, indSide));

  var v = Math.min(resSide, indSide);
  return num(v, c.tag + ' × ' + gkey + ' 自给率');
}

/* 组装矩阵：显式二维，逐格调用（形状不可能出错） */
function matrix(era) {
  var M = [];
  for (var c = 0; c < E.COUNTRIES.length; c++) {
    var row = [];
    for (var g = 0; g < 5; g++) row.push(selfSufficiency(era, c, GKEYS[g]));
    M.push(row);
  }
  return M;
}

/* ── 史实断言 ── */
var idx = {};
E.COUNTRIES.forEach(function (c, i) { idx[c.tag] = i; });
function rankOf(M, g) {
  var a = M.map(function (row, i) { return { i: i, v: row[g] }; });
  a.sort(function (u, v) { return v.v - u.v; });
  return a.map(function (x) { return x.i; });
}
function assertions(M) {
  return [
    ['印度在谷物上应进前 3（耕地 + 人口）', rankOf(M, 0).slice(0, 3).indexOf(idx.IND) >= 0],
    ['中国在谷物上应进前 5', rankOf(M, 0).slice(0, 5).indexOf(idx.CHN) >= 0],
    ['日本谷物应低于世界平均（山地岛国）', M[idx.JPN][0] < 1.0],
    ['美国在奢侈品(工业)上应是世界第 1', rankOf(M, 4)[0] === idx.USA],
    ['沙特在工具(矿产)上应进前 5', rankOf(M, 3).slice(0, 5).indexOf(idx.SAU) >= 0],
    ['苏联或加拿大在木材上应进前 5',
      rankOf(M, 2).slice(0, 5).indexOf(idx.SUN) >= 0 || rankOf(M, 2).slice(0, 5).indexOf(idx.CAN) >= 0]
  ];
}

console.log('══════ 要素→商品 标定 v3（真实 1945 世界线） ══════\n');

var SETS = [
  { name: 'S1 粮食完全不靠工业', s: { farm: 0.00, cloth: 0.55, wood: 0.25, tools: 0.85, lux: 0.70 } },
  { name: 'S2 粮食轻微靠工业', s: { farm: 0.15, cloth: 0.55, wood: 0.25, tools: 0.85, lux: 0.70 } },
  { name: 'S3 粮食也吃工业', s: { farm: 0.40, cloth: 0.65, wood: 0.35, tools: 0.95, lux: 0.75 } }
];

var best = null;
SETS.forEach(function (set) {
  SENS = set.s;
  var M = matrix(1945);
  var checks = assertions(M);
  var pass = checks.filter(function (x) { return x[1]; }).length;

  var all = [];
  M.forEach(function (r) { r.forEach(function (v) { all.push(v); }); });
  var mean = all.reduce(function (a, b) { return a + b; }, 0) / all.length;
  var sd = Math.sqrt(all.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / all.length);

  console.log('【' + set.name + '】 断言 ' + pass + '/6   自给率 均值 ' + mean.toFixed(2) +
    '  变异系数 ' + (sd / mean).toFixed(2) +
    '  范围 ' + Math.min.apply(null, all).toFixed(2) + '~' + Math.max.apply(null, all).toFixed(2));
  checks.forEach(function (k) { console.log('    ' + (k[1] ? '✓' : '✗') + ' ' + k[0]); });
  console.log('    抽样：印度谷物 ' + M[idx.IND][0].toFixed(2) + '  中国谷物 ' + M[idx.CHN][0].toFixed(2) +
    '  美国奢侈品 ' + M[idx.USA][4].toFixed(2) + '  沙特工具 ' + M[idx.SAU][3].toFixed(2) +
    '  日本谷物 ' + M[idx.JPN][0].toFixed(2));
  console.log('');

  var score = pass * 10 + Math.min(sd / mean, 1.5);
  if (!best || score > best.score) { best = { set: set, M: M, pass: pass, score: score }; }
});

SENS = best.set.s;
console.log('══════ 最佳：' + best.set.name + '（断言 ' + best.pass + '/6）══════\n');
var M45 = matrix(1945), M73 = matrix(1973);

console.log('  1945 年自给率（< 1 标 ★ = 必须进口）');
console.log('  国家    ' + GOODS.map(function (g) { return g.padEnd(8); }).join(''));
E.COUNTRIES.forEach(function (c, i) {
  var line = '  ' + c.tag + '  ';
  for (var g = 0; g < 5; g++) line += (M45[i][g].toFixed(2) + (M45[i][g] < 1 ? '★' : ' ')).padEnd(8);
  console.log(line);
});

var rigid = 0;
M45.forEach(function (r) { r.forEach(function (v) { if (v < 1) rigid++; }); });
console.log('\n  刚性依赖：' + rigid + ' / ' + (M45.length * 5) +
  '（' + (rigid / (M45.length * 5) * 100).toFixed(0) + '%）← 贸易必需性');

console.log('\n══════ 时代解锁：1945 → 1973（机制一行不改，只换资源表）══════\n');
console.log('  商品        1945 最自给前三               1973 最自给前三');
GKEYS.forEach(function (k, g) {
  function top(M) {
    var a = M.map(function (r, i) { return { i: i, v: r[g] }; }).sort(function (u, v) { return v.v - u.v; });
    return a.slice(0, 3).map(function (x) { return E.COUNTRIES[x.i].tag + ' ' + x.v.toFixed(2); }).join('  ');
  }
  console.log('  ' + GOODS[g].padEnd(10) + top(M45).padEnd(28) + top(M73));
});
console.log('\n  注：石油目前只在 1973 的数据表里，还没进配方。要让"石油武器"成立，');
console.log('      下一步是把石油接进「工具/奢侈品」的工业侧——那是 1973 年真正卡脖子的地方。');
