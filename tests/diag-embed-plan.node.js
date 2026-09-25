/**
 * diag-embed-plan.node.js —— 诊断脚本（不是验收测试）
 *
 * 目的：校验 embed.html 里"秘密图偏大，将自动缩小至 W×H"这段预判逻辑
 *       （页面侧用公开 API 复刻了内核的逐级缩小梯形 + 容量判断），
 *       与 StegoCore.embedSecret 的真实结果是否一致。
 *       如果哪天内核改了缩放策略而页面没跟上，这个脚本会立刻暴露出来。
 *
 * 运行：node tests/diag-embed-plan.node.js
 *
 * 说明：Node 垫片没有 canvas.toDataURL，这里改用同一个 JPEG 编码器拿精确字节数，
 *       因此校验的是"缩小梯形 + 容量判断"这段逻辑；浏览器里页面与内核用的是
 *       同一个 toDataURL('image/jpeg', 0.75)，差别只有 base64 长度换算的 ±2 字节。
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js', 'stego-core.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, kc) => encodeJpeg(img, Math.round(q01 * 100), kc);
const SC = global.StegoCore, IU = global.ImageUtils, CONST = SC.CONST;

function newImageData(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d').createImageData(w, h);
}
function canvasOf(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
function photo(w, h, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) >>> 0; };
  const img = newImageData(w, h);
  const lw = Math.max(4, Math.round(w / 24)), lh = Math.max(4, Math.round(h / 24));
  const low = new Float32Array(lw * lh);
  for (let i = 0; i < lw * lh; i++) low[i] = 30 + (rnd() % 200);
  for (let y = 0; y < h; y++) {
    const fy = y * (lh - 1) / (h - 1), y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x * (lw - 1) / (w - 1), x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
      const top = low[y0 * lw + x0] * (1 - tx) + low[y0 * lw + x1] * tx;
      const bot = low[y1 * lw + x0] * (1 - tx) + low[y1 * lw + x1] * tx;
      const v = Math.max(0, Math.min(255, top * (1 - ty) + bot * ty + (rnd() % 7) - 3));
      const o = (y * w + x) * 4;
      img.data[o] = v; img.data[o + 1] = Math.max(0, Math.min(255, v * 0.8 + 25));
      img.data[o + 2] = Math.max(0, Math.min(255, 200 - v * 0.5)); img.data[o + 3] = 255;
    }
  }
  return img;
}

// ---- 与 embed.html 中完全相同的预判逻辑（复制过来做对照）----
// 注意：Node 垫片没有 canvas.toDataURL，这里用同一个 JPEG 编码器拿到**精确**字节数，
// 于是本脚本校验的是"逐级缩小 + 容量判断"这段逻辑；浏览器里 toDataURL 与内核同源同质量，
// 差别仅在 base64 长度换算的 ±2 字节。
function jpegBytesOf(img) {
  return encodeJpeg(img, 75, true).length;
}
function resizeToLongSide(img, longSide) {
  return IU.getImageData(IU.resizeImage(canvasOf(img), longSide));
}
function predict(carrier, secret, redundancy, lowFreq) {
  const mode = lowFreq ? CONST.MODE_4 : CONST.MODE_6;
  const factor = CONST.REDUNDANCY[redundancy];
  const room = SC.analyzeCapacity(carrier, 0, { redundancy }).texturedTiles;
  const head = CONST.SECRET_HEADER_BYTES;
  const W = secret.width, H = secret.height;
  for (const scale of CONST.AUTO_RESIZE_FACTORS) {
    const longSide = Math.round(Math.max(W, H) * scale);
    if (scale < 1 && longSide < CONST.MIN_SECRET_LONG_SIDE) break;
    const cand = scale === 1 ? secret : resizeToLongSide(secret, longSide);
    const bytes = jpegBytesOf(cand);
    if (!bytes) return null;
    const parts = Math.ceil((head + bytes) / mode.symbolSize);
    if (Math.ceil(parts * factor) <= room) {
      return { w: cand.width, h: cand.height, scale, bytes };
    }
  }
  return null;
}

console.log('载体 → 秘密图 | 档位 | 模式 | 预判(缩小到) | 内核实际 | 一致?');
const cases = [
  ['512 载体 / 512 秘密', photo(512, 512, 5), photo(512, 512, 9), 'standard', false],
  ['512 载体 / 512 秘密', photo(512, 512, 5), photo(512, 512, 9), 'standard', true],
  ['512 载体 / 1024 秘密', photo(512, 512, 6), photo(1024, 1024, 11), 'balanced', true],
  ['2000 载体 / 1024 秘密', photo(2000, 2000, 7), photo(1024, 1024, 12), 'compact', false],
  ['512 载体 / 32 秘密', photo(512, 512, 8), photo(32, 32, 13), 'standard', false]
];
let bad = 0;
for (const [label, carrier, secret, red, low] of cases) {
  const p = predict(carrier, secret, red, low);
  let real = null, realBytes = 0, threw = '';
  try {
    const st = SC.embedSecret(carrier, secret, { redundancy: red, lowFrequencyMode: low });
    real = st.stats.secretFinalSize;
    realBytes = st.stats.secretJpegBytes;
  } catch (e) {
    threw = e.message.slice(0, 24) + '…';
  }
  const ok = threw ? (p === null) : (!!p && p.w === real.W && p.h === real.H);
  if (!ok) bad++;
  console.log(`${label} | ${red} | ${low ? '4对' : '6对'} | ${p ? p.w + '×' + p.h + '(' + p.scale + ')' : 'null（放不下）'} | ` +
    `${real ? real.W + '×' + real.H : '抛错：' + threw} | ${ok ? 'YES' : 'NO'}（JPEG 估算 ${p ? p.bytes : '-'} vs 实际 ${realBytes}）`);
}
console.log(bad === 0 ? '\n全部一致：预判与内核吻合' : `\n有 ${bad} 例不一致`);
