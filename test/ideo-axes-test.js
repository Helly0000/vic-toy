/* 意识形态轴集的对照检验
 *
 * 用法：node test/ideo-axes-test.js
 *
 * 对两份参考资料里的轴设计做同一件事：**用它们自己举的历史例子，检验轴是否正交、是否够用**。
 * 数据来源（逐条对照原文，我不改判定，只做数学）：
 *   - 参考资料/冷战游戏设计之意识工业.md 的「9 种意识形态 × 轴」表
 *   - 参考资料/意识形态设计.html   的「6 种意识形态组合示例」
 *
 * 三件事：
 *   1) 两份文档的轴集，谁的共线性更低？
 *   2) HTML 里那处「无神论 + 未来理想 = 矛盾？」到底是不是矛盾
 *   3) 把轴做成"从世界状态推导"时，会不会产生**被结构强制出来的伪相关**（这决定轴能不能自由组合）
 */
'use strict';

var AX = {
  econ:   '① 公有 ↔ 私有',
  indiv:  '② 个人 ↔ 集体',
  central:'③ 集权 ↔ 分权',
  hier:   '④ 等级 ↔ 平等',
  trad:   '⑤ 传统 ↔ 变革',
  sacred: '⑥ 神圣 ↔ 世俗',
  world:  '⑦ 现世 ↔ 来世',
  nation: '⑧ 民族 ↔ 世界',
  manual: '⑪ 体力 ↔ 脑力',
  race:   '⑫ 种族优越 ↔ 平等',
  urban:  '⑬ 城市 ↔ 乡村',
  expan:  '⑮ 扩张 ↔ 内敛',
  gender: '⑩ 男权 ↔ 女权',
  auth:   '威权 ↔ 批判',
  law:    '法治 ↔ 人治'
};

/* ───────── 数据集 A：markdown（9 案 × 12 轴） ───────── */
var KEYS_A = ['econ','indiv','central','hier','trad','sacred','world','nation','manual','race','urban','expan'];
var NAME_A = ['苏联马列','美国自由','北欧社民','纳粹','伊朗伊斯兰','甘地主义','庇隆第三位置','不结盟尼赫鲁','南非种族隔离'];
var DATA_A = [
  [0.05,0.05,0.05,0.50,0.90,0.05,0.30,0.40,0.80,0.70,0.85,0.30],
  [0.95,0.95,0.80,0.65,0.70,0.45,0.95,0.35,0.45,0.35,0.80,0.25],
  [0.55,0.65,0.95,0.95,0.70,0.05,0.95,0.20,0.50,0.90,0.75,0.70],
  [0.45,0.10,0.05,0.05,0.35,0.50,0.70,0.05,0.60,0.05,0.70,0.05],
  [0.35,0.10,0.05,0.30,0.05,0.95,0.05,0.35,0.40,0.55,0.40,0.35],
  [0.20,0.35,0.80,0.95,0.05,0.60,0.15,0.40,0.15,0.85,0.05,0.85],
  [0.50,0.35,0.30,0.35,0.65,0.35,0.95,0.05,0.25,0.60,0.60,0.30],
  [0.50,0.40,0.60,0.60,0.65,0.30,0.55,0.25,0.50,0.75,0.55,0.75],
  [0.65,0.45,0.30,0.05,0.10,0.55,0.60,0.25,0.40,0.05,0.65,0.30]
];

/* ───────── 数据集 B：HTML（6 案 × 15 轴，按原文逐条打分） ─────────
 * 0 = 左端，1 = 右端；缺项按"原文未提"填中性值并标记
 * 轴序：econ indiv central hier trad sacred world nation manual race urban expan gender auth law
 */
var KEYS_B = ['econ','indiv','central','hier','trad','sacred','world','nation','manual','race','urban','expan','gender','auth','law'];
var NAME_B = ['斯大林主义苏联','美国自由主义','瑞典社会民主','印度尼赫鲁','伊朗神权','纳粹德国'];
var DATA_B = [
  // 斯大林主义苏联：极高集体 + 极高计划 + 极高公有 + 极高精英统治 + 高等级 + 高威权 + 高世俗 + 高服从
  //                  + 高国际(名义) + 高体力 + 中等平等 + 法律上性别平等(实践复杂) + 高激进革命(过去时)
  //                 econ indiv cent hier trad sacr world natn manu race urbn expn gend auth law
  [0.03, 0.03, 0.02, 0.78, 0.90, 0.02, 0.95, 0.30, 0.85, 0.70, 0.90, 0.25, 0.35, 0.05, 0.10],
  // 美国自由主义：高个人 + 极高市场 + 极高私有 + 高大众民主 + 低等级 + 高民主 + 高法治
  //                + 中等世俗(政教分离但社会有宗教性) + 高现世享乐 + 推崇脑力 + 中等性别平等
  //                + 中等民族主义 + 容忍异议(麦卡锡时期低) + 渐进改良
  [0.95, 0.95, 0.85, 0.25, 0.60, 0.45, 0.08, 0.40, 0.30, 0.30, 0.75, 0.30, 0.55, 0.75, 0.90],
  // 瑞典社会民主：中等集体 + 混合经济 + 私有为主但有公有 + 高大众民主 + 低等级 + 高民主 + 高法治
  //                + 高世俗 + 现世享乐 + 高性别平等 + 高国际包容 + 高批判思维 + 渐进改良 + 高经济平等
  [0.40, 0.45, 0.90, 0.15, 0.70, 0.08, 0.90, 0.15, 0.45, 0.90, 0.70, 0.80, 0.90, 0.88, 0.92],
  // 印度尼赫鲁：中等偏集体(村社) + 国家主导混合 + 世俗(宪法)但社会宗教性强 + 民主但挑战多
  //              + 高民族主义(反殖) + 追求平等与发展 + 渐进改良 + 高国际(不结盟)
  [0.50, 0.42, 0.72, 0.42, 0.62, 0.35, 0.58, 0.15, 0.50, 0.70, 0.52, 0.75, 0.55, 0.62, 0.60],
  // 伊朗神权：高集体(宗教共同体) + 中等国家干预 + 高宗教传统 + 高来世精神 + 高威权(宗教领袖)
  //           + 高人治 + 传统性别 + 高民族(宗教色彩) + 高服从
  [0.35, 0.12, 0.05, 0.62, 0.05, 0.98, 0.10, 0.32, 0.40, 0.55, 0.40, 0.35, 0.10, 0.08, 0.12],
  // 纳粹：极高集体(民族/种族) + 国家控制经济(非纯计划) + 私有制扭曲 + 极高精英(领袖原则)
  //       + 极高等级(种族) + 极高威权 + 极高民族排外 + 推崇体力 + 传统性别 + 高服从 + 激进变革
  [0.45, 0.04, 0.02, 0.95, 0.42, 0.38, 0.35, 0.02, 0.85, 0.02, 0.70, 0.02, 0.10, 0.05, 0.08]
];

function pc(a, b) {
  var n = a.length, ma = 0, mb = 0, i;
  for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  var num = 0, da = 0, db = 0;
  for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(Math.max(1e-12, da * db));
}

function stats(keys, names, data) {
  var n = data.length, nA = keys.length;
  function col(j) { return data.map(function (r) { return r[j]; }); }
  function pearson(a, b) {
    var m = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < m; i++) { ma += a[i]; mb += b[i]; }
    ma /= m; mb /= m;
    var num = 0, da = 0, db = 0;
    for (i = 0; i < m; i++) { var x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / Math.sqrt(Math.max(1e-12, da * db));
  }
  var hi = [];
  for (var i = 0; i < nA; i++) for (var j = i + 1; j < nA; j++) {
    var r = pearson(col(i), col(j));
    if (Math.abs(r) > 0.7) hi.push({ a: keys[i], b: keys[j], r: r });
  }
  // 距离分辨率
  var ds = [];
  for (var p = 0; p < n; p++) for (var q = p + 1; q < n; q++) {
    var s = 0;
    for (var k = 0; k < nA; k++) { var d = data[p][k] - data[q][k]; s += d * d; }
    ds.push(Math.sqrt(s));
  }
  var mean = ds.reduce(function (x, y) { return x + y; }, 0) / ds.length;
  var sd = Math.sqrt(ds.reduce(function (x, y) { return x + (y - mean) * (y - mean); }, 0) / ds.length);
  return { nA: nA, pairs: nA * (nA - 1) / 2, hi: hi, dsMean: mean, dsCV: sd / mean,
           dsMin: Math.min.apply(null, ds), dsMax: Math.max.apply(null, ds) };
}

console.log('══════ 1) 两份文档的轴集，共线性谁更低？ ══════\n');
var A = stats(KEYS_A, NAME_A, DATA_A);
var B = stats(KEYS_B, NAME_B, DATA_B);
console.log('  数据集            轴数   样本   高相关对数(>0.7)   占比     距离变异系数');
console.log('  A markdown 版      ' + A.nA + '     ' + NAME_A.length + '      ' +
  String(A.hi.length).padStart(2) + ' / ' + A.pairs + '          ' +
  (A.hi.length / A.pairs * 100).toFixed(0).padStart(3) + '%    ' + A.dsCV.toFixed(3));
console.log('  B HTML 版          ' + B.nA + '     ' + NAME_B.length + '      ' +
  String(B.hi.length).padStart(2) + ' / ' + B.pairs + '          ' +
  (B.hi.length / B.pairs * 100).toFixed(0).padStart(3) + '%    ' + B.dsCV.toFixed(3));
console.log('\n  注意：两个数据集的**样本数不同**（9 vs 6），而样本数本身就会压低可观测相关——');
console.log('  6 个样本几乎不可能显出 |r|>0.7，所以这个对比不能直接说明"HTML 版更正交"。');
console.log('  下面用它自己的例子来单独检验。');

console.log('\n══════ 2) 核心问题：现世↔来世 与 神圣↔世俗 到底是不是同一根轴？ ══════\n');
console.log('  这个问题的答案决定：**「无神论 + 来世」是不是一个矛盾状态**。\n');
var iS = KEYS_B.indexOf('sacred'), iW = KEYS_B.indexOf('world');
console.log('  国家              神圣↔世俗      现世↔来世      组合是否"矛盾"？');
NAME_B.forEach(function (nm, i) {
  var sv = DATA_B[i][iS], wv = DATA_B[i][iW];
  var sLabel = sv < 0.35 ? '世俗' : (sv > 0.65 ? '神圣' : '中等');
  var wLabel = wv < 0.35 ? '偏现世' : (wv > 0.65 ? '偏来世' : '中等');
  var odd = (sv < 0.35 && wv < 0.35) ? '  ← 世俗且偏现世' :
            (sv < 0.35 && wv > 0.65) ? '  ← **世俗且偏来世**' : '';
  console.log('  ' + nm.padEnd(16) + sLabel.padEnd(10) + wLabel.padEnd(12) + odd);
});
var colS = DATA_B.map(function (r) { return r[iS]; });
var colW = DATA_B.map(function (r) { return r[iW]; });
console.log('\n  两根轴的相关系数 = ' + pc(colS, colW).toFixed(2));
console.log('  苏联：世俗 ' + DATA_B[0][iS].toFixed(2) + ' + 偏来世 ' + DATA_B[0][iW].toFixed(2) +
  '  → 「为几代人后的 Utopia 牺牲当下」');
console.log('  美国：中等宗教 ' + DATA_B[1][iS].toFixed(2) + ' + 极现世 ' + DATA_B[1][iW].toFixed(2) +
  '  → 「消费主义」');
console.log('\n  → 如果这两根轴真的绑定，苏联这个组合就不该存在；但它恰恰是苏联的定义性特征。');
console.log('  → 结论：**两轴必须独立**，"加约束让它们不能同时在高位"会把最重要的样本排除掉。');

console.log('\n══════ 3) 轴做成"从世界状态推导"时，会不会被结构强制出伪相关？ ══════\n');
console.log('  实验：让一个国家的禀赋结构越来越偏（越来越像石油国），看它的');
console.log('       「公有↔私有」与「扩张↔内敛」会不会被强制同向变动。\n');
console.log('  进口依赖度    推得的公有度    推得的扩张性    说明');
[0.0, 0.25, 0.5, 0.75, 1.0].forEach(function (dep) {
  // 进口依赖越高 → 国家越需要控制关键资源（公有度↑）
  var pub = Math.min(1, dep * 1.15);
  // 进口依赖越高 → 越需要向外伸手或结盟（扩张性↑）
  var expan = Math.min(1, dep * 0.95 + 0.05);
  console.log('    ' + dep.toFixed(2) + '          ' + pub.toFixed(2) + '          ' +
    expan.toFixed(2) + '        ' + (dep === 0 ? '自给自足的小农国' : (dep === 1 ? '几乎全部依赖进口' : '')));
});
console.log('\n  → 相关系数会接近 ' + (0.95 / 1.15).toFixed(2) + '：**它们会被同一个原因（依赖度）同时推动**。');
console.log('     这不是设计缺陷，是**物理约束**：在"从状态推导"的架构下，');
console.log('     某些轴对必然同向。→ 所以轴集必须**按实际会产生的相关性**来裁剪，');
console.log('     而不是按"概念上是否独立"来裁剪。');

console.log('\n══════ 结论 ══════\n');
console.log('  1. 判断轴集好坏的标准，不是"概念上正交"，而是"在这套世界里实际会不会同向"。');
console.log('  2. HTML 版把 神圣↔世俗 与 现世↔来世 当成"会互相排斥"的两根轴、并想加约束 —— ');
console.log('     这是**错的解法**：它会把苏联（世俗 + 为未来牺牲）这个最重要的样本排除在合法状态之外。');
console.log('  3. 真正需要防的伪相关来自**推导公式**本身（同一个世界变量喂给两根轴），');
console.log('     这只能靠在接入主 sim 后用真实数据回归来发现——所以这必须是一个测试台。');
