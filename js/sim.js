/* 蒸汽与账本 — 模拟层
 *
 * 设计原则（对应之前讨论的架构纪律）：
 *   - 纯计算：不引用 window / document / canvas，可在 node 里单测
 *   - SoA 布局：所有状态放 TypedArray，tick 循环内零对象分配
 *   - 三个入口：tick() / snapshot() / applyCommand()
 *
 * 闭环：生产 → 市场清算定价 → 各阶层收入 → 消费与财富
 *       → 不满 → 效率下降 ； 盈余 → 投资 → 新产能 → 更多需求
 */
(function (root) {
  'use strict';
  var VIC = root.VIC || (root.VIC = {});
  var R = VIC.rng;
  var clamp = R.clamp;

  /* ---------------- 静态定义 ---------------- */

  var GOODS = [
    { key: 'grain', name: '谷物', base: 20, hue: 44, desc: '所有人的口粮，价格是所有工资的锚' },
    { key: 'cloth', name: '布料', base: 34, hue: 210, desc: '衣物与家纺，城市化的第一需求' },
    { key: 'wood', name: '木材', base: 26, hue: 28, desc: '燃料与建材，工业的起步料' },
    { key: 'tools', name: '工具', base: 62, hue: 190, desc: '机械与器具，决定长期产能' },
    { key: 'luxury', name: '奢侈品', base: 130, hue: 320, desc: '只有上层买得起，利润最厚' }
  ];
  var G = GOODS.length;

  var STRATA = [
    { key: 'lower', name: '底层', share: 0.78, color: '#8a7a5c' },
    { key: 'middle', name: '中层', share: 0.18, color: '#6f8fa8' },
    { key: 'upper', name: '上层', share: 0.04, color: '#c8a45c' }
  ];
  var S = STRATA.length;

  // 各阶层人均消费篮子（基准财富下）
  var NEEDS = [
    [0.55, 0.20, 0.15, 0.07, 0.03], // 底层：几乎全在口粮
    [0.30, 0.28, 0.18, 0.14, 0.10], // 中层
    [0.12, 0.18, 0.15, 0.20, 0.35]  // 上层：奢侈品占大头
  ];

  // 财富对各类商品消费的弹性：越奢侈越敏感
  var LUX_SENS = [0.35, 0.65, 0.75, 1.00, 1.60];

  /* 消费下限。这是全模型最关键的一组常数：
   * 如果穷了就能无限压缩消费，财富反馈会把所有省份的收支比统统拉回 1，
   * 世界一片祥和，地图上什么都看不出来。
   * 口粮砍不掉（0.85），奢侈品可以完全不买（0.10）—— 生存陷阱由此产生。 */
  var NEED_FLOOR = [0.85, 0.55, 0.50, 0.30, 0.10];

  /* 每级建筑的基础产出（单位：千人份）
   * 标定依据 —— 每级建筑的产值（out × base）：
   *   农场 360 / 纺织 340 / 伐木 300 / 机械 558 / 奢侈品 897
   * 工业品每级产值更高，所以"工业化"才是有利可图的，这就是本作的核心张力。 */
  var BUILDINGS = [
    { good: 0, name: '农场', out: 18.0, jobs: 4200 },
    { good: 1, name: '纺织工场', out: 10.0, jobs: 3600 },
    { good: 2, name: '伐木场', out: 11.5, jobs: 3800 },
    { good: 3, name: '机械工坊', out: 9.0, jobs: 3000 },
    { good: 4, name: '奢侈品工坊', out: 6.9, jobs: 2400 }
  ];

  /* 建筑序号 = 商品序号（每种商品对应一种建筑）。
   * 这么排是为了让「玩家想增产什么商品」直接等于「建哪种建筑」，命令层不用再做映射。 */

  /* 建造的定价与工期。
   * buildCost 与自动投资用的 investCost 同源（都随规模加速），但付款人是国库而不是省的投资池 ——
   * 这是「玩家花钱」与「系统自发生长」两条路的分界。 */
  var BUILD_COST_BASE = 520;
  var BUILD_MONTHS = 6;        // 工期：让「现在建、五年后才有用」成为真决策
  function buildCost(level) {
    return BUILD_COST_BASE * (1 + level * 0.55 + level * level * 0.085);
  }

  /* 灾害：歉收是**量级冲击**，不是价格冲击。
   * 实测（见 vic-toy-好玩化设计.md「价的冲击 vs 量的冲击」）：改价格会被财富反馈自愈，
   * 砍产能才会留下永久后果。所以灾情直接摧毁农场等级 + 堆一个跨月衰减的 harvestShock，
   * 而不是去动 price。 */
  var FAMINE_MONTH = 8;        // 每年 9 月（0-indexed）收获季定生死
  var FAMINE_DESTROY = 0.35;   // 受灾省农场等级被摧毁的比例
  var FAMINE_SHOCK = 0.55;     // 受当月波及的谷物产出乘数
  var FAMINE_SPREAD = 0.34;    // 同国其他省被波及的概率
  var SHOCK_DECAY = 0.72;      // 跨月衰减：三个月后基本恢复
  var RELIEF_COST = 300;       // 每省每月赈灾开销（国库）
  var RELIEF_MONTHS = 12;      // 赈灾承诺期
  var RELIEF_WEALTH_FLOOR = 0.85;  // 赈灾只把人托回这条线，不给更多（给多了反而推高物价、拖垮人口）


  /* ---------------- 玩家命令层 ----------------
   * 队列预分配、UI 只写队列（cmdHead/cmdTail），applyCommands() 在 tick 开头消费。
   * 纪律：UI 绝不直接改世界状态 —— 模拟保持确定性、可回放，将来存档只要存队列与种子。 */
  var CMD_CAP = 256;
  var CMD_BUILD = 1;
  var CMD_RELIEF = 2;
  var CMD_SET_AUTO = 3;

  function pushCommand(w, kind, prov, good, value) {
    var next = (w.cmdTail + 1) % CMD_CAP;
    if (next === w.cmdHead) { w.cmdDropped++; return false; }   // 队列满：丢掉并记账
    w.cmdKind[w.cmdTail] = kind;
    w.cmdProv[w.cmdTail] = prov;
    w.cmdGood[w.cmdTail] = good;
    w.cmdValue[w.cmdTail] = value || 0;
    w.cmdTail = next;
    return true;
  }

  /* 起始建筑等级：标定到"开局总产出 ≈ 总消费"，
   * 于是价格围绕基准波动，而不是一上来就通缩。
   * 这组数是量出来的：开局供需比需≈1，且要留出 eff（不满/劳力）的折扣余量。 */
  var BASE_LEVEL = [5.4, 4.2, 2.7, 1.9, 1.6];

  /* 收入分配。这三个数≈各阶层的消费价值占比（0.693 / 0.224 / 0.083），
   * 因此开局各阶层大致收支相抵；上层略占便宜，才有盈余去投资。 */
  var WAGE_BASE = [0.680, 0.230, 0.090];
  var MAX_LEVEL = 14;
  var TAX_RATE = 0.08;
  var INVEST_RATE = 0.06;     // 每 tick 拿多少比例的收入去投资
  var PRICE_SMOOTH = 0.42;    // 价格向目标收敛的速度
  var PRICE_ELASTIC = 0.68;   // 供需比对价格的弹性

  /* 升级成本随规模加速上升 —— 这是防止 300 tick 后全世界堆满建筑的唯一刹车 */
  function investCost(totalLv) {
    return 200 * (1 + totalLv * 0.30 + totalLv * totalLv * 0.028);
  }

  /* ---------------- 世界构建 ---------------- */

  function createWorld(map, opts) {
    opts = opts || {};
    var rng = R.makeRng(opts.seed || 991177);
    /* 事件用独立 PRNG：绝不能挤占 rng 的序列，否则地图/禀赋/初始建筑全会漂移，
     * 现有回归测试的基线数字（人口 45~48M、均收支 1.055 等）会全部失效。 */
    var eventRng = R.makeRng((opts.seed || 991177) ^ 0x5EED1);
    var P = map.provinces.length;
    var C = map.countries.length;


    var nFert = R.makeNoise(rng, 128);
    var nWood = R.makeNoise(rng, 128);
    var nMine = R.makeNoise(rng, 128);
    var nUrb = R.makeNoise(rng, 128);

    var w = {
      map: map,
      P: P,
      C: C,
      G: G,
      S: S,
      tick: 0,
      year: 1836,
      month: 0,

      // —— SoA 状态 ——
      pop: new Float32Array(S * P),       // 人口
      wealth: new Float32Array(S * P),    // 财富指数，1 = 基准
      ratio: new Float32Array(S * P),     // 收入/支出比，<1 即入不敷出
      income: new Float32Array(S * P),
      cost: new Float32Array(S * P),
      level: new Uint8Array(G * P),       // 建筑等级
      output: new Float32Array(G * P),    // 本 tick 产出
      unrest: new Float32Array(P),
      invest: new Float32Array(P),
      wageShare: new Float32Array(S * P),

      // 地理禀赋（决定各国专业化，是"谁赚谁亏"的根源）
      fert: new Float32Array(P),
      timber: new Float32Array(P),
      mineral: new Float32Array(P),
      urban: new Float32Array(P),
      // 由禀赋折算出的生产加成，静态，算一次即可
      geoBonus: new Float32Array(G * P),
      // 有限要素：省级产能天花板。levelCapUnit 是"单位人口的承载力"（静态），
      // levelCap = levelCapUnit × 当前人口（每次结算刷新）。分工见 createWorld 里的说明。
      levelCap: new Float32Array(G * P),
      levelCapUnit: new Float32Array(G * P),


      // 国家层
      price: new Float32Array(G * C),
      supply: new Float32Array(G * C),
      demand: new Float32Array(G * C),
      treasury: new Float32Array(C),
      gdp: new Float32Array(C),
      gdpSmooth: new Float32Array(C),
      gdpPrev: new Float32Array(C),
      popTotal: new Float32Array(C),
      unrestAvg: new Float32Array(C),
      countryLowWealth: new Float32Array(C),
      // 预分配的累加器：tick 循环内绝不 new，避免 GC 抖动
      gdpAcc: new Float32Array(C),
      treasuryGain: new Float32Array(C),
      provCount: new Float32Array(C),
      lowWealthAcc: new Float32Array(C),
      lowPopAcc: new Float32Array(C),

      // —— 玩家命令层（预分配环形队列）——
      cmdKind: new Uint8Array(CMD_CAP),
      cmdGood: new Uint8Array(CMD_CAP),
      cmdProv: new Int16Array(CMD_CAP),
      cmdCountry: new Int16Array(CMD_CAP),
      cmdValue: new Float32Array(CMD_CAP),
      cmdHead: 0,
      cmdTail: 0,
      cmdDropped: 0,          // 队列满时被丢弃的命令数（UI 据此提示「操作没跟上」）

      // —— 在建工程（一个省同时最多一项）——
      building: new Uint8Array(P),        // 0 = 空闲，1 = 在建
      buildGood: new Uint8Array(P),
      buildLeft: new Uint8Array(P),       // 剩余工期（月）
      constructionDone: 0,                // 累计完工数（结算评分用）

      // —— 灾害（量的冲击）——
      harvestShock: new Float32Array(C),  // 当月谷物产出乘数，跨月衰减
      famineCount: new Float32Array(C),   // 累计受灾次数（结算评分用）
      famineLoss: new Float32Array(C),    // 累计被摧毁的农场等级
      reliefOn: new Uint8Array(C),        // 赈灾开关
      reliefLeft: new Uint8Array(C),      // 剩余赈灾月数
      reliefPaid: new Float32Array(C),     // 累计赈灾支出
      reliefReached: new Float32Array(C),  // 累计受赈省份次数（用来判断钱有没有花在刀刃上）


      autoInvest: opts.autoInvest !== false,  // 默认 true：保持原行为，回归基线不变

      events: [],
      eventRng: eventRng,      // 事件专用 PRNG（与地图/禀赋用的 rng 分开，避免序列漂移）


    };

    /* —— 地理禀赋：用质心采样噪声，让相邻省份相似 → 形成专业化地带 —— */
    for (var p = 0; p < P; p++) {
      var prov = map.provinces[p];
      var u = prov.cx / map.width, v = prov.cy / map.height;
      w.fert[p] = clamp(R.fbm(nFert, u * 3.4, v * 3.4, 3, 2, 0.5) * 1.7 - 0.25, 0.25, 1.9);
      w.timber[p] = clamp(R.fbm(nWood, u * 4.1 + 11, v * 4.1 + 7, 3, 2, 0.5) * 1.7 - 0.25, 0.25, 1.9);
      w.mineral[p] = clamp(R.fbm(nMine, u * 4.6 + 23, v * 4.6 + 31, 3, 2, 0.5) * 1.9 - 0.40, 0.10, 2.2);
      w.urban[p] = clamp(R.fbm(nUrb, u * 3.1 + 41, v * 3.1 + 19, 3, 2, 0.5) * 1.6 - 0.15, 0.25, 1.8);
    }

    /* —— 禀赋 → 生产加成（静态表，算一次） —— */
    var GEO_SENS = [0.35, 0.30, 0.30, 0.45, 0.30];
    var GEO_SRC = [w.fert, w.urban, w.timber, w.mineral, w.urban];
    for (var gb = 0; gb < G; gb++) {
      for (var gp = 0; gp < P; gp++) {
        w.geoBonus[gb * P + gp] = 1 + (GEO_SRC[gb][gp] - 1) * GEO_SENS[gb];
      }
    }

    /* —— 初始人口：与陆地面积和城市化程度挂钩 —— */
    var areaSum = 0;
    for (var a = 0; a < P; a++) areaSum += map.provinces[a].area;
    var avgArea = areaSum / P;

    for (var p2 = 0; p2 < P; p2++) {
      var prov2 = map.provinces[p2];
      var density = w.urban[p2] * 0.85 + 0.35;
      var total = (prov2.area / avgArea) * density * 165000;
      total = clamp(total, 28000, 620000);
      var lower = total * STRATA[0].share;
      var mid = total * STRATA[1].share;
      var up = total * STRATA[2].share;
      w.pop[0 * P + p2] = lower;
      w.pop[1 * P + p2] = mid;
      w.pop[2 * P + p2] = up;
      // 城市省份上层更富（但起点别太高，否则奢侈品乘数会把他们自己吃穷）
      w.wealth[0 * P + p2] = 0.88 + w.urban[p2] * 0.12;
      w.wealth[1 * P + p2] = 0.95 + w.urban[p2] * 0.20;
      w.wealth[2 * P + p2] = 1.05 + w.urban[p2] * 0.35;
    }

    /* —— 初始建筑：禀赋决定初始专业化 ——
     * 先把地理因子归一化到均值 1，再乘人口规模，这样各省总量可比、
     * 但结构千差万别 —— 有的产粮、有的产矿，贸易与贫富差异由此而来。 */
    var meanFert = 0, meanTimber = 0, meanMineral = 0, meanUrban = 0;
    for (var m = 0; m < P; m++) {
      meanFert += w.fert[m]; meanTimber += w.timber[m];
      meanMineral += w.mineral[m]; meanUrban += w.urban[m];
    }
    meanFert /= P; meanTimber /= P; meanMineral /= P; meanUrban /= P;

    var totalPop0 = 0;
    for (var tp = 0; tp < P; tp++) {
      totalPop0 += w.pop[0 * P + tp] + w.pop[1 * P + tp] + w.pop[2 * P + tp];
    }
    var avgPop0 = totalPop0 / P;

    /* ═══════════ 有限要素：省级产能天花板（本次接入的核心） ═══════════
     * 设计动机（见 冷战题材-涌现设计.md）：现状是「任何商品在任何地方都造得出来」，
     * 唯一限制是钱和等级 —— 于是禀赋被大数定律摊平、贸易没有必需性、封锁没有牙齿。
     *
     * 与 geoBonus 的分工（两者都要，不重复）：
     *   geoBonus  = 效率（同样的厂，产出多少）—— 决定谁更划算
     *   levelCap  = 规模（这种厂最多能建几级）—— 决定谁能做大
     * 前者是价格信号，后者是物理约束。已证实：只有量的约束会留疤。
     *
     * 标定方式（踩过一次坑）：**按各省自己的开局等级放大，而不是按 BASE_LEVEL 重算**。
     * 第一版按 BASE_LEVEL 算，结果 80% 的格子开局就顶死、还出现负天花板 ——
     * 因为各商品的实际开局等级普遍高于 BASE_LEVEL（人口 scale 与禀赋 bias 都在往上推）。
     * 现在：天花板 = 开局等级 × (1 + 余量 × 适配度)，适配度 ∈ [-1, +1]，
     * 于是"地理上不适合"的商品会被封在开局水平附近，"适合"的能长 2 倍以上。 */
    var GOOD_TO_FACTOR = [w.fert, w.urban, w.timber, w.mineral, w.urban];
    var IND_SENS = [0.15, 0.45, 0.20, 0.50, 0.40];   // 各商品对"工业/城市化"的依赖度
    var CAP_GAIN = [1.35, 0.85, 1.30, 1.10, 0.90];  // 资源侧灵敏度
    /* 余量参数：可通过 opts.capHeadroom 覆盖，用于标定扫描（见 test/cap-sweep.js）。
     * 默认 3.0 —— 由扫描确定：太小则天花板成为增长天花板（人口 39M、不满 0.15），
     * 太大则形同虚设。目标是让天花板约束**少数不合适的格子**，而不是掐住整体增长。 */
    var CAP_HEADROOM = (opts.capHeadroom !== undefined) ? opts.capHeadroom : 5.5;

    /* 不归一化：天花板是"每个省各自的地理约束"，不是一个要守恒的世界总量。
     * 第一版做过归一化，那是把它当成了预算 —— 但它不是预算，是地貌。 */

    for (var p3 = 0; p3 < P; p3++) {
      var popHere = w.pop[0 * P + p3] + w.pop[1 * P + p3] + w.pop[2 * P + p3];
      var scale = clamp(popHere / avgPop0, 0.35, 2.8);
      var bias = [
        w.fert[p3] / meanFert,        // 谷物 ← 土地肥力
        w.urban[p3] / meanUrban,      // 布料 ← 城市化
        w.timber[p3] / meanTimber,    // 木材 ← 森林
        w.mineral[p3] / meanMineral,  // 工具 ← 矿藏
        w.urban[p3] / meanUrban       // 奢侈品 ← 富裕人口
      ];
      for (var gi = 0; gi < G; gi++) {
        var jitter = 0.85 + rng() * 0.30;
        var lv = Math.round(BASE_LEVEL[gi] * bias[gi] * scale * jitter);
        w.level[gi * P + p3] = clamp(lv, 0, MAX_LEVEL);
      }
      w.unrest[p3] = clamp(0.30 - w.urban[p3] * 0.10 + rng() * 0.08, 0.02, 0.6);
    }

    /* —— 有限要素的天花板：必须在开局等级填好之后才算 ——
     * 踩过的坑：第一次把这段放在人口循环之前，那时 w.level 还全是 0，
     * 于是所有天花板都被下限兜成 1.00，97% 的格子开局就顶死。 */
    /* 适配度必须相对**各省均值**算，不能相对 1。
     * 踩过的坑：fert/urban 的实际分布并不以 1 为中心（种子 8888 里
     * 大半个地图的 fert 在 0.25~0.50，而均值是 1.09），
     * 用 (fert - 1) 当偏离量，等于把绝大多数省判成"不适配"，
     * 天花板全线低于开局等级 —— 那不是约束，那是噪声。
     * 正确做法：先求该要素在全部省份上的均值，再看这个省偏离均值多少。 */
    var factorMean = [];
    for (var f4 = 0; f4 < G; f4++) {
      var acc4 = 0;
      for (var pm = 0; pm < P; pm++) acc4 += GOOD_TO_FACTOR[f4][pm];
      factorMean.push(acc4 / P);
    }

    var popBase = new Float32Array(P);
    for (var pb = 0; pb < P; pb++) {
      popBase[pb] = w.pop[0 * P + pb] + w.pop[1 * P + pb] + w.pop[2 * P + pb];
      if (popBase[pb] < 1) popBase[pb] = 1;
    }

    for (var p4 = 0; p4 < P; p4++) {
      for (var g4 = 0; g4 < G; g4++) {
        var idx4 = g4 * P + p4;
        var startLv = w.level[idx4];
        // 相对均值的偏离（-1 = 该要素只有世界平均的一半）
        var resDev = factorMean[g4] > 0 ? (GOOD_TO_FACTOR[g4][p4] / factorMean[g4] - 1) : 0;
        var indDev = factorMean[1] > 0 ? (w.urban[p4] / factorMean[1] - 1) : 0;
        var fit = Math.min(resDev * CAP_GAIN[g4], indDev * IND_SENS[g4]);
        fit = Math.max(-1, Math.min(1, fit));
        /* 余量的给法（第二次踩坑）：中位省的 fit ≈ 0，如果写成
         * cap = startLv × (1 + h × fit)，中位省的余量正好是 0 —— 它开局就顶死。
         * 正确的形状是：fit = 0（世界平均水平）的省也要有基础余量，
         * 高于平均的多长，低于平均的少长甚至封在开局水平。 */
        var cap = startLv * (CAP_HEADROOM + fit);
        // 下限：再不适配也要留一点位置，否则等于地理上完全禁止
        if (cap < 1) cap = 1;
        // 记的是"单位人口的承载力"，运行时再乘当前人口（见 refreshLevelCaps）
        w.levelCapUnit[idx4] = cap / Math.max(1e-9, popBase[p4]);
      }
    }

    /* —— 初始价格 —— */
    for (var c = 0; c < C; c++) {
      for (var g = 0; g < G; g++) w.price[g * C + c] = GOODS[g].base;
    }

    // 先跑一次清算，避免开局价格全在基准线上（一上来就能看到差异）
    /* 灾情乘数必须显式初始化成 1。
     * 踩过的坑：Float32Array 初值是 0，而衰减逻辑的条件是「< 1 才衰减」——
     * 于是开局把 0 当成「灾情 100%」，每 tick 都在衰减一个并不存在的灾年，
     * 谷物价格直接飙到基准的 2.04 倍。零值在这里是个合法数值，必须显式写成 1。 */
    w.harvestShock.fill(1);
    refreshLevelCaps(w);      // 开局先刷一次，之后每 tick 跟随人口
    for (var warm = 0; warm < 3; warm++) tick(w);
    w.warmed = true;   // 预热不再触发灾情：开局不该在第 0 个月就挨一次歉收



    w.year = 1836;
    w.month = 0;
    w.tick = 0;
    w.events.length = 0;
    w.gdpPrev.set(w.gdp);
    w.gdpSmooth.set(w.gdp);
    pushEvent(w, '王国纪年 1836 年，欧洲列强的账本翻开了新的一页。', 'info');

    return w;
  }

  /* 有限要素：天花板随人口缩放。
   * 为什么必须缩放：天花板是按开局人口标定的，而人口在 100 年里会涨 30% 以上。
   * 如果钉死在开局那一刻，它就从"地理约束"退化成"增长天花板"——
   * 实测 300 tick 时谷物想长到 13 级、却被钉在 4.76，那是在掐增长而不是在塑地理。
   * 缩放后：省份人口翻倍，它的地理承载力也翻倍；而"适不适合产这个"的性格不变。 */
  function refreshLevelCaps(w) {
    var P = w.P, G = w.G;
    for (var p = 0; p < P; p++) {
      var pop = w.pop[0 * P + p] + w.pop[1 * P + p] + w.pop[2 * P + p];
      for (var g = 0; g < G; g++) {
        var cap = w.levelCapUnit[g * P + p] * pop;
        if (cap < 1) cap = 1;
        w.levelCap[g * P + p] = cap;
      }
    }
  }

  /* ---------------- 事件日志 ---------------- */

  function pushEvent(w, text, kind) {
    w.events.unshift({ text: text, kind: kind || 'info', year: w.year, month: w.month });
    if (w.events.length > 60) w.events.length = 60;
  }

  /* ---------------- 核心：一次月度清算 ---------------- */

  function tick(w) {
    var P = w.P, C = w.C, G2 = w.G, S2 = w.S;
    var i, p, c, g, s;

    /* 0) 玩家命令：在 tick 开头消费。
     * 放在这里而不是每帧处理，是为了让「一次操作 = 一个 tick 边界」确定、可回放。 */
    applyCommands(w);

    /* 1) 生产 */
    for (p = 0; p < P; p++) {
      var workers = w.pop[0 * P + p] + w.pop[1 * P + p] * 0.7;
      var required = 0;
      for (g = 0; g < G2; g++) required += w.level[g * P + p] * BUILDINGS[g].jobs;
      var labor = required > 0 ? clamp(workers / required, 0.25, 1) : 1;
      var eff = (1 - 0.55 * w.unrest[p]) * labor;
      for (g = 0; g < G2; g++) {
        // 灾年的谷物产出乘数（量的冲击：砍的是产出，不是价格）。
        // 注意：c 要到第 2 步才被赋值，这里必须自己取国家，否则首 tick 会拿到 undefined → output 全 NaN。
        var shock = (g === 0 ? w.harvestShock[w.map.provinces[p].country] : 1);
        w.output[g * P + p] = w.level[g * P + p] * BUILDINGS[g].out * eff * w.geoBonus[g * P + p] * shock;

      }
    }

    /* 2) 供给聚合到国家市场 */
    w.supply.fill(0);
    for (p = 0; p < P; p++) {
      c = w.map.provinces[p].country;
      for (g = 0; g < G2; g++) w.supply[g * C + c] += w.output[g * P + p];
    }

    /* 3) 需求 */
    w.demand.fill(0);
    for (p = 0; p < P; p++) {
      c = w.map.provinces[p].country;
      for (s = 0; s < S2; s++) {
        var n = w.pop[s * P + p] / 1000;
        var wl = w.wealth[s * P + p];
        for (g = 0; g < G2; g++) {
          var mult = Math.max(NEED_FLOOR[g], 1 + (wl - 1) * LUX_SENS[g]);
          w.demand[g * C + c] += n * NEEDS[s][g] * mult;
        }
      }
    }

    /* 4) 市场清算定价 */
    for (c = 0; c < C; c++) {
      for (g = 0; g < G2; g++) {
        var sup = Math.max(w.supply[g * C + c], 0.001);
        var dem = w.demand[g * C + c];
        var ratio = dem / sup;
        var target = GOODS[g].base * clamp(Math.pow(ratio, PRICE_ELASTIC), 0.28, 3.4);
        var key2 = g * C + c;
        w.price[key2] = w.price[key2] * (1 - PRICE_SMOOTH) + target * PRICE_SMOOTH;
      }
    }

    /* 5) 收入分配 + 支出 */
    var gdpAcc = w.gdpAcc;
    gdpAcc.fill(0);
    for (p = 0; p < P; p++) {
      c = w.map.provinces[p].country;
      var revenue = 0;
      for (g = 0; g < G2; g++) revenue += w.output[g * P + p] * w.price[g * C + c];
      gdpAcc[c] += revenue;

      // 工业化程度 → 收入分配向中上层倾斜
      var totalLv = 0, indLv = 0;
      for (g = 0; g < G2; g++) {
        totalLv += w.level[g * P + p];
        if (g === 3 || g === 4) indLv += w.level[g * P + p];
      }
      var indShare = totalLv > 0 ? indLv / totalLv : 0;
      var sh = [
        WAGE_BASE[0] - 0.06 * indShare,
        WAGE_BASE[1] + 0.04 * indShare,
        WAGE_BASE[2] + 0.02 * indShare
      ];

      for (s = 0; s < S2; s++) {
        var idx = s * P + p;
        w.wageShare[idx] = sh[s];
        w.income[idx] = revenue * sh[s];
        var expense = 0;
        var n2 = w.pop[idx] / 1000;
        var wl2 = w.wealth[idx];
        for (g = 0; g < G2; g++) {
          var mult2 = Math.max(NEED_FLOOR[g], 1 + (wl2 - 1) * LUX_SENS[g]);
          expense += n2 * NEEDS[s][g] * mult2 * w.price[g * C + c];
        }
        expense = Math.max(expense, 0.5);
        w.cost[idx] = expense;
        var r = w.income[idx] / expense;
        w.ratio[idx] = r;

        // 财富随盈亏缓慢漂移
        w.wealth[idx] = clamp(wl2 + (r - 1) * 0.055, 0.12, 4.0);

        // 人口随生活水平增减
        var growth = clamp((r - 1) * 0.0105, -0.0045, 0.012);
        w.pop[idx] = Math.max(250, w.pop[idx] * (1 + growth));
      }

      /* 6) 不满 —— 用"目标值"模型，而不是累加漂移
       * 累加模型的问题：只要收支比一好转就以固定速率衰减到 0，地图上留不下东西。
       * 改成先算一个目标不满度 floor，再让实际值向它靠拢。
       *
       * floor 有两个来源：
       *   a) 绝对赤字 —— 收支比跌破死区
       *   b) 相对剥夺 —— 温饱但明显落后于本国平均（用上一 tick 的均值）
       * 不满是整个模型里唯一的正反馈，所以上限必须封死。 */
      var lowRatio = w.ratio[0 * P + p];
      var floor = 0;
      if (lowRatio < 0.92) floor = (0.92 - lowRatio) * 2.0;
      var refWealth = w.countryLowWealth[c];
      if (refWealth > 0.05) {
        var rel = w.wealth[0 * P + p] / refWealth;
        if (rel < 0.90) floor = Math.max(floor, (0.90 - rel) * 1.6);
      }
      floor = clamp(floor, 0, 0.80);
      if (w.unrest[p] < floor) {
        w.unrest[p] = Math.min(floor, w.unrest[p] + 0.012);
      } else {
        w.unrest[p] = Math.max(floor, w.unrest[p] - 0.020);
      }

      /* 7) 投资：盈余省份按"比较优势 × 价格信号"扩产
       * 关键是 geoBonus 参与打分 —— 否则所有省份都会追同一个高价商品，
       * 世界趋同，地图就没有意义了。 */
      w.invest[p] += revenue * INVEST_RATE;
      if (w.autoInvest && w.unrest[p] < 0.72 && totalLv < MAX_LEVEL * G2) {
        var costNext = investCost(totalLv);
        if (w.invest[p] >= costNext) {
          var bestG = -1, bestScore = -1;
          for (g = 0; g < G2; g++) {
            if (w.level[g * P + p] >= MAX_LEVEL) continue;
            // 有限要素：该省该商品已经顶到地理天花板，就不再投
            if (w.level[g * P + p] + 1.5 > w.levelCap[g * P + p]) continue;

            var score = (w.price[g * C + c] / GOODS[g].base) *
                        Math.pow(w.geoBonus[g * P + p], 1.6) -
                        w.level[g * P + p] * 0.05;
            if (score > bestScore) { bestScore = score; bestG = g; }
          }
          if (bestG >= 0) {
            w.level[bestG * P + p]++;
            w.invest[p] -= costNext;
            w.treasuryGain[c] += costNext * 0.12;
          }
        }
      }
    }

    /* 8) 国家统计 */
    var popTotal = w.popTotal, unrestAvg = w.unrestAvg, provCount = w.provCount;
    var lowAcc = w.lowWealthAcc, lowW = w.countryLowWealth, lowPopAcc = w.lowPopAcc;
    popTotal.fill(0);
    unrestAvg.fill(0);
    provCount.fill(0);
    lowAcc.fill(0);
    lowPopAcc.fill(0);
    for (p = 0; p < P; p++) {
      c = w.map.provinces[p].country;
      var lowPop = w.pop[0 * P + p];
      popTotal[c] += lowPop + w.pop[1 * P + p] + w.pop[2 * P + p];
      unrestAvg[c] += w.unrest[p];
      provCount[c]++;
      lowAcc[c] += w.wealth[0 * P + p] * lowPop;
      lowPopAcc[c] += lowPop;
    }
    for (c = 0; c < C; c++) {
      if (provCount[c] > 0) unrestAvg[c] /= provCount[c];
      // 人口加权的本国底层平均财富 —— 下一 tick 衡量"相对剥夺"的基准
      lowW[c] = lowPopAcc[c] > 0 ? lowAcc[c] / lowPopAcc[c] : 1;
      w.treasury[c] += gdpAcc[c] * TAX_RATE + w.treasuryGain[c];
      w.gdpPrev[c] = w.gdp[c];
      w.gdp[c] = gdpAcc[c];
      w.gdpSmooth[c] = w.gdpSmooth[c] * 0.88 + gdpAcc[c] * 0.12;
    }
    w.treasuryGain.fill(0);

    /* 8.5) 在建工程 + 赈灾：都走国库，与「系统自发生长」在经济上分开 */
    for (p = 0; p < P; p++) {
      if (!w.building[p]) continue;
      if (--w.buildLeft[p] <= 0) {
        var bg = w.buildGood[p];
        if (w.level[bg * P + p] < MAX_LEVEL && w.level[bg * P + p] + 1 <= w.levelCap[bg * P + p]) {
          w.level[bg * P + p]++;
        }

        w.building[p] = 0;
        w.constructionDone++;
      }
    }
    for (c = 0; c < C; c++) {
      if (!w.reliefOn[c]) continue;
      if (w.reliefLeft[c] <= 0) { w.reliefOn[c] = 0; continue; }   // 赈灾承诺到期
      w.reliefLeft[c]--;
      /* 赈灾是**定点**的：只发给真正困难的省。
       * 第一版是无差别发给全国每个省，实测 100 年花掉 15M 换来 0 收益 —— 因为大半钱
       * 花在根本不困难的省身上。历史逻辑也不对：赈灾不会给富裕地区发粮。 */
      var needy = 0;
      for (p = 0; p < P; p++) {
        if (w.map.provinces[p].country !== c) continue;
        if (w.unrest[p] > 0.22 || w.ratio[0 * P + p] < 0.90 || w.wealth[0 * P + p] < 0.55) needy++;
      }
      var reliefBill = needy * RELIEF_COST;
      if (needy === 0) continue;              // 没有困难省份，不花钱
      if (w.treasury[c] >= reliefBill) {
        w.treasury[c] -= reliefBill;
        w.reliefPaid[c] += reliefBill;
        // 发到手上要真的管用：压住不满、托住底层财富
        for (p = 0; p < P; p++) {
          if (w.map.provinces[p].country !== c) continue;
          if (!(w.unrest[p] > 0.22 || w.ratio[0 * P + p] < 0.90 || w.wealth[0 * P + p] < 0.55)) continue;
          w.unrest[p] = Math.max(0, w.unrest[p] - 0.035);
          /* 只托底，不给富。
           * 踩过的坑：一开始写成 wealth += 0.02 且不设上限，实测 100 年把底层财富从 1.18
           * 推到 2.51。而财富直接乘在消费上（mult = max(NEED_FLOOR, 1+(w-1)*LUX_SENS)），
           * 人均支出从 5010 涨到 6540、超过收入 6114，收支比 0.912 → 人口反而 −31%。
           * 教训：让救济去抬高财富，等于让受救济者自己把物价推起来把自己拖垮。
           * 现在只把跌到 0.85 以下的人拉回 0.85（生存线），不提供任何扩张动力。 */
          if (w.wealth[0 * P + p] < RELIEF_WEALTH_FLOOR) {
            w.wealth[0 * P + p] = RELIEF_WEALTH_FLOOR;
          }

          w.reliefReached[c]++;
        }
      } else {
        w.reliefOn[c] = 0;                  // 国库见底，赈灾中断
        pushEvent(w, w.map.countries[c].name + ' 国库见底，赈灾无以为继。', 'bad');
      }

    }

    /* 8.6) 灾情乘数跨月衰减 —— 灾年的痛要摊开，而不是一个月就抹平 */
    for (c = 0; c < C; c++) {
      if (w.harvestShock[c] < 1) {
        w.harvestShock[c] = 1 - (1 - w.harvestShock[c]) * SHOCK_DECAY;
        if (w.harvestShock[c] > 0.995) w.harvestShock[c] = 1;
      }
    }

    /* 8.7) 人口变了，地理承载力跟着变 —— 天花板是"地貌"，不是"开局快照" */
    refreshLevelCaps(w);

    /* 9) 日历 */
    w.month++;
    if (w.month >= 12) { w.month = 0; w.year++; }
    w.tick++;

    /* 10) 大事件：只在真正异常时记录，避免刷屏。
     * 灾情独立于 detectEvents：它每月都要检查（只有收获月可能触发），而且会改世界状态。 */
    if (w.tick % 6 === 0) detectEvents(w);
    detectFamine(w);
  }

  /* 歉收：模型里唯一会留下永久后果的随机事件。
   * 只在收获月结算；受灾国当月谷物产出被砸，部分农场等级被直接摧毁。
   * 数据依据（见 vic-toy-好玩化设计.md）：价的冲击会被财富反馈自愈（+11.6% 人口），
   * 量的冲击会留下永久后果（−26% 人口）。所以这里砍的是 level 和 output，不是 price。 */
  function detectFamine(w) {
    if (!w.warmed) return;                        // 预热阶段不结算灾情
    if (w.month !== FAMINE_MONTH) return;

    if (w.eventRng() > 0.34) return;              // 约三年一次，不是年年有
    var c = (w.eventRng() * w.C) | 0;
    if (c >= w.C) c = w.C - 1;
    var P = w.P;
    var lo = 0.72 + w.eventRng() * 0.28;          // 受灾国当月谷物产出乘数
    if (lo > 1) lo = 1;
    w.harvestShock[c] = Math.min(w.harvestShock[c], lo);
    w.famineCount[c]++;

    // 摧毁一部分农场等级：只能等玩家自己花钱重建
    var destroyed = 0;
    for (var p = 0; p < P; p++) {
      if (w.map.provinces[p].country !== c) continue;
      if (w.eventRng() > 0.30) continue;          // 不是每省都受灾
      var lv = w.level[0 * P + p];
      var cut = Math.max(1, Math.round(lv * FAMINE_DESTROY));
      if (cut > lv) cut = lv;
      w.level[0 * P + p] = lv - cut;
      destroyed += cut;
    }
    w.famineLoss[c] += destroyed;
    pushEvent(w, w.map.countries[c].name + ' 遭遇歉收，' + destroyed +
      ' 级农产被毁（次年谷物产出承压）。', 'bad');
  }

  /* 从环形队列取出玩家命令并执行。命令只写世界状态：不返回值、不分配对象。 */
  function applyCommands(w) {
    while (w.cmdHead !== w.cmdTail) {
      var i = w.cmdHead;
      var kind = w.cmdKind[i];
      var prov = w.cmdProv[i];
      var good = w.cmdGood[i];
      if (kind === CMD_BUILD) {
        if (prov >= 0 && prov < w.P && good >= 0 && good < w.G && !w.building[prov]) {
          var lv = w.level[good * w.P + prov];
          /* 玩家建造同样受地理天花板约束 —— 否则玩家就成了绕过物理规律的后门，
           * 而「玩家与 AI 守同一套规则」是这个架构的公平性地基。 */
          if (lv < MAX_LEVEL && lv + 1 <= w.levelCap[good * w.P + prov]) {

            var cost = buildCost(lv);
            var ctry = w.map.provinces[prov].country;
            if (w.treasury[ctry] >= cost) {
              w.treasury[ctry] -= cost;
              w.building[prov] = 1;
              w.buildGood[prov] = good;
              w.buildLeft[prov] = BUILD_MONTHS;
            } else {
              pushEvent(w, w.map.countries[ctry].name + ' 国库不足，' +
                w.map.provinces[prov].name + ' 的工程未能开工。', 'info');
            }
          }
        }
      } else if (kind === CMD_RELIEF) {
        var rc = w.cmdCountry[i];
        if (rc >= 0 && rc < w.C) {
          var on = w.cmdValue[i] > 0.5;
          w.reliefOn[rc] = on ? 1 : 0;
          w.reliefLeft[rc] = on ? RELIEF_MONTHS : 0;
        }
      } else if (kind === CMD_SET_AUTO) {
        w.autoInvest = w.cmdValue[i] > 0.5;
      }
      w.cmdHead = (w.cmdHead + 1) % CMD_CAP;
    }
  }
  function detectEvents(w) {
    var C = w.C, G2 = w.G, P = w.P, i;

    /* 1) 价格极端 —— 谁的商品在暴涨，谁的在崩盘 */
    for (var g = 0; g < G2; g++) {
      for (var c = 0; c < C; c++) {
        var rel = w.price[g * C + c] / GOODS[g].base;
        if (rel > 1.45) {
          maybePush(w, w.map.countries[c].name + ' 的' + GOODS[g].name + '涨到基准价的 ' +
            (rel * 100).toFixed(0) + '%，下层生活成本正在被推高。', 'bad', 'hi-' + g + '-' + c);
        } else if (rel < 0.68) {
          maybePush(w, w.map.countries[c].name + ' 的' + GOODS[g].name + '跌到基准价的 ' +
            (rel * 100).toFixed(0) + '%，' + BUILDINGS[g].name + '主正在亏损。', 'bad', 'lo-' + g + '-' + c);
        }
      }
    }

    /* 2) 哪个国家最不安定 */
    var worstC = -1, worstU = 0.34;
    for (i = 0; i < C; i++) {
      if (w.unrestAvg[i] > worstU) { worstU = w.unrestAvg[i]; worstC = i; }
    }
    if (worstC >= 0) {
      maybePush(w, w.map.countries[worstC].name + ' 民怨沸腾（不安定指数 ' +
        (worstU * 100).toFixed(0) + '），产能正在流失。', 'bad', 'unrest-' + worstC);
    }

    /* 3) 国力排行更替 —— "谁赚谁亏"最直观的呈现 */
    var order = [];
    for (i = 0; i < C; i++) order.push(i);
    order.sort(function (a, b) { return w.gdpSmooth[b] - w.gdpSmooth[a]; });
    if (w.prevOrder && w.prevOrder.length === C) {
      for (var k = 0; k < Math.min(3, C); k++) {
        if (w.prevOrder[k] !== order[k]) {
          var up = order[k], dn = w.prevOrder[k];
          maybePush(w, w.map.countries[up].name + ' 的国力超越了 ' +
            w.map.countries[dn].name + '，跻身第 ' + (k + 1) + ' 位。', 'good', 'rank-' + up + '-' + dn);
          break;
        }
      }
    }
    if (!w.prevOrder) w.prevOrder = new Int16Array(C);
    for (i = 0; i < C; i++) w.prevOrder[i] = order[i];

    /* 4) 工业化里程碑 */
    for (i = 0; i < C; i++) {
      var lv = 0;
      for (var p2 = 0; p2 < P; p2++) {
        if (w.map.provinces[p2].country !== i) continue;
        for (var g2 = 0; g2 < G2; g2++) lv += w.level[g2 * P + p2];
      }
      var tier = Math.floor(lv / 250);
      if (tier >= 1) {
        w.milestone = w.milestone || new Int16Array(C);
        if (tier > w.milestone[i]) {
          w.milestone[i] = tier;
          pushEvent(w, w.map.countries[i].name + ' 的工业规模突破第 ' + tier +
            ' 个台阶，烟囱正在改变这片土地。', 'good');
        }
      }
    }

    /* 5) 赤贫省份 */
    var worstP = -1, worstR = 0.72;
    for (var p3 = 0; p3 < P; p3++) {
      if (w.ratio[0 * P + p3] < worstR) { worstR = w.ratio[0 * P + p3]; worstP = p3; }
    }
    if (worstP >= 0) {
      maybePush(w, w.map.provinces[worstP].name + ' 的底层入不敷出（收支比 ' +
        (worstR * 100).toFixed(0) + '%），正在挨饿。', 'bad', 'poor-' + worstP);
    }
  }

  function maybePush(w, text, kind, key) {
    if (!w.eventCooldown) w.eventCooldown = Object.create(null);
    var last = w.eventCooldown[key];
    if (last !== undefined && w.tick - last < 48) return;
    w.eventCooldown[key] = w.tick;
    pushEvent(w, text, kind);
  }

  /* ---------------- 对 UI 的只读输出 ---------------- */

  function countryRows(w) {
    var rows = [];
    for (var c = 0; c < w.C; c++) {
      var prev = w.gdpPrev[c] || 0;
      rows.push({
        id: c,
        name: w.map.countries[c].name,
        tag: w.map.countries[c].tag,
        color: w.map.countries[c].color,
        gdp: w.gdp[c],
        gdpDelta: w.gdp[c] - prev,
        pop: w.popTotal[c],
        unrest: w.unrestAvg[c],
        treasury: w.treasury[c]
      });
    }
    rows.sort(function (a, b) { return b.gdp - a.gdp; });
    return rows;
  }

  function marketRows(w, countryId) {
    var rows = [];
    for (var g = 0; g < w.G; g++) {
      var price = w.price[g * w.C + countryId];
      var sup = w.supply[g * w.C + countryId];
      var dem = w.demand[g * w.C + countryId];
      rows.push({
        id: g,
        key: GOODS[g].key,
        name: GOODS[g].name,
        hue: GOODS[g].hue,
        desc: GOODS[g].desc,
        base: GOODS[g].base,
        price: price,
        rel: price / GOODS[g].base,
        supply: sup,
        demand: dem,
        balance: sup - dem
      });
    }
    return rows;
  }

  function provinceRows(w, p) {
    var P = w.P, out = { pop: [], buildings: [] };
    var totalPop = 0, totalWealth = 0;
    for (var s = 0; s < w.S; s++) {
      var n = w.pop[s * P + p];
      totalPop += n;
      totalWealth += n * w.wealth[s * P + p];
      out.pop.push({
        key: STRATA[s].key,
        name: STRATA[s].name,
        color: STRATA[s].color,
        count: n,
        wealth: w.wealth[s * P + p],
        ratio: w.ratio[s * P + p],
        income: w.income[s * P + p],
        cost: w.cost[s * P + p]
      });
    }
    for (var g = 0; g < w.G; g++) {
      out.buildings.push({
        name: BUILDINGS[g].name,
        good: GOODS[g].name,
        hue: GOODS[g].hue,
        level: w.level[g * P + p],
        output: w.output[g * P + p]
      });
    }
    out.totalPop = totalPop;
    out.avgWealth = totalPop > 0 ? totalWealth / totalPop : 0;
    out.unrest = w.unrest[p];
    out.invest = w.invest[p];
    return out;
  }

  VIC.sim = {
    GOODS: GOODS,
    STRATA: STRATA,
    BUILDINGS: BUILDINGS,
    NEEDS: NEEDS,
    createWorld: createWorld,
    tick: tick,
    countryRows: countryRows,
    marketRows: marketRows,
    provinceRows: provinceRows,
    pushCommand: pushCommand,
    buildCost: buildCost,
    applyCommands: applyCommands,
    CMD_BUILD: CMD_BUILD,
    CMD_RELIEF: CMD_RELIEF,
    CMD_SET_AUTO: CMD_SET_AUTO,
    BUILD_MONTHS: BUILD_MONTHS,
    RELIEF_COST: RELIEF_COST,
    RELIEF_MONTHS: RELIEF_MONTHS
  };
})(typeof window !== 'undefined' ? window : globalThis);
