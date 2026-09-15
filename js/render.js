/* 蒸汽与账本 — 地图渲染
 *
 * 分层策略（顺序即绘制顺序）：
 *   1. 海洋（渐变）
 *   2. 陆地投影阴影  ← 让大陆"浮"在海面上
 *   3. 海岸线（掩码膨胀一圈）
 *   4. 陆地本体：省份多边形 → 省界 → 国界，最后用陆地掩码 destination-in 裁掉海里的部分
 *   5. 国名标注
 *   6. 悬停 / 选中高亮
 *
 * 关键点：省份是**矢量多边形**（缩放不糊），只有海岸线是栅格掩码。
 * 把"省ID图"换成真正的多边形，是这套渲染能看起来干净的原因。
 */
(function (root) {
  'use strict';
  var VIC = root.VIC || (root.VIC = {});
  var MG = VIC.mapgen;

  /* ---------------- 颜色工具 ---------------- */

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbCss(c, a) {
    return a === undefined
      ? 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'
      : 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')';
  }
  function shade(c, f) {
    return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
  }
  /* 多段色带取样：stops = [[t,[r,g,b]], ...] */
  function ramp(stops, t) {
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stops[i], b = stops[i + 1];
      if (t <= b[0]) {
        var k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return [
          a[1][0] + (b[1][0] - a[1][0]) * k,
          a[1][1] + (b[1][1] - a[1][1]) * k,
          a[1][2] + (b[1][2] - a[1][2]) * k
        ];
      }
    }
    return stops[stops.length - 1][1];
  }

  var RAMPS = {
    population: [
      [0.00, [40, 54, 74]],
      [0.30, [72, 105, 128]],
      [0.55, [130, 160, 140]],
      [0.78, [206, 176, 106]],
      [1.00, [232, 214, 168]]
    ],
    wealth: [
      [0.00, [122, 46, 44]],
      [0.35, [168, 106, 62]],
      [0.50, [176, 168, 138]],
      [0.65, [96, 138, 96]],
      [1.00, [188, 214, 152]]
    ],
    unrest: [
      [0.00, [58, 70, 76]],
      [0.35, [122, 96, 62]],
      [0.62, [176, 94, 52]],
      [0.85, [198, 56, 44]],
      [1.00, [232, 108, 72]]
    ],
    industry: [
      [0.00, [52, 62, 72]],
      [0.35, [70, 96, 116]],
      [0.62, [96, 138, 156]],
      [0.85, [156, 190, 196]],
      [1.00, [222, 232, 226]]
    ]
  };

  /* ---------------- 掩码贴图 ---------------- */

  function buildTintedMask(mask, W, H, rgb, alpha) {
    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(W, H);
    var d = img.data;
    for (var i = 0, j = 0; i < mask.length; i++, j += 4) {
      if (mask[i]) {
        d[j] = rgb[0]; d[j + 1] = rgb[1]; d[j + 2] = rgb[2]; d[j + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  var DILATE = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1]
  ];

  /* 把"膨胀 9 连画"的结果烘成一张静态贴图。
   * 之前这一步每帧都要做两遍（阴影一遍、海岸线一遍），
   * 而且每次 drawImage 都挂着 blur 滤镜 —— 实测 18 次全画布模糊就是卡顿的主因。
   * 现在膨胀在启动时烘一次，运行时只剩最多两次模糊。 */
  function dilateTo(src, r, W, H) {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (var i = 0; i < DILATE.length; i++) {
      g.drawImage(src, DILATE[i][0] * r, DILATE[i][1] * r);
    }
    g.drawImage(src, 0, 0);
    return c;
  }

  /* 只柔化，不膨胀 */
  function softenTo(src, px, W, H) {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    g.filter = 'blur(' + px + 'px)';
    g.drawImage(src, 0, 0);
    g.filter = 'none';
    return c;
  }

  function drawDilated(ctx, src, r) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (var i = 0; i < DILATE.length; i++) {
      ctx.drawImage(src, DILATE[i][0] * r, DILATE[i][1] * r);
    }
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }

  /* 预计算国界线段。
   *
   * 走过的弯路：
   *   ① 先用"两站点中垂线上取点"求公共边 —— 99 对跨国相邻省里 49 对算出的边短到画不出来。
   *   ② 改用"从多边形的边反推对面站点"（精确），但过滤条件是"边的**中点**在陆地上"。
   *      结果横穿窄岛的边，中点掉进海里，整条边被丢弃 —— 岛上有省份却没有国界。
   *
   * 现在：沿边按 4px 采样，逐点要求"在陆地上"且"最近站点确实是这两省之一"，
   * 只保留满足条件的连续段。横穿岛屿、跨越半岛的边都能正确画出，
   * 而隔海相望的两省之间那条整段落在水里的中垂线会被完全滤掉。 */
  function buildCountryBorders(map) {
    var provs = map.provinces;
    var W = map.width, H = map.height, mask = map.mask;
    var segs = [];
    var STEP = 4;
    var mark = new Uint8Array(256);

    function nearestSite(px, py, skip) {
      var best = -1, bestD = Infinity;
      for (var j = 0; j < provs.length; j++) {
        if (j === skip) continue;
        var dx = provs[j].sx - px, dy = provs[j].sy - py;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      return best;
    }

    for (var pi = 0; pi < provs.length; pi++) {
      var a = provs[pi], poly = a.poly, n = poly.length;
      for (var k = 0; k < n; k += 2) {
        var q = (k + 2) % n;
        var x1 = poly[k], y1 = poly[k + 1], x2 = poly[q], y2 = poly[q + 1];

        var nb = nearestSite((x1 + x2) * 0.5, (y1 + y2) * 0.5, pi);
        if (nb < 0 || nb < pi) continue;                 // 每条边只画一次
        if (provs[nb].country === a.country) continue;   // 同国不画

        var len = Math.hypot(x2 - x1, y2 - y1);
        var steps = Math.max(1, Math.ceil(len / STEP));
        if (mark.length < steps + 1) mark = new Uint8Array(steps + 1);
        mark.fill(0, 0, steps + 1);

        for (var s = 0; s <= steps; s++) {
          var t = s / steps;
          var px = x1 + (x2 - x1) * t, py = y1 + (y2 - y1) * t;
          var xi = px | 0, yi = py | 0;
          if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
          if (!mask[yi * W + xi]) continue;
          // 该点的最近站点必须就是这两省之一，否则它其实落在第三省的地盘上
          if (nearestSite(px, py, pi) !== nb) continue;
          mark[s] = 1;
        }

        var s2 = 0;
        while (s2 <= steps) {
          if (!mark[s2]) { s2++; continue; }
          var e = s2;
          while (e + 1 <= steps && mark[e + 1]) e++;
          if (e > s2) {
            var t0 = s2 / steps, t1 = e / steps;
            segs.push(
              x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0,
              x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1
            );
          }
          s2 = e + 1;
        }
      }
    }
    return segs;
  }

  /* 低频噪声地形贴图。
   * 关键：不要逐像素算 fbm —— 160 万像素 × 4 个八度会卡上一两秒。
   * 在 256×160 上算完再放大插值，得到的软斑块反而更像地形。 */
  function buildTerrainTexture(W, H) {
    var TW = 256, TH = 160;
    var rng = VIC.rng.makeRng(90210);
    var nz = VIC.rng.makeNoise(rng, 128);
    var small = document.createElement('canvas');
    small.width = TW; small.height = TH;
    var sctx = small.getContext('2d');
    var img = sctx.createImageData(TW, TH);
    var d = img.data;
    for (var y = 0; y < TH; y++) {
      for (var x = 0; x < TW; x++) {
        var lo = VIC.rng.fbm(nz, x / TW * 5.0, y / TH * 5.0, 4, 2.0, 0.5);
        var hi = VIC.rng.fbm(nz, x / TW * 17.0 + 40, y / TH * 17.0 + 12, 2, 2.0, 0.5);
        var v = lo * 0.72 + hi * 0.28;
        var g = Math.round(Math.max(0, Math.min(255, (v - 0.5) * 300 + 128)));
        var i = (y * TW + x) * 4;
        d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);

    var big = document.createElement('canvas');
    big.width = W; big.height = H;
    var bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, W, H);
    return big;
  }

  /* ---------------- 渲染器 ---------------- */

  function create(canvas, world, opts) {
    opts = opts || {};
    var map = world.map;
    var W = map.width, H = map.height;
    var ctx = canvas.getContext('2d');
    var dpr = 1;

    // 每省一个固定的明度扰动，让政治地图有"纸纹理"而不是一块死色
    var shadeTint = new Float32Array(world.P);
    var srng = VIC.rng.makeRng(4242);
    for (var i = 0; i < world.P; i++) shadeTint[i] = 0.88 + srng() * 0.24;

    // 国家颜色预转 rgb
    var countryRgb = world.map.countries.map(function (c) { return hexToRgb(c.color); });
    var countryAccent = world.map.countries.map(function (c) { return hexToRgb(c.accent); });

    var maskWhite = buildTintedMask(map.mask, W, H, [255, 255, 255], 255);
    var maskShadow = buildTintedMask(map.mask, W, H, [8, 12, 20], 210);
    var maskCoast = buildTintedMask(map.mask, W, H, [40, 44, 40], 255);
    var terrainTex = buildTerrainTexture(W, H);
    var countryBorders = buildCountryBorders(map);

    /* 静态贴图：启动时烘一次，之后每帧只做普通 drawImage，不再挂滤镜。
     * 膨胀半径按默认取景比例（scale≈1.42）标定：
     * 原代码是 round(3/scale) 和 round(1.5/scale)，在默认取景下正好是 2 和 1，
     * 取这两个值初始观感与改前完全一致。
     * 代价：放大后描边会随地图一起变粗（原来会保持屏幕像素恒定）。
     * 对纸质地图的观感来说可以接受，换来了每帧省掉 18 次全画布模糊。 */
    var shadowDilated = dilateTo(maskShadow, 2, W, H);
    var coastDilated = dilateTo(maskCoast, 1, W, H);
    var maskWhiteSoft = softenTo(maskWhite, 0.6, W, H);

    /* 屏幕空间的背景缓存：海洋 + 投影 + 海岸线。
     * 这三样只跟视口有关、跟模拟数据无关，所以平移缩放之外根本不用重建。 */
    var bgCanvas = document.createElement('canvas');

    // 陆地合成层（离屏）—— 只在需要时重绘
    var landCanvas = document.createElement('canvas');
    landCanvas.width = W; landCanvas.height = H;
    var landCtx = landCanvas.getContext('2d');

    var view = { scale: 1, tx: 0, ty: 0, baseScale: 1 };
    var hovered = -1, selected = -1;
    var mode = opts.mode || 'political';
    var selectedCountry = opts.country || 0;
    var dirty = true;        // 陆地层需要重建（换地图模式 / 数据变了）
    var bgDirty = true;      // 背景缓存失效（缩放 / 平移 / 改窗口）
    var needsDraw = true;    // 这一帧是否需要重绘

    /* 视口变了：背景和国名都要跟着重算 */
    function viewChanged() { bgDirty = true; needsDraw = true; }

    /* --- 视口 ---
     * 两个要点：
     *   a) 按**陆地包围盒**取景，而不是整张 1600×1000 —— 否则大陆只占屏幕中间一小块
     *   b) 留出左右面板的宽度，否则大陆会被面板盖住一半 */

    var PANEL_L = 320, PANEL_R = 336, BAR_T = 56, BAR_B = 58; // CSS px，与 style.css 对齐

    var bbox = (function () {
      var x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          if (!map.mask[y * W + x]) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      return [x0, y0, x1, y1];
    })();

    function safeRect() {
      var l = PANEL_L * dpr, r = canvas.width - PANEL_R * dpr;
      var t = BAR_T * dpr, b = canvas.height - BAR_B * dpr;
      // 窄屏时面板会盖住大半地图，这时索性不留边，让地图铺满
      if (r - l < canvas.width * 0.40) {
        l = canvas.width * 0.015;
        r = canvas.width * 0.985;
      }
      return [l, t, r, b];
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, root.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      bgCanvas.width = canvas.width;
      bgCanvas.height = canvas.height;
      fit();
      dirty = true;
      bgDirty = true;
      needsDraw = true;
    }

    function fit() {
      var sr = safeRect();
      var bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
      var sx = (sr[2] - sr[0]) / bw, sy = (sr[3] - sr[1]) / bh;
      view.baseScale = Math.min(sx, sy) * 0.94;
      view.scale = view.baseScale;
      var cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
      view.tx = (sr[0] + sr[2]) / 2 - cx * view.scale;
      view.ty = (sr[1] + sr[3]) / 2 - cy * view.scale;
      viewChanged();
    }

    function clampPan() {
      var vw = canvas.width, vh = canvas.height;
      var cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
      var mw = (bbox[2] - bbox[0]) * view.scale;
      var mh = (bbox[3] - bbox[1]) * view.scale;
      var slackX = Math.max(vw * 0.30, (mw - vw) * 0.5 + vw * 0.18);
      var slackY = Math.max(vh * 0.30, (mh - vh) * 0.5 + vh * 0.18);
      var sx = cx * view.scale + view.tx;
      var sy = cy * view.scale + view.ty;
      sx = Math.min(vw / 2 + slackX, Math.max(vw / 2 - slackX, sx));
      sy = Math.min(vh / 2 + slackY, Math.max(vh / 2 - slackY, sy));
      view.tx = sx - cx * view.scale;
      view.ty = sy - cy * view.scale;
    }

    function screenToWorld(sx, sy) {
      return [(sx * dpr - view.tx) / view.scale, (sy * dpr - view.ty) / view.scale];
    }

    /* --- 省份取色 --- */

    /* 地图模式取哪个指标 */
    function metric(mode, p) {
      var P = world.P;
      switch (mode) {
        case 'population':
          return world.pop[0 * P + p] + world.pop[1 * P + p] + world.pop[2 * P + p];
        case 'wealth':
          return world.wealth[0 * P + p];
        case 'unrest':
          return world.unrest[p];
        case 'industry': {
          var lv = 0;
          for (var g = 0; g < world.G; g++) lv += world.level[g * P + p];
          return lv;
        }
      }
      return 0;
    }

    /* 动态归一化：用 92 分位数当色带上限。
     * 写死上限（比如"55 级算满"）的话，开局全世界都挤在色带同一段里，看不出差别。
     * 注意这个值每次重建只算一次，绝不能放进 provinceColor 里逐省算（那是 O(P²)）。 */
    var statArr = [];
    function dynamicMax(mode) {
      statArr.length = 0;
      for (var p = 0; p < world.P; p++) statArr.push(metric(mode, p));
      statArr.sort(function (a, b) { return a - b; });
      var v = statArr[Math.floor(statArr.length * 0.92)];
      return Math.max(1e-6, v);
    }

    var modeMax = 1;

    function provinceColor(p) {
      var prov = map.provinces[p];
      switch (mode) {
        case 'political':
          return shade(countryRgb[prov.country], shadeTint[p]);
        case 'population':
          return ramp(RAMPS.population, Math.min(1, metric('population', p) / modeMax));
        case 'wealth':
          // 财富以 1.0 为"基准线"，色带中点是刻意对齐的，所以不动态归一
          return ramp(RAMPS.wealth, Math.min(1, metric('wealth', p) / 2.4));
        case 'unrest':
          return ramp(RAMPS.unrest, Math.min(1, metric('unrest', p) / 0.7));
        case 'industry':
          return ramp(RAMPS.industry, Math.min(1, metric('industry', p) / modeMax));
      }
      return [120, 120, 120];
    }

    /* --- 背景层：海洋 + 投影 + 海岸线 ---
     * 全部在屏幕空间合成进 bgCanvas，只在视口变化时重建。
     * 膨胀已经烘进贴图，这里每样只剩一次模糊。 */
    function buildBackground() {
      if (bgCanvas.width !== canvas.width || bgCanvas.height !== canvas.height) {
        bgCanvas.width = canvas.width;
        bgCanvas.height = canvas.height;
      }
      var bctx = bgCanvas.getContext('2d');
      var vw = canvas.width, vh = canvas.height;

      // 海洋
      var og = bctx.createLinearGradient(0, 0, 0, vh);
      og.addColorStop(0, '#141c24');
      og.addColorStop(0.55, '#0f161d');
      og.addColorStop(1, '#0a1017');
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.fillStyle = og;
      bctx.fillRect(0, 0, vw, vh);

      bctx.save();
      bctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);

      // 陆地投影
      bctx.save();
      bctx.globalAlpha = 0.55;
      bctx.filter = 'blur(' + (5 / view.scale) + 'px)';
      bctx.translate(0, 7 / view.scale);
      bctx.drawImage(shadowDilated, 0, 0);
      bctx.restore();

      // 海岸线
      bctx.save();
      bctx.filter = 'blur(' + (0.5 / view.scale) + 'px)';
      bctx.drawImage(coastDilated, 0, 0);
      bctx.restore();

      bctx.restore();
      bgDirty = false;
    }

    /* --- 陆地层重绘 --- */

    function buildLandLayer() {
      modeMax = dynamicMax(mode);   // 每次重建只算一次
      landCtx.setTransform(1, 0, 0, 1, 0, 0);
      landCtx.clearRect(0, 0, W, H);
      landCtx.lineJoin = 'round';
      landCtx.lineCap = 'round';

      // 省份填充
      for (var p = 0; p < map.provinces.length; p++) {
        var poly = map.provinces[p].poly;
        if (!poly || poly.length < 6) continue;
        landCtx.beginPath();
        landCtx.moveTo(poly[0], poly[1]);
        for (var k = 2; k < poly.length; k += 2) landCtx.lineTo(poly[k], poly[k + 1]);
        landCtx.closePath();
        landCtx.fillStyle = rgbCss(provinceColor(p));
        landCtx.fill();
      }

      // 地形质感：软斑块叠加，让色块不再是死板的平涂
      landCtx.save();
      landCtx.globalCompositeOperation = 'overlay';
      landCtx.globalAlpha = 0.50;
      landCtx.drawImage(terrainTex, 0, 0);
      landCtx.restore();

      // 省界
      landCtx.strokeStyle = 'rgba(14,18,22,0.46)';
      landCtx.lineWidth = 1.3;
      for (var p2 = 0; p2 < map.provinces.length; p2++) {
        var poly2 = map.provinces[p2].poly;
        if (!poly2 || poly2.length < 6) continue;
        landCtx.beginPath();
        landCtx.moveTo(poly2[0], poly2[1]);
        for (var k2 = 2; k2 < poly2.length; k2 += 2) landCtx.lineTo(poly2[k2], poly2[k2 + 1]);
        landCtx.closePath();
        landCtx.stroke();
      }

      // 国界：深色粗线 + 浅色内衬，读起来才像印刷地图上的国境线
      for (var pass = 0; pass < 2; pass++) {
        landCtx.strokeStyle = pass === 0 ? 'rgba(10,12,16,0.92)' : 'rgba(240,230,205,0.36)';
        landCtx.lineWidth = pass === 0 ? 4.2 : 1.5;
        landCtx.beginPath();
        for (var bi = 0; bi < countryBorders.length; bi += 4) {
          landCtx.moveTo(countryBorders[bi], countryBorders[bi + 1]);
          landCtx.lineTo(countryBorders[bi + 2], countryBorders[bi + 3]);
        }
        landCtx.stroke();
      }

      // 用**预柔化**的陆地掩码裁掉海里的部分。
      // 柔化启动时做一次就够 —— 之前每次重建都现挂 blur 滤镜，
      // 而数据模式下重建每秒要发生好几次。
      landCtx.globalCompositeOperation = 'destination-in';
      landCtx.drawImage(maskWhiteSoft, 0, 0);
      landCtx.globalCompositeOperation = 'source-over';
    }

    /* --- 国名标注 --- */

    function countryLabelAnchors() {
      var C = map.countries.length;
      var acc = [];
      for (var c = 0; c < C; c++) acc.push({ x: 0, y: 0, w: 0, area: 0, best: null, bestArea: 0 });
      for (var p = 0; p < map.provinces.length; p++) {
        var prov = map.provinces[p];
        var a = prov.area;
        acc[prov.country].x += prov.cx * a;
        acc[prov.country].y += prov.cy * a;
        acc[prov.country].w += a;
        if (a > acc[prov.country].bestArea) {
          acc[prov.country].bestArea = a;
          acc[prov.country].best = prov;
        }
      }
      var out = [];
      for (var c2 = 0; c2 < C; c2++) {
        var o = acc[c2];
        if (o.w <= 0) continue;
        var x = o.x / o.w, y = o.y / o.w;
        var xi = x | 0, yi = y | 0;
        // 质心落在海里就退回到最大省
        if (xi < 0 || yi < 0 || xi >= W || yi >= H || !map.mask[yi * W + xi]) {
          if (!o.best) continue;
          x = o.best.cx; y = o.best.cy;
        }
        out.push({ country: c2, x: x, y: y, weight: o.w });
      }
      return out;
    }
    var labelAnchors = null;

    /* --- 绘制 --- */

    /* 每帧入口。没变化就直接返回 —— 这一条是最大的性能来源：
     * 之前哪怕暂停、鼠标不动、政治模式，也照样每帧把整张地图重新合成一遍。 */
    function draw() {
      if (!needsDraw) return;
      needsDraw = false;

      if (!labelAnchors) labelAnchors = countryLabelAnchors();
      if (bgDirty) buildBackground();
      if (dirty) { buildLandLayer(); dirty = false; }

      // 1) 背景（海洋 + 投影 + 海岸线）已经合成好，一次 blit
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bgCanvas, 0, 0);

      ctx.save();
      ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);

      // 2) 陆地本体：掩码阶段已经柔化过，这里不再挂滤镜
      ctx.drawImage(landCanvas, 0, 0);

      // 3) 国名
      drawLabels();

      // 4) 高亮
      if (hovered >= 0 && hovered !== selected) strokeProvince(hovered, 'rgba(255,252,240,0.55)', 2.2);
      if (selected >= 0) {
        strokeProvince(selected, 'rgba(255,232,150,0.95)', 3.4);
        strokeProvince(selected, 'rgba(30,24,10,0.55)', 1.2);
      }

      ctx.restore();
    }

    function strokeProvince(p, color, px) {
      var poly = map.provinces[p].poly;
      if (!poly || poly.length < 6) return;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(poly[0], poly[1]);
      for (var k = 2; k < poly.length; k += 2) ctx.lineTo(poly[k], poly[k + 1]);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = px / view.scale;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    }

    function drawLabels() {
      var showPx = 62 / view.scale; // 太小的国家不标注
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var i = 0; i < labelAnchors.length; i++) {
        var a = labelAnchors[i];
        var sizeW = Math.sqrt(a.weight) * 1.35;
        var fs = Math.max(15, Math.min(46, sizeW)) / view.scale * 1.0;
        fs = Math.max(15 / view.scale, fs);
        if (fs < 9 / view.scale) continue;
        ctx.font = '600 ' + fs.toFixed(1) + 'px "Songti SC", "STSong", Georgia, serif';
        var name = map.countries[a.country].name;
        ctx.lineWidth = fs * 0.13;
        ctx.strokeStyle = 'rgba(6,8,12,0.72)';
        ctx.strokeText(name, a.x, a.y);
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = fs * 0.30;
        ctx.fillStyle = 'rgba(246,239,220,0.95)';
        ctx.fillText(name, a.x, a.y);
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }

    /* --- 拾取 --- */

    function pick(sx, sy) {
      var w = screenToWorld(sx, sy);
      // 从后往前找，视觉上后画的（后邻接的）优先
      for (var p = map.provinces.length - 1; p >= 0; p--) {
        var poly = map.provinces[p].poly;
        if (!poly || poly.length < 6) continue;
        if (MG.pointInPoly(w[0], w[1], poly)) {
          var xi = w[0] | 0, yi = w[1] | 0;
          if (xi < 0 || yi < 0 || xi >= W || yi >= H) return -1;
          if (!map.mask[yi * W + xi]) return -1; // 海面不算
          return p;
        }
      }
      return -1;
    }

    /* --- 交互 --- */

    var dragging = false, dragMoved = 0, lastX = 0, lastY = 0;

    function onWheel(e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var before = screenToWorld(mx, my);
      var k = Math.exp(-e.deltaY * 0.0016);
      var next = Math.max(view.baseScale * 0.85, Math.min(view.baseScale * 9, view.scale * k));
      view.scale = next;
      // 让光标下的世界坐标保持不动
      view.tx = mx * dpr - before[0] * view.scale;
      view.ty = my * dpr - before[1] * view.scale;
      clampPan();
      viewChanged();
    }

    function onDown(e) {
      dragging = true;
      dragMoved = 0;
      lastX = e.clientX; lastY = e.clientY;
    }

    function onMove(e) {
      var rect = canvas.getBoundingClientRect();
      if (dragging) {
        var dx = e.clientX - lastX, dy = e.clientY - lastY;
        dragMoved += Math.abs(dx) + Math.abs(dy);
        view.tx += dx * dpr;
        view.ty += dy * dpr;
        lastX = e.clientX; lastY = e.clientY;
        clampPan();
        viewChanged();
        if (dragMoved > 4) canvas.style.cursor = 'grabbing';
        return;
      }
      var p = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (p !== hovered) {
        hovered = p;
        needsDraw = true;
        canvas.style.cursor = p >= 0 ? 'pointer' : 'default';
        if (opts.onHover) opts.onHover(p, e.clientX, e.clientY);
      } else if (p >= 0 && opts.onHoverMove) {
        opts.onHoverMove(p, e.clientX, e.clientY);
      }
      if (p < 0 && opts.onHoverLeave) opts.onHoverLeave();
    }

    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      canvas.style.cursor = 'default';
      if (dragMoved > 4) return; // 拖拽不是点击
      var rect = canvas.getBoundingClientRect();
      var p = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (opts.onClick) opts.onClick(p);
    }

    function onLeave() {
      dragging = false;
      hovered = -1;
      needsDraw = true;
      canvas.style.cursor = 'default';
      if (opts.onHoverLeave) opts.onHoverLeave();
    }

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', onLeave);

    return {
      resize: resize,
      draw: draw,
      pick: pick,
      invalidate: function () { dirty = true; needsDraw = true; },
      setMode: function (m) { mode = m; dirty = true; needsDraw = true; },
      getMode: function () { return mode; },
      setHovered: function (p) { hovered = p; needsDraw = true; },
      setSelected: function (p) { selected = p; needsDraw = true; },
      getSelected: function () { return selected; },
      setCountry: function (c) { selectedCountry = c; },
      getView: function () { return view; },
      resetView: function () { fit(); dirty = true; needsDraw = true; }
    };
  }

  VIC.render = { create: create, RAMPS: RAMPS, hexToRgb: hexToRgb, rgbCss: rgbCss };
})(typeof window !== 'undefined' ? window : globalThis);
