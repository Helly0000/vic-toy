/* 蒸汽与账本 — 剧本数据层（**世界即数据**）
 *
 * 为什么要有这一层
 * ----------------
 * 在这之前，世界只有一种来源：`js/mapgen.js` 用噪声造大陆、抖动网格播种、BFS 分国。
 * 那张地图是**好看且自洽**的，但它和"真实地球"没有任何关系 —— 于是冷战题材
 * （1945–2045）没有落脚点：不能有"鲁尔区""关中""巴库"，也就没有"谁缺油"。
 *
 * 这一层把"世界"变成**纯数据**：一个国家是一行，一个省是一行，一张地图是一张字符画。
 * 加一个省是三行文本，加一个国家是五行 —— 不需要碰任何模拟代码。
 * 这条设计直接借自 Fallowborn（dli9431/fallowborn），它的原话是
 * "The entire world is data… adding a province is three lines of text"。
 *
 * 纪律：**剧本世界和随机世界共用地理流水线**
 * ----------------------------------------
 * `VIC.mapgen.packWorld()` 是地理的后半段（站点 → Voronoi 胞 → 陆地统计 → 邻接
 * → 国家 → 打包），`js/mapgen.js` 的 `generate()` 和这里的 `build()` 都调它。
 * 这条纪律不是洁癖，是**标定的前提**：所有参数（基建成本、商路衰减、天花板余量）
 * 都是在随机地图上标定的；如果剧本世界走另一套地理代码，那些数字就没有理由适用。
 * 分叉只有三处 —— 国家怎么来、省份叫什么、站点推不推。
 *
 * 数据格式（`VIC.scenario.define(def)`）
 * ------------------------------------
 *   id / name            标识与显示名
 *   year                 起始年份（喂给 sim，覆盖默认的 1836）
 *   width / height       画布像素尺寸（默认 1600×1000）
 *   grid                 字符画：每行等长，一个字符 = 一个国家 tag 的首字母或数字
 *   codes                字符 → 国家 tag 的映射（省略则按 tag 首字母自动推）
 *   ocean                海洋字符（默认 '.'）
 *   countries[]          { tag, name, color?, accent?, factors{ farm,oil,mine,wood,ind } }
 *   provinces[]          { n: 省名, c: 国家 tag, lat, lon, p: 人口(百万), t?: 要素倾斜 }
 *   eras                 { 1973: { tag: {farm,oil,...} } } —— 时代解锁用的另一张资源表
 *   blocs                { ID: { name, members: [tag…] } } —— 阵营（省略 = 没有阵营）
 *   blocRelation         [ [ID, ID, 0..1] … ] —— 阵营之间的关系，1 = 正常通商，0 = 全面禁运
 *   latTop/latBottom     字符画覆盖的纬度范围（默认 84N ~ 61S）
 *
 * 坐标约定
 * -------
 * 等距圆柱投影：x = (lon + 180) / 360 × W，y = (latTop − lat) / (latTop − latBottom) × H。
 * 1600×1000 的画幅配 360° 经度是放不下的（要 225° 纬度才等比例），所以南北方向被
 * 拉伸了约 1.55 倍。这不是失误：sim 的距离是**像素欧氏距离**，而真实地球上 1° 纬度
 * 恒为 111km、1° 经度在中纬度只有 ~78km —— 两者恰好抵消，在 30°–55° 纬度带上
 * 误差最小（那正是本作主要战场所在）。代价是高纬度的东西向距离被压扁。
 *
 * 依赖：VIC.rng（噪声）、VIC.mapgen（packWorld）。两个都在调用时才取，见 build()。
 */
(function (root) {
  'use strict';
  var VIC = root.VIC || (root.VIC = {});
  var R = VIC.rng;
  var clamp = R.clamp;

  var SCENARIOS = {};

  /* ═══════════ 真实要素 → 模拟层的四条禀赋通道 ═══════════
   * sim 只认识四条通道（fert / timber / mineral / urban），它们同时决定两件事：
   *   geoBonus  —— 效率：同样的厂，这个省产出多少
   *   levelCap  —— 规模：这种厂这个省最多能建几级
   * 真实数据是"某国某要素占世界份额"，需要先换算成"人均禀赋"才能进这两条通道：
   *
   *   perCapita(f, c) = 要素份额(f, c) / 人口份额(c)        （1.0 = 世界平均）
   *
   * 这个量的分布是**长尾**的：1945 年沙特的石油人均禀赋是世界平均的 100 倍以上，
   * 而印度的耕地只有 0.7 倍。直接塞进 sim 会炸 —— geoBonus 的公式是
   * `1 + (通道 − 1) × 灵敏度`，通道 100 就是 40 倍产出。
   *
   * 所以要做一次压缩。形状是幂函数 `perCapita ^ BETA`，BETA 与上下限都不是拍的：
   * `test/endow-calib.js` 先量出**随机地图上这四条通道的实际分布**（p10 / p50 / p90），
   * 再选 BETA 让剧本世界的分布和它同形。理由很实在：sim 的常数全是照着那个分布
   * 标定的，分布一致 → 常数继续有效；分布不同 → 每一条标定都得重来。
   */
  var ENDOW = {
    /* 目标分布：**随机地图上四条通道的实际分位数**，由 test/endow-calib.js 量出。
     * 每一条通道的均值都不一样（耕地 0.55、工业 0.63、矿产 0.50），
     * 所以不能用一个统一的标尺 —— 必须逐通道对齐。 */
    TARGET: {
      fert:    { p10: 0.273, p50: 0.553, p90: 0.860, lo: 0.25, hi: 1.25 },
      timber:  { p10: 0.325, p50: 0.582, p90: 0.865, lo: 0.25, hi: 1.32 },
      mineral: { p10: 0.192, p50: 0.483, p90: 0.827, lo: 0.10, hi: 1.30 },
      urban:   { p10: 0.346, p50: 0.643, p90: 0.891, lo: 0.25, hi: 1.25 }
    },
    /* 工具 ← 矿产与石油合并：sim 没有石油这条商品，而两者都是"采掘业禀赋"。
     * 权重按 1945 年两者的世界经济分量粗估 —— 它只影响两条曲线的融合方式。 */
    ORE: { mine: 0.70, oil: 0.30 },
    FLOOR: 1e-3           // 人均禀赋的对数下限，避免 wood=0 的国家炸出 -Infinity
  };

  /* ═══════════ 人均禀赋 → 通道：分位数锚定的仿射映射 ═══════════
   *
   * 第一版用的是幂压缩 `perCapita ^ BETA`，实测失败，原因值得记住：
   * 随机地图上四条通道的**均值只有 0.50~0.63**（不是 1！因为它们是
   * `fbm × 1.7 − 0.25` 再截断的产物），而真实人均禀赋的中心在 1 附近。
   * 幂压缩只压"离散度"，压不动"中心" —— 结果剧本世界整体悬在 1.85，
   * 并且 90 分位全部顶在截断上限上，上半段完全没有区分度。
   *
   * 换成分位数锚定：把 `ln(人均禀赋)` 的 p10/p50/p90 **线性地**贴到目标通道的
   * p10/p50/p90 上。于是
   *   · 水平对齐（均值、中位数都对得上）—— geoBonus 一族常数继续有效
   *   · 离散度对齐 —— levelCap 的余量继续有效
   *   · 真实性只贡献**排序与相对倍数**，那正是数据真正可靠的 part
   * 超出 p10~p90 的部分按同一斜率外推，再截到随机世界观测到的极值。
   */
  /* 折线（两段）：中位数以下一段斜率、以上另一段。
   * 为什么不能用一条直线：真实人均禀赋的对数分布是**偏的** ——
   * 例如森林的 p10 在中位数下方 1.28，p90 在上方 1.88。一条直线只能同时对齐
   * "中位数"和"总跨度"，两端必然一头高一头低（实测森林被整体抬高、工业被压低）。
   * 两段折线可以同时把 p10 / p50 / p90 三点钉死，也就是把**偏度**一起搬过来。 */
  function fitChannel(logVals, wSum, tgt) {
    var n = logVals.length;
    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    var wOf = logVals.w || null;
    idx.sort(function (a, b) { return logVals[a] - logVals[b]; });
    function q(p) {
      var target = p * wSum, acc = 0;
      for (var k = 0; k < idx.length; k++) {
        acc += wOf ? wOf[idx[k]] : 1;
        if (acc >= target) return logVals[idx[k]];
      }
      return logVals[idx[idx.length - 1]];
    }
    var p10 = q(0.10), p50 = q(0.50), p90 = q(0.90);
    var loSpan = p50 - p10, hiSpan = p90 - p50;
    var loSlope = loSpan > 1e-9 ? (tgt.p50 - tgt.p10) / loSpan : 0;
    var hiSlope = hiSpan > 1e-9 ? (tgt.p90 - tgt.p50) / hiSpan : 0;
    return function (lp) {
      var v = (lp < p50)
        ? tgt.p50 + (lp - p50) * loSlope
        : tgt.p50 + (lp - p50) * hiSlope;
      return v < tgt.lo ? tgt.lo : (v > tgt.hi ? tgt.hi : v);
    };
  }

  /* ═══════════ 栅格 → 掩码 ═══════════
   * 字符画是 5° 一格的粗格（72×30 那种量级）。直接放大 = 直角海岸线，像 Excel 画的。
   * 做法分三步，每一步都在修一个具体的问题：
   *   1) 3×3 均值模糊两遍 → 粗格的 0/1 变成 0..1 的斜坡，格子边界有了过渡带
   *   2) 斜坡上叠一层噪声再取阈值 → 海岸线从"等值线"变成有海湾与半岛的折线
   *   3) 去孤点 / 填孤洞 → 采样与噪声会在近海留一些一两像素的碎渣
   * 噪声幅度必须**小于**海洋区的斜坡高度，否则经度接缝处会凭空长出一条陆地
   * （接缝在 180° 太平洋中央，那里必须永远是海 —— test/scenario-test.js 会断言这件事）。
   */
  function box3(src, rows, cols) {
    var out = new Float32Array(rows * cols);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var s = 0, n = 0;
        for (var dr = -1; dr <= 1; dr++) {
          var rr = r + dr;
          if (rr < 0 || rr >= rows) continue;         // 纬度不绕圈
          for (var dc = -1; dc <= 1; dc++) {
            var cc = ((c + dc) % cols + cols) % cols; // 经度**要**绕圈
            s += src[rr * cols + cc]; n++;
          }
        }
        out[r * cols + c] = s / n;
      }
    }
    return out;
  }

  /* 3×3 膨胀（取邻域最大值），经度方向环绕。
   * **为什么必须有这一步**：5° 栅格上的日本、新西兰、尤卡坦都只有两三格宽，
   * 两遍 3×3 均值模糊会把它们的中心值压到 0.55 上下，再加上海岸噪声，
   * 于是一半的孤立小岛会掉到 0.5 阈值以下 —— 直接从地图上消失。
   * 实测：不膨胀时「关东-东京」「南部-尤卡坦」「新西兰」三个省的 landArea 是 0，
   * 也就是整块陆地连同省会一起没了。先膨胀再模糊，岛屿的中心值回到 0.8 以上，
   * 而海岸线仍然是平滑的（膨胀只放大半格，模糊再把它抹开）。 */
  function dilate3(src, rows, cols) {
    var out = new Float32Array(rows * cols);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var mx = 0;
        for (var dr = -1; dr <= 1; dr++) {
          var rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (var dc = -1; dc <= 1; dc++) {
            var cc = ((c + dc) % cols + cols) % cols;
            var v = src[rr * cols + cc];
            if (v > mx) mx = v;
          }
        }
        out[r * cols + c] = mx;
      }
    }
    return out;
  }

  /* 双线性采样，经度方向环绕 */
  function sampleSoft(soft, rows, cols, fx, fy) {
    var x = fx - 0.5, y = fy - 0.5;
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var tx = x - x0, ty = y - y0;
    var c0 = ((x0 % cols) + cols) % cols, c1 = (c0 + 1) % cols;
    var r0 = clamp(y0, 0, rows - 1), r1 = clamp(y0 + 1, 0, rows - 1);
    var a = soft[r0 * cols + c0], b = soft[r0 * cols + c1];
    var cc = soft[r1 * cols + c0], d = soft[r1 * cols + c1];
    var top = a + (b - a) * tx, bot = cc + (d - cc) * tx;
    return top + (bot - top) * ty;
  }

  /* 去孤点 / 填孤洞。判据用 4 邻域 —— 8 邻域会把对角相连的细长陆地也当成"有邻居" */
  function despeckle(mask, W, H) {
    var x, y, n;
    var tmp = new Uint8Array(mask.length);
    for (var pass = 0; pass < 2; pass++) {
      tmp.set(mask);
      for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
          var idx = y * W + x;
          n = 0;
          if (x > 0 && tmp[idx - 1]) n++;
          if (x < W - 1 && tmp[idx + 1]) n++;
          if (y > 0 && tmp[idx - W]) n++;
          if (y < H - 1 && tmp[idx + W]) n++;
          if (mask[idx]) { if (n === 0) mask[idx] = 0; }
          else { if (n >= 4) mask[idx] = 1; }
        }
      }
    }
    // 再扫一遍：把只剩 1 个邻居的孤立小片也清掉（两遍足够，W×H 是 160 万，别贪）
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        var id2 = y * W + x;
        if (!mask[id2]) continue;
        n = 0;
        if (x > 0 && mask[id2 - 1]) n++;
        if (x < W - 1 && mask[id2 + 1]) n++;
        if (y > 0 && mask[id2 - W]) n++;
        if (y < H - 1 && mask[id2 + W]) n++;
        if (n <= 1) mask[id2] = 0;
      }
    }
    return mask;
  }

  /* ═══════════ 定义与校验 ═══════════ */

  function codesOf(def) {
    if (def.codes) return def.codes;
    var m = {};
    for (var i = 0; i < def.countries.length; i++) {
      var t = def.countries[i].tag;
      m[t.charAt(0)] = t;
      m[t.charAt(0).toLowerCase()] = t;
    }
    return m;
  }

  /* 省份有两种写法，这里统一成一种：
   *   A) 按国家分组的对象（**推荐**，也就是"加一个省是一行文本"的字面实现）
   *        provinces: { USA: [['新英格兰', 42.4, -71.1, 11], …], SUN: [...] }
   *        每行 = 省名 / 纬度 / 经度 / 人口(百万) / 要素倾斜(可选，形如 { oil: 3.0 })
   *   B) 扁平数组：[{ n:'新英格兰', c:'USA', lat:42.4, lon:-71.1, p:11 }, …]
   * 分组写法把"这个省属于谁"编码进了位置，少写一个字段，也少一类错。
   */
  function provList(def) {
    var out = [];
    var src = def.provinces || {};
    if (Object.prototype.toString.call(src) === '[object Array]') {
      for (var i = 0; i < src.length; i++) out.push(src[i]);
      return out;
    }
    Object.keys(src).forEach(function (tag) {
      var rows = src[tag] || [];
      for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        out.push({ n: r[0], lat: r[1], lon: r[2], p: r[3], t: r[4], c: tag });
      }
    });
    return out;
  }

  /* 返回**问题列表**（空数组 = 通过）。不抛异常 —— 校验器要能一次报出所有毛病，
   * 而不是让作者修一个跑一次。 */
  /* 阵营声明 → 一张 tag → blocId 的表。校验与 build 共用，避免两处口径。 */
  function blocMap(def) {
    var out = {};
    var blocs = def.blocs;
    if (!blocs) return out;
    Object.keys(blocs).forEach(function (id) {
      var m = (blocs[id] && blocs[id].members) || [];
      for (var i = 0; i < m.length; i++) out[m[i]] = id;
    });
    return out;
  }

  function validate(def) {
    var bad = [];
    var need = function (cond, msg) { if (!cond) bad.push(msg); };
    need(def && def.id, '缺少 id');
    need(def && def.grid && def.grid.length, '缺少 grid');
    if (!def || !def.grid) return bad;

    var cols = def.grid[0].length;
    for (var r = 0; r < def.grid.length; r++) {
      need(def.grid[r].length === cols,
        'grid 第 ' + r + ' 行长度 ' + def.grid[r].length + ' ≠ 首行 ' + cols);
    }

    var codes = codesOf(def);
    var ocean = def.ocean || '.';
    var seen = {};
    for (var r2 = 0; r2 < def.grid.length; r2++) {
      for (var c = 0; c < cols; c++) {
        var ch = def.grid[r2].charAt(c);
        if (ch === ocean) continue;
        if (!codes[ch]) bad.push('grid 第 ' + r2 + ' 行第 ' + c + ' 列的字符「' + ch + '」没有对应国家');
        else seen[codes[ch]] = (seen[codes[ch]] || 0) + 1;
      }
    }

    var tags = {};
    (def.countries || []).forEach(function (c) {
      need(c.tag && c.name, '国家缺少 tag 或 name：' + JSON.stringify(c));
      if (c.tag) {
        need(!tags[c.tag], '国家 tag 重复：' + c.tag);
        tags[c.tag] = 1;
      }
      var f = c.factors || {};
      ['farm', 'oil', 'mine', 'wood', 'ind'].forEach(function (k) {
        need(typeof f[k] === 'number' && f[k] >= 0,
          '国家 ' + c.tag + ' 的要素 ' + k + ' 缺失或非法');
      });
    });
    Object.keys(seen).forEach(function (t) {
      need(tags[t], 'grid 里出现了未登记的国家 ' + t);
    });
    Object.keys(tags).forEach(function (t) {
      need(seen[t], '国家 ' + t + ' 在 grid 里一格都没有');
    });

    var popSum = 0;
    provList(def).forEach(function (p, i) {
      var at = '省 #' + i + '「' + (p.n || '?') + '」';
      need(p.n, at + ' 缺少省名 n');
      need(typeof p.lat === 'number' && p.lat <= 90 && p.lat >= -90, at + ' 纬度非法');
      need(typeof p.lon === 'number' && p.lon <= 180 && p.lon >= -180, at + ' 经度非法');
      need(typeof p.p === 'number' && p.p > 0, at + ' 人口 p 缺失或非正');
      if (p.c) need(tags[p.c], at + ' 的国家 ' + p.c + ' 未登记');
      popSum += (p.p || 0);
      // 站点必须落在自己声明的国家里 —— 这是**最值得自动抓**的一类错：
      // 经纬度写反 / 小数点错位，肉眼看不出来，画出来才发现那个省飞到了别国
      if (p.c && typeof p.lat === 'number' && typeof p.lon === 'number') {
        var cell = cellOf(def, p.lat, p.lon);
        if (cell && cell !== def.ocean) {
          var owner = codes[cell];
          if (owner !== p.c) {
            bad.push(at + ' 落在 ' + owner + ' 的格子上（声明的是 ' + p.c +
              '）；经纬度写错了，或者 grid 没画到那里');
          }
        } else {
          bad.push(at + ' 落在海里（' + p.lat + ', ' + p.lon + '）；经纬度写错了，' +
            '或者 grid 没画到那里');
        }
      }
    });
    need(popSum > 0, '所有省的人口加起来是 0');
    return bad;
  }

  /* 经纬度 → 字符画格子 */
  function cellOf(def, lat, lon) {
    var rows = def.grid.length, cols = def.grid[0].length;
    var latTop = def.latTop === undefined ? 84 : def.latTop;
    var latBot = def.latBottom === undefined ? -61 : def.latBottom;
    var r = Math.floor((latTop - lat) / (latTop - latBot) * rows);
    var c = Math.floor((lon + 180) / 360 * cols);
    if (r < 0 || r >= rows) return null;
    c = ((c % cols) + cols) % cols;
    return def.grid[r].charAt(c);
  }

  /* 阵营校验单独一遍，理由是它**不属于 grid** —— grid 那一段验的是字符画，
   * 这里验的是「谁和谁一伙」。混在一起会让错误信息指错地方。 */
  function validateBlocs(def) {
    var bad = [];
    var blocs = def.blocs;
    if (!blocs) return bad;
    var tagSet = {};
    (def.countries || []).forEach(function (c) { tagSet[c.tag] = 1; });

    var owner = {};
    Object.keys(blocs).forEach(function (id) {
      var b = blocs[id];
      if (!b || typeof b !== 'object') { bad.push('阵营「' + id + '」不是一个对象'); return; }
      var m = b.members;
      if (!m || !m.length) { bad.push('阵营「' + id + '」没有成员'); return; }
      for (var i = 0; i < m.length; i++) {
        if (!tagSet[m[i]]) bad.push('阵营「' + id + '」的成员「' + m[i] + '」不在 countries 里');
        else if (owner[m[i]]) bad.push('国家「' + m[i] + '」同时属于阵营「' + owner[m[i]] + '」和「' + id + '」');
        else owner[m[i]] = id;
      }
    });

    var seenPair = {};
    (def.blocRelation || []).forEach(function (row, i) {
      if (!row || row.length !== 3) { bad.push('blocRelation 第 ' + i + ' 项不是 [ID, ID, 值]'); return; }
      var a = row[0], b = row[1], v = row[2];
      if (!blocs[a]) bad.push('blocRelation 第 ' + i + ' 项引用了不存在的阵营「' + a + '」');
      if (!blocs[b]) bad.push('blocRelation 第 ' + i + ' 项引用了不存在的阵营「' + b + '」');
      if (a === b) bad.push('blocRelation 第 ' + i + ' 项两端都是「' + a + '」—— 同阵营内部关系恒为 1');
      if (!(typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1)) {
        bad.push('blocRelation「' + a + '↔' + b + '」的值 ' + v + ' 不在 0..1');
      }
      var key = a < b ? a + '|' + b : b + '|' + a;
      if (seenPair[key]) bad.push('blocRelation 里「' + a + '↔' + b + '」声明了不止一次');
      seenPair[key] = 1;
    });
    return bad;
  }

  /* 阵营两两之间的关系矩阵（对称）。未声明的组合取 1.0 ——
   * 于是「不写 blocs」与「写了但关系全 1」在模型里是同一件事。 */
  function blocMatrix(tags, owner, rel) {
    var C = tags.length;
    var m = new Float32Array(C * C);
    m.fill(1);
    var pair = {};
    (rel || []).forEach(function (row) {
      if (!row || row.length !== 3) return;
      var key = row[0] < row[1] ? row[0] + '|' + row[1] : row[1] + '|' + row[0];
      pair[key] = row[2];
    });
    for (var a = 0; a < C; a++) {
      for (var b = 0; b < C; b++) {
        if (a === b) continue;
        var ba = owner[tags[a]], bb = owner[tags[b]];
        if (!ba || !bb || ba === bb) continue;      // 同阵营 / 无阵营 ⇒ 1.0
        var k = ba < bb ? ba + '|' + bb : bb + '|' + ba;
        if (pair[k] !== undefined) m[a * C + b] = pair[k];
      }
    }
    return m;
  }

  function define(def) {
    var bad = validate(def);
    bad = bad.concat(validateBlocs(def));      // 两遍分开查，错误信息才指得准地方
    if (bad.length) {
      var e = new Error('剧本「' + (def && def.id) + '」有 ' + bad.length + ' 处问题：\n  ' +
        bad.slice(0, 24).join('\n  ') + (bad.length > 24 ? '\n  …还有 ' + (bad.length - 24) + ' 处' : ''));
      e.problems = bad;
      throw e;
    }
    def._prov = provList(def);      // 统一成扁平数组：build 与测试都只读这一个
    SCENARIOS[def.id] = def;
    return def;
  }

  /* ═══════════ 构建：数据 → sim 认识的那张 map ═══════════ */

  function lonToX(lon, W) { return (lon + 180) / 360 * W; }
  function latToY(lat, def, H) {
    var latTop = def.latTop === undefined ? 84 : def.latTop;
    var latBot = def.latBottom === undefined ? -61 : def.latBottom;
    return (latTop - lat) / (latTop - latBot) * H;
  }

  function build(def, opts) {
    opts = opts || {};
    var MG = VIC.mapgen;
    if (!MG || !MG.packWorld) throw new Error('data/scenario.js 需要先加载 js/mapgen.js');

    var W = opts.width || def.width || 1600;
    var H = opts.height || def.height || 1000;
    var rng = R.makeRng(opts.seed === undefined ? (def.seed || def.year || 1945) : opts.seed);
    var rows = def.grid.length, cols = def.grid[0].length;
    var ocean = def.ocean || '.';
    var codes = codesOf(def);

    /* —— 1. 字符画 → 粗格软场 —— */
    var raw = new Float32Array(rows * cols);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        raw[r * cols + c] = def.grid[r].charAt(c) === ocean ? 0 : 1;
      }
    }
    var soft = box3(box3(dilate3(raw, rows, cols), rows, cols), rows, cols);

    /* —— 2. 软场 → 像素掩码 —— */
    var nCoast = R.makeNoise(rng, 128);
    var amp = def.coastNoise === undefined ? 0.085 : def.coastNoise;
    var freq = def.coastFreq === undefined ? 6.5 : def.coastFreq;
    var field = new Float32Array(W * H);
    for (var y = 0; y < H; y++) {
      var v = (y + 0.5) / H * rows;
      for (var x = 0; x < W; x++) {
        var u = (x + 0.5) / W * cols;
        var s = sampleSoft(soft, rows, cols, u, v);
        s += (R.fbm(nCoast, (x / W) * freq, (y / H) * freq * 1.9, 3, 2, 0.5) - 0.5) * amp;
        field[y * W + x] = s;
      }
    }

    /* 二分阈值，命中字符画自己的陆地占比。
     * 这一步是必需的，不是讲究：膨胀让陆地整体变胖 ——
     * 实测固定阈值 0.5 时，35.7% 的字符画会变成 54.9% 的像素，
     * 海洋缩成几条缝，大西洋和地中海都不见了。
     * 二分之后陆地占比回到字符画本身的值，而海岸线的形状仍然由膨胀+模糊+噪声决定。
     * （这招是从 js/mapgen.js 的大陆生成里搬来的：不让阈值变成需要手调的旋钮。） */
    var rawLand = 0;
    for (var rl = 0; rl < raw.length; rl++) if (raw[rl] > 0) rawLand++;
    var want = Math.round(W * H * (rawLand / raw.length));
    var lo = -0.6, hi = 1.6;
    for (var it = 0; it < 22; it++) {
      var mid = (lo + hi) * 0.5, cnt = 0;
      for (var fi = 0; fi < field.length; fi++) if (field[fi] > mid) cnt++;
      if (cnt > want) lo = mid; else hi = mid;
    }
    var thr = (lo + hi) * 0.5;
    var mask = new Uint8Array(W * H);
    for (var mi = 0; mi < field.length; mi++) mask[mi] = field[mi] > thr ? 1 : 0;
    despeckle(mask, W, H);

    /* —— 3. 站点：真实经纬度 → 像素坐标 —— */
    var provs = def._prov || provList(def);
    var sites = new Float64Array(provs.length * 2);
    var ownerHint = new Int16Array(provs.length);
    var tagToIdx = {};
    def.countries.forEach(function (cd, i) { tagToIdx[cd.tag] = i; });
    for (var q = 0; q < provs.length; q++) {
      sites[q * 2] = lonToX(provs[q].lon, W);
      sites[q * 2 + 1] = latToY(provs[q].lat, def, H);
      ownerHint[q] = tagToIdx[provs[q].c];
    }

    /* —— 4. 交给 mapgen 的后半段 —— */
    var landCount = 0;
    for (var m = 0; m < mask.length; m++) if (mask[m]) landCount++;

    var countryDefs = def.countries.map(function (cd, i) {
      var hue = Math.round(i * 360 / def.countries.length);
      return {
        tag: cd.tag, name: cd.name,
        color: cd.color || ('hsl(' + hue + ' 42% 46%)'),
        accent: cd.accent || ('hsl(' + hue + ' 52% 68%)')
      };
    });

    var cellSize = Math.sqrt(landCount / Math.max(1, provs.length));
    var map = MG.packWorld({
      W: W, H: H, mask: mask, sites: sites, rng: rng,
      cellSize: cellSize, baseMin: cellSize * 0.62,
      /* 剧本的站点是手放的真实城市坐标，不该被随机推走 —— 只留一点点抖动，
       * 让省界不是完美的中垂线（完美中垂线在地图上看着像用尺子画的）。 */
      jitterScale: 0.18,
      ownerHint: ownerHint, countries: countryDefs,
      landCount: landCount,
      /* 补种出来的小岛没有名字 —— 用最近的有名省来命名，比"无名地-42"可读 */
      nameOf: function (si, isForced) {
        if (!isForced && si < provs.length) return provs[si].n;
        return nearestName(sites, si, provs.length, provs);
      }
    });

    map.scenario = def.id;
    map.year = def.year || 1836;
    /* 省份规模的钳位随剧本走。sim 的默认 [0.35, 2.8] 是照随机世界标定的
     * （那里的省际人口差只有 2 倍），真实地球差 2000 倍，需要宽一点。
     * 剧本不声明就用 sim 的默认值 —— 随机世界因此一位都不动。 */
    if (def.scaleLo !== undefined) map.scaleLo = def.scaleLo;
    if (def.scaleHi !== undefined) map.scaleHi = def.scaleHi;

    /* —— 阵营：剧本声明 → 一张 C×C 的初始关系矩阵 ——
     * 放在 map 上而不是直接写进 world，理由和 scaleLo 一样：
     * 剧本给的是**世界的初始设定**，world 决定要不要采纳（sim 那边有兜底）。
     * 随机世界没有 blocOf，于是它一位都不动。 */
    var blocTags = def.countries.map(function (cd) { return cd.tag; });
    var blocOwner = blocMap(def);
    map.blocOf = new Int8Array(blocTags.length);
    map.blocIds = [];
    var blocIdx = {};
    Object.keys(def.blocs || {}).forEach(function (id) {
      blocIdx[id] = map.blocIds.length;
      map.blocIds.push({ id: id, name: (def.blocs[id] && def.blocs[id].name) || id });
    });
    for (var bt = 0; bt < blocTags.length; bt++) {
      var bo = blocOwner[blocTags[bt]];
      map.blocOf[bt] = (bo === undefined) ? -1 : blocIdx[bo];
    }
    map.relation0 = blocMatrix(blocTags, blocOwner, def.blocRelation);

    /* —— 5. 禀赋与人口：数据 → 四条通道 —— */
    attachEndowments(map, def, provs, tagToIdx, opts);
    return map;
  }

  function nearestName(sites, si, namedCount, provs) {
    var bx = sites[si * 2], by = sites[si * 2 + 1];
    var bd = Infinity, bi = -1;
    for (var i = 0; i < namedCount; i++) {
      var dx = sites[i * 2] - bx, dy = sites[i * 2 + 1] - by;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi >= 0 ? (provs[bi].n + '外海') : ('无名地 ' + si);
  }

  /* 把国家/省的要素数据算成 sim 的四条通道 + 初始人口，挂在 map.provinces 上。
   * sim 只在**字段存在时**才用它们（见 js/sim.js 的"世界接口"一节），
   * 所以随机地图一个字段都不带，走原来的噪声路径 —— 两边互不干扰。 */
  function attachEndowments(map, def, provs, tagToIdx, opts) {
    var eraKey = opts.era && def.eras && def.eras[opts.era] ? opts.era : null;
    var C = def.countries.length;

    /* 1) 各国的人口份额与要素份额 */
    var popShare = new Float64Array(C), popSum = 0;
    for (var i = 0; i < provs.length; i++) popSum += provs[i].p;
    for (var i2 = 0; i2 < provs.length; i2++) popShare[tagToIdx[provs[i2].c]] += provs[i2].p / popSum;

    var keys = ['farm', 'oil', 'mine', 'wood', 'ind'];
    var share = {};                       // share[要素][国家]
    keys.forEach(function (k) {
      var arr = new Float64Array(C), tot = 0;
      for (var c = 0; c < C; c++) {
        var f = (eraKey && def.eras[eraKey][def.countries[c].tag]) || def.countries[c].factors;
        arr[c] = f[k] || 0; tot += arr[c];
      }
      for (var c2 = 0; c2 < C; c2++) arr[c2] = tot > 0 ? arr[c2] / tot : 0;
      share[k] = arr;
    });

    /* 2) 人均要素禀赋（1.0 = 世界平均）。
     * 注意：**不需要再归一化** —— 份额各自求和为 1，于是人口加权平均的 perCapita
     * 恒等于 1。这是选"份额比份额"这个定义式的唯一理由。 */
    function perCapita(k, c) {
      return popShare[c] > 0 ? share[k][c] / popShare[c] : 0;
    }

    /* 3) 国的要素倾斜 → 省的倾斜。倾斜是"相对本国平均的倍数"，默认 1，
     *    在**国内按人口加权归一**，于是国内总和严格守恒（不会因为写了倾斜就凭空多出要素）。 */
    var tiltKeys = ['farm', 'oil', 'mine', 'wood', 'ind'];
    var tiltMean = {};                    // 每国每要素的**国内**人口加权平均倾斜
    for (var c3 = 0; c3 < C; c3++) {
      tiltMean[c3] = {};
      tiltKeys.forEach(function (k) { tiltMean[c3][k] = 0; });
    }
    /* 归一化的分母必须是**本国人口**，不是世界人口。
     * 踩过的坑：第一版写成 `src.p / popSum`（世界份额），于是 tiltMean 只有
     * 本国世界人口份额那么大，tn = tilt/tiltMean 被放大了 10~40 倍，
     * 人均禀赋的对数中位数跑到 3.28（≈ 26 倍世界平均）。
     * 分位数映射把这个荒谬的尾巴整个压平了，看起来"能用"，其实是错的。 */
    var countryPop = new Float64Array(C);
    for (var cp0 = 0; cp0 < provs.length; cp0++) countryPop[tagToIdx[provs[cp0].c]] += provs[cp0].p;
    var provOf = map.provinces;
    /* 站点顺序 = 省的顺序（ownerHint 让所有站点都存活，不会错位），
     * 但补种出来的额外省没有对应数据，只在 0..provs.length-1 上有。 */
    for (var p = 0; p < provOf.length && p < provs.length; p++) {
      var src = provs[p], t = src.t || {};
      var ci = provOf[p].country;
      var wgt = countryPop[ci] > 0 ? src.p / countryPop[ci] : 0;
      tiltKeys.forEach(function (k) { tiltMean[ci][k] += wgt * (t[k] === undefined ? 1 : t[k]); });
    }

    /* 4) 第一遍：把每条通道的 ln(人均禀赋) 收齐。
     *    必须**先收齐再映射** —— 分位数是全局量，逐省算不出来。
     *    这一遍只记原始量，不写通道。 */
    var TARGET_POP = opts.targetPop === undefined ? 2.5e7 : opts.targetPop;
    var popScale = TARGET_POP / popSum;
    var chans = ['fert', 'timber', 'mineral', 'urban'];
    var logBuf = {};
    chans.forEach(function (k) { logBuf[k] = []; logBuf[k].w = []; });
    function pushLog(k, v, wgt) {
      logBuf[k].push(Math.log(Math.max(ENDOW.FLOOR, v)));
      logBuf[k].w.push(wgt);
    }

    for (var q = 0; q < provOf.length && q < provs.length; q++) {
      var s = provs[q], cc = provOf[q].country, tt = s.t || {};
      var tl = tiltMean[cc];                     // 本国的人口加权平均倾斜
      function tn(k) { return (tt[k] === undefined ? 1 : tt[k]) / (tl[k] > 0 ? tl[k] : 1); }
      var pcFarm = perCapita('farm', cc) * tn('farm');
      var pcWood = perCapita('wood', cc) * tn('wood');
      var pcMine = perCapita('mine', cc) * tn('mine');
      var pcOil = perCapita('oil', cc) * tn('oil');
      var pcInd = perCapita('ind', cc) * tn('ind');
      /* 权重恒为 1：sim 的 factorMean 是**按省平均**算的，不是按人口加权的
       * （见 js/sim.js 天花板那一段）。所以"同形"的判据也必须是按省的分布 ——
       * 第一版按人口加权拟合，结果中国与印度两个人口巨头把中位数整个拉偏，
       * 四条通道的均值全部高出目标 30%~45%。 */
      pushLog('fert', pcFarm, 1);
      pushLog('timber', pcWood, 1);
      pushLog('mineral', ENDOW.ORE.mine * pcMine + ENDOW.ORE.oil * pcOil, 1);
      pushLog('urban', pcInd, 1);
      /* 原始量留给界面显示与测试断言（sim 不读 _pc / _popM） */
      provOf[q]._pc = { farm: pcFarm, wood: pcWood, mine: pcMine, oil: pcOil, ind: pcInd };
      provOf[q]._popM = s.p;
    }

    /* 5) 第二遍：拟合出四条通道的映射函数，逐省写入 */
    var fit = {};
    chans.forEach(function (k) { fit[k] = fitChannel(logBuf[k], logBuf[k].length, ENDOW.TARGET[k]); });

    for (var q2 = 0; q2 < provOf.length; q2++) {
      var prov = provOf[q2];
      if (q2 >= provs.length) {
        /* 补种出来的小岛：拿最近的有名省的禀赋兜底，人口给一个很小的值，
         * 免得地图上出现"有地无人"的空壳（那会让那片地的价格结构失真）。
         * 因为按顺序遍历，被参照的那个省**已经在上一轮写好了**。 */
        var near = nearestIndex(map, q2);
        prov.fert = provOf[near].fert; prov.timber = provOf[near].timber;
        prov.mineral = provOf[near].mineral; prov.urban = provOf[near].urban;
        prov.pop0 = provOf[near].pop0 * 0.25;
        continue;
      }
      var pc = prov._pc;
      prov.fert = fit.fert(Math.log(Math.max(ENDOW.FLOOR, pc.farm)));
      prov.timber = fit.timber(Math.log(Math.max(ENDOW.FLOOR, pc.wood)));
      prov.mineral = fit.mineral(Math.log(Math.max(ENDOW.FLOOR,
        ENDOW.ORE.mine * pc.mine + ENDOW.ORE.oil * pc.oil)));
      prov.urban = fit.urban(Math.log(Math.max(ENDOW.FLOOR, pc.ind)));
      prov.pop0 = provs[q2].p * popScale;
    }
  }

  function nearestIndex(map, q) {
    var prov = map.provinces[q];
    var bd = Infinity, bi = 0;
    for (var i = 0; i < q; i++) {
      var o = map.provinces[i];
      var dx = o.cx - prov.cx, dy = o.cy - prov.cy;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  VIC.scenario = {
    define: define,
    build: build,
    validate: validate,
    list: function () { return Object.keys(SCENARIOS); },
    get: function (id) { return SCENARIOS[id]; },
    register: function (def) { return define(def); },   // define 的别名，读起来更顺
    ENDOW: ENDOW,
    _cellOf: cellOf,
    _blocMap: blocMap,
    _blocMatrix: blocMatrix,
    _validateBlocs: validateBlocs,
    _sampleSoft: sampleSoft,
    _despeckle: despeckle,
    _regs: SCENARIOS
  };
})(typeof window !== 'undefined' ? window : globalThis);
