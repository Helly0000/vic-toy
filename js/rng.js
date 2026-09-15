/* 蒸汽与账本 — 随机数与噪声
 * 经典 script（非 module），因此 file:// 直接打开也能工作。
 * 同时兼容 node，方便脱离浏览器单测模拟层。
 */
(function (root) {
  'use strict';
  var VIC = root.VIC || (root.VIC = {});

  /* mulberry32：小而快的确定性 PRNG */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 二维 value noise，size 必须是 2 的幂（用于位运算取模环绕） */
  function makeNoise(rng, size) {
    var g = new Float32Array(size * size);
    for (var i = 0; i < g.length; i++) g[i] = rng();
    var M = size - 1;
    return function (x, y) {
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var fx = x - x0, fy = y - y0;
      var sx = fx * fx * (3 - 2 * fx);
      var sy = fy * fy * (3 - 2 * fy);
      var X0 = x0 & M, Y0 = y0 & M, X1 = (x0 + 1) & M, Y1 = (y0 + 1) & M;
      var r0 = Y0 * size, r1 = Y1 * size;
      var a = g[r0 + X0], b = g[r0 + X1], c = g[r1 + X0], d = g[r1 + X1];
      var top = a + (b - a) * sx;
      var bot = c + (d - c) * sx;
      return top + (bot - top) * sy;
    };
  }

  /* 分形叠加 */
  function fbm(noise, x, y, oct, lac, gain) {
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var o = 0; o < oct; o++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  VIC.rng = {
    makeRng: makeRng,
    makeNoise: makeNoise,
    fbm: fbm,
    clamp: clamp
  };
})(typeof window !== 'undefined' ? window : globalThis);
