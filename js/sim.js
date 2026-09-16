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
  var CMD_TRADE = 4;      // 通商政策：value = 开放度 0..1（0 = 闭关，1 = 自由贸易）
  var CMD_INFRA = 5;      // 修基建：prov = 省份

  /* country 是给「一国的制度」用的（赈灾、通商政策）。
   * 建造不需要它 —— 省份已经隐含了国家。
   *
   * 踩过的坑：前四个参数之外原本没有 country，而 applyCommands 里一直是
   * `w.cmdCountry[i]` 在读它。也就是说 CMD_RELIEF **一直在给 0 号国赈灾**，
   * 不管玩家在看哪个国家。之所以没被发现，是因为张力台恰好扮演 0 号国、
   * 主循环默认选中的也是人口最多的那个（在 seed 8888 上正好是 0 号）。
   * 两个巧合叠在一起，把一个真 bug 藏了整整一版。
   * 教训：UI 与测试台「走同一条路」还不够，这条路上的**每一个参数**都要真的被走过。 */
  function pushCommand(w, kind, prov, good, value, country) {
    var next = (w.cmdTail + 1) % CMD_CAP;
    if (next === w.cmdHead) { w.cmdDropped++; return false; }   // 队列满：丢掉并记账
    w.cmdKind[w.cmdTail] = kind;
    w.cmdProv[w.cmdTail] = prov;
    w.cmdGood[w.cmdTail] = good;
    w.cmdValue[w.cmdTail] = value || 0;
    w.cmdCountry[w.cmdTail] = country || 0;
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

  /* ---------------- 跨国市场 ----------------
   *
   * 为什么要它：封闭市场里，专业化**赚不到额外收益**。
   * 实测（test/trade-probe.js，等价格收敛后）：收入对自身产出的弹性只有 0.546 ——
   * 把全国都建成农场，粮价就被自己砸下来；把禀赋最好的商品翻倍，
   * 人均产值只涨 4.5%~8.9%。地理因此决定不了国运，地图只是配色。
   *
   * 模型形状（刻意做成一个可标定的约化式，而不是完整的一般均衡）：
   *   1) 世界价 pw = base × (世界总需求 / 世界总供给)^PRICE_ELASTIC
   *      —— 与国内定价**同一条公式**，只是把求和范围从一国换成全世界
   *   2) 各国的封闭价 pa 仍按老公式逐国算（不是为了用它，是为了留作对照与显示）
   *   3) 实际价 target = pa^(1−λ) × pw^λ      λ = 市场整合度 ∈ [0,1]
   *      λ=0 完全封闭（本作原来的行为），λ=1 完全一体化（本国价就是世界价）
   *   4) λ = TRADE_LAMBDA × 政策开放度 × 地理可达性 × 该商品的贸易品程度
   *
   * 两个刻意的选择，都是为了以后不被自己坑：
   *   · 用**几何**混合而不是线性：价格是正数，「翻倍/减半」才是它该有的对称性；
   *     线性混合会随着 λ 变化悄悄改变价格的量纲。
   *   · 不做成真正的多边出清：本模型的消费需求对价格**完全无弹性**
   *     （NEEDS 是固定篮子，CONSUME 不看价格），所以根本不存在一个「让世界出清」的价格。
   *     现有定价本来就是「稀缺度加成」而不是均衡价，跨国这一层沿用同一套语言，
   *     不假装它是均衡。 */
  /* 标定结论（test/trade-sweep.js，seed 8888，240 tick）：
   *   运输技术   弹性    结构分化   本国价偏离世界价   各国 λ 的极差
   *      0     0.537     0.029        0.051             0.000     ← 接入前的旧行为
   *     1.0    0.792     0.048        0.034             0.268
   *     1.3    0.862     0.059        0.026             0.348     ← 取这一档
   *     1.6    0.923     0.070        0.016             0.428
   *   两个反直觉的读数，都值得记下来：
   *     · 一体化**没有**抹平结构差异，反而放大了它（0.029 → 0.059）。
   *       原本担心「大家看到一个世界价 → 都建同样的东西」，实测是反的：
   *       统一的价格信号 + 各省不同的 geoBonus，才让比较优势真正显形。
   *     · 弹性推到 0.98 需要 λ 均值 0.94，那时本国价与世界价的偏离只剩 0.9%，
   *       「本国价 vs 世界价」这条信息在 UI 上就看不见了，地理也就没了抓手。
   *   取 1.3 = 专业化已经明显有回报（0.86，接近小国开放的极限 1.0），
   *   同时各国 λ 还差 1.9 倍、价偏离还有 2.6% —— 地理与政策都还留着力。 */
  /* 价格上下限。这两个数字看着像防爆保护，其实是**设计决策**：
   * 它们决定了「供给不足」能有多少从价格渠道出去、有多少必须从数量渠道出去。
   *   VIC3 是 [0.25, 1.75]（它的公式是 base × (1 + 0.75 × 失衡比)）
   *   我们是 [0.28, 3.40] —— 上限比它高一倍
   * 谁高谁低不是"谁更真"，而是两种不同的传导方式。标定台 test/price-ceiling.js
   * 量的就是这件事：把上限收进 VIC3 的量级，世界会变成什么样。
   * 可通过 createWorld 的 opts 覆盖（扫描用）。 */
  /* ---------------- 省 ↔ 国的接入层（基建） ----------------
   *
   * 动机：现在一个省生产的东西直接进国家池子，全国所有省面对同一个国家价 ——
   * 等于假设**全国的路都是免费的**。VIC3 不是这样，它有
   *     Local Price = MAPI × Market Price + (1 − MAPI) × State Price
   * 一个州跟全国市场连得不好，卖东西收得少、买东西付得多，中间那道差价是真金白银。
   * 铁路 / 港口 / 电报该住的地方，就是这个被我们跳过的夹层。
   *
   * 接法与跨国那层**同形**（几何混合，串成一条链）：
   *     省价 = 省的封闭价^(1−conn) × 国家价^conn
   *     国家价 = 国的封闭价^(1−λ)   × 世界价^λ
   * 于是 省 → 国 → 世界 三级，和 VIC3 的 州 → 全国 → 世界 同构。
   *
   * 为什么这层顺带救活了价格天花板（见 test/price-ceiling.js）：
   * 天花板现在是个死参数，因为**国家级市场把所有省份平均掉了** ——
   * 一个省的歉收扔进国家池子根本不算事（常态供需比最大 1.62，0.00% 撞墙）。
   * 接入这一层之后，conn 低的省调不到外面的货，它的本地供需比会真的走极端，
   * 天花板立刻从摆设变成饥荒的杀伤力旋钮。
   *
   * 地理决定的是**天花板**（能连通到什么程度），不是起点：
   * 沿海和城市的省能修到很密的路网，内陆深处修不动。
   * 起点统一给天花板的 30%，这样每个省都有得投、也都投得起。 */
  /* 标定（test/infra-test.js）：
   * 第一版写的是 CONN_BASE=0.60 / K=3.00，实测连通度全挤在 0.651~0.741 ——
   * 极差 0.09，等于没做。**这是同一个错误的第二次**：世界层那次也是饱和函数
   * 把仅有的差别压平（当时是 succ/(succ+A0)），我换了张皮又写了一遍。
   * 病根是基底给得太高：conn=0.167 意味着"一级路都没有的省"也已经 83% 接进国家市场，
   * 那"路不通"这件事就没代价了。
   * 现在压到 CONN_BASE=0.35，一级基建都没有的省是真孤立。 */
  var CONN_BASE = 0.35;        // 一级基建都没有时的底子（人扛马驮，不是完全隔绝）
  var CONN_K = 4.50;           // 连通度的饱和尺度
  /* 开局基建 = 天花板的这个比例。刻意给得很低：
   * 1836 年本来就没有"全国市场"，内陆省份是各自的小世界；
   * 整个 19 世纪的故事就是修铁路把它们缝起来。给 0.30 的话开局就已经缝好了。 */
  var INFRA_INIT = 0.15;
  /* 省价的偏离上限。加这一条是因为退化情形：
   * 一个完全不产工具的省，省级供需比会趋于无穷（output 被 max(·, 0.001) 兜着），
   * 省价直接顶到 3.4 倍。但现实里再差的路也是路，内陆省的工具是从外面买的。
   * 这个带子就是"运输成本不可能无限大"，同时让零产量的商品不至于发疯。 */
  var LOCAL_BAND = 2.20;
  /* 天花板的三项。
   * 第二项乘的是「沿海度」而不是"离海距离"本身 —— 见 refreshInfraCaps 里的说明：
   * 距离的绝对尺度随地图大小变，直接喂进指数会得到一段没用的平台期。 */
  /* 基础项给 4.0 而不是 1.0，是**为了玩家杠杆**：
   * 实测最需要修路的省内陆省天花板只有 3.3~5，而开局基建 = 天花板的 15%，
   * 于是它们只剩 3~4 级的空间 —— 玩家想使劲的地方正好没空间，
   * 测量出来"修基建只提升人均产值 0.1%"。地理该决定**能修多少**，不该决定**有没有得修**。 */
  var INFRA_CAP_BASE = 4.0;      // 每个省都有得修，内陆深处也不例外
  /* 沿海项从 7.0 拉到 10.0：基础项抬到 4.0 之后，天花板的**相对**差距被压窄了，
   * 连通度极差从 0.24 掉到 0.11 —— 那是"每个省都有得修"的代价，得从沿海项补回来。
   * 两项的分工：基础项保证**有没有得修**（玩家杠杆），沿海项保证**差多少**（地理）。 */
  var INFRA_CAP_COAST = 10.0;    // 靠海额外给多少
  var INFRA_CAP_URBAN = 3.0;     // 城市化
  /* 380 太便宜了：实测 AI 在 240 tick（20 年）内就把全国修到顶，
   * 之后 100 年一动不动 —— 基建会退化成"开局 20 年的机制"，
   * 和当年"1200 tick 后全图满级"是同一个毛病。
   * 同期的工厂是 investCost(总级 15) ≈ 2360，所以一级基建要定价在同一个量级。
   * 现在 infraCost(1)=1812 / infraCost(5)=5700 / infraCost(10)=13800。 */
  var INFRA_COST_BASE = 1200;
  var INFRA_MONTHS = 4;
  function infraCost(level) {
    return INFRA_COST_BASE * (1 + level * 0.45 + level * level * 0.06);
  }

  var PRICE_FLOOR = 0.28;
  var PRICE_CEIL = 3.40;

  var TRADE_LAMBDA = 1.30;               // 运输技术：把「可达份额」放大成整合度的总闸（标定台 test/trade-sweep.js）
  var TRADE_D0 = 260;                    // 引力衰减尺度（地图坐标；地图宽 1600）
  var SEA_COST = 1.30;                   // 跨海边的距离倍率
  /* 各商品的贸易品程度。谷物最好运（人也得吃饭），奢侈品最不好运
   * （高价值低重量，但需求高度本地化、且是身份消费）。
   * 这一列以后是「石油」「粮食禁运」这类题材的抓手。 */
  var TRADABILITY = [1.00, 0.92, 0.70, 0.88, 0.62];
  var TARIFF_MAX = 0.25;                 // 闭关到底能收多少关税（开放度=0 时的关税率）

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
      year: opts.startYear === undefined ? 1836 : opts.startYear,
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
      tradeBalance: new Float32Array(C),   // 净出口值（按世界价计价，全世界加起来恰好为 0）
      tradeGross: new Float32Array(C),     // 贸易总额（进出口之和，显示用）
      tariffPaid: new Float32Array(C),     // 累计关税收入
      // 中间量，预分配
      potExpo: new Float32Array(C),
      potImpo: new Float32Array(C),

      // —— 跨国市场 ——
      dist: new Float32Array(C * C),       // 国与国之间的商路距离（静态，开局算一次）
      access: new Float32Array(C),         // 地理可达性 0..1
      tradeOpen: new Float32Array(C),      // 政策开放度 0..1（玩家可改）
      tradeWeight: new Float32Array(C),    // λ：市场整合度（每 tick 现算）
      /* 这两个是「世界设定」而不是「世界状态」：默认取模块常量，
       * 但可以在 createWorld 的 opts 里覆盖 —— 标定台靠它扫参数（test/trade-sweep.js）。
       * 运输技术将来也可以随时代/科技推进，所以放在世界里而不是写死在函数里。 */
      priceFloor: (opts.priceFloor !== undefined) ? opts.priceFloor : PRICE_FLOOR,
      priceCeil: (opts.priceCeil !== undefined) ? opts.priceCeil : PRICE_CEIL,
      tradeLambda: (opts.tradeLambda !== undefined) ? opts.tradeLambda : TRADE_LAMBDA,
      tradeD0: (opts.tradeD0 !== undefined) ? opts.tradeD0 : TRADE_D0,
      /* 省份规模的钳位。剧本世界会放宽它（真实地球的人口分布宽得多），
       * 随机世界用默认值 —— 于是这个改动对既有回归是零影响。 */
      scaleLo: (opts.scaleLo !== undefined) ? opts.scaleLo
        : (map.scaleLo !== undefined ? map.scaleLo : 0.35),
      scaleHi: (opts.scaleHi !== undefined) ? opts.scaleHi
        : (map.scaleHi !== undefined ? map.scaleHi : 2.8),
      worldPrice: new Float32Array(G),
      worldSupply: new Float32Array(G),
      worldDemand: new Float32Array(G),
      autarky: new Float32Array(G * C),    // 各国的封闭价（对照与显示用）
      expo: new Float32Array(G * C),       // 出口量
      impo: new Float32Array(G * C),       // 进口量
      expoTot: new Float32Array(G),        // 全世界该商品的潜在出口 / 进口（逐商品平账用）
      impoTot: new Float32Array(G),
      expoScale: new Float32Array(G),      // 逐商品的出口侧 / 进口侧平账系数
      impoScale: new Float32Array(G),

      // —— 省 ↔ 国的接入层（基建）——
      infra: new Uint8Array(P),            // 各省的路网/港口等级
      infraCap: new Float32Array(P),       // 地理允许修到多少（离海近的高、内陆深处低）
      coastDist: new Float32Array(P),      // 到最近沿海省的商路距离（静态地理，开局算一次）
      conn: new Float32Array(P),           // 连通度 0..1：这个省离本国市场有多近
      localPrice: new Float32Array(G * P), // 省价（生产与消费真正用的价）
      demandP: new Float32Array(G * P),    // 省级需求（算省价用）
      infraBuild: new Uint8Array(P),       // 在建标志
      infraLeft: new Uint8Array(P),        // 剩余工期
      infraDone: 0,

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

    /* ═══════════ 世界接口：剧本数据优先 ═══════════
     * 四条禀赋通道有**两个来源**，逐省判定，互不干扰：
     *   随机世界 —— 下面这段用质心采样噪声，让相邻省份相似 → 形成专业化地带
     *   剧本世界 —— data/scenario.js 已把真实要素（人均耕地/森林/矿产/工业）
     *               压缩好挂在 map.provinces[p].fert 等字段上
     * 为什么敢在这里分叉：`geoBonus` 与 `levelCap` 全都由这四条通道派生，
     * 于是"接真实资源"不需要在模拟层写一行新机制 —— 换掉原料，产物自己就变了。
     *
     * 关键细节：R.fbm 不消耗 rng（噪声表在 makeNoise 时就抽完了），
     * 所以"跳过 fbm 改读字段"**不会让 rng() 序列漂移**。这是剧本世界能复用
     * 随机世界全部标定常数的前提 —— 也是本文件里唯一允许出现 if 的地方。 */
    for (var p = 0; p < P; p++) {
      var prov = map.provinces[p];
      if (prov.fert !== undefined) {
        w.fert[p] = clamp(prov.fert, 0.05, 4);
        w.timber[p] = clamp(prov.timber, 0.05, 4);
        w.mineral[p] = clamp(prov.mineral, 0.05, 4);
        w.urban[p] = clamp(prov.urban, 0.05, 4);
        continue;
      }
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
      /* 剧本世界直接给人口。真实人口分布和土地面积几乎无关 ——
       * 加拿大比中国大，人口是它的四十五分之一；按面积摊就全错了。 */
      var total;
      if (prov2.pop0 !== undefined) {
        total = prov2.pop0;
      } else {
        var density = w.urban[p2] * 0.85 + 0.35;
        total = clamp((prov2.area / avgArea) * density * 165000, 28000, 620000);
      }
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
      /* 省份规模钳位。**它是一条世界参数，不是一个物理常数** ——
       * 随机世界的省际人口差只有 2 倍（raw 0.56~2.1），钳位永远够用；
       * 真实地球的省际人口差是 2000 倍（raw 0.15~7.0），同一副钳位会把
       * 23% 的省压到下限、9% 压到上限，于是"华北平原能建多少厂"由钳位决定
       * 而不是由它有多少人决定。默认值原样保留 ⇒ 随机世界逐字节不变。 */
      var scale = clamp(popHere / avgPop0, w.scaleLo, w.scaleHi);
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
    /* 跨国市场：商路距离是静态地理，开局算一次；通商政策默认全开放。
     * 初始价 = 基准价，但预热会把世界价与各国价一起推到有差异的位置。 */
    w.dist.fill(Infinity);
    w.tradeOpen.fill(1);
    buildTradeDistances(w);
    /* 基建：天花板由地理算，起点统一给天花板的 30%（不摇随机数 ——
     * createWorld 里的 rng() 序列一动，初始建筑与禀赋全都会漂，
     * 现有回归的基线数字就全失效了。这里刻意做成纯确定的地理函数）。 */
    refreshInfraCaps(w);
    for (var ip = 0; ip < P; ip++) {
      var ilv = Math.round(w.infraCap[ip] * INFRA_INIT);
      w.infra[ip] = ilv < 0 ? 0 : ilv;
    }
    refreshConn(w);
    refreshLevelCaps(w);      // 开局先刷一次，之后每 tick 跟随人口
    for (var warm = 0; warm < 3; warm++) tick(w);
    w.warmed = true;   // 预热不再触发灾情：开局不该在第 0 个月就挨一次歉收



    w.year = opts.startYear === undefined ? 1836 : opts.startYear;
    w.month = 0;
    w.tick = 0;
    w.events.length = 0;
    w.gdpPrev.set(w.gdp);
    w.gdpSmooth.set(w.gdp);
    pushEvent(w, opts.intro || ('王国纪年 ' + w.year + ' 年，欧洲列强的账本翻开了新的一页。'), 'info');

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

  /* ---------------- 跨国市场：地理 ---------------- */

  /* 国与国之间的**商路距离**：在省图上跑最短路，而不是量两个首都之间的直线。
   *
   * 为什么要绕这一道：直线距离不知道「中间隔着谁」。两个只隔一道海峡的国家，
   * 和两个隔着三个国家、两条山脉的国家，直线距离可以一样，商路距离差好几倍。
   * 而决定贸易的是后者。
   *
   * 边的权重 = 两省中心的直线距离 × 跨海倍率。
   * 「这条边是不是跨海」用两省中心连线的**中点**落在陆地还是水面来判断 ——
   * 用一个像素去问一次地图，比自己去重建海岸线简单得多，精度也够。
   *
   * 算法：每个国家做一次多源 Dijkstra（源 = 它的全部省份，初值 0），
   * 得到的到各省距离里、取目标国各省的最小值，就是两国的商路距离。
   * 复杂度 O(C·P²) = 8 × 260² ≈ 54 万次，开局一次性，可以忽略。
   * 刻意不用优先队列：省一个数据结构，也省得解释。 */
  var MAX_NB = 12;    // 一个省最多记几条邻边（Voronoi 胞通常 5~7 条）

  function buildTradeDistances(w) {
    var map = w.map, P = w.P, C = w.C;
    var W = map.width, H = map.height, mask = map.mask;

    var nIdx = new Int32Array(P * MAX_NB);
    var nW = new Float32Array(P * MAX_NB);
    var nCount = new Int32Array(P);

    for (var p = 0; p < P; p++) {
      var prov = map.provinces[p];
      var nb = prov.neighbors || [];
      var k = 0;
      for (var e = 0; e < nb.length && k < MAX_NB; e++) {
        var q = nb[e];
        if (q < 0 || q >= P) continue;
        var dx = map.provinces[q].cx - prov.cx;
        var dy = map.provinces[q].cy - prov.cy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) d = 1;
        // 中点落在水里 ⇒ 这条边要过海
        var mx = ((prov.cx + map.provinces[q].cx) * 0.5) | 0;
        var my = ((prov.cy + map.provinces[q].cy) * 0.5) | 0;
        var sea = 0;
        if (mx >= 0 && mx < W && my >= 0 && my < H) sea = mask[my * W + mx] ? 0 : 1;
        else sea = 1;
        nIdx[p * MAX_NB + k] = q;
        nW[p * MAX_NB + k] = d * (sea ? SEA_COST : 1);
        k++;
      }
      nCount[p] = k;
    }

    var dist = new Float32Array(P);
    var done = new Uint8Array(P);

    /* —— 到最近海岸的商路距离：顺手在同一张邻接表上再跑一次多源 Dijkstra ——
     * 为什么要这个量而不是直接用 landFrac：landFrac 的中位数就是 1.000
     * （大多数省的 Voronoi 胞完全落在陆地上），拿它当"沿海度"等于只给少数几个省发福利，
     * 基建天花板会全挤在 5.8~8.0 那一小段里。而"离海多远"是个连续量，
     * 历史上也正是它决定铁路修到哪里 —— 港口 → 内陆 → 腹地。 */
    dist.fill(Infinity);
    done.fill(0);
    for (var s0 = 0; s0 < P; s0++) {
      var lf0 = map.provinces[s0].landFrac;
      if (lf0 !== undefined && lf0 < 0.98) dist[s0] = 0;
    }
    for (var it0 = 0; it0 < P; it0++) {
      var b0 = -1, bd0 = Infinity;
      for (var q0 = 0; q0 < P; q0++) if (!done[q0] && dist[q0] < bd0) { bd0 = dist[q0]; b0 = q0; }
      if (b0 < 0) break;
      done[b0] = 1;
      var base0 = b0 * MAX_NB, n0 = nCount[b0];
      for (var e0 = 0; e0 < n0; e0++) {
        var to0 = nIdx[base0 + e0];
        var nd0 = bd0 + nW[base0 + e0];
        if (nd0 < dist[to0]) dist[to0] = nd0;
      }
    }
    for (var p0 = 0; p0 < P; p0++) w.coastDist[p0] = (dist[p0] < Infinity) ? dist[p0] : 9999;

    for (var c = 0; c < C; c++) {
      dist.fill(Infinity);
      done.fill(0);
      for (var s = 0; s < P; s++) if (map.provinces[s].country === c) dist[s] = 0;
      for (var it = 0; it < P; it++) {
        var best = -1, bd = Infinity;
        for (var a = 0; a < P; a++) if (!done[a] && dist[a] < bd) { bd = dist[a]; best = a; }
        if (best < 0) break;
        done[best] = 1;
        var base = best * MAX_NB, n = nCount[best];
        for (var e2 = 0; e2 < n; e2++) {
          var to = nIdx[base + e2];
          var nd = bd + nW[base + e2];
          if (nd < dist[to]) dist[to] = nd;
        }
      }
      for (var t2 = 0; t2 < P; t2++) {
        var tc = map.provinces[t2].country;
        if (dist[t2] < w.dist[c * C + tc]) w.dist[c * C + tc] = dist[t2];
      }
      w.dist[c * C + c] = 0;
    }
  }

  /* 地理可达性 = **你能触达的世界市场比重**。
   *   access_c = Σ_{o≠c} (人口_o / 他国总人口) × exp(−商路距离 / D0)
   * 取值天然落在 [0,1]，含义直接：1 = 全世界都挨着你，0 = 你在天边。
   *
   * 为什么不用 saturating 的 succ/(succ+A0)：第一版就是那么写的，实测
   * 八个国家的 access 全落在 0.687~0.719 —— 地理几乎不起作用。
   * 原因是地图上八国本就首尾相连，succ 都差不多，再套一个饱和函数
   * 等于把仅有的差别压平。份额加权的写法保留了「你的伙伴离你多远」这个差别的**全部**。
   *
   * 市场规模用**人口**而不是 GDP：GDP 是内生的、会崩的，
   * 用它会让「邻居垮了 → 我也做不成生意 → 我也垮」变成一条正反馈回路。
   * 人口也会变，但它是缓变量 —— 这里要问的是「你在世界的哪个位置」，
   * 不是「谁今年景气」。
   *
   * 每 tick 重算：C² = 64 次乘加，比一次开方还便宜。 */
  function refreshAccess(w) {
    var C = w.C;
    var totalPop = 0;
    for (var c = 0; c < C; c++) totalPop += w.popTotal[c];
    if (totalPop <= 0) { w.access.fill(0); w.tradeWeight.fill(0); return; }
    for (var c2 = 0; c2 < C; c2++) {
      var others = totalPop - w.popTotal[c2];
      if (others <= 0) { w.access[c2] = 0; w.tradeWeight[c2] = 0; continue; }
      var reach = 0;
      for (var o = 0; o < C; o++) {
        if (o === c2) continue;
        var d = w.dist[c2 * C + o];
        if (!(d < Infinity)) continue;             // 没有陆路/海路相通
        reach += (w.popTotal[o] / others) * Math.exp(-d / w.tradeD0);
      }
      w.access[c2] = reach;
      w.tradeWeight[c2] = w.tradeLambda * w.tradeOpen[c2] * reach;
    }
  }

  /* 连通度：基建等级 → 0..1 的饱和函数。
   * 用 CONN_BASE 兜底而不是从 0 起：一级路都没有的省也不是完全隔绝的
   * （人背马驮、集市、走亲戚），彻底断绝会让内陆省变成另一个模型。 */
  function refreshConn(w) {
    var P = w.P;
    for (var p = 0; p < P; p++) {
      var x = CONN_BASE + w.infra[p];
      w.conn[p] = x / (x + CONN_K);
    }
  }

  /* 基建天花板：地理决定的。沿海（landFrac 低 ⇒ 胞内大片是海）和城市化的省
   * 能修到很密的路网；内陆深处修不动 —— 这和 levelCap 是同一条哲学：
   * **地理定的是天花板，不是起点**。 */
  /* 基建天花板 = 基础 + 沿海度 + 城市化。
   *
   * 「沿海度」是**离海距离在本图内的分位**，不是距离本身。这一步是量出来的：
   *   · 用 landFrac 当沿海度 → 中位数就是 1.000，只有少数省吃到，天花板全挤在 5.8~8.0
   *   · 用 exp(−离海距离/D0) → 地图是紧凑的，绝大多数省都在 200 单位以内，
   *     exp 几乎不衰减，天花板变成 8.1~17.0 的一段高平台 —— **而 AI 的钱只够修到 12 级**
   *     于是卡住所有人的不是地理而是钱包，conn 全饱和在 0.733，地理又不起作用了
   * 病根是「离海距离」的绝对尺度依赖地图大小。取分位就把尺度问题消掉了：
   * 最靠海的省和最内陆的省之间**一定**有确定的差距，换地图换种子都不变。
   * 代价是它不再是一个物理量 —— 但天花板本来就是相对的（"这个省比那个省更适合修路"），
   * 不是绝对的（"它值 7.3 级路"）。 */
  function refreshInfraCaps(w) {
    var P = w.P, p;
    var sorted = new Float32Array(P);
    for (p = 0; p < P; p++) sorted[p] = w.coastDist[p];
    Array.prototype.sort.call(sorted, function (a, b) { return a - b; });
    var n = P;
    for (p = 0; p < P; p++) {
      /* 二分找出自己在排序表里的位置 → 分位 */
      var d = w.coastDist[p], lo = 0, hi = n;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (sorted[mid] < d) lo = mid + 1; else hi = mid;
      }
      var pct = n > 1 ? lo / (n - 1) : 0;      // 0 = 最靠海，1 = 最内陆
      if (pct > 1) pct = 1;
      var near = 1 - pct;
      w.infraCap[p] = INFRA_CAP_BASE + INFRA_CAP_COAST * near + INFRA_CAP_URBAN * w.urban[p];
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
    w.demandP.fill(0);
    for (p = 0; p < P; p++) {
      c = w.map.provinces[p].country;
      for (s = 0; s < S2; s++) {
        var n = w.pop[s * P + p] / 1000;
        var wl = w.wealth[s * P + p];
        for (g = 0; g < G2; g++) {
          var mult = Math.max(NEED_FLOOR[g], 1 + (wl - 1) * LUX_SENS[g]);
          var qty = n * NEEDS[s][g] * mult;
          w.demand[g * C + c] += qty;
          /* 同一个量同时记到省上 —— 省级封闭价要用它。
           * 一份数据两处累加，而不是事后拆，是为了不引入第二套口径。 */
          w.demandP[g * P + p] += qty;
        }
      }
    }

    /* 4) 市场清算定价 —— 从「一国一价」改成「世界价 + 各国对世界的接入程度」
     *
     * 三步，缺一不可：
     *   4a 世界总量 → 世界价（与国内定价同一条公式，只换了求和范围）
     *   4b 地理可达性 → 市场整合度 λ
     *   4c 各国价 = 封闭价与世界价的几何混合
     *   4d 贸易流量（供显示、供关税、供以后的封锁用）
     *
     * 注意 4d **不反过来影响本 tick 的价格**。价格已经通过 λ 把
     * 「多余的能卖到外面去」这件事计进去了；再按流量算一遍就是重复计提，
     * 而且会引入一条自己咬自己的回路（价→量→价），标定会变成噩梦。 */
    w.worldSupply.fill(0);
    w.worldDemand.fill(0);
    for (c = 0; c < C; c++) {
      for (g = 0; g < G2; g++) {
        w.worldSupply[g] += w.supply[g * C + c];
        w.worldDemand[g] += w.demand[g * C + c];
      }
    }
    for (g = 0; g < G2; g++) {
      var ws = Math.max(w.worldSupply[g], 0.001);
      w.worldPrice[g] = GOODS[g].base *
        clamp(Math.pow(w.worldDemand[g] / ws, PRICE_ELASTIC), w.priceFloor, w.priceCeil);
    }

    /* 可达性用的是上一 tick 的人口（国家统计在第 8 步）。
     * 一 tick 的滞后在 100 年的尺度上无所谓，换来的是明确的先后次序。 */
    refreshAccess(w);

    for (c = 0; c < C; c++) {
      var lam0 = w.tradeWeight[c];
      for (g = 0; g < G2; g++) {
        var key2 = g * C + c;
        var sup = Math.max(w.supply[key2], 0.001);
        var dem = w.demand[key2];
        var pa = GOODS[g].base * clamp(Math.pow(dem / sup, PRICE_ELASTIC), w.priceFloor, w.priceCeil);
        w.autarky[key2] = pa;
        var lam = lam0 * TRADABILITY[g];
        if (lam > 1) lam = 1;
        var target = Math.pow(pa, 1 - lam) * Math.pow(w.worldPrice[g], lam);
        w.price[key2] = w.price[key2] * (1 - PRICE_SMOOTH) + target * PRICE_SMOOTH;
      }
    }

    /* 4e) 省价 —— 省 ↔ 国的接入层，和 4c 是同一套写法的下一级。
     * 省的封闭价按**这个省自己**的供需算，再按连通度 conn 混向国家价。
     * conn 接近 0 的省就是个自给自足的小世界：产什么吃什么，
     * 多余的砸在自己手里，缺的贵得离谱。那就是"基建差就是难以贸易"。 */
    for (p = 0; p < P; p++) {
      c = w.map.provinces[p].country;
      var cn = w.conn[p];
      for (g = 0; g < G2; g++) {
        var sp = Math.max(w.output[g * P + p], 0.001);
        var dp = w.demandP[g * P + p];
        var pp = GOODS[g].base *
          clamp(Math.pow(dp / sp, PRICE_ELASTIC), w.priceFloor, w.priceCeil);
        var nat = w.price[g * C + c];
        if (pp > nat * LOCAL_BAND) pp = nat * LOCAL_BAND;
        else if (pp < nat / LOCAL_BAND) pp = nat / LOCAL_BAND;
        if (cn >= 1) w.localPrice[g * P + p] = w.price[g * C + c];
        else w.localPrice[g * P + p] = Math.pow(pp, 1 - cn) * Math.pow(w.price[g * C + c], cn);
      }
    }

    /* 4d) 贸易流量。
     * 口径：能出口的 = 本国过剩 × 整合度；能进口的 = 本国缺口 × 整合度。
     * 然后按较小的一边**等比例缩放**，让全世界的出口量恰好等于进口量。
     * 为什么必须缩放：这是一本账。出口总和 ≠ 进口总和 的账本，
     * 缩放因子本身也是信息 —— 世界性过剩（大家都在卖、没人买）会把它压到 1 以下。
     *
     * ⚠ 缩放必须**逐商品**做，不能只算一个全局因子。
     * 踩过的坑：第一版用全局 covered = min(Σ所有商品出口, Σ所有商品进口) 去缩两边，
     * 结果「全世界出口量 = 全世界进口量」成立了，但**分商品的账不平**。
     * 而贸易余额是按世界价逐商品加权的，于是全球贸易余额合计 = 47317 而不是 0 ——
     * 凭空多出来的钱。逐商品缩放之后每一项都归零。
     * 商品之间不能互相抵账：谷物卖不掉不能用木材的买家来平。 */
    /* 先逐国逐商品算出「想卖多少 / 想买多少」，再逐商品平账 */
    w.expoTot.fill(0);
    w.impoTot.fill(0);
    for (c = 0; c < C; c++) {
      var lamC = w.tradeWeight[c];
      for (g = 0; g < G2; g++) {
        var key3 = g * C + c;
        var lg = lamC * TRADABILITY[g];
        if (lg > 1) lg = 1;
        var bal = w.supply[key3] - w.demand[key3];
        var ex = bal > 0 ? bal * lg : 0;
        var im = bal < 0 ? -bal * lg : 0;
        w.expo[key3] = ex;
        w.impo[key3] = im;
        w.expoTot[g] += ex;
        w.impoTot[g] += im;
      }
    }
    for (g = 0; g < G2; g++) {
      var te = w.expoTot[g], ti = w.impoTot[g];
      var cov = te < ti ? te : ti;
      w.expoScale[g] = te > 1e-9 ? cov / te : 0;
      w.impoScale[g] = ti > 1e-9 ? cov / ti : 0;
    }

    w.tradeBalance.fill(0);
    w.tradeGross.fill(0);
    for (c = 0; c < C; c++) {
      var tb = 0, gross = 0, duty = 0;
      /* 开放度同时管两件事：
       *   a) 它已经在 λ 里，闭关 = 本国价与外国价脱钩（保护生产者，坑消费者）
       *   b) 它还是关税率：开放度 0 → 关税 TARIFF_MAX，进口值抽一道进国库
       * 这不是重复收费，而是保护主义的两个真实后果。 */
      var open = w.tradeOpen[c];
      for (g = 0; g < G2; g++) {
        var key4 = g * C + c;
        var e3 = w.expo[key4] * w.expoScale[g];
        var m3 = w.impo[key4] * w.impoScale[g];
        w.expo[key4] = e3;
        w.impo[key4] = m3;
        var pw = w.worldPrice[g];
        tb += (e3 - m3) * pw;
        gross += (e3 + m3) * pw;
        duty += m3 * pw * (1 - open) * TARIFF_MAX;
      }
      w.tradeBalance[c] = tb;      // 按世界价计，全世界加起来恰好为 0
      w.tradeGross[c] = gross;
      w.treasuryGain[c] += duty;
      w.tariffPaid[c] += duty;
    }

    /* 5) 收入分配 + 支出 */
    var gdpAcc = w.gdpAcc;
    gdpAcc.fill(0);
    for (p = 0; p < P; p++) {
      c = w.map.provinces[p].country;
      /* 收入按**省价**结算，不是国家价。
       * 这就是基建的全部经济意义：路不好的省，东西卖不出国家价。
       * 生产者和消费者在同一个省时那道差价不发生 —— 和 VIC3 的 MAPI 一模一样。 */
      var revenue = 0;
      for (g = 0; g < G2; g++) revenue += w.output[g * P + p] * w.localPrice[g * P + p];
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
          expense += n2 * NEEDS[s][g] * mult2 * w.localPrice[g * P + p];
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

      /* 基建优先于建厂：一条路能让这个省**所有**产业的成交价都往上抬，
       * 而多建一级厂只影响一种商品、还受天花板管。
       * 阈值放在 conn < 0.72 而不是"修到顶"：接到 0.72 以后边际收益已经很小，
       * 钱应该转去建厂（这个数是标定量，见 test/infra-test.js）。 */
      if (w.autoInvest && !w.infraBuild[p] && w.infra[p] < w.infraCap[p] && w.conn[p] < 0.72) {
        var icost = infraCost(w.infra[p]);
        if (w.invest[p] >= icost) {
          w.invest[p] -= icost;
          w.infraBuild[p] = 1;
          w.infraLeft[p] = INFRA_MONTHS;
          w.treasuryGain[c] += icost * 0.12;
        }
      }
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
    /* 基建在建工程：与建筑同一条规则（走国库/投资池的钱，工期到了才 +1 级，也受天花板管） */
    for (p = 0; p < P; p++) {
      if (!w.infraBuild[p]) continue;
      if (--w.infraLeft[p] <= 0) {
        if (w.infra[p] < w.infraCap[p]) w.infra[p]++;
        w.infraBuild[p] = 0;
        w.infraDone++;
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
    /* 连通度只随基建变，但它便宜，和天花板一起刷，少一个调用点就少一处遗漏 */
    refreshConn(w);

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
      } else if (kind === CMD_INFRA) {
        if (prov >= 0 && prov < w.P && !w.infraBuild[prov]) {
          var ilv2 = w.infra[prov];
          /* 和建造同一条纪律：玩家也受地理天花板管，没有后门 */
          if (ilv2 < Math.floor(w.infraCap[prov])) {
            var icost2 = infraCost(ilv2);
            var ctry2 = w.map.provinces[prov].country;
            if (w.treasury[ctry2] >= icost2) {
              w.treasury[ctry2] -= icost2;
              w.infraBuild[prov] = 1;
              w.infraLeft[prov] = INFRA_MONTHS;
            } else {
              pushEvent(w, w.map.countries[ctry2].name + ' 国库不足，' +
                w.map.provinces[prov].name + ' 的基建未能开工。', 'info');
            }
          }
        }
      } else if (kind === CMD_TRADE) {
        /* 通商政策。用 cmdCountry 而不是 cmdProv：这是一国的制度，不是一省的工程。 */
        var tc = w.cmdCountry[i];
        if (tc >= 0 && tc < w.C) {
          var ov = w.cmdValue[i];
          if (ov < 0) ov = 0;
          if (ov > 1) ov = 1;
          w.tradeOpen[tc] = ov;
        }
      }
      w.cmdHead = (w.cmdHead + 1) % CMD_CAP;
    }
  }
  function detectEvents(w) {
    var C = w.C, G2 = w.G, P = w.P, i;

    /* 0) 世界行情 —— 接进跨国市场之后，玩家最该被提醒的是"全世界都在缺什么"。
     * 它和下面第 1 条（本国的价格极端）是两件事：本国粮价高可能只是本国的问题，
     * 世界粮价高则是所有人一起在抢。混在一句里说，玩家分不出该怪谁。 */
    for (var gw = 0; gw < G2; gw++) {
      var wr = w.worldPrice[gw] / GOODS[gw].base;
      if (wr > 1.25) {
        maybePush(w, '世界市场的' + GOODS[gw].name + '涨到基准价的 ' + (wr * 100).toFixed(0) +
          '%，各国都在抢，进口国尤其吃紧。', 'bad', 'w-hi-' + gw);
      } else if (wr < 0.75) {
        maybePush(w, '世界市场的' + GOODS[gw].name + '跌到基准价的 ' + (wr * 100).toFixed(0) +
          '%，出口国正在被自己的产量压价。', 'bad', 'w-lo-' + gw);
      }
    }

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
        treasury: w.treasury[c],
        // —— 跨国市场 ——
        access: w.access[c],
        tradeOpen: w.tradeOpen[c],
        tradeWeight: w.tradeWeight[c],
        tradeBalance: w.tradeBalance[c],
        tradeGross: w.tradeGross[c],
        tariffPaid: w.tariffPaid[c]
      });
    }
    rows.sort(function (a, b) { return b.gdp - a.gdp; });
    return rows;
  }

  function marketRows(w, countryId) {
    var rows = [];
    for (var g = 0; g < w.G; g++) {
      var key = g * w.C + countryId;
      var price = w.price[key];
      var sup = w.supply[key];
      var dem = w.demand[key];
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
        balance: sup - dem,
        // —— 跨国市场 ——
        worldPrice: w.worldPrice[g],
        worldRel: w.worldPrice[g] / GOODS[g].base,
        autarky: w.autarky[key],
        autarkyRel: w.autarky[key] / GOODS[g].base,
        expo: w.expo[key],
        impo: w.impo[key],
        net: w.expo[key] - w.impo[key]
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
    // —— 省 ↔ 国的接入层 ——
    out.infra = w.infra[p];
    out.infraCap = w.infraCap[p];
    out.conn = w.conn[p];
    out.infraBuilding = !!w.infraBuild[p];
    out.infraLeft = w.infraLeft[p];
    out.infraCost = infraCost(w.infra[p]);
    var lp = [];
    for (var lg = 0; lg < w.G; lg++) {
      lp.push({
        name: GOODS[lg].name,
        hue: GOODS[lg].hue,
        local: w.localPrice[lg * P + p],
        national: w.price[lg * w.C + w.map.provinces[p].country],
        world: w.worldPrice[lg],
        gap: w.price[lg * w.C + w.map.provinces[p].country] > 0
          ? w.localPrice[lg * P + p] / w.price[lg * w.C + w.map.provinces[p].country] - 1 : 0
      });
    }
    out.localPrices = lp;
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
    CMD_TRADE: CMD_TRADE,
    CMD_INFRA: CMD_INFRA,
    infraCost: infraCost,
    INFRA_MONTHS: INFRA_MONTHS,
    BUILD_MONTHS: BUILD_MONTHS,
    RELIEF_COST: RELIEF_COST,
    RELIEF_MONTHS: RELIEF_MONTHS,
    refreshAccess: refreshAccess
  };
})(typeof window !== 'undefined' ? window : globalThis);
