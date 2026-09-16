/* 蒸汽与账本 — 启动与主循环
 *
 * 时序纪律：模拟跑在自己的节拍上，渲染和 UI 各自节流，
 * 三者互不阻塞 —— 这是这类游戏不卡的唯一办法。
 */
(function (root) {
  'use strict';
  var VIC = root.VIC;

  var SEED = 8888;
  var TICKS_PER_SEC = [0, 1, 3, 9, 24];
  var UI_INTERVAL = 120;   // ms，面板刷新节流
  var DATA_MODE_EVERY = 4; // 非政治模式下每几 tick 重建一次地图
  var YEARS_PER_RUN = 100; // 一局 = 100 年（1200 tick）。有终点才有「再来一局」。
  var HORIZON = YEARS_PER_RUN * 12;

  /* 世界线的选择：URL 参数 `?w=<剧本 id>`。用参数而不是内存里的开关，
   * 是因为换世界线要整个重建渲染器 —— 直接 reload 最省事也最不容易留下脏状态。
   * 不带参数 = 原来的随机世界，所以双击 index.html 的行为完全不变。 */
  function wantScenario() {
    var m = /[?&]w=([A-Za-z0-9_]+)/.exec(root.location ? root.location.search : '');
    return m ? m[1] : '';
  }

  /* 建图：有剧本就用剧本，没有就照旧噪声生成。
   * 两条路产出的都是 sim 认识的那张 map，差别只在 provinces 上多了几个字段。 */
  function buildMap() {
    var id = wantScenario();
    var SC = VIC.scenario;
    if (id && SC && SC.get(id)) {
      var def = SC.get(id);
      var map = SC.build(def, { seed: def.seed || SEED });
      map.scenarioName = def.name;
      map.intro = def.intro;
      return map;
    }
    if (id && SC) console.warn('找不到剧本「' + id + '」，回退到随机世界');
    return VIC.mapgen.generate({
      width: 1600, height: 1000, seed: SEED, provinces: 260, countries: 8
    });
  }

  /* 顶栏的世界线下拉：列出"随机世界" + 所有已注册剧本 */
  function bindScenarioSelect() {
    var sel = document.getElementById('scenario');
    if (!sel) return;
    var cur = wantScenario();
    var html = '<option value="">随机世界 · seed ' + SEED + '</option>';
    var list = (VIC.scenario && VIC.scenario.list) ? VIC.scenario.list() : [];
    for (var i = 0; i < list.length; i++) {
      var d = VIC.scenario.get(list[i]);
      html += '<option value="' + list[i] + '">' + (d.name || list[i]) + '</option>';
    }
    sel.innerHTML = html;
    sel.value = cur;
    sel.addEventListener('change', function () {
      var v = sel.value;
      var base = location.href.split('?')[0];
      location.href = v ? (base + '?w=' + encodeURIComponent(v)) : base;
    });
  }

  var world = null, renderer = null;
  var speed = 1;
  var acc = 0, lastT = 0;
  var uiAcc = 0;
  var activeCountry = 0;
  var selectedProvince = -1;
  var mapMode = 'political';
  var lastBuildTick = 0;   // 上次重建陆地层时的 tick，用于节流
  var ended = false;       // 一局是否已结算
  var starts = null;       // 开局快照，用于结算时对比


  function boot() {
    // 让载入遮罩先画出来，再做几百毫秒的重活
    requestAnimationFrame(function () {
      setTimeout(function () {
        var t0 = performance.now();
        bindScenarioSelect();
        var map = buildMap();
        world = VIC.sim.createWorld(map, {
          seed: SEED + 7,
          startYear: map.year,          // 剧本自带起始年（1945）；随机世界仍是 1836
          intro: map.intro
        });

        // 默认选中人口最多的国家
        var best = 0;
        for (var c = 1; c < world.C; c++) if (world.popTotal[c] > world.popTotal[best]) best = c;
        activeCountry = best;
        starts = takeStartSnapshot(world);   // 开局基线：结算时算「这一百年你改变了什么」


        var canvas = document.getElementById('map');
        renderer = VIC.render.create(canvas, world, {
          mode: mapMode,
          onHover: function (p, x, y) {
            if (p >= 0) VIC.ui.showTooltip(world, p, x, y);
            else VIC.ui.hideTooltip();
          },
          onHoverMove: function (p, x, y) { VIC.ui.showTooltip(world, p, x, y); },
          onHoverLeave: function () { VIC.ui.hideTooltip(); },
          onClick: function (p) {
            selectedProvince = p;
            renderer.setSelected(p);
            if (p >= 0) {
              activeCountry = map.provinces[p].country;
              VIC.ui.showProvince(world, p);
            } else {
              VIC.ui.showCountryOverview(world, activeCountry);
            }
            refreshAll(true);
          }
        });

        VIC.ui.init(world, {
          onSpeed: function (s) { setSpeed(s); },
          onMode: function (m) { mapMode = m; lastBuildTick = world.tick; renderer.setMode(m); },
          onResetView: function () { renderer.resetView(); },
          /* 两个花钱口子。UI 不直接改世界，只把命令塞进 sim 的环形队列，
           * 由下一个 tick 的 applyCommands 消费 —— 和 test/tension.js 走同一条路。 */
          /* 修基建：和建造走同一条命令队列，只是 kind 不同、付款人一样是国库 */
          onInfra: function (prov) {
            if (prov < 0) return;
            VIC.sim.pushCommand(world, VIC.sim.CMD_INFRA, prov, 0, 0, activeCountry);
            VIC.sim.applyCommands(world);
            VIC.ui.showProvince(world, prov);
            refreshAll(false);
          },
          onBuild: function (prov, good) {
            VIC.sim.pushCommand(world, VIC.sim.CMD_BUILD, prov, good, 0);
            VIC.ui.updateActions(world);
            refreshAll(true);
          },
          onRelief: function () {
            var on = world.reliefOn[activeCountry] ? 0 : 1;
            VIC.sim.pushCommand(world, VIC.sim.CMD_RELIEF, -1, 0, on, activeCountry);
            /* 命令照常入队，但立刻消费一次：否则按钮要等下一个 tick 才变色，
             * 玩家会以为没点上。入队 + 消费都走 sim 的公开接口，没有绕过后门。 */
            VIC.sim.applyCommands(world);
            VIC.ui.showCountryOverview(world, activeCountry);
            refreshAll(false);
          },

          /* 通商政策：同样只入队 + 立刻消费一次，让按钮即时生效。
           * 注意它是**一国的制度**，所以必须把 activeCountry 一起带上 ——
           * 这个参数是这次接跨国市场时补上的（之前 pushCommand 根本没有它，
           * 于是赈灾一直在给 0 号国发钱）。 */
          onTrade: function (open) {
            VIC.sim.pushCommand(world, VIC.sim.CMD_TRADE, -1, 0, open, activeCountry);
            VIC.sim.applyCommands(world);
            VIC.ui.showCountryOverview(world, activeCountry);
            refreshAll(false);
          },

          onRestart: function () { location.reload(); }
        });

        VIC.ui.bindRankingClicks(function (c) {
          activeCountry = c;
          selectedProvince = -1;
          renderer.setSelected(-1);
          VIC.ui.showCountryOverview(world, c);
          refreshAll(true);
        });

        renderer.resize();
        window.addEventListener('resize', function () { renderer.resize(); });

        setSpeed(1);
        VIC.ui.showCountryOverview(world, activeCountry);
        VIC.ui.updateMarket(world, activeCountry);
        VIC.ui.updateRanking(world, activeCountry);
        VIC.ui.updateTopbar(world, activeCountry);
        VIC.ui.updateTicker(world, true);
        renderer.draw();

        document.getElementById('loading').classList.add('done');
        console.log('[蒸汽与账本] 世界生成耗时 ' + (performance.now() - t0).toFixed(0) + ' ms，' +
          world.P + ' 省 / ' + world.C + ' 国');

        lastT = performance.now();
        requestAnimationFrame(frame);
      }, 30);
    });
  }

  function setSpeed(s) {
    speed = s;
    VIC.ui.setSpeed(s);
  }

  /* 开局快照：结算时要用它算「这一百年你让国家变了多少」 */
  function takeStartSnapshot(w) {
    var pop = 0, lv = 0, prov = 0;
    for (var p = 0; p < w.P; p++) {
      if (w.map.provinces[p].country !== activeCountry) continue;
      prov++;
      pop += w.pop[0 * w.P + p] + w.pop[1 * w.P + p] + w.pop[2 * w.P + p];
      for (var g = 0; g < w.G; g++) lv += w.level[g * w.P + p];
    }
    return { pop: pop, lv: lv, gdp: w.gdp[activeCountry], unrest: w.unrestAvg[activeCountry], prov: prov };
  }

  /* 一局结束：结算并弹出成绩单。
   * 为什么要有终点：长跑实测显示 1200 tick 后 207/214 个省全部满级、地图不再传递任何信息。
   * 与其让玩家看着数字冻结，不如把「100 年」做成一局的边界，让每局都有成败可谈。 */
  function endRun() {
    if (ended) return;
    ended = true;
    speed = 0;
    VIC.ui.setSpeed(0);

    var w = world, c = activeCountry, C = w.C;
    // 国力排名
    var order = [];
    for (var i = 0; i < C; i++) order.push(i);
    order.sort(function (a, b) { return w.gdpSmooth[b] - w.gdpSmooth[a]; });
    var rank = order.indexOf(c) + 1;
    var worldGdp = 0;
    for (var k = 0; k < C; k++) worldGdp += w.gdp[k];
    var share = worldGdp > 0 ? w.gdp[c] / worldGdp : 0;

    var pop = 0, lv = 0, prov = 0;
    for (var p = 0; p < w.P; p++) {
      if (w.map.provinces[p].country !== c) continue;
      prov++;
      pop += w.pop[0 * w.P + p] + w.pop[1 * w.P + p] + w.pop[2 * w.P + p];
      for (var g = 0; g < w.G; g++) lv += w.level[g * w.P + p];
    }

    var start = starts || { pop: pop, lv: lv, gdp: w.gdp[c], unrest: w.unrestAvg[c], prov: prov };
    var popGrowth = start.pop > 0 ? pop / start.pop - 1 : 0;
    var gdpGrowth = start.gdp > 0 ? w.gdp[c] / start.gdp - 1 : 0;
    var lvGrowth = start.lv > 0 ? lv / start.lv - 1 : 0;

    var famines = 0;
    for (var f = 0; f < C; f++) famines += w.famineCount[f];

    /* 评分：把「国力排名 / 人均财富 / 不满」折成一个 0~100 的数。
     * 刻意让不满占很大权重 —— 这个模型里唯一还有正反馈的量就是它，
     * 只堆国力而不管民怨，不该拿高分。 */
    var sRank = Math.max(0, (C - rank) / (C - 1)) * 40;
    var sWealth = Math.min(1, (w.gdp[c] / Math.max(1, pop)) / 60) * 25;
    var sCalm = Math.max(0, 1 - w.unrestAvg[c] / 0.45) * 25;
    var sGrowth = Math.min(1, Math.max(0, gdpGrowth) / 4) * 10;
    var score = Math.round(sRank + sWealth + sCalm + sGrowth);

    var title = score >= 80 ? '盛世' : score >= 60 ? '中兴' : score >= 40 ? '守成' : score >= 20 ? '勉强' : '崩坏';

    VIC.ui.showVerdict(w, {
      title: title + ' · ' + score + ' 分',
      rows: [
        ['年代', w.year + ' 年 · 一局 ' + YEARS_PER_RUN + ' 年'],
        ['国力排名', '第 ' + rank + ' / ' + C + ' 位', rank <= 2 ? 'good' : (rank >= C - 1 ? 'bad' : '')],
        ['占世界国力', (share * 100).toFixed(1) + '%', share >= 1 / C * 1.6 ? 'good' : '']
          , ['本国人口', VIC.ui.fmtPop(pop) + '（' + (popGrowth >= 0 ? '+' : '') + (popGrowth * 100).toFixed(0) + '%）'],
        ['工业规模', VIC.ui.fmtInt(lv) + ' 级（' + (lvGrowth >= 0 ? '+' : '') + (lvGrowth * 100).toFixed(0) + '%）'],
        ['国力增长', (gdpGrowth >= 0 ? '+' : '') + (gdpGrowth * 100).toFixed(0) + '%', gdpGrowth > 1 ? 'good' : ''],
        ['不安定指数', (w.unrestAvg[c] * 100).toFixed(0) + '%', w.unrestAvg[c] > 0.25 ? 'bad' : (w.unrestAvg[c] < 0.08 ? 'good' : 'warn')],
        ['国库结余', VIC.ui.fmtMoney(w.treasury[c])],
        ['累计完工工程', w.constructionDone + ' 项'],
        ['世界歉收', famines + ' 次']
      ]
    });
  }


  function refreshAll(force) {
    VIC.ui.updateTopbar(world, activeCountry);
    VIC.ui.updateMarket(world, activeCountry);
    VIC.ui.updateRanking(world, activeCountry);
    if (force) {
      if (selectedProvince >= 0) VIC.ui.showProvince(world, selectedProvince);
      else VIC.ui.showCountryOverview(world, activeCountry);
    }
  }

  function frame(now) {
    var dt = now - lastT;
    lastT = now;
    if (dt > 250) dt = 250; // 切标签页回来时别一次补几百 tick

    /* 1) 模拟 */
    if (speed > 0) {
      acc += dt;
      var interval = 1000 / TICKS_PER_SEC[speed];
      var budget = 40; // 单帧最多补 40 tick，避免卡死
      var ticked = false;
      while (acc >= interval && budget-- > 0) {
        VIC.sim.tick(world);
        acc -= interval;
        ticked = true;
        if (world.tick >= HORIZON) { endRun(); break; }   // 一局 100 年，到点结算
      }

      /* 数据类地图模式的配色随 tick 变化，这里节流重建。
       * 千万不要写成 world.tick % DATA_MODE_EVERY === 0 ——
       * world.tick 只在结算时变化，那个条件会在连续几十帧里一直为真，
       * 同一个 tick 会把整张地图反复重建。实测这让重建次数从 6/s 涨到 30/s。 */
      if (ticked && mapMode !== 'political' &&
          world.tick - lastBuildTick >= DATA_MODE_EVERY) {
        lastBuildTick = world.tick;
        renderer.invalidate();
      }
    }

    /* 2) UI（节流） */
    uiAcc += dt;
    if (uiAcc >= UI_INTERVAL) {
      uiAcc = 0;
      refreshAll(false);
      VIC.ui.updateActions(world);      // 建造按钮的等级/价格/可点状态
      VIC.ui.updateTicker(world, false);

    }

    /* 3) 地图 */
    renderer.draw();

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
