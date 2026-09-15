/* 蒸汽与账本 — 无浏览器回归测试
 *
 * 用法：  node test/check.js
 *
 * 只覆盖纯逻辑层（rng / mapgen / sim），不需要浏览器、不需要服务器。
 * render.js 和 ui.js 依赖 DOM，不在这个范围内 —— 它们靠截图自查。
 *
 * 退出码 0 = 全部通过，1 = 有失败项。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));

var VIC = globalThis.VIC;
var MG = VIC.mapgen;
var SIM = VIC.sim;

var pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  \u2713 ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '   ' + detail : '')); }
}
function group(title) { console.log('\n' + title); }

var SEEDS = [8888, 20260823, 777];
var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };

/* ───────────── 工具：陆地连通域打标签 ───────────── */
function labelLand(mask, W, H) {
  var label = new Int32Array(W * H).fill(-1);
  var stack = new Int32Array(W * H);
  var comps = [];
  for (var s = 0; s < W * H; s++) {
    if (label[s] >= 0 || !mask[s]) continue;
    var id = comps.length, sp = 0, pix = [];
    stack[sp++] = s; label[s] = id;
    while (sp > 0) {
      var cur = stack[--sp];
      pix.push(cur);
      var cx = cur % W, cy = (cur / W) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
        var ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = ny * W + nx;
        if (label[ni] >= 0 || !mask[ni]) continue;
        label[ni] = id;
        stack[sp++] = ni;
      }
    }
    comps.push(pix);
  }
  return { label: label, comps: comps };
}

/* ───────────── 工具：省份多边形覆盖了多少陆地 ───────────── */
function landCoverage(map, step) {
  step = step || 3;
  var W = map.width, H = map.height, mask = map.mask;
  var boxes = map.provinces.map(function (p) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < p.poly.length; i += 2) {
      if (p.poly[i] < x0) x0 = p.poly[i];
      if (p.poly[i] > x1) x1 = p.poly[i];
      if (p.poly[i + 1] < y0) y0 = p.poly[i + 1];
      if (p.poly[i + 1] > y1) y1 = p.poly[i + 1];
    }
    return { poly: p.poly, x0: x0, y0: y0, x1: x1, y1: y1 };
  });
  var landSamples = 0, uncovered = 0;
  for (var y = 0; y < H; y += step) {
    for (var x = 0; x < W; x += step) {
      if (!mask[y * W + x]) continue;
      landSamples++;
      var hit = false;
      for (var b = 0; b < boxes.length; b++) {
        var bx = boxes[b];
        if (x < bx.x0 || x > bx.x1 || y < bx.y0 || y > bx.y1) continue;
        if (MG.pointInPoly(x + 0.5, y + 0.5, bx.poly)) { hit = true; break; }
      }
      if (!hit) uncovered++;
    }
  }
  return { landSamples: landSamples, uncovered: uncovered,
           ratio: landSamples ? uncovered / landSamples : 0 };
}

/* ───────────── 工具：模拟 render.js 的 pick() ───────────── */
function pick(map, wx, wy) {
  var W = map.width, H = map.height, mask = map.mask;
  for (var p = map.provinces.length - 1; p >= 0; p--) {
    var poly = map.provinces[p].poly;
    if (!poly || poly.length < 6) continue;
    if (MG.pointInPoly(wx, wy, poly)) {
      var xi = wx | 0, yi = wy | 0;
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) return -1;
      if (!mask[yi * W + xi]) return -1;
      return p;
    }
  }
  return -1;
}

/* ═══════════════════════════════════════════════ */
console.log('蒸汽与账本 · 回归测试');
console.log('种子: ' + SEEDS.join(', '));

var maps = [];

group('【1】地图生成');
SEEDS.forEach(function (seed) {
  var t0 = Date.now();
  var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: seed }));
  var ms = Date.now() - t0;
  maps.push(map);
  console.log('  -- seed ' + seed + ' --');

  check('国家数 = 8', map.countries.length === 8, '实际 ' + map.countries.length);
  check('省份数在 150~300', map.provinces.length >= 150 && map.provinces.length <= 300,
        '实际 ' + map.provinces.length);
  check('生成耗时 < 2000ms', ms < 2000, ms + 'ms');

  // 每块陆地都必须有省份 —— 曾经有一块 5527px 的岛一个省都没有（"南极洲" bug）
  var land = labelLand(map.mask, map.width, map.height);
  var orphan = 0, orphanPx = 0;
  land.comps.forEach(function (pix) {
    var has = false;
    for (var i = 0; i < map.provinces.length; i++) {
      var p = map.provinces[i];
      if (land.label[(p.sy | 0) * map.width + (p.sx | 0)] === land.label[pix[0]]) { has = true; break; }
    }
    if (!has) { orphan++; orphanPx += pix.length; }
  });
  check('没有无省份的陆地块', orphan === 0,
        land.comps.length + ' 块陆地' + (orphan ? '，' + orphan + ' 块无主（' + orphanPx + 'px）' : ''));

  // 每个陆地像素都要被某个省份多边形覆盖
  var cov = landCoverage(map);
  check('陆地被省份覆盖 > 99.5%', cov.ratio < 0.005,
        '未覆盖 ' + (cov.ratio * 100).toFixed(2) + '%');

  // 邻接健康度：Voronoi 平均邻居数应接近 6
  var adj = map.provinces.reduce(function (a, p) { return a + p.neighbors.length; }, 0) / map.provinces.length;
  check('平均邻接数在 4~7', adj >= 4 && adj <= 7, adj.toFixed(2));
  check('没有孤立省', map.provinces.every(function (p) { return p.neighbors.length > 0; }));
});

group('【2】点击拾取');
maps.forEach(function (map, mi) {
  var seed = SEEDS[mi];
  var land = labelLand(map.mask, map.width, map.height);
  var worst = { name: '', hit: 1, total: 0 };
  land.comps.forEach(function (pix) {
    var stepN = Math.max(1, Math.floor(pix.length / 200));
    var tot = 0, hit = 0;
    for (var i = 0; i < pix.length; i += stepN) {
      var c = pix[i], x = c % map.width, y = (c / map.width) | 0;
      tot++;
      if (pick(map, x + 0.5, y + 0.5) >= 0) hit++;
    }
    var r = tot ? hit / tot : 1;
    if (r < worst.hit) worst = { name: 'seed' + seed + '块' + pix.length + 'px', hit: r, total: tot };
  });
  check('seed ' + seed + ' 每块陆地都能拾取', worst.hit >= 0.99,
        '最差 ' + worst.name + ' 命中 ' + (worst.hit * 100).toFixed(1) + '%');

  // 海面不能误判成陆地省份
  var seaTot = 0, seaHit = 0;
  for (var y = 100; y < map.height - 100; y += 53) {
    for (var x = 100; x < map.width - 100; x += 71) {
      if (map.mask[y * map.width + x]) continue;
      seaTot++;
      if (pick(map, x + 0.5, y + 0.5) >= 0) seaHit++;
    }
  }
  check('seed ' + seed + ' 海面不误判', seaHit === 0, seaTot + ' 个海面采样，误判 ' + seaHit);
});

group('【3】模拟稳定性（300 tick = 25 年）');
var world = null;
SEEDS.forEach(function (seed, mi) {
  var w = SIM.createWorld(maps[mi], { seed: seed + 7 });
  var t0 = Date.now();
  var threw = null;
  try { for (var i = 0; i < 300; i++) SIM.tick(w); }
  catch (e) { threw = e; }
  var ms = Date.now() - t0;

  check('seed ' + seed + ' 跑 300 tick 不报错', !threw, threw ? String(threw) : '');
  if (threw) return;

  var pop = 0;
  for (var s = 0; s < w.S; s++) for (var p = 0; p < w.P; p++) pop += w.pop[s * w.P + p];
  check('seed ' + seed + ' 总人口在 20M~80M', pop > 20e6 && pop < 80e6, (pop / 1e6).toFixed(1) + 'M');

  var bad = [];
  for (var g = 0; g < w.G; g++) {
    var mean = 0;
    for (var c = 0; c < w.C; c++) mean += w.price[g * w.C + c];
    mean /= w.C;
    var rel = mean / SIM.GOODS[g].base;
    if (rel < 0.5 || rel > 2.0) bad.push(SIM.GOODS[g].name + ' ' + rel.toFixed(2));
  }
  check('seed ' + seed + ' 各商品均价在基准 0.5~2.0 倍', bad.length === 0, bad.join(' '));

  var ratio = 0, unrest = 0, n = w.S * w.P;
  for (var i2 = 0; i2 < n; i2++) ratio += w.ratio[i2];
  for (var p2 = 0; p2 < w.P; p2++) unrest += w.unrest[p2];
  ratio /= n; unrest /= w.P;
  check('seed ' + seed + ' 平均收支比在 0.85~1.5', ratio > 0.85 && ratio < 1.5, ratio.toFixed(3));
  check('seed ' + seed + ' 平均不满 < 0.5', unrest < 0.5, unrest.toFixed(3));

  if (seed === SEEDS[0]) {
    world = w;
    check('单 tick 耗时 < 2ms', ms / 300 < 2, (ms / 300).toFixed(3) + 'ms/tick');
  }
});

group('【4】经济标定（开局不应通缩或恶性通胀）');
if (world) {
  var w0 = SIM.createWorld(maps[0], { seed: SEEDS[0] + 7 });
  var rels = [];
  for (var g2 = 0; g2 < w0.G; g2++) {
    var m2 = 0;
    for (var c2 = 0; c2 < w0.C; c2++) m2 += w0.price[g2 * w0.C + c2];
    rels.push((m2 / w0.C) / SIM.GOODS[g2].base);
  }
  check('开局价格在基准 0.7~1.4 倍', rels.every(function (r) { return r > 0.7 && r < 1.4; }),
        rels.map(function (r) { return r.toFixed(2); }).join(' / '));
}

console.log('\n' + '─'.repeat(52));
console.log(fail === 0
  ? '全部通过：' + pass + ' 项'
  : pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
