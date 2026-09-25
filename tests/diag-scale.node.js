/**
 * diag-scale.node.js —— 诊断脚本（不是验收测试）
 * ---------------------------------------------------------------
 * 目的（本轮"标尺干扰对消 + 低频回退模式"的实测定标）：
 *   1) 校验 GeoCalibration.generateScalePattern 是否与 embedScale 实际叠加的
 *      图案逐像素一致（对消的前提）；
 *   2) 测最小二乘残留幅度 alpha 在 无退化 / 0.75x / 0.5x 下的真实取值；
 *   3) 测 6 对模式 vs 4 对低频模式在缩放退化后的逐 Tile CRC 通过率，
 *      以及"对消前 / 对消后 / 端到端"三条线的差异；
 *   4) 拆解 T32（未隐写图提取 <2s）的耗时构成。
 *
 * 运行：node tests/diag-scale.node.js
 *
 * 注意：垫片里的 drawImage 是**最近邻采样**（比浏览器的高质量平滑缩放苛刻
 * 得多），所以这里的数字是"最坏情况"，真机（浏览器）实测通常更好。
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js', 'stego-core.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));

const { encodeJpeg } = require('./jpeg-encode.js');
const { simulateJpegRoundTrip } = require('./jpeg-sim.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, keepColor) => encodeJpeg(img, Math.round(q01 * 100), keepColor);

const IU = global.ImageUtils;
const DCT = global.DctStego;
const SC = global.StegoCore;
const GC = global.GeoCalibration;
const Packet = global.Packet;

const S = 512;
const SEED = 20240601;

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function newImageData(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d').createImageData(w, h);
}

function cloneImageData(img) {
  const out = newImageData(img.width, img.height);
  out.data.set(img.data);
  return out;
}

/** 与 test-suite.js 完全一致的"照片感"载体 */
function photoCarrier(size) {
  const s = size || S;
  const rng = makeRng(SEED + 991);
  const lw = Math.round(s / 24), lh = Math.round(s / 24);
  const low = new Float32Array(lw * lh);
  let i;
  for (i = 0; i < lw * lh; i++) low[i] = 30 + (rng() >>> 24) % 200;
  const img = newImageData(s, s);
  for (let y = 0; y < s; y++) {
    const fy = y * (lh - 1) / (s - 1);
    const y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < s; x++) {
      const fx = x * (lw - 1) / (s - 1);
      const x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
      const top = low[y0 * lw + x0] * (1 - tx) + low[y0 * lw + x1] * tx;
      const bot = low[y1 * lw + x0] * (1 - tx) + low[y1 * lw + x1] * tx;
      const v = Math.max(0, Math.min(255, top * (1 - ty) + bot * ty + (rng() >>> 24) % 7 - 3));
      const o = (y * s + x) * 4;
      img.data[o] = v;
      img.data[o + 1] = Math.max(0, Math.min(255, v * 0.8 + 25));
      img.data[o + 2] = Math.max(0, Math.min(255, 200 - v * 0.5));
      img.data[o + 3] = 255;
    }
  }
  return img;
}

/** 与 test-suite.js 一致的秘密图（2px 棋盘 + 斜纹） */
function makeSecret(size) {
  const s = size || 16;
  const img = newImageData(s, s);
  const d = img.data;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let v = ((((x >> 1) + (y >> 1)) & 1) === 1) ? 235 : 20;
      if (((x + y) & 7) < 2) v = v > 128 ? 70 : 190;
      const o = (y * s + x) * 4;
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
    }
  }
  return img;
}

function canvasOf(imageData) {
  const c = document.createElement('canvas');
  c.width = imageData.width; c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c;
}

/** 走 canvas 缩放（与 test-suite 的 scaleImage 同路径：垫片里是最近邻） */
function scaleImage(imageData, scale) {
  const w = Math.max(1, Math.round(imageData.width * scale));
  const h = Math.max(1, Math.round(imageData.height * scale));
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvasOf(imageData), 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** 重采样到指定尺寸（与 stego-core 的 resizeToSize 同路径） */
function resizeTo(imageData, w, h) {
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvasOf(imageData), 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function lumAt(img, x, y) {
  const o = (y * img.width + x) * 4;
  return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
}

/** 直接对整图统计某模式下的 CRC 通过率（诊断用，绕过 StegoCore 的恢复逻辑） */
function tilePassRate(img, pairs, bits) {
  const tiles = IU.splitIntoTiles(img, 64);
  let total = 0, pass = 0;
  for (const t of tiles) {
    if (t.width !== 64 || t.height !== 64) continue;
    total++;
    const b = DCT.extractBitsFromTile(t.data, bits, pairs ? { pairs } : {});
    const n = Math.floor(b.length / 8);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | (b[i * 8 + k] & 1);
      bytes[i] = v;
    }
    const r = Packet.unpack(bytes);
    if (r && r.valid && r.payload && r.payload.length === bytes.length - 4) pass++;
  }
  return { pass, total, rate: total ? pass / total : 0 };
}

const M6 = SC.CONST.MODE_6, M4 = SC.CONST.MODE_4;
const PILOT_AMP = GC.CONST.PILOT_AMP;
const carrier = photoCarrier(S);
const secret = makeSecret(16);

function fmt(r) { return `${r.pass}/${r.total}(${(r.rate * 100).toFixed(0)}%)`; }

console.log('=== 诊断 1：图案重建一致性（generateScalePattern vs embedScale 实际叠加）===');
{
  // 先不带标尺嵌入，拿到"纯隐写图"，再自己叠标尺 —— 这样能算出真实叠加量
  const st0 = SC.embedSecret(carrier, secret, { embedScale: false });
  const plainStego = st0.outputImageData;
  const marked = GC.embedScale(plainStego, plainStego.width, plainStego.height);
  const pat = GC.generateScalePattern(S, S, PILOT_AMP);
  let maxDiff = 0, sumAbs = 0, clipped = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const real = lumAt(marked, x, y) - lumAt(plainStego, x, y);
      const d = Math.abs(real - pat[y * S + x]);
      sumAbs += d;
      if (d > maxDiff) maxDiff = d;
      if (marked.data[(y * S + x) * 4] === 0 || marked.data[(y * S + x) * 4] === 255) clipped++;
    }
  }
  console.log(`  平均绝对误差=${(sumAbs / (S * S)).toFixed(4)}，最大误差=${maxDiff.toFixed(3)}，` +
    `截断像素=${clipped}`);
  // 直接对"纯隐写图"做对消：理想情况 alpha≈0（没有标尺），残差应几乎无变化
  const noScale = GC.removeScale(plainStego, S, S);
  let psnrNoise = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    const d0 = plainStego.data[o] - noScale.data[o];
    psnrNoise += d0 * d0;
  }
  console.log(`  对"无标尺图"调用 removeScale：alpha=${GC.lastAlpha.toFixed(4)}（理想 0），` +
    `RMS 改动=${Math.sqrt(psnrNoise / (S * S)).toFixed(3)} / 255`);
}

console.log('\n=== 诊断 2：残留幅度 alpha 的实测（无退化 / 0.75x / 0.5x / 1.25x）===');
{
  const st0 = SC.embedSecret(carrier, secret, { embedScale: false });
  const marked = GC.embedScale(st0.outputImageData, S, S);
  const cases = [
    ['无退化    ', () => marked],
    ['0.75x     ', () => scaleImage(marked, 0.75)],
    ['0.75x(高质)', () => resizeTo(scaleImage(marked, 0.75), S, S)],   // 只降采样不还原
    ['0.5x      ', () => scaleImage(marked, 0.5)],
    ['1.25x     ', () => scaleImage(marked, 1.25)]
  ];
  for (const [label, make] of cases) {
    const img = make();
    const size = GC.extractScale(img);
    if (!size) { console.log(`  ${label} 标尺未读出`); continue; }
    const restored = (img.width === size.width && img.height === size.height) ?
      img : resizeTo(img, size.width, size.height);
    const cancelled = GC.removeScale(restored, size.width, size.height);
    // 与"未叠标尺的隐写图"对比：理想情况下对消后应非常接近它
    const ref = (img.width === S && img.height === S) ? st0.outputImageData : null;
    let line = `  ${label} 读回 ${size.width}x${size.height} alpha=${GC.lastAlpha.toFixed(3)}`;
    if (ref) {
      let seBefore = 0, seAfter = 0;
      for (let i = 0; i < S * S; i++) {
        const o = i * 4;
        for (let c = 0; c < 3; c++) {
          const b = restored.data[o + c] - ref.data[o + c];
          const a = cancelled.data[o + c] - ref.data[o + c];
          seBefore += b * b; seAfter += a * a;
        }
      }
      const n = S * S * 3;
      line += ` | 与"无标尺图"的 MSE：对消前=${(seBefore / n).toFixed(2)} 对消后=${(seAfter / n).toFixed(2)}`;
    }
    console.log(line);
  }
}

console.log('\n=== 诊断 3：缩放退化下的逐 Tile CRC 通过率（对消前 / 对消后 / 端到端）===');
for (const cfg of [
  { label: 'MODE_6 + standard', low: false, opts: {} },
  { label: 'MODE_4 + balanced', low: true, opts: { redundancy: 'balanced' } }
]) {
  const opts = Object.assign({ lowFrequencyMode: cfg.low }, cfg.opts);
  const st = SC.embedSecret(carrier, secret, opts);
  console.log(`--- ${cfg.label}（symbol=${st.stats.symbolSize}B, K=${st.stats.K}, N=${st.stats.N}, ` +
    `usedTiles=${st.stats.usedTiles}）---`);
  const cases = [
    ['无退化    ', st.outputImageData],
    ['0.75x     ', scaleImage(st.outputImageData, 0.75)],
    ['0.85JPEG+0.75x', scaleImage(simulateJpegRoundTrip(st.outputImageData, 85), 0.75)],
    ['0.5x      ', scaleImage(st.outputImageData, 0.5)],
    ['1.25x     ', scaleImage(st.outputImageData, 1.25)],
    ['0.5x+涂黑25%', (() => {
      const s = scaleImage(st.outputImageData, 0.5);
      const out = cloneImageData(s);
      const x0 = Math.floor(out.width / 2), y0 = Math.floor(out.height / 2);
      for (let y = y0; y < out.height; y++) {
        for (let x = x0; x < out.width; x++) {
          const o = (y * out.width + x) * 4;
          out.data[o] = 0; out.data[o + 1] = 0; out.data[o + 2] = 0;
        }
      }
      return out;
    })()]
  ];
  for (const [label, img] of cases) {
    const size = GC.extractScale(img);
    let line = `  ${label} `;
    if (size) {
      const restored = (img.width === size.width && img.height === size.height) ?
        img : resizeTo(img, size.width, size.height);
      const b4 = tilePassRate(restored, M4.pairs, M4.bitsPerTile);
      const b6 = tilePassRate(restored, null, M6.bitsPerTile);
      const cancelled = GC.removeScale(restored, size.width, size.height);
      const a4 = tilePassRate(cancelled, M4.pairs, M4.bitsPerTile);
      const a6 = tilePassRate(cancelled, null, M6.bitsPerTile);
      line += `标尺 ${size.width}x${size.height}(alpha=${GC.lastAlpha.toFixed(2)}) ` +
        `对消前 4对=${fmt(b4)} 6对=${fmt(b6)} | 对消后 4对=${fmt(a4)} 6对=${fmt(a6)}`;
    } else {
      line += '标尺未读出';
    }
    const res = SC.extractSecret(img);
    line += ` | 端到端 success=${res.success} path=${res.recoveryPath} mode=${res.mode} ` +
      `valid=${res.validTiles}/${res.totalTiles}`;
    console.log(line);
  }
  console.log('');
}

console.log('=== 诊断 5：真实核（盒式均值降采样）下的表现 —— 浏览器 imageSmoothingQuality=high 近似）===');
{
  const M6b = M6.bitsPerTile, M4b = M4.bitsPerTile;
  function boxDown(img, w2, h2) {
    const out = newImageData(w2, h2);
    const sx = img.width / w2, sy = img.height / h2;
    for (let y = 0; y < h2; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.ceil((y + 1) * sy));
      for (let x = 0; x < w2; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.ceil((x + 1) * sx));
        let r = 0, g = 0, b = 0, c = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const o = (yy * img.width + xx) * 4;
            r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; c++;
          }
        }
        const d = (y * w2 + x) * 4;
        out.data[d] = r / c; out.data[d + 1] = g / c; out.data[d + 2] = b / c; out.data[d + 3] = 255;
      }
    }
    return out;
  }
  for (const cfg of [
    { label: 'MODE_6 + standard', low: false, opts: {} },
    { label: 'MODE_4 + balanced', low: true, opts: { redundancy: 'balanced' } }
  ]) {
    const st = SC.embedSecret(carrier, secret, Object.assign({ lowFrequencyMode: cfg.low }, cfg.opts));
    console.log(`--- ${cfg.label}（K=${st.stats.K}, N=${st.stats.N}）---`);
    for (const scale of [0.75, 0.5, 1.25]) {
      const w2 = Math.round(S * scale), h2 = Math.round(S * scale);
      const down = boxDown(st.outputImageData, w2, h2);
      const size = GC.extractScale(down);
      let line = `  ${scale}x -> ${w2}x${h2} 标尺=${size ? size.width + 'x' + size.height : 'null'}`;
      if (size && size.width === S) {
        const back = resizeTo(down, S, S);           // 与 stego-core 的 resizeToSize 同路径
        const b4 = tilePassRate(back, M4.pairs, M4b);
        const b6 = tilePassRate(back, null, M6b);
        const cancelled = GC.removeScale(back, S, S);
        const a4 = tilePassRate(cancelled, M4.pairs, M4b);
        const a6 = tilePassRate(cancelled, null, M6b);
        line += ` alpha=${GC.lastAlpha.toFixed(3)} | 对消前 4对=${fmt(b4)} 6对=${fmt(b6)}` +
          ` | 对消后 4对=${fmt(a4)} 6对=${fmt(a6)}`;
      }
      const res = SC.extractSecret(down);
      line += ` | 端到端 success=${res.success} path=${res.recoveryPath} mode=${res.mode} valid=${res.validTiles}/${res.totalTiles}`;
      console.log(line);
    }
  }
  // 只嵌标尺（不含载荷）时，0.75x 的读数与 alpha：用于标尺对载荷干扰的定量
  const st0 = SC.embedSecret(carrier, secret, { embedScale: false });
  const marked = GC.embedScale(st0.outputImageData, S, S);
  for (const scale of [0.75, 0.5]) {
    const w2 = Math.round(S * scale), h2 = Math.round(S * scale);
    const down = boxDown(marked, w2, h2);
    const size = GC.extractScale(down);
    const back = resizeTo(down, S, S);
    GC.removeScale(back, S, S);
    console.log(`  [标尺+载荷] ${scale}x 读回=${size ? size.width + 'x' + size.height : 'null'}` +
      ` alpha=${GC.lastAlpha.toFixed(3)}`);
  }
}

console.log('\n=== 诊断 9：复刻 T6/T30/T32 的真实路径（canvas drawImage 缩放）===');
{
  const lowOpts = { lowFrequencyMode: true, redundancy: 'balanced' };
  for (const [label, makeC, scale] of [
    ['T6（照片载体 0.5x）', photoCarrier, 0.5],
    ['T5（照片载体 0.75x）', photoCarrier, 0.75],
    ['T26（照片载体 1.25x）', photoCarrier, 1.25],
    ['T30（噪声载体 0.75x，仅标尺）', null, 0.75]
  ]) {
    let src;
    if (makeC) {
      const st = SC.embedSecret(makeC(), secret, lowOpts);
      src = st.outputImageData;
    } else {
      src = GC.embedScale(carrier, S, S);   // 注意：这里用照片载体做"仅标尺"，另测噪声
    }
    const down = scaleImage(src, scale);    // 与 test-suite 的 scaleImage 同路径（垫片 drawImage）
    const size = GC.extractScale(down);
    let line = `  ${label} → ${down.width}x${down.height}，标尺读回=${size ? size.width + 'x' + size.height : 'null'}`;
    if (size) {
      const back = resizeTo(down, size.width, size.height);
      const rate4 = tilePassRate(back, M4.pairs, M4.bitsPerTile);
      const cancelled = GC.removeScale(back, size.width, size.height);
      const rate4c = tilePassRate(cancelled, M4.pairs, M4.bitsPerTile);
      const res = SC.extractSecret(down);
      line += `；还原后 4 对 CRC=${fmt(rate4)}（对消后 ${fmt(rate4c)}）` +
        `；端到端 success=${res.success} path=${res.recoveryPath} valid=${res.validTiles}/${res.totalTiles}`;
    }
    console.log(line);
  }
  // T30 用的是噪声载体：单独测
  {
    const noise = (() => {
      const img = newImageData(S, S);
      const rng = makeRng(SEED + S);
      for (let i = 0; i < S * S; i++) {
        const o = i * 4;
        img.data[o] = rng() >>> 24; img.data[o + 1] = rng() >>> 24; img.data[o + 2] = rng() >>> 24; img.data[o + 3] = 255;
      }
      return img;
    })();
    const marked = GC.embedScale(noise, S, S);
    for (const sc of [0.75, 0.5]) {
      const down = scaleImage(marked, sc);
      const size = GC.extractScale(down);
      console.log(`  T30（噪声载体仅标尺 ${sc}x）→ ${down.width}x${down.height}，标尺读回=` +
        `${size ? size.width + 'x' + size.height : 'null'}（期望 512x512）`);
    }
    // T32：未隐写图的耗时
    const t0 = Date.now();
    const res = SC.extractSecret(noise);
    console.log(`  T32（未隐写噪声图）extractSecret 耗时=${Date.now() - t0} ms（success=${res.success}, path=${res.recoveryPath}）`);
  }
}

console.log('\n=== 诊断 4：T32 耗时分解（未隐写噪声图 512x512）===');
{
  const plain = (() => {
    const img = newImageData(S, S);
    const rng = makeRng(SEED + S);
    for (let i = 0; i < S * S; i++) {
      const o = i * 4;
      img.data[o] = rng() >>> 24;
      img.data[o + 1] = rng() >>> 24;
      img.data[o + 2] = rng() >>> 24;
      img.data[o + 3] = 255;
    }
    return img;
  })();
  let t0 = Date.now();
  const r0 = SC.extractSecret(plain);
  const total = Date.now() - t0;
  t0 = Date.now();
  const size = GC.extractScale(plain);
  const scaleMs = Date.now() - t0;
  t0 = Date.now();
  const tiles = IU.splitIntoTiles(plain, 64);
  console.log(`  extractSecret 总耗时=${total} ms（success=${r0.success}, path=${r0.recoveryPath}）`);
  console.log(`  GeoCalibration.extractScale 单独=${scaleMs} ms（读数=${size ? size.width : 'null'}）`);
  console.log(`  单次整图 6 对提取（64 Tile）=${(function () {
    const t = Date.now();
    tilePassRate(plain, null, M6.bitsPerTile);
    return Date.now() - t;
  })()} ms；切 Tile 数=${tiles.length}`);
}
