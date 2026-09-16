/* 蒸汽与账本 — 界面层
 *
 * 性能纪律（这是这类游戏真正会翻车的地方）：
 *   - 市场面板 5 行固定 → DOM 只建一次，之后只改 textContent / style
 *   - 排行面板顺序会变 → 重建，但只在 10fps 节流下进行，不是每个 tick
 *   - 地图只在 dirty 时重绘
 */
(function (root) {
  'use strict';
  var VIC = root.VIC || (root.VIC = {});
  var SIM = VIC.sim;

  function $(id) { return document.getElementById(id); }

  function fmtMoney(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return v.toFixed(0);
  }
  function fmtPop(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(0) + 'k';
    return v.toFixed(0);
  }
  function fmtInt(v) { return Math.round(v).toLocaleString('en-US'); }
  function pct(v) { return (v * 100).toFixed(0) + '%'; }

  function goodColor(hue) { return 'hsl(' + hue + ' 58% 56%)'; }

  var el = {};
  var marketRows = [];   // 缓存的 5 行市场 DOM
  var hooks = {};
  var tickerIdx = 0, tickerAt = 0;

  /* ═════════════ 初始化 ═════════════ */

  function init(world, callbacks) {
    hooks = callbacks || {};
    el.date = $('date');
    el.clock = $('clock');
    el.flag = $('country-flag');
    el.countryName = $('country-name');
    el.countrySub = $('country-sub');
    el.treasury = $('stat-treasury');
    el.pop = $('stat-pop');
    el.gdp = $('stat-gdp');
    el.unrest = $('stat-unrest');
    el.selName = $('sel-name');
    el.selSub = $('sel-sub');
    el.selBody = $('sel-body');
    el.marketBody = $('market-body');
    el.marketSub = $('market-sub');
    el.rankingBody = $('ranking-body');
    el.tooltip = $('tooltip');
    el.tickerText = $('ticker-text');
    el.hintProvinces = $('hint-provinces');
    el.hintCountries = $('hint-countries');
    el.actionBody = $('action-body');
    el.verdict = $('verdict');
    el.verdictTitle = $('verdict-title');
    el.verdictBody = $('verdict-body');
    el.verdictAgain = $('verdict-again');

    if (el.hintProvinces) el.hintProvinces.textContent = world.P;
    if (el.hintCountries) el.hintCountries.textContent = world.C;
    setActionProvince(-1);

    if (el.verdictAgain) {
      el.verdictAgain.addEventListener('click', function () {
        if (hooks.onRestart) hooks.onRestart();
      });
    }


    // 时钟按钮
    el.clock.addEventListener('click', function (e) {
      var b = e.target.closest('.spd');
      if (!b) return;
      if (hooks.onSpeed) hooks.onSpeed(+b.dataset.speed);
    });

    // 地图模式
    $('mapmodes').addEventListener('click', function (e) {
      var b = e.target.closest('.mode');
      if (!b) return;
      if (b.id === 'reset-view') {
        if (hooks.onResetView) hooks.onResetView();
        return;
      }
      setActiveMode(b.dataset.mode);
      if (hooks.onMode) hooks.onMode(b.dataset.mode);
    });

    /* 面板里的按钮全用事件委托，不在 HTML 里写 onclick（便于将来加 CSP，也少一层字符串拼接） */
    el.selBody.addEventListener('click', function (e) {
      var rb = e.target.closest('#btn-relief');
      if (rb && hooks.onRelief) hooks.onRelief();
    });

    buildMarketRows(world);

  }

  function setActiveMode(mode) {
    var btns = document.querySelectorAll('#mapmodes .mode[data-mode]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.mode === mode);
    }
  }

  function setSpeed(speed) {
    var btns = el.clock.querySelectorAll('.spd');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', +btns[i].dataset.speed === speed);
    }
  }

  /* ═════════════ 顶栏 ═════════════ */

  var MONTHS = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];

  function updateTopbar(world, countryId) {
    el.date.textContent = world.year + ' 年 ' + MONTHS[world.month];
    var c = world.map.countries[countryId];
    if (!c) return;
    el.flag.style.background =
      'linear-gradient(135deg, ' + c.color + ' 0%, ' + c.color + ' 48%, ' + c.accent + ' 52%, ' + c.accent + ' 100%)';
    el.countryName.textContent = c.name;
    el.countrySub.textContent = c.tag + ' · 第 ' + (world.tick) + ' 个月';
    el.treasury.textContent = fmtMoney(world.treasury[countryId]);
    el.pop.textContent = fmtPop(world.popTotal[countryId]);
    el.gdp.textContent = fmtMoney(world.gdp[countryId]);
    var u = world.unrestAvg[countryId];
    el.unrest.textContent = pct(u);
    el.unrest.className = u > 0.35 ? 'bad' : (u > 0.18 ? 'warn' : 'good');
  }

  /* ═════════════ 市场（缓存节点） ═════════════ */

  function buildMarketRows(world) {
    el.marketBody.innerHTML = '';
    marketRows = [];
    for (var g = 0; g < world.G; g++) {
      var good = SIM.GOODS[g];
      var row = document.createElement('div');
      row.className = 'row';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';

      var top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;gap:8px';

      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = goodColor(good.hue);
      chip.style.color = goodColor(good.hue);

      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = good.name;
      var sub = document.createElement('small');
      nm.appendChild(sub);

      var num = document.createElement('span');
      num.className = 'num';

      top.appendChild(chip); top.appendChild(nm); top.appendChild(num);

      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      var mid = document.createElement('i');
      mid.className = 'mid';
      bar.appendChild(fill); bar.appendChild(mid);

      row.appendChild(top); row.appendChild(bar);
      el.marketBody.appendChild(row);
      marketRows.push({ sub: sub, num: num, fill: fill, nm: nm });
    }
  }

  function updateMarket(world, countryId) {
    var rows = SIM.marketRows(world, countryId);
    for (var g = 0; g < rows.length; g++) {
      var r = rows[g], dom = marketRows[g];
      if (!dom) continue;
      dom.num.textContent = r.price.toFixed(1);
      // 高于基准 → 消费者吃亏（红）；低于基准 → 生产者吃亏（蓝）
      var dev = r.rel - 1;
      var cls = dev > 0.18 ? 'bad' : (dev < -0.18 ? 'gold' : 'dim');
      dom.num.className = 'num ' + cls;
      dom.sub.textContent = '供 ' + fmtInt(r.supply) + ' · 需 ' + fmtInt(r.demand) +
        ' · ' + (r.balance >= 0 ? '盈余 ' : '缺口 ') + fmtInt(Math.abs(r.balance));
      var w = Math.max(0, Math.min(1, r.rel / 2)) * 100;
      dom.fill.style.width = w + '%';
      dom.fill.style.background = dev > 0.18 ? 'var(--bad)' : (dev < -0.18 ? '#5f8fb0' : 'var(--gold-dim)');
    }
  }

  /* ═════════════ 排行 ═════════════ */

  function updateRanking(world, activeCountry) {
    var rows = SIM.countryRows(world);
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var d = r.gdpDelta;
      var arrow = d > 1 ? '▲' : (d < -1 ? '▼' : '·');
      var dcls = d > 1 ? 'good' : (d < -1 ? 'bad' : 'dim');
      html += '<div class="rank' + (r.id === activeCountry ? ' sel' : '') + '" data-c="' + r.id + '">' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="swatch" style="background:' + r.color + '"></span>' +
        '<span class="rname">' + r.name +
          '<small>' + r.tag + ' · ' + fmtPop(r.pop) + ' 人 · 不安定 ' + pct(r.unrest) + '</small>' +
        '</span>' +
        '<span class="rval">' + fmtMoney(r.gdp) +
          '<small class="' + dcls + '">' + arrow + ' ' + fmtMoney(Math.abs(d)) + '</small>' +
        '</span>' +
      '</div>';
    }
    el.rankingBody.innerHTML = html;
  }

  function bindRankingClicks(handler) {
    el.rankingBody.onclick = function (e) {
      var row = e.target.closest('.rank');
      if (!row) return;
      handler(+row.dataset.c);
    };
  }

  /* ═════════════ 省份详情 ═════════════ */

  function showCountryOverview(world, countryId) {
    var c = world.map.countries[countryId];
    var rows = SIM.countryRows(world);
    var rank = 1;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === countryId) rank = i + 1;

    // 本国各商品产出占比
    var prod = [0, 0, 0, 0, 0];
    var total = 0, levelTotal = 0;
    for (var p = 0; p < world.P; p++) {
      if (world.map.provinces[p].country !== countryId) continue;
      for (var g = 0; g < world.G; g++) {
        prod[g] += world.output[g * world.P + p];
        total += world.output[g * world.P + p];
        levelTotal += world.level[g * world.P + p];
      }
    }

    var html = '<div class="section-title">国家概览</div>' +
      '<div class="kv"><span>国力排名</span><b>第 ' + rank + ' / ' + world.C + ' 位</b></div>' +
      '<div class="kv"><span>总人口</span><b>' + fmtPop(world.popTotal[countryId]) + '</b></div>' +
      '<div class="kv"><span>国库</span><b>' + fmtMoney(world.treasury[countryId]) + '</b></div>' +
      '<div class="kv"><span>不安定指数</span><b class="' +
        (world.unrestAvg[countryId] > 0.3 ? 'bad' : '') + '">' + pct(world.unrestAvg[countryId]) + '</b></div>' +
      '<div class="kv"><span>建筑总级数</span><b>' + fmtInt(levelTotal) + '</b></div>' +
      '<div class="section-title">产出结构</div>';

    for (var g2 = 0; g2 < world.G; g2++) {
      var share = total > 0 ? prod[g2] / total : 0;
      html += '<div class="row"><span class="chip" style="background:' + goodColor(SIM.GOODS[g2].hue) +
        ';color:' + goodColor(SIM.GOODS[g2].hue) + '"></span>' +
        '<span class="nm">' + SIM.GOODS[g2].name + '</span>' +
        '<span class="num">' + pct(share) + '</span></div>';
    }
    /* 修 bug：这里以前直接用 innerHTML 覆盖整个 sel-body，把 index.html 里那对
     * <b id="hint-provinces">/<b id="hint-countries"> 从 DOM 里连根移除，
     * 于是 init() 写好的省份/国家数永远显示成初始的「—」。现在国家概览自己也报这两个数字。 */
    html += '<div class="hint" style="margin-top:12px">这片大陆上有 <b id="hint-provinces">' + world.P +
      '</b> 个省份、<b id="hint-countries">' + world.C +
      '</b> 个国家。<br>在地图上点击任意省份，查看它的阶层账本。</div>';

    /* 赈灾：全国性的 1 位决策。花钱压住最困难省份的不满，但赈灾只是托底，
     * 不会让人变富（给多了会推高物价，反而拖垮人口 —— 见 sim.js 里的注释）。 */
    var reliefOn = world.reliefOn[countryId];
    var needy = 0, bill = 0;
    for (var pr = 0; pr < world.P; pr++) {
      if (world.map.provinces[pr].country !== countryId) continue;
      if (world.unrest[pr] > 0.22 || world.ratio[0 * world.P + pr] < 0.90 ||
          world.wealth[0 * world.P + pr] < 0.55) needy++;
    }
    bill = needy * SIM.RELIEF_COST;
    html += '<div class="section-title">赈灾</div>' +
      '<button class="abtn wide' + (reliefOn ? ' on' : '') + '" id="btn-relief">' +
      (reliefOn ? '赈灾进行中' : '开赈灾') + '</button>' +
      '<div class="anote">' + (needy > 0
        ? needy + ' 个省份需要赈济，每月 ' + fmtMoney(bill) + '，为期 ' + SIM.RELIEF_MONTHS + ' 个月。'
        : '当前没有省份需要赈济。') + '</div>';

    el.selName.textContent = c.name;
    el.selSub.innerHTML = '<span class="tagpill">' + c.tag + '</span>';
    el.selBody.innerHTML = html;
    setActionProvince(-1);       // 看国家时收起建造按钮


  }

  function showProvince(world, p) {
    var prov = world.map.provinces[p];
    var d = SIM.provinceRows(world, p);
    var c = world.map.countries[prov.country];

    var html = '';

    // 阶层
    html += '<div class="section-title">阶层</div>';
    for (var s = 0; s < d.pop.length; s++) {
      var st = d.pop[s];
      var ratioCls = st.ratio >= 1.05 ? 'good' : (st.ratio >= 0.95 ? 'dim' : 'bad');
      html += '<div class="stratum">' +
        '<div class="stratum-top">' +
          '<span class="sn" style="color:' + st.color + '">' + st.name + '</span>' +
          '<span class="sv dim">' + fmtPop(st.count) + ' 人</span>' +
          '<span class="sv ' + ratioCls + '">收支 ' + pct(st.ratio) + '</span>' +
        '</div>' +
        '<div class="hbar">' +
          '<i style="width:' + Math.max(0, Math.min(100, st.wealth / 2.6 * 100)) + '%;background:' +
            st.color + '"></i>' +
        '</div>' +
        '<div class="stratum-top" style="margin-top:3px">' +
          '<span class="sv dim" style="flex:1 1 auto">财富指数 ' + st.wealth.toFixed(2) + '</span>' +
          '<span class="sv dim">收入 ' + fmtMoney(st.income) + ' / 支出 ' + fmtMoney(st.cost) + '</span>' +
        '</div>' +
      '</div>';
    }

    // 建筑
    html += '<div class="section-title">产业</div>';
    for (var g = 0; g < d.buildings.length; g++) {
      var b = d.buildings[g];
      var pips = '';
      for (var k = 0; k < 10; k++) {
        pips += '<i class="' + (k < Math.round(b.level / 14 * 10) ? 'on' : '') + '"></i>';
      }
      html += '<div class="building">' +
        '<span class="bl">' + b.name + '</span>' +
        '<span class="pips">' + pips + '</span>' +
        '<span class="num" style="min-width:auto">' + b.level + ' 级</span>' +
      '</div>';
    }

    // 状态
    html += '<div class="section-title">状况</div>' +
      '<div class="kv"><span>不安定</span><b class="' +
        (d.unrest > 0.35 ? 'bad' : (d.unrest > 0.15 ? 'warn' : 'good')) + '">' + pct(d.unrest) + '</b></div>' +
      '<div class="kv"><span>平均财富</span><b>' + d.avgWealth.toFixed(2) + '</b></div>' +
      '<div class="kv"><span>在建投资</span><b>' + fmtMoney(d.invest) + '</b></div>' +
      '<div class="kv"><span>陆地占比</span><b>' + pct(prov.landFrac) + '</b></div>';

    el.selName.textContent = prov.name;
    el.selSub.innerHTML = c.name + ' <span class="tagpill">' + c.tag + '</span>';
    el.selBody.innerHTML = html;
    setActionProvince(p);        // 选中省份时才亮出建造按钮
  }


  function resetPanel(world) {
    el.selName.textContent = '选择一个省份';
    el.selSub.textContent = '点击地图上的任意省份查看它的账本';
    el.selBody.innerHTML = '<p class="hint">这片大陆上有 <b>' + world.P +
      '</b> 个省份、<b>' + world.C + '</b> 个国家。<br>拖动平移，滚轮缩放，点击省份查看详情。</p>';
  }

  /* ═════════════ 悬浮提示 ═════════════ */

  function showTooltip(world, p, clientX, clientY) {
    var prov = world.map.provinces[p];
    var c = world.map.countries[prov.country];
    var pop = world.pop[0 * world.P + p] + world.pop[1 * world.P + p] + world.pop[2 * world.P + p];
    var lv = 0;
    for (var g = 0; g < world.G; g++) lv += world.level[g * world.P + p];

    el.tooltip.innerHTML =
      '<div class="tt-name">' + prov.name + '</div>' +
      '<div class="tt-country">' + c.name + '</div>' +
      '<div class="tt-kv"><span class="dim">人口</span><b>' + fmtPop(pop) + '</b></div>' +
      '<div class="tt-kv"><span class="dim">建筑</span><b>' + lv + ' 级</b></div>' +
      '<div class="tt-kv"><span class="dim">不安定</span><b class="' +
        (world.unrest[p] > 0.35 ? 'bad' : (world.unrest[p] > 0.15 ? 'warn' : 'good')) + '">' +
        pct(world.unrest[p]) + '</b></div>' +
      '<div class="tt-kv"><span class="dim">底层收支</span><b class="' +
        (world.ratio[0 * world.P + p] >= 0.95 ? 'good' : 'bad') + '">' +
        pct(world.ratio[0 * world.P + p]) + '</b></div>';

    el.tooltip.classList.remove('hidden');
    var r = el.tooltip.getBoundingClientRect();
    var x = clientX + 16, y = clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = clientY - r.height - 14;
    el.tooltip.style.left = x + 'px';
    el.tooltip.style.top = y + 'px';
  }

  function hideTooltip() { el.tooltip.classList.add('hidden'); }

  /* ═════════════ 大事记 ═════════════ */

  function updateTicker(world, force) {
    if (!world.events.length) return;
    var now = performance.now();
    if (!force && now - tickerAt < 5200) return;
    tickerAt = now;
    var e = world.events[tickerIdx % world.events.length];
    tickerIdx++;
    el.tickerText.textContent = e.text;
    el.tickerText.className = e.kind === 'bad' ? 'bad' : (e.kind === 'good' ? 'good' : 'dim');
  }

  /* ═════════════ 建造面板（玩家操作的主界面） ═════════════
   * 只往 sim 的环形队列里塞命令，绝不直接改世界状态 —— 这条纪律保证了
   * 「浏览器里点一下」和「test/tension.js 里跑策略」走的是同一条路。 */

  var actionBtns = [];          // 缓存 5 个商品按钮，每 tick 只改 textContent / disabled
  var boundProvince = -1;

  function buildActions() {
    el.actionBody.innerHTML = '';
    actionBtns = [];

    var title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = '建造';
    el.actionBody.appendChild(title);

    var head = document.createElement('div');
    head.className = 'anote';
    head.textContent = '用国库在选中省份开工。工期 6 个月，完工后才增产。';
    el.actionBody.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'btns';
    for (var g = 0; g < SIM.GOODS.length; g++) {
      var b = document.createElement('button');
      b.className = 'abtn';
      b.dataset.good = g;
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = goodColor(SIM.GOODS[g].hue);
      chip.style.color = goodColor(SIM.GOODS[g].hue);
      var nm = document.createElement('span');
      nm.className = 'an';
      nm.textContent = SIM.BUILDINGS[g].name;
      var lv = document.createElement('span');
      lv.className = 'al';
      var cost = document.createElement('span');
      cost.className = 'ac';
      b.appendChild(chip); b.appendChild(nm); b.appendChild(lv); b.appendChild(cost);
      wrap.appendChild(b);
      actionBtns.push({ btn: b, good: g, lv: lv, cost: cost });
    }
    el.actionBody.appendChild(wrap);

    var prog = document.createElement('div');
    prog.className = 'abuild';
    el.actionBody.appendChild(prog);
    el.actionProg = prog;

    wrap.addEventListener('click', function (e) {
      var b = e.target.closest('button.abtn');
      if (!b || b.disabled) return;
      if (hooks.onBuild && boundProvince >= 0) hooks.onBuild(boundProvince, +b.dataset.good);
    });
  }

  /* 只在选中省份时显示建造按钮；选国家时这个面板让位给国家概览里的赈灾开关 */
  function setActionProvince(p) {
    boundProvince = p;
    if (!el.actionBody) return;
    if (p < 0) {
      el.actionBody.innerHTML = '';
      el.actionBody.style.display = 'none';
      actionBtns = [];
      return;
    }
    if (!actionBtns.length) buildActions();
    el.actionBody.style.display = '';
  }

  function updateActions(world) {
    if (!el.actionBody || boundProvince < 0 || !actionBtns.length) return;
    var c = world.map.provinces[boundProvince].country;
    var treasury = world.treasury[c];
    var busy = world.building[boundProvince] > 0;

    for (var i = 0; i < actionBtns.length; i++) {
      var a = actionBtns[i];
      var idx = a.good * world.P + boundProvince;
      var lv = world.level[idx];
      var cap = world.levelCap[idx];
      var cost = SIM.buildCost(lv);
      // 天花板顶住时显示"到顶"，而不是继续显示 14 —— 玩家要知道为什么点不动
      var maxedByCap = lv + 1 > cap;
      a.lv.textContent = maxedByCap
        ? lv + ' 级 · 地理上限'
        : lv + ' / ' + Math.min(14, Math.floor(cap)) + ' 级';
      a.cost.textContent = maxedByCap ? '—' : fmtMoney(cost);
      a.btn.disabled = busy || lv >= 14 || maxedByCap || treasury < cost;
    }

    if (busy) {
      var g = world.buildGood[boundProvince];
      el.actionProg.textContent = '在建：' + SIM.BUILDINGS[g].name +
        '（还需 ' + world.buildLeft[boundProvince] + ' 个月）';
    } else {
      el.actionProg.textContent = '国库可用 ' + fmtMoney(treasury);
    }
  }

  /* ═════════════ 百年结算 ═════════════ */

  function showVerdict(world, res) {
    el.verdictTitle.textContent = res.title;
    var rows = '';
    res.rows.forEach(function (r) {
      rows += '<div class="kv"><span>' + r[0] + '</span><b class="' +
        (r[2] || '') + '">' + r[1] + '</b></div>';
    });
    el.verdictBody.innerHTML = rows;
    el.verdict.classList.remove('hidden');
  }

  function hideVerdict() { el.verdict.classList.add('hidden'); }

  VIC.ui = {

    init: init,
    updateTopbar: updateTopbar,
    updateMarket: updateMarket,
    updateRanking: updateRanking,
    bindRankingClicks: bindRankingClicks,
    showProvince: showProvince,
    showCountryOverview: showCountryOverview,
    resetPanel: resetPanel,
    showTooltip: showTooltip,
    hideTooltip: hideTooltip,
    updateTicker: updateTicker,
    setSpeed: setSpeed,
    setActiveMode: setActiveMode,
    fmtMoney: fmtMoney,
    fmtPop: fmtPop,
    fmtInt: fmtInt,

    updateActions: updateActions,
    setActionProvince: setActionProvince,
    showVerdict: showVerdict,
    hideVerdict: hideVerdict

  };
})(typeof window !== 'undefined' ? window : globalThis);
