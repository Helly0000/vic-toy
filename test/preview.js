/* 蒸汽与账本 — 无浏览器预览地图形状
 *
 * 用法：  node test/preview.js [seed] [列数]
 * 例：    node test/preview.js 8888 104
 *
 * 为什么需要它：改地图生成参数时，起浏览器 + 截图 + 肉眼看的循环太慢。
 * 这个脚本把陆地掩码降采样成 ASCII，一秒就能看出大陆形状对不对。
 * 当初"大陆是个完美圆盘"和"整块大陆被删光"这两个 bug 都是靠它定位的。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));

var seed = parseInt(process.argv[2], 10) || 8888;
var CW = parseInt(process.argv[3], 10) || 104;
var CH = Math.max(8, Math.round(CW * 1000 / 1600 / 2.5));

var map = VIC.mapgen.generate({ width: 1600, height: 1000, seed: seed, provinces: 260, countries: 8 });
var W = map.width, H = map.height;

var out = '', land = 0;
for (var cy = 0; cy < CH; cy++) {
  var line = '';
  for (var cx = 0; cx < CW; cx++) {
    var x0 = Math.floor(cx * W / CW), x1 = Math.floor((cx + 1) * W / CW);
    var y0 = Math.floor(cy * H / CH), y1 = Math.floor((cy + 1) * H / CH);
    var hit = 0, tot = 0;
    for (var y = y0; y < y1; y += 2) {
      for (var x = x0; x < x1; x += 2) { tot++; if (map.mask[y * W + x]) hit++; }
    }
    var r = tot ? hit / tot : 0;
    if (r > 0.5) land++;
    line += r > 0.5 ? '#' : (r > 0.15 ? '+' : ' ');
  }
  out += line + '\n';
}

// 同一块陆地上的省份用同一个字符标出来，方便看清国家划分
var per = new Array(map.countries.length).fill(0);
for (var i = 0; i < map.provinces.length; i++) per[map.provinces[i].country]++;

console.log(out);
console.log('种子 ' + seed +
  '   陆地 ' + (100 * map.landCount / (W * H)).toFixed(1) + '%' +
  '   省份 ' + map.provinces.length +
  '   国家 ' + map.countries.length);
console.log('每国省份数: ' + per.join(', ') +
  '   最均衡度 ' + (Math.min.apply(null, per) / Math.max.apply(null, per)).toFixed(2));
console.log('（均衡度 = 最小国 / 最大国，越接近 1 越均衡；>0.4 算好）');
