/* 蒸汽与账本 — 地图生成
 *
 * 流程：
 *   1. 噪声 + 径向衰减 → 大陆掩码（raster，带有机海岸线）
 *   2. 抖动网格播种 + Lloyd 松弛 → 省份站点
 *   3. 半平面裁剪法算 Voronoi 胞（vector 多边形，缩放无损）
 *   4. 邻接从**最终胞的每条边**反推（中点最近站点）
 *   5. 按陆地占比过滤掉纯海洋胞
 *   6. 多源 BFS + 严格多数派平滑 → 国家
 */
(function (root) {
  'use strict';
  var VIC = root.VIC || (root.VIC = {});
  var R = VIC.rng;

  /* ---------------- 多边形工具（扁平数组 [x0,y0,x1,y1,...]） ---------------- */

  function polyArea(p) {
    var a = 0, n = p.length;
    for (var i = 0; i < n; i += 2) {
      var j = (i - 2 + n) % n;
      a += p[j] * p[i + 1] - p[i] * p[j + 1];
    }
    return a * 0.5;
  }

  function polyCentroid(p) {
    var a = 0, cx = 0, cy = 0, n = p.length;
    for (var i = 0; i < n; i += 2) {
      var j = (i - 2 + n) % n;
      var cross = p[j] * p[i + 1] - p[i] * p[j + 1];
      a += cross;
      cx += (p[j] + p[i]) * cross;
      cy += (p[j + 1] + p[i + 1]) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-7) {
      var sx = 0, sy = 0;
      for (var k = 0; k < n; k += 2) { sx += p[k]; sy += p[k + 1]; }
      return [sx / (n / 2), sy / (n / 2)];
    }
    return [cx / (6 * a), cy / (6 * a)];
  }

  function pointInPoly(x, y, p) {
    var inside = false, n = p.length;
    for (var i = 0; i < n; i += 2) {
      var j = (i - 2 + n) % n;
      var xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function polyBBox(p) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    return [x0, y0, x1, y1];
  }

  /* 保留"离 A 比离 B 近"的部分：f(p)=(p-mid)·(b-a)，f<=0 即离 A 近 */
  function clipByBisector(poly, ax, ay, bx, by) {
    var mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
    var nx = bx - ax, ny = by - ay;
    var n = poly.length, out = [];
    for (var i = 0; i < n; i += 2) {
      var j = (i + 2) % n;
      var cx = poly[i], cy = poly[i + 1];
      var dx = poly[j], dy = poly[j + 1];
      var dc = (cx - mx) * nx + (cy - my) * ny;
      var dd = (dx - mx) * nx + (dy - my) * ny;
      if (dc <= 0) out.push(cx, cy);
      if ((dc < 0 && dd > 0) || (dc > 0 && dd < 0)) {
        var t = dc / (dc - dd);
        out.push(cx + (dx - cx) * t, cy + (dy - cy) * t);
      }
    }
    return out.length < 6 ? [] : out;
  }

  /* Voronoi 胞：从整个矩形开始，被所有其他站点的中垂线依次裁剪 */
  function voronoiCell(sites, i, W, H) {
    var poly = [0, 0, W, 0, W, H, 0, H];
    var ax = sites[i * 2], ay = sites[i * 2 + 1];
    var count = sites.length / 2;
    for (var j = 0; j < count; j++) {
      if (j === i) continue;
      poly = clipByBisector(poly, ax, ay, sites[j * 2], sites[j * 2 + 1]);
      if (poly.length === 0) return [];
    }
    return poly;
  }

  /* 邻接的正解：胞的每条边都躺在某条中垂线上，
   * 取边中点，最近的"非本站点"就是这条边对面的邻居。 */
  function neighborsFromPoly(poly, sites, i) {
    var out = [];
    var n = poly.length;
    var count = sites.length / 2;
    for (var k = 0; k < n; k += 2) {
      var q = (k + 2) % n;
      var mx = (poly[k] + poly[q]) * 0.5;
      var my = (poly[k + 1] + poly[q + 1]) * 0.5;
      var best = -1, bestD = Infinity;
      for (var j = 0; j < count; j++) {
        if (j === i) continue;
        var dx = sites[j * 2] - mx, dy = sites[j * 2 + 1] - my;
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0 && out.indexOf(best) < 0) out.push(best);
    }
    return out;
  }

  /* 采样估算胞内的陆地面积（也顺便得到"这省到底是不是海"） */
  function landStats(poly, mask, W, H) {
    var bb = polyBBox(poly);
    var x0 = Math.max(0, bb[0] | 0), y0 = Math.max(0, bb[1] | 0);
    var x1 = Math.min(W - 1, Math.ceil(bb[2])), y1 = Math.min(H - 1, Math.ceil(bb[3]));
    var step = 4;
    var total = 0, land = 0;
    for (var y = y0; y <= y1; y += step) {
      for (var x = x0; x <= x1; x += step) {
        if (!pointInPoly(x + 0.5, y + 0.5, poly)) continue;
        total++;
        if (mask[y * W + x]) land++;
      }
    }
    var cellArea = Math.abs(polyArea(poly));
    var pxArea = step * step;
    return {
      landArea: land * pxArea,
      cellArea: cellArea,
      landFrac: total > 0 ? land / total : 0
    };
  }

  /* ---------------- 掩码清理 ---------------- */

  function filterComponents(mask, W, H, minSize, target) {
    var seen = new Uint8Array(W * H);
    var stack = new Int32Array(W * H);
    for (var s = 0; s < W * H; s++) {
      if (seen[s] || mask[s] !== target) continue;
      var sp = 0, comp = [];
      stack[sp++] = s;
      seen[s] = 1;
      while (sp > 0) {
        var cur = stack[--sp];
        comp.push(cur);
        var cx = cur % W, cy = (cur / W) | 0;
        for (var d = 0; d < 4; d++) {
          var nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
          var ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var ni = ny * W + nx;
          if (seen[ni] || mask[ni] !== target) continue;
          seen[ni] = 1;
          stack[sp++] = ni;
        }
      }
      if (comp.length < minSize) {
        for (var c = 0; c < comp.length; c++) mask[comp[c]] = target ? 0 : 1;
      }
    }
  }

  /* 删掉所有触及画布边界的陆块。
   * 注意：这一步只有在陆地占比够低（不会横跨全图）时才有意义，
   * 否则整块大陆都会被判定为"触边"而全部删除 —— 我第一版就踩了这个坑。 */
  function removeBorderComponents(mask, W, H) {
    var seen = new Uint8Array(W * H);
    var stack = new Int32Array(W * H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var s = y * W + x;
        if (seen[s] || !mask[s]) continue;
        var sp = 0, comp = [], touch = false;
        stack[sp++] = s;
        seen[s] = 1;
        while (sp > 0) {
          var cur = stack[--sp];
          comp.push(cur);
          var cx = cur % W, cy = (cur / W) | 0;
          if (cx === 0 || cy === 0 || cx === W - 1 || cy === H - 1) touch = true;
          for (var d = 0; d < 4; d++) {
            var nx2 = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
            var ny2 = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
            if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
            var ni = ny2 * W + nx2;
            if (seen[ni] || !mask[ni]) continue;
            seen[ni] = 1;
            stack[sp++] = ni;
          }
        }
        if (touch) for (var c = 0; c < comp.length; c++) mask[comp[c]] = 0;
      }
    }
  }

  /* 给陆地的每个连通域打标签，并顺带算出面积与质心。
   * 用来找"一块陆地上一个站点都没有"的漏网之鱼。 */
  function labelLand(mask, W, H) {
    var label = new Int32Array(W * H).fill(-1);
    var stack = new Int32Array(W * H);
    var sizes = [], sumX = [], sumY = [];
    var count = 0;
    for (var s = 0; s < W * H; s++) {
      if (label[s] >= 0 || !mask[s]) continue;
      var sp = 0, n = 0, sx = 0, sy = 0;
      stack[sp++] = s;
      label[s] = count;
      while (sp > 0) {
        var cur = stack[--sp];
        var cx = cur % W, cy = (cur / W) | 0;
        n++; sx += cx; sy += cy;
        for (var d = 0; d < 4; d++) {
          var nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
          var ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var ni = ny * W + nx;
          if (label[ni] >= 0 || !mask[ni]) continue;
          label[ni] = count;
          stack[sp++] = ni;
        }
      }
      sizes.push(n); sumX.push(sx); sumY.push(sy);
      count++;
    }
    return { label: label, count: count, sizes: sizes, sumX: sumX, sumY: sumY };
  }

  /* ---------------- 国家设定 ---------------- */

  var COUNTRY_DEFS = [
    { name: '阿尔比恩王国', tag: 'ALB', color: '#a4544a', accent: '#e0a294' },
    { name: '法兰克尼亚帝国', tag: 'FRA', color: '#4a6f9e', accent: '#93b8e0' },
    { name: '伊比利亚联合省', tag: 'IBE', color: '#bc9a42', accent: '#eed49a' },
    { name: '维斯瓦共和国', tag: 'VIS', color: '#5b8257', accent: '#9ccb99' },
    { name: '诺德兰联合王国', tag: 'NOR', color: '#7d5a91', accent: '#bfa0d4' },
    { name: '奥斯曼尼亚苏丹国', tag: 'OTT', color: '#b0703c', accent: '#e8b183' },
    { name: '瓦拉几亚大公国', tag: 'WAL', color: '#457b7c', accent: '#8ec9c9' },
    { name: '塞里斯帝国', tag: 'SER', color: '#96506d', accent: '#db9cb8' }
  ];

  var SYL_A = ['卡', '瓦', '诺', '德', '布', '雷', '斯', '特', '兰', '奥', '米', '塞', '图', '维', '安', '科', '罗', '佩', '格', '伊', '托', '法', '赫', '吕'];
  var SYL_B = ['伦', '尔', '拉', '里', '蒙', '德', '斯', '特', '纳', '维', '亚', '提', '博', '林', '顿', '堡', '姆', '什', '茨', '夫'];
  var SYL_C = ['城', '堡', '港', '镇', '郡', '原', '川', '谷', '湾', '关', '野', '洲'];

  function makeNameGen(rng) {
    var used = Object.create(null);
    return function () {
      for (var tries = 0; tries < 40; tries++) {
        var n = SYL_A[(rng() * SYL_A.length) | 0] +
                SYL_B[(rng() * SYL_B.length) | 0] +
                (rng() < 0.45 ? SYL_C[(rng() * SYL_C.length) | 0] : '');
        if (!used[n]) { used[n] = 1; return n; }
      }
      return '无名' + ((rng() * 900 + 100) | 0);
    };
  }

  /* ---------------- 主生成 ---------------- */

  function generate(opts) {
    opts = opts || {};
    var W = opts.width || 1600;
    var H = opts.height || 1000;
    var seed = opts.seed || 20260823;
    var wantProvinces = opts.provinces || 190;
    var wantCountries = Math.min(COUNTRY_DEFS.length, opts.countries || 8);

    var rng = R.makeRng(seed);
    var n1 = R.makeNoise(rng, 256);
    var n2 = R.makeNoise(rng, 256);
    var n3 = R.makeNoise(rng, 256);

    /* --- 1. 大陆掩码 ---
     * 第一版写成 v *= falloff，结果轮廓严格等于衰减函数的等高线 → 一个完美圆盘。
     * 第二版去掉径向项、只把触及边界的陆块删掉，结果整块大陆被删光（54% 陆地必然横跨全图）。
     * 现在这版：
     *   a) 域扭曲的 fbm 决定轮廓（有机形状）
     *   b) 边缘阻尼只在最外圈压制（保证四周留出海洋）
     *   c) 二分搜索阈值，精确命中目标陆地占比（不靠手调）
     *   d) 删触边陆块 + 去碎渣，作为安全网 */
    var field = new Float32Array(W * H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var nx = x / W, ny = y / H;
        var wx = (R.fbm(n2, nx * 1.8 + 11.0, ny * 1.8 + 5.0, 3, 2, 0.5) - 0.5) * 0.85;
        var wy = (R.fbm(n3, nx * 1.8 + 31.0, ny * 1.8 + 17.0, 3, 2, 0.5) - 0.5) * 0.85;
        var v = R.fbm(n1, nx * 2.55 + wx, ny * 2.55 + wy, 5, 2.0, 0.5);

        // 椭圆距离；y 方向压扁一点，让大陆横向舒展（画幅是 1.6:1）
        var dx = (nx - 0.5) * 2, dy = (ny - 0.5) * 2;
        var d = Math.sqrt(dx * dx + dy * dy * 1.25);
        var t = (d - 0.70) / (1.04 - 0.70);
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        var damp = 1 - t * t * (3 - 2 * t);   // smoothstep，内圈恒为 1

        field[y * W + x] = v * (0.30 + 0.70 * damp);
      }
    }

    // 二分阈值，命中目标陆地率
    var targetLand = opts.landRatio || 0.36;
    var want = Math.floor(W * H * targetLand);
    var lo = 0.05, hi = 1.2;
    for (var it = 0; it < 26; it++) {
      var mid = (lo + hi) * 0.5, cnt = 0;
      for (var fi = 0; fi < field.length; fi++) if (field[fi] > mid) cnt++;
      if (cnt > want) lo = mid; else hi = mid;
    }
    var thr = (lo + hi) * 0.5;

    var mask = new Uint8Array(W * H);
    for (var mi = 0; mi < field.length; mi++) mask[mi] = field[mi] > thr ? 1 : 0;

    removeBorderComponents(mask, W, H);
    filterComponents(mask, W, H, 110, 1);   // 留一些岛，好看
    filterComponents(mask, W, H, 150, 0);   // 填掉小湖

    var landCount = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i]) landCount++;

    /* --- 2. 抖动网格播种（最小距离用空间哈希加速）
     * 播种密度由一层噪声调制：密的地方省份小而多，疏的地方省份大而少。
     * 这既打破了"规则蜂巢"的观感，也更像真实的行政区划。 --- */
    var dens = R.makeNoise(rng, 256);
    var cellSize = Math.sqrt(landCount / wantProvinces);
    var baseMin = cellSize * 0.62;
    var buckets = Object.create(null);
    var sites = [];
    var lastMinDist = baseMin;
    function tryAdd(px, py) {
      // 局部密度 → 局部最小间距（约 0.55x ~ 1.35x）
      var local = R.fbm(dens, (px / W) * 3.2 + 5.0, (py / H) * 3.2 + 9.0, 3, 2.0, 0.5);
      var minDist = baseMin * (1.35 - local * 0.80);
      var hc = minDist;
      var bx = Math.floor(px / hc), by = Math.floor(py / hc);
      for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 1; oy++) {
          var b = buckets[(bx + ox) + ',' + (by + oy)];
          if (!b) continue;
          for (var k = 0; k < b.length; k += 3) {
            // 密度差太多的邻居本来就不该互相约束
            if (Math.abs(b[k + 2] - minDist) > baseMin * 0.5) continue;
            var ddx = b[k] - px, ddy = b[k + 1] - py;
            var need = Math.max(minDist, b[k + 2]);
            if (ddx * ddx + ddy * ddy < need * need) return false;
          }
        }
      }
      sites.push(px, py);
      (buckets[bx + ',' + by] || (buckets[bx + ',' + by] = [])).push(px, py, minDist);
      lastMinDist = minDist;
      return true;
    }

    var cols = Math.ceil(W / cellSize), rows = Math.ceil(H / cellSize);
    for (var gy = 0; gy < rows; gy++) {
      for (var gx = 0; gx < cols; gx++) {
        var jx = (gx + 0.15 + rng() * 0.7) * cellSize;
        var jy = (gy + 0.15 + rng() * 0.7) * cellSize;
        if (jx < 2 || jy < 2 || jx >= W - 2 || jy >= H - 2) continue;
        if (!mask[(jy | 0) * W + (jx | 0)]) continue;
        tryAdd(jx, jy);
      }
    }
    var seedCount = sites.length / 2;

    /* 后半段（胞 → 邻接 → 国家 → 打包）与剧本世界共用同一条流水线。 */
    return packWorld({
      W: W, H: H, mask: mask, sites: sites, rng: rng,
      cellSize: cellSize, baseMin: baseMin, wantCountries: wantCountries,
      landCount: landCount, ownerHint: null, nameOf: null, countries: null
    });
  }

  /* ═══════════ 把「掩码 + 站点」打包成一张地图 ═══════════
   * 这是地理的**后半段**：站点 → Voronoi 胞 → 陆地统计 → 邻接 → 国家 → 打包。
   * 前半段（掩码从哪来、站点撒在哪）交给调用方，于是同一条流水线服务两种世界：
   *   generate()          —— 噪声造大陆 + 抖动网格播种 + BFS 分国   （随机世界）
   *   VIC.scenario.build  —— 真实地球栅格 + 真实城市坐标 + 真实国界（剧本世界）
   * 分叉只有三处：国家怎么来、省份叫什么、站点推不推。其余三百行完全共用 ——
   * 这条纪律很关键：**剧本世界和随机世界不能是两套地理代码**，
   * 否则"在随机地图上标定的参数"就没有理由适用于剧本，反之亦然。
   */
  function packWorld(o) {
    var W = o.W, H = o.H, mask = o.mask, rng = o.rng;
    var cellSize = o.cellSize, baseMin = o.baseMin;
    /* 站点表统一转成普通数组再处理：补种那一步要 **追加**，
     * 而剧本传进来的是定长的 Float64Array —— 第一次跑就在 sites.push 上崩了。
     * 站点总量只有几百个，转一次的代价可以忽略。 */
    var sites = [];
    for (var si0 = 0; si0 < o.sites.length; si0++) sites.push(o.sites[si0]);
    var ownerHint = o.ownerHint || null;       // 逐站点的国家号；随机世界为 null
    var seedCount = sites.length / 2;
    var jitterScale = (o.jitterScale === undefined) ? 1 : o.jitterScale;
    var wantCountries = o.wantCountries || 0;  // 只有随机世界分支用得上
    var landCount = o.landCount;
    if (landCount === undefined) {              // 剧本世界自己数，随机世界由 generate 传进来
      landCount = 0;
      for (var lc0 = 0; lc0 < mask.length; lc0++) if (mask[lc0]) landCount++;
    }

    /* --- 2b. 补种：每一块陆地都必须至少有一个省份 ---
     * 播种是约 47px 间距的抖动网格。一块 180×51 的窄岛，网格点可能一次都不落在上面，
     * 于是那块陆地没有任何 Voronoi 胞覆盖 —— 渲染时露出一块没有省份颜色的深色空地，
     * 玩家点上去"不属于任何国家"。（我就是在截图里看到那块"南极洲"才发现这个 bug 的。） */
    var land = labelLand(mask, W, H);
    var compHasSeed = new Uint8Array(land.count);
    for (var cs = 0; cs < seedCount; cs++) {
      var sxi = sites[cs * 2] | 0, syi = sites[cs * 2 + 1] | 0;
      if (sxi < 0 || syi < 0 || sxi >= W || syi >= H) continue;
      var lb = land.label[syi * W + sxi];
      if (lb >= 0) compHasSeed[lb] = 1;
    }
    var forcedSeed = new Uint8Array(0);
    var forcedList = [];
    for (var lc = 0; lc < land.count; lc++) {
      if (compHasSeed[lc]) continue;
      var tx = land.sumX[lc] / land.sizes[lc];
      var ty = land.sumY[lc] / land.sizes[lc];
      var qx0 = -1, qy0 = -1;
      var ci = (ty | 0) * W + (tx | 0);
      if (tx >= 0 && ty >= 0 && tx < W && ty < H && land.label[ci] === lc) {
        qx0 = tx; qy0 = ty;
      } else {
        // 质心落在岛外（凹形或环状），从质心一圈圈向外找属于这块陆地的像素
        for (var rr = 1; rr < 260 && qx0 < 0; rr += 2) {
          for (var aa = 0; aa < 16; aa++) {
            var th = aa / 16 * Math.PI * 2;
            var ax2 = (tx + Math.cos(th) * rr) | 0;
            var ay2 = (ty + Math.sin(th) * rr) | 0;
            if (ax2 < 0 || ay2 < 0 || ax2 >= W || ay2 >= H) continue;
            if (land.label[ay2 * W + ax2] === lc) { qx0 = ax2 + 0.5; qy0 = ay2 + 0.5; break; }
          }
        }
      }
      if (qx0 < 0) continue;
      forcedList.push(sites.length / 2);
      sites.push(qx0, qy0);
    }
    seedCount = sites.length / 2;
    if (forcedList.length) {
      forcedSeed = new Uint8Array(seedCount);
      for (var fi = 0; fi < forcedList.length; fi++) forcedSeed[forcedList[fi]] = 1;
    }

    /* --- 3. 松弛 + 扰动 ---
     * 只做 1 次 Lloyd：做满 2 次会让所有胞变成一模一样的六边形，看着像蜂巢。
     * 之后再把站点随机推一下，把残留的规则性彻底打散。 */
    for (var iter = 0; iter < 1; iter++) {
      var moved = new Float64Array(sites.length);
      for (var si = 0; si < sites.length / 2; si++) {
        var poly0 = voronoiCell(sites, si, W, H);
        var keep = true, c = null;
        if (poly0.length >= 6) {
          c = polyCentroid(poly0);
          var cxi = c[0] | 0, cyi = c[1] | 0;
          if (cxi < 1 || cyi < 1 || cxi >= W - 1 || cyi >= H - 1 || !mask[cyi * W + cxi]) keep = false;
        } else keep = false;
        if (keep) { moved[si * 2] = c[0]; moved[si * 2 + 1] = c[1]; }
        else { moved[si * 2] = sites[si * 2]; moved[si * 2 + 1] = sites[si * 2 + 1]; }
      }
      sites = moved;
    }
    for (var js = 0; js < seedCount; js++) {
      var ang = rng() * Math.PI * 2;
      var rad = (0.06 + rng() * 0.40) * baseMin * jitterScale;
      var nxp = sites[js * 2] + Math.cos(ang) * rad;
      var nyp = sites[js * 2 + 1] + Math.sin(ang) * rad;
      var nxi = nxp | 0, nyi = nyp | 0;
      // 只推到场站仍在陆地上，否则沿海省会被推进海里
      if (nxi > 0 && nyi > 0 && nxi < W - 1 && nyi < H - 1 && mask[nyi * W + nxi]) {
        sites[js * 2] = nxp;
        sites[js * 2 + 1] = nyp;
      }
    }

    /* --- 4. 最终胞 + 陆地统计 + 邻接 --- */
    var seedPolys = new Array(seedCount);
    var seedStats = new Array(seedCount);
    var seedAdj = new Array(seedCount);
    for (var pi = 0; pi < seedCount; pi++) {
      var pcell = voronoiCell(sites, pi, W, H);
      seedPolys[pi] = pcell;
      seedStats[pi] = pcell.length >= 6
        ? landStats(pcell, mask, W, H)
        : { landArea: 0, cellArea: 0, landFrac: 0 };
      seedAdj[pi] = pcell.length >= 6 ? neighborsFromPoly(pcell, sites, pi) : [];
    }

    /* --- 5. 丢掉几乎没有陆地的胞 ---
     * 判据只用 landArea，**不能用 landFrac**。
     * landFrac 是"胞内陆地占比"，而沿海省和孤岛省的 Voronoi 胞必然大部分是海，
     * 占比一定很低 —— 拿它当阈值，会把整座岛连同岛上的站点一起杀掉，
     * 于是地图上留下点不出国家的无主之地（就是那块"南极洲"）。
     * landArea 衡量的才是"这个省实际拥有多少陆地"，那才是该管的。 */
    var alive = new Uint8Array(seedCount);
    var minLand = cellSize * cellSize * 0.18;
    for (var a = 0; a < seedCount; a++) {
      /* 剧本世界：站点是手放的真实省会坐标，一个都不该被面积阈值丢掉。
       * 随机世界仍按"这块胞实际拥有多少陆地"筛。 */
      if (ownerHint) { alive[a] = 1; continue; }
      var need = forcedSeed[a] ? 1 : minLand;
      alive[a] = seedStats[a].landArea >= need ? 1 : 0;
    }

    /* --- 6. 国家划分 ---
     * 两种来源，二选一：
     *   ownerHint（剧本）—— 国界是**给定的**，来自真实政区栅格，不做 BFS、不做平滑。
     *     平滑那一步是为了修随机 BFS 的锯齿，套到真实国界上只会帮倒忙。
     *   否则（随机）—— 多源 BFS 从地理上最分散的国家种子长出来，再平滑。 */
    var owner = new Int16Array(seedCount).fill(-1);
    var countries;

    /* 顶点的质心。两条路径都要用（打包时写进 cx/cy），所以在分叉**之前**算 ——
     * 第一版把它留在 BFS 分支里，剧本世界一跑就在这里 undefined 崩了。 */
    var centroids = new Float64Array(seedCount * 2);
    for (var c2 = 0; c2 < seedCount; c2++) {
      var ct = seedPolys[c2].length >= 6 ? polyCentroid(seedPolys[c2]) : [0, 0];
      centroids[c2 * 2] = ct[0];
      centroids[c2 * 2 + 1] = ct[1];
    }

    if (ownerHint) {
      for (var oh = 0; oh < seedCount; oh++) owner[oh] = ownerHint[oh];
      /* 剧本没覆盖到的站点（补种出来的小岛）挂到最近的已归属站点上，
       * 否则地图上会留下"点了没反应"的无主之地。 */
      for (var ih = 0; ih < seedCount; ih++) {
        if (owner[ih] >= 0) continue;
        var hd = Infinity, ho = 0;
        for (var ht = 0; ht < seedCount; ht++) {
          if (owner[ht] < 0) continue;
          var hx = sites[ih * 2] - sites[ht * 2], hy = sites[ih * 2 + 1] - sites[ht * 2 + 1];
          var hh = hx * hx + hy * hy;
          if (hh < hd) { hd = hh; ho = owner[ht]; }
        }
        owner[ih] = ho;
      }
      countries = o.countries.map(function (d, k) {
        return { id: k, name: d.name, tag: d.tag, color: d.color, accent: d.accent };
      });
    } else {

    var cSeeds = [];
    var firstAlive = 0;
    while (firstAlive < seedCount && !alive[firstAlive]) firstAlive++;
    cSeeds.push(firstAlive);
    while (cSeeds.length < wantCountries) {
      var best = -1, bestD = -1;
      for (var cand = 0; cand < seedCount; cand++) {
        if (!alive[cand] || cSeeds.indexOf(cand) >= 0) continue;
        var nearest = Infinity;
        for (var cs = 0; cs < cSeeds.length; cs++) {
          var ddx2 = centroids[cand * 2] - centroids[cSeeds[cs] * 2];
          var ddy2 = centroids[cand * 2 + 1] - centroids[cSeeds[cs] * 2 + 1];
          var dd2 = ddx2 * ddx2 + ddy2 * ddy2;
          if (dd2 < nearest) nearest = dd2;
        }
        if (nearest > bestD) { bestD = nearest; best = cand; }
      }
      if (best < 0) break;
      cSeeds.push(best);
    }

    var frontier = [];
    for (var ci = 0; ci < cSeeds.length; ci++) { owner[cSeeds[ci]] = ci; frontier.push(cSeeds[ci]); }
    while (frontier.length) {
      var next = [];
      for (var f = 0; f < frontier.length; f++) {
        var cur = frontier[f];
        var nb = seedAdj[cur];
        for (var k2 = 0; k2 < nb.length; k2++) {
          var tj = nb[k2];
          if (!alive[tj] || owner[tj] >= 0) continue;
          owner[tj] = owner[cur];
          next.push(tj);
        }
      }
      frontier = next;
    }
    // 孤立省兜底给最近的已归属省
    for (var iso = 0; iso < seedCount; iso++) {
      if (!alive[iso] || owner[iso] >= 0) continue;
      var bd = Infinity, bo = 0;
      for (var t = 0; t < seedCount; t++) {
        if (owner[t] < 0) continue;
        var ddx3 = centroids[iso * 2] - centroids[t * 2];
        var ddy3 = centroids[iso * 2 + 1] - centroids[t * 2 + 1];
        var dd3 = ddx3 * ddx3 + ddy3 * ddy3;
        if (dd3 < bd) { bd = dd3; bo = owner[t]; }
      }
      owner[iso] = bo;
    }

    /* 严格多数派平滑：只有"过半邻居都是别国"才翻转，否则会雪崩式吞并 */
    for (var pass = 0; pass < 6; pass++) {
      var flips = 0;
      var nextOwner = Int16Array.from(owner);
      for (var s2 = 0; s2 < seedCount; s2++) {
        if (!alive[s2]) continue;
        var tally = Object.create(null);
        var totalN = 0;
        var nb2 = seedAdj[s2];
        for (var k3 = 0; k3 < nb2.length; k3++) {
          var o2 = owner[nb2[k3]];
          if (o2 < 0) continue;
          tally[o2] = (tally[o2] || 0) + 1;
          totalN++;
        }
        if (totalN < 3) continue;
        var mine = owner[s2];
        var myCount = tally[mine] || 0;
        var bestOther = -1, bestCount = myCount;
        for (var key in tally) {
          if (+key === mine) continue;
          if (tally[key] > bestCount) { bestCount = tally[key]; bestOther = +key; }
        }
        // 必须是绝对多数（> 一半），且严格多于自己
        if (bestOther >= 0 && bestCount * 2 > totalN && bestCount > myCount) {
          nextOwner[s2] = bestOther;
          flips++;
        }
      }
      owner = nextOwner;
      if (!flips) break;
    }

    /* 重映射到连续国家编号 */
    var present = Object.create(null);
    for (var pa = 0; pa < seedCount; pa++) if (alive[pa] && owner[pa] >= 0) present[owner[pa]] = 1;
    var usedOwners = Object.keys(present).map(Number).sort(function (a, b) { return a - b; });
    var remap = new Int16Array(wantCountries).fill(-1);
    for (var u = 0; u < usedOwners.length; u++) remap[usedOwners[u]] = u;
    for (var rr = 0; rr < seedCount; rr++) if (owner[rr] >= 0) owner[rr] = remap[owner[rr]];
    var C = usedOwners.length;

    countries = [];
    for (var cc = 0; cc < C; cc++) {
      var def = COUNTRY_DEFS[cc % COUNTRY_DEFS.length];
      countries.push({ id: cc, name: def.name, tag: def.tag, color: def.color, accent: def.accent });
    }
    }   /* ← 结束「随机世界」分支 */

    /* --- 7. 打包 --- */
    /* 省名：剧本给真名（"鲁尔""关中"），随机世界用名字生成器。
     * 生成器只在随机路径上构造 —— 它要吃 rng，序列一动全图都漂。 */
    var nameGen = o.nameOf ? null : makeNameGen(rng);
    var indexOfSeed = new Int32Array(seedCount).fill(-1);
    var provinces = [];
    for (var pp = 0; pp < seedCount; pp++) {
      if (!alive[pp] || owner[pp] < 0) continue;
      indexOfSeed[pp] = provinces.length;
      provinces.push({
        id: provinces.length,
        seedIndex: pp,
        name: nameGen ? nameGen() : o.nameOf(pp),
        poly: seedPolys[pp],
        cx: centroids[pp * 2],
        cy: centroids[pp * 2 + 1],
        // 站点坐标（Voronoi 的生成点）。注意它和质心不是一回事 ——
        // 求两个胞的公共边必须用中垂于站点的直线，用质心会一条边都匹配不上。
        sx: sites[pp * 2],
        sy: sites[pp * 2 + 1],
        country: owner[pp],
        area: seedStats[pp].landArea,
        cellArea: seedStats[pp].cellArea,
        landFrac: seedStats[pp].landFrac,
        neighbors: []
      });
    }
    for (var z = 0; z < provinces.length; z++) {
      var src = seedAdj[provinces[z].seedIndex];
      var out = [];
      for (var w2 = 0; w2 < src.length; w2++) {
        var idx = indexOfSeed[src[w2]];
        if (idx >= 0) out.push(idx);
      }
      provinces[z].neighbors = out;
    }

    return {
      width: W,
      height: H,
      mask: mask,
      provinces: provinces,
      countries: countries,
      landCount: landCount,
      seedCount: seedCount
    };

  }


  VIC.mapgen = {
    generate: generate,
    packWorld: packWorld,
    pointInPoly: pointInPoly,
    polyArea: polyArea,
    polyCentroid: polyCentroid
  };
})(typeof window !== 'undefined' ? window : globalThis);
