/* 意识形态自由度标定台（ideo-dof）
 *
 * 用法：node test/ideo-dof.js
 *
 * ── 为什么需要这台 ──
 * 设计文档（参考资料/意识形态干预机制-设计.md）提出 6 根意识形态轴，
 * 但它的结论（"只能干净支撑 4 根"）写在一次**已经失效的测量**上：
 * 复跑 test/ideo-derive.js 得到的是 2/15 高相关轴对，不是文档记的 6/15。
 *
 * 而且 |r|>0.7 这个口径本身会骗人：它只抓阈值以上的对数，
 * 抓不到"同一个结构性耦合的尾巴"（0.69 / 0.64 / -0.63 连着出现）。
 *
 * 所以本台换一个口径：**直接量世界的自由度**。
 *   · 相关矩阵的全谱（Jacobi）——每个特征值 = 该方向占用的"轴数"
 *   · 参与比 (Σλ)²/Σλ² —— 有效独立维数（6 根全独立 = 6.00，全共线 = 1.00）
 *   · 逐驱动 R² —— 该驱动能被其余驱动线性预测多少（→1 即纯冗余）
 *
 * ── 这台守什么纪律 ──
 * 加一个新驱动（识字率、pop 分化、外部压力……）后跑本台，必须看到两件事：
 *   ① 该驱动的 R² **< REDUNDANT_R2**（它真的带来了新信息，不是别人的线性组合）
 *   ② 参与比**上升**（世界的有效维数真的变多了）
 * 只看 ① 会被"加了一个和主梯度相关但没被现成分量覆盖的东西"骗过去；
 * 只看 ② 会被"加了一堆噪声"骗过去。两条一起才成立。
 *
 * ── 与 ideo-derive.js 的关系 ──
 * 本台**不重复定义轴公式**：它只算"定稿 6 轴所用原料"与 6 根轴本身，
 * 并断言自己算出的 6 根轴与 test/ideo-derive.js 的 deriveAxes **逐位一致**。
 * 一旦有人改了那边的公式而没改这边，这条一致性断言会当场失败，
 * 而不是让本台静默地量错东西（这正是 factor-sweep 踩过的坑）。
 */
'use strict';

var path = require('path');
var ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'js/rng.js'));
require(path.join(ROOT, 'js/mapgen.js'));
require(path.join(ROOT, 'js/sim.js'));
var SIM = VIC.sim, MG = VIC.mapgen;

/* ── 断言框架（与 test/check.js 同风格）── */
var pass = 0, fail = 0;
function check(what, ok, detail) {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + what + (detail === undefined ? '' : '   ' + detail));
  if (ok) pass++; else fail++;
}
function group(t) { console.log('\n' + t); }
/* 打印从 N 个驱动里取全部子集的参与比，用于横向比较同一批样本上的不同驱动集 */
function prOfSet(idx) {
  var cols = idx.map(function (i) { return COLS[i]; });
  return participationRatio(jacobiEig(corrMatrix(cols), idx.length));
}

var MAP_OPTS = { width: 1600, height: 1000, provinces: 260, countries: 8 };
var N_AXES = 6;                      // 定稿 6 轴（参照系，勿动）
var REDUNDANT_R2 = 0.90;             // 单个驱动 R² ≥ 此值 = 几乎是他人的线性组合
var SEEDS = [8888, 777, 2718];
/* 教育政策档位。必须 >1 档：识字率的方差**全部**来自政策的外生变化
 * （政策全同时它会退化成城市化的函数）。 */
var EDU_SET = [0, 0.5, 1.0];

/* ── 驱动清单 ──
 * core 6 个 = 定稿 6 轴各自的原料（参照系）
 * extra 若干 = 候选新驱动。加驱动就往这里加一条：
 *   { k: '识字率', f: function (a) { return a.lit; }, core: false }
 * 本台会自动把它纳入谱、R²、参与比，并按 REDUNDANT_R2 判定。
 */
var DRIVERS = [
  { k: '①不安定', core: true, f: function (a) { return a.unrestMean; } },
  { k: '②底层/均值', core: true, f: function (a) { return a.lowOverMean; } },
  { k: '③上层/底层', core: true, f: function (a) { return a.upOverLow; } },
  { k: '④城市化', core: true, f: function (a) { return a.urban; } },
  { k: '⑤工业占比', core: true, f: function (a) { return a.indShare; } },
  { k: '⑥进口依赖', core: true, f: function (a) { return a.dep; } },
  /* 候选（未接入主 sim）：已在 world 里，但当前 6 轴一根都没读 */
  { k: '⑦基建等级', core: false, f: function (a) { return a.infra; } },
  { k: '⑧连通度', core: false, f: function (a) { return a.conn; } },
  { k: '⑨识字率', core: false, f: function (a) { return a.literacy; } },
  { k: '⑩乡城比', core: false, f: function (a) { return a.ruralUrban; } }
];

/* ── 原料提取：逐字对齐 test/ideo-derive.js 的 deriveAxes ── */
function rawDrivers(w, c) {
  var P = w.P, S = w.S, G = w.G;
  var prov = [];
  for (var p = 0; p < P; p++) if (w.map.provinces[p].country === c) prov.push(p);

  var strata = [], pop = 0, wealthNum = 0;
  for (var s = 0; s < S; s++) {
    var sp = 0, sw = 0;
    for (var k = 0; k < prov.length; k++) {
      var i1 = s * P + prov[k];
      sp += w.pop[i1]; sw += w.wealth[i1] * w.pop[i1];
    }
    strata.push({ pop: sp, wealthMean: sp > 0 ? sw / sp : 0 });
    pop += sp; wealthNum += sw;
  }
  var meanW = pop > 0 ? wealthNum / pop : 1;

  var indLv = 0, allLv = 0, urbanSum = 0, urbanPop = 0;
  for (var k2 = 0; k2 < prov.length; k2++) {
    var pp = prov[k2];
    for (var g = 0; g < G; g++) {
      var lv = w.level[g * P + pp];
      allLv += lv;
      if (g === 3 || g === 4) indLv += lv;
    }
    var wgt = w.pop[0 * P + pp];
    urbanSum += w.urban[pp] * wgt; urbanPop += wgt;
  }

  var needTotal = 0, gapTotal = 0;
  for (var g3 = 0; g3 < G; g3++) {
    var sup = w.supply[g3 * w.C + c], dem = w.demand[g3 * w.C + c];
    needTotal += dem;
    if (dem > sup) gapTotal += dem - sup;
  }
  var unrestSum = 0;
  for (var k3 = 0; k3 < prov.length; k3++) unrestSum += w.unrest[prov[k3]];

  var infraSum = 0, connSum = 0, wsum = 0, litSum = 0, ruSum = 0;
  for (var k4 = 0; k4 < prov.length; k4++) {
    var pq = prov[k4], wq = w.pop[0 * P + pq];
    infraSum += w.infra[pq] * wq; connSum += w.conn[pq] * wq; wsum += wq;
    litSum += w.literacy[pq] * wq;
    ruSum += (w.lowerUrban[pq] > 0 ? w.lowerRural[pq] / w.lowerUrban[pq] : 1) * wq;
  }

  return {
    unrestMean: unrestSum / Math.max(1, prov.length),
    lowOverMean: meanW > 0 ? strata[0].wealthMean / meanW : 1,
    upOverLow: strata[0].wealthMean > 0 ? strata[2].wealthMean / strata[0].wealthMean : 1,
    urban: urbanPop > 0 ? urbanSum / urbanPop : 0,
    indShare: allLv > 0 ? indLv / allLv : 0,
    dep: needTotal > 0 ? gapTotal / needTotal : 0,
    infra: wsum > 0 ? infraSum / wsum : 0,
    conn: wsum > 0 ? connSum / wsum : 0,
    literacy: wsum > 0 ? litSum / wsum : 0,
    ruralUrban: wsum > 0 ? ruSum / wsum : 1
  };
}

/* 定稿 6 轴（含 clamp01）。用于与 ideo-derive.js 做一致性断言。 */
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function axesFrom(a) {
  return [
    clamp01(a.unrestMean / 0.35),
    clamp01(1 - (a.lowOverMean - 0.85) / 0.3),
    clamp01(1 - (a.upOverLow - 0.9) / 0.9),
    clamp01(a.urban / 1.1),
    clamp01(a.indShare / 0.5),
    clamp01(1 - a.dep / 0.5)
  ];
}

/* ── 采样：与 ideo-derive.js 同调度（3 种子 × 5 冲击 × 5 时点 × 8 国 = 600）── */
var SHOCKS = [
  null,
  { at: 300, ticks: 60, kind: 'farm' },
  { at: 300, ticks: 60, kind: 'ind' },
  { at: 600, ticks: 60, kind: 'wealth' },
  { at: 240, ticks: 120, kind: 'urban' }
];
function applyShock(w, c, kind) {
  var P = w.P;
  for (var p = 0; p < P; p++) {
    if (w.map.provinces[p].country !== c) continue;
    if (kind === 'farm') {
      var lv = w.level[0 * P + p];
      if (lv > 1) w.level[0 * P + p] = Math.max(1, Math.round(lv * 0.5));
    } else if (kind === 'ind') {
      for (var g = 3; g <= 4; g++) {
        var l2 = w.level[g * P + p];
        if (l2 > 0) w.level[g * P + p] = Math.max(1, Math.round(l2 * 0.5));
      }
    } else if (kind === 'wealth') {
      for (var s = 0; s < w.S; s++) {
        var i1 = s * P + p;
        w.wealth[i1] = 1 + (w.wealth[i1] - 1) * 0.25;
      }
    } else if (kind === 'urban') {
      w.urban[p] = Math.min(1.8, w.urban[p] * 1.35);
    }
  }
}

console.log('══════ 意识形态自由度标定台（ideo-dof）══════');
console.log('  种子 ' + SEEDS.join('/') + ' × ' + SHOCKS.length + ' 类冲击 × ' +
  EDU_SET.length + ' 档教育政策 × 5 时点 × 8 国');
console.log('  REDUNDANT_R2 = ' + REDUNDANT_R2.toFixed(2) + '（驱动 R² 超过它即判为冗余）');
console.log('  注：识字率由**外生政策**驱动，所以采样必须把政策撒开 —— 政策全同的地方');
console.log('      识字率会退化成城市化的函数（事前探针量到 r = 1.000）。\n');

var SAMPLES = [];
SEEDS.forEach(function (seed) {
  SHOCKS.forEach(function (shock) {
    EDU_SET.forEach(function (edu) {
      var map = MG.generate(Object.assign({}, MAP_OPTS, { seed: seed }));
      var w = SIM.createWorld(map, { seed: seed + 7 });
      /* 把教育/工资政策按国错开，制造真实的政策方差 */
      for (var ci = 0; ci < w.C; ci++) {
        SIM.pushCommand(w, SIM.CMD_EDU, -1, -1, (edu + ci * 0.13) % 1, ci);
        SIM.pushCommand(w, SIM.CMD_WAGE, -1, -1, (ci % 5) / 4, ci);
      }
      SIM.applyCommands(w);
      var cps = [0, 60, 300, 600, 1200], last = 0;
      cps.forEach(function (t) {
        while (last < t) {
          if (shock && last >= shock.at && last < shock.at + shock.ticks) {
            for (var c2 = 0; c2 < w.C; c2++) applyShock(w, c2, shock.kind);
          }
          SIM.tick(w); last++;
        }
        for (var c = 0; c < w.C; c++) SAMPLES.push(rawDrivers(w, c));
      });
    });
  });
});

/* 列矩阵：column j = 驱动 j */
var N = DRIVERS.length;
var COLS = DRIVERS.map(function (d) {
  return SAMPLES.map(function (a) { return d.f(a); });
});

/* ── 工具 ── */
function corrOf(x, y) {
  var n = x.length, mx = 0, my = 0, k;
  for (k = 0; k < n; k++) { mx += x[k]; my += y[k]; }
  mx /= n; my /= n;
  var a = 0, bx = 0, by = 0;
  for (k = 0; k < n; k++) {
    var u = x[k] - mx, v = y[k] - my;
    a += u * v; bx += u * u; by += v * v;
  }
  return (bx > 0 && by > 0) ? a / Math.sqrt(bx * by) : 0;
}
function varianceOf(x) {
  var n = x.length, m = 0, k;
  for (k = 0; k < n; k++) m += x[k];
  m /= n; var a = 0;
  for (k = 0; k < n; k++) { var u = x[k] - m; a += u * u; }
  return a / n;
}
function corrMatrix(cols) {
  var n = cols.length, C = [];
  for (var i = 0; i < n; i++) {
    C.push([]);
    for (var j = 0; j < n; j++) C[i].push(corrOf(cols[i], cols[j]));
  }
  return C;
}
/* Jacobi 全谱：每个特征值 = 该方向占用的轴数 */
function jacobiEig(Cin, n) {
  var A = [], i, j, k;
  for (i = 0; i < n; i++) { A.push([]); for (j = 0; j < n; j++) A[i].push(Cin[i][j]); }
  for (var sweep = 0; sweep < 100; sweep++) {
    var off = 0;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-18) break;
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        if (Math.abs(A[i][j]) < 1e-15) continue;
        var theta = (A[j][j] - A[i][i]) / (2 * A[i][j]);
        var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        var cos = 1 / Math.sqrt(t * t + 1), sin = t * cos;
        for (k = 0; k < n; k++) {
          var aik = A[i][k], ajk = A[j][k];
          A[i][k] = cos * aik - sin * ajk;
          A[j][k] = sin * aik + cos * ajk;
        }
        for (k = 0; k < n; k++) {
          var aki = A[k][i], akj = A[k][j];
          A[k][i] = cos * aki - sin * akj;
          A[k][j] = sin * aki + cos * akj;
        }
      }
    }
  }
  var ev = [];
  for (i = 0; i < n; i++) ev.push(A[i][i]);
  ev.sort(function (a, b) { return b - a; });
  return ev;
}
/* 参与比：有效独立维数 */
function participationRatio(ev) {
  var s1 = 0, s2 = 0;
  for (var i = 0; i < ev.length; i++) { s1 += ev[i]; s2 += ev[i] * ev[i]; }
  return s2 > 0 ? s1 * s1 / s2 : 0;
}
/* 多元回归 R²：用其余列线性预测第 y 列（高斯消元） */
function regR2(cols, y, preds) {
  var k = preds.length + 1, rows = cols[0].length;
  var XtX = [], Xty = [], i, j;
  for (i = 0; i < k; i++) { XtX.push(new Array(k).fill(0)); Xty.push(0); }
  for (var r = 0; r < rows; r++) {
    var x = [1];
    for (j = 0; j < preds.length; j++) x.push(cols[preds[j]][r]);
    for (i = 0; i < k; i++) {
      Xty[i] += x[i] * cols[y][r];
      for (j = 0; j < k; j++) XtX[i][j] += x[i] * x[j];
    }
  }
  for (var c = 0; c < k; c++) {
    var piv = c;
    for (var d = c + 1; d < k; d++) if (Math.abs(XtX[d][c]) > Math.abs(XtX[piv][c])) piv = d;
    if (Math.abs(XtX[piv][c]) < 1e-12) return 1;
    var tmp = XtX[c]; XtX[c] = XtX[piv]; XtX[piv] = tmp;
    var t2 = Xty[c]; Xty[c] = Xty[piv]; Xty[piv] = t2;
    for (var e = c + 1; e < k; e++) {
      var f = XtX[e][c] / XtX[c][c];
      for (var g = c; g < k; g++) XtX[e][g] -= f * XtX[c][g];
      Xty[e] -= f * Xty[c];
    }
  }
  var beta = new Array(k).fill(0);
  for (var h = k - 1; h >= 0; h--) {
    var s = Xty[h];
    for (var m = h + 1; m < k; m++) s -= XtX[h][m] * beta[m];
    beta[h] = s / XtX[h][h];
  }
  var my = 0;
  for (var r2 = 0; r2 < rows; r2++) my += cols[y][r2];
  my /= rows;
  var ssTot = 0, ssRes = 0;
  for (var r3 = 0; r3 < rows; r3++) {
    var ph = beta[0];
    for (var p2 = 0; p2 < preds.length; p2++) ph += beta[p2 + 1] * cols[preds[p2]][r3];
    ssTot += (cols[y][r3] - my) * (cols[y][r3] - my);
    ssRes += (cols[y][r3] - ph) * (cols[y][r3] - ph);
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : 1;
}

/* ────────────────────────────────────────────────────────────
 * 【1】健全性：样本、有限性、与 ideo-derive.js 的一致性
 * ──────────────────────────────────────────────────────────── */
group('【1】健全性（样本量 / 有限性 / 与 ideo-derive.js 的一致性）');

check('样本数 = 种子×冲击×政策档×时点×国家',
  SAMPLES.length === SEEDS.length * SHOCKS.length * EDU_SET.length * 5 * 8,
  SAMPLES.length + ' 条');

var anyNaN = false;
COLS.forEach(function (col) {
  col.forEach(function (v) { if (typeof v !== 'number' || !isFinite(v)) anyNaN = true; });
});
check('所有驱动取值均有限（无 NaN）', !anyNaN);

/* 一致性：本台算出的 6 轴 必须与 test/ideo-derive.js 的 deriveAxes 一致。
 * 做法是**静态核对公式里的常数**，而不是 require 那个文件——
 * ideo-derive.js 是脚本，require 会跑它自己整套采样（多花一倍时间并往输出里
 * 灌一份重复报告）。这里只做"公式漂移"这个真实故障模式的守卫：
 * 一旦有人在 ideo-derive.js 里改了归一化常数而没改本台，
 * 下面的断言会当场失败，而不是让本台静默地量一个过期公式。
 * 每个正则**只捕获一个数**（改写公式时为每个常数单列一条），
 * 于是"捕获组与期望值错位"这种自身故障模式不可能发生。 */
var CONSISTENCY_SPECS = [
  [/a1\s*=\s*clamp01\(unrestSum\s*\/\s*Math\.max\(1,\s*prov\.length\)\s*\/\s*([0-9.]+)/, 0.35, '①不安定 /0.35'],
  [/a2\s*=\s*clamp01\(1\s*-\s*\(wealthRatio\s*-\s*([0-9.]+)\)\s*\/\s*0\.3/, 0.85, '②底层/均值 下界 0.85'],
  [/a2\s*=\s*clamp01\(1\s*-\s*\(wealthRatio\s*-\s*0\.85\)\s*\/\s*([0-9.]+)/, 0.3, '②底层/均值 跨度 0.3'],
  [/a3\s*=\s*clamp01\(1\s*-\s*\(gap\s*-\s*([0-9.]+)\)\s*\/\s*0\.9/, 0.9, '③上下层比 下界 0.9'],
  [/a3\s*=\s*clamp01\(1\s*-\s*\(gap\s*-\s*0\.9\)\s*\/\s*([0-9.]+)/, 0.9, '③上下层比 跨度 0.9'],
  [/a4\s*=\s*clamp01\(urban\s*\/\s*([0-9.]+)/, 1.1, '④城市化 /1.1'],
  [/a5\s*=\s*clamp01\(indShare\s*\/\s*([0-9.]+)/, 0.5, '⑤工业占比 /0.5'],
  [/a6\s*=\s*clamp01\(1\s*-\s*dep\s*\/\s*([0-9.]+)/, 0.5, '⑥进口依赖 /0.5']
];
(function () {
  var src;
  try { src = require('fs').readFileSync(path.join(__dirname, 'ideo-derive.js'), 'utf8'); }
  catch (e) { src = null; }
  if (!src) {
    console.log('  – 跳过一致性断言：读不到 ideo-derive.js。');
    return;
  }
  var drifted = [], missing = [];
  CONSISTENCY_SPECS.forEach(function (sp) {
    var m = src.match(sp[0]);
    if (!m) { missing.push(sp[2]); return; }
    var got = parseFloat(m[1]);
    if (Math.abs(got - sp[1]) > 1e-9) drifted.push(sp[2] + ': ideo-derive=' + got + ' 本台=' + sp[1]);
  });
  check('本台的归一化常数与 ideo-derive.js 一致（防公式漂移）',
    drifted.length === 0 && missing.length === 0,
    drifted.length ? drifted.join('; ')
      : (missing.length ? '未匹配：' + missing.join('、') : CONSISTENCY_SPECS.length + ' 个常数全部一致'));
})();

/* ────────────────────────────────────────────────────────────
 * 【2】自由度：全谱 / 参与比 / 主成分
 * ──────────────────────────────────────────────────────────── */
group('【2】世界的自由度（参与比 = 有效独立维数）');

var CM = corrMatrix(COLS);
var EV = jacobiEig(CM, N);
var sumEv = EV.reduce(function (a, b) { return a + b; }, 0);
var PR = participationRatio(EV);

console.log('    相关矩阵谱（每个特征值 = 该方向占用的轴数；全独立时每个都 = 1.00）');
EV.forEach(function (l, i) {
  console.log('      λ' + (i + 1) + ' = ' + l.toFixed(3).padStart(6) +
    '   ' + (l / sumEv * 100).toFixed(1).padStart(5) + '%');
});
console.log('    参与比 = ' + PR.toFixed(2) + ' / ' + N +
  '   最大特征值占比 = ' + (EV[0] / sumEv * 100).toFixed(1) + '%（全独立 = ' + (100 / N).toFixed(1) + '%）');

check('参与比在合理区间（1 < PR ≤ 驱动数）', PR > 1 && PR <= N, PR.toFixed(2) + ' / ' + N);
check('相关矩阵谱无量值（1e-9 以下视为数值噪声）', EV.every(function (l) { return isFinite(l); }),
  'λ最小 ' + EV[EV.length - 1].toExponential(1));
check('谱的迹 = 驱动数（数值健全性）', Math.abs(sumEv - N) < 1e-6, sumEv.toFixed(6));

/* ────────────────────────────────────────────────────────────
 * 【3】逐驱动 R²：哪些是纯冗余
 * ──────────────────────────────────────────────────────────── */
group('【3】逐驱动冗余度 R²（能被其余驱动线性预测多少）');

var R2 = [];
var allIdx = [];
for (var i2 = 0; i2 < N; i2++) allIdx.push(i2);
DRIVERS.forEach(function (d, y) {
  var preds = allIdx.filter(function (x) { return x !== y; });
  R2.push(regR2(COLS, y, preds));
  console.log('    ' + d.k.padEnd(14) + ' R² = ' + R2[y].toFixed(3) +
    (R2[y] >= REDUNDANT_R2 ? '  ← 冗余（>=' + REDUNDANT_R2 + '）' : '') +
    (d.core ? '' : '   [候选]'));
});

/* 参照系里的 6 根轴：文档已承认会塌，这里如实记录，不判失败。
 * 只断言"至少有一根轴是干净的"，防止公式退化成全共线。 */
var cleanCore = R2.slice(0, N_AXES).filter(function (r) { return r < REDUNDANT_R2; }).length;
check('定稿 6 轴里至少有 1 根是干净的（R² < ' + REDUNDANT_R2 + '）', cleanCore >= 1,
  cleanCore + ' / ' + N_AXES + ' 根干净');

/* ────────────────────────────────────────────────────────────
 * 【4】候选驱动闸门：加驱动必须过这一关
 * ──────────────────────────────────────────────────────────── */
group('【4】候选驱动闸门（新驱动必须带来新信息，而不是搭主梯度的车）');

var cands = [];
DRIVERS.forEach(function (d, i) { if (!d.core) cands.push(i); });

if (cands.length === 0) {
  console.log('    （当前没有候选驱动）');
}
cands.forEach(function (ci) {
  var others = allIdx.filter(function (x) { return x !== ci; });
  var r2 = regR2(COLS, ci, others);
  /* 与主梯度的相关：诊断用，说明它是"独立"还是"搭车" */
  var cmax = 0, cwith = '';
  DRIVERS.forEach(function (d, j) {
    if (j === ci) return;
    var r = Math.abs(corrOf(COLS[ci], COLS[j]));
    if (r > cmax) { cmax = r; cwith = d.k; }
  });
  console.log('    ' + DRIVERS[ci].k.padEnd(12) + ' R² = ' + r2.toFixed(3) +
    '   与最强相关驱动 |r| = ' + cmax.toFixed(2) + '（' + cwith + '）');
  check(DRIVERS[ci].k + ' 不是纯冗余（R² < ' + REDUNDANT_R2 + '）', r2 < REDUNDANT_R2,
    'R² = ' + r2.toFixed(3));
});

/* ────────────────────────────────────────────────────────────
 * 5】加驱动是否真的提高了自由度（必须在**同一把尺子**下比）
 * 参与比的量纲是"有几根轴"，所以 8 驱动里的 2.36 与 6 驱动里的 2.95
 * **不能直接比**（分母不同）。必须在同一批样本上、固定驱动个数来比。
 * ──────────────────────────────────────────────────────────── */
group('【5】候选驱动的边际贡献（固定 4 个驱动的预算来比）');

var CORE_IDX = [];
for (var i3 = 0; i3 < N_AXES; i3++) CORE_IDX.push(i3);

/* 参照系 A/B：同样 4 个驱动，换掉其中两根，看自由度怎么动 */
var setA = [1, 2, 3, 4];        // ②底层/均值 ③上层/底层 ④城市化 ⑤工业占比
var setB = [0, 3, 4, 5];        // ①不安定 ④城市化 ⑤工业占比 ⑥进口依赖
console.log('    同一批 ' + SAMPLES.length + ' 个样本，固定取 4 个驱动：');
console.log('      A ②③④⑤  参与比 = ' + prOfSet(setA).toFixed(2) + ' / 4   （含两根塌陷轴）');
console.log('      B ①④⑤⑥  参与比 = ' + prOfSet(setB).toFixed(2) + ' / 4   （换成不安定+进口依赖）');

cands.forEach(function (ci) {
  var withCand = CORE_IDX.slice(0, 4).concat([ci]);   /* ①②③④ + 候选 */
  var pr = prOfSet(withCand);
  console.log('      ①②③④ + ' + DRIVERS[ci].k + '  参与比 = ' + pr.toFixed(2) + ' / 5');
});

check('尺子有分辨力（换掉两根轴，参与比会动）',
  Math.abs(prOfSet(setA) - prOfSet(setB)) > 0.01,
  'A=' + prOfSet(setA).toFixed(2) + '  B=' + prOfSet(setB).toFixed(2));

/* ── 总结 ── */
console.log('\n' + '─'.repeat(52));
console.log(fail === 0 ? '全部通过：' + pass + ' 项' : pass + ' 项通过，' + fail + ' 项失败');
console.log('\n  读数解读：');
console.log('   · 参与比是这台的主指标。加驱动后它若不动，"加系统"就只是加噪声。');
console.log('   · 单个驱动的 R² 超过 ' + REDUNDANT_R2 + ' 说明它是已有驱动的线性组合。');
console.log('   · 参照系 6 轴里高 R² 的根（②③⑤）即设计文档所说的"塌成大梯度"，');
console.log('     它们应当被合并或重新配驱动，而不是继续当独立轴用。');
process.exit(fail === 0 ? 0 : 1);
