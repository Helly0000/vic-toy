/* 蒸汽与账本 — 扫描地图种子，挑地理条件最好的
 *
 * 用法：  node test/seed.js [种子1 种子2 ...]
 * 不带参数则扫一批内置候选。
 *
 * 换地图时用这个：好的种子应该「国家大小均衡」「省份面积离散度低」。
 * 均衡度太低（某国只有 1~2 个省）会让国力排行一开始就锁死，玩起来很闷。
 *
 * 注意：地图生成的任何改动都会让这份排名洗牌。
 * 当前用的是 seed 8888（均衡度 0.35）—— 是在「修掉孤岛 bug 之前」的生成器下挑的，
 * 那之后播种和存活判据都改过，现在的榜首其实是 2718（0.46）。
 * 没换是因为换了要重跑全套视觉验证，收益不大。你想换的话：
 * 改 js/main.js 的 SEED → node test/check.js → 浏览器截图确认。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));

var seeds = process.argv.slice(2).map(Number).filter(function (n) { return !isNaN(n); });
if (!seeds.length) {
  seeds = [8888, 20260823, 777, 31337, 1234, 4242, 99991, 5150, 80808, 606,
           20250101, 31415, 2718, 555, 12345, 9001];
}

var rows = seeds.map(function (seed) {
  var t0 = Date.now();
  var m = VIC.mapgen.generate({ width: 1600, height: 1000, seed: seed, provinces: 260, countries: 8 });
  var per = new Array(m.countries.length).fill(0);
  for (var i = 0; i < m.provinces.length; i++) per[m.provinces[i].country]++;
  var areas = m.provinces.map(function (p) { return p.area; }).sort(function (a, b) { return a - b; });
  var spread = areas[Math.floor(areas.length * 0.95)] / areas[Math.floor(areas.length * 0.05)];
  return {
    seed: seed,
    C: m.countries.length,
    prov: m.provinces.length,
    bal: Math.min.apply(null, per) / Math.max.apply(null, per),
    mx: Math.max.apply(null, per),
    mn: Math.min.apply(null, per),
    spread: spread,
    ms: Date.now() - t0,
    per: per
  };
});

rows.sort(function (a, b) { return b.bal - a.bal; });

console.log('种子        国家  省份   均衡度   最大/最小   省面积p95/p05   耗时');
console.log('─'.repeat(70));
rows.forEach(function (r) {
  console.log(
    String(r.seed).padEnd(11) +
    String(r.C).padEnd(6) +
    String(r.prov).padStart(4) + '   ' +
    r.bal.toFixed(2).padStart(6) + '   ' +
    (r.mx + '/' + r.mn).padEnd(11) + ' ' +
    (r.spread.toFixed(1) + 'x').padEnd(14) + ' ' +
    (r.ms + 'ms')
  );
});

console.log('\n最好三个（按均衡度）:');
rows.slice(0, 3).forEach(function (r) {
  console.log('  seed ' + r.seed + '   均衡度 ' + r.bal.toFixed(2) +
    '   省份 ' + r.prov + '   每国 [' + r.per.join(',') + ']');
});
console.log('\n选定后改 js/main.js 里的 SEED，然后跑 node test/check.js 确认没退化。');
