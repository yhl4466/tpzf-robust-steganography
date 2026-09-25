/** diag-period.node.js —— 打印各路周期估计，评估"取平均"能否同时治好奇/照片载体 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));
const GC = global.GeoCalibration;
const S = 512, SEED = 20240601;
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const randByte = (r) => r() >>> 24;
function newImageData(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d').createImageData(w, h);
}
function noise(w, h) {
  const img = newImageData(w, h), rng = makeRng(SEED + w);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    img.data[o] = randByte(rng); img.data[o + 1] = randByte(rng); img.data[o + 2] = randByte(rng); img.data[o + 3] = 255;
  }
  return img;
}
function photo(w, h, seed) {
  const rng = makeRng(seed);
  const lw = Math.max(4, Math.round(w / 24)), lh = Math.max(4, Math.round(h / 24));
  const low = new Float32Array(lw * lh);
  for (let i = 0; i < lw * lh; i++) low[i] = 30 + (randByte(rng) % 200);
  const img = newImageData(w, h);
  for (let y = 0; y < h; y++) {
    const fy = y * (lh - 1) / (h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x * (lw - 1) / (w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
      const top = low[y0 * lw + x0] * (1 - tx) + low[y0 * lw + x1] * tx;
      const bot = low[y1 * lw + x0] * (1 - tx) + low[y1 * lw + x1] * tx;
      const v = Math.max(0, Math.min(255, top * (1 - ty) + bot * ty + (randByte(rng) % 7) - 3));
      const o = (y * w + x) * 4;
      img.data[o] = v; img.data[o + 1] = Math.max(0, Math.min(255, v * 0.8 + 25));
      img.data[o + 2] = Math.max(0, Math.min(255, 200 - v * 0.5)); img.data[o + 3] = 255;
    }
  }
  return img;
}
function solid(w, h, v) {
  const img = newImageData(w, h);
  for (let i = 0; i < w * h; i++) { const o = i * 4; img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255; }
  return img;
}
function gradient(w, h) {
  const img = newImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const v = Math.round(30 + 180 * (x / w) + 40 * (y / h));
    img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  return img;
}
function shimScale(img, sc) {
  const w = Math.round(img.width * sc), h = Math.round(img.height * sc);
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d').putImageData(img, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
const carriers = [
  ['噪声(测试套件)', noise(S, S)],
  ['照片感A', photo(S, S, 41)],
  ['照片感B', photo(S, S, 31)],
  ['纯色', solid(S, S, 128)],
  ['渐变', gradient(S, S)]
];
console.log('载体                缩放  主导频细扫   次导频等效   平均     单用主/次/平均 得到的尺寸');
for (const [name, carrier] of carriers) {
  const marked = GC.embedScale(carrier, S, S);
  for (const sc of [1, 0.75, 0.5, 1.25]) {
    const img = sc === 1 ? marked : shimScale(marked, sc);
    const got = GC.extractScale(img);
    const info = GC.lastPeriodInfo || {};
    const W = img.width;
    const estW = (P) => Math.round(W * 32 / P);
    const avg = (info.primary !== undefined && info.secondaryEquiv !== undefined)
      ? (info.primary + info.secondaryEquiv) / 2 : undefined;
    console.log(`${name.padEnd(16)} ${String(sc).padStart(5)}  ` +
      `${info.primary !== undefined ? info.primary.toFixed(4) : '-'}  ` +
      `${info.secondaryEquiv !== undefined ? info.secondaryEquiv.toFixed(4) : '-'}  ` +
      `${avg !== undefined ? avg.toFixed(4) : '-'}   ` +
      `${info.primary !== undefined ? estW(info.primary) : '-'}/` +
      `${info.secondaryEquiv !== undefined ? estW(info.secondaryEquiv) : '-'}/` +
      `${avg !== undefined ? estW(avg) : '-'}  实际=${got ? got.width : 'null'}`);
  }
}
