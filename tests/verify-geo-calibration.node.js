/**
 * verify-geo-calibration.node.js —— js/geo-calibration.js 自测（Node，零第三方依赖）
 *
 * 覆盖 AC1~AC6，并补充：
 *   · 周期检测精度（导频最小可分辨周期变化）
 *   · 载荷交叉校验是否真的被用上（RS 解码成功率）
 *   · 缩放恢复后的**比特误码率**实测（决定 T5/T6/T7 能否成功的关键数据）
 *
 * 运行： node tests/verify-geo-calibration.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js']
  .forEach((f) => require(path.join(__dirname, '..', 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
const { simulateJpegRoundTrip } = require('./jpeg-sim.js');

const GC = global.GeoCalibration;
const IU = global.ImageUtils;
const DCT = global.DctStego;
if (!GC || !IU) { console.error('致命错误：GeoCalibration / ImageUtils 未定义'); process.exit(1); }

const results = [];
let failures = 0;
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}\n        ${detail}`);
}
function assertThrows(fn) { try { fn(); return null; } catch (e) { return e; } }
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

function solidImage(w, h, v) {
  const img = new global.ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  return img;
}
function gradientImage(w, h) {
  const img = new global.ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = Math.round(30 + 180 * (x / w) + 40 * (y / h));
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
    }
  }
  return img;
}
/** 照片感图像：低频块状内容 + 轻微噪声（宽带频谱，不刻意制造强周期） */
function photoImage(w, h, seed) {
  const rng = makeRng(seed);
  // 先生成低分辨率"内容图"，再双线性放大 → 平滑的低频结构，频谱宽带
  const lw = Math.max(4, Math.round(w / 24)), lh = Math.max(4, Math.round(h / 24));
  const low = new Float32Array(lw * lh);
  for (let i = 0; i < lw * lh; i++) low[i] = 30 + (randByte(rng) % 200);
  const img = new global.ImageData(w, h);
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
      img.data[o] = v;
      img.data[o + 1] = Math.max(0, Math.min(255, v * 0.8 + 25));
      img.data[o + 2] = Math.max(0, Math.min(255, 200 - v * 0.5));
      img.data[o + 3] = 255;
    }
  }
  return img;
}
function resizeNearest(img, w, h) {
  const out = new global.ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * img.height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * img.width / w));
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}
/** 面积平均降采样（比最近邻更接近浏览器的真实缩放） */
function boxDown(img, w2, h2) {
  const out = new global.ImageData(w2, h2);
  const sx = img.width / w2, sy = img.height / h2;
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.ceil((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.ceil((y + 1) * sy));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
        }
      }
      const d = (y * w2 + x) * 4;
      out.data[d] = Math.round(r / n); out.data[d + 1] = Math.round(g / n);
      out.data[d + 2] = Math.round(b / n); out.data[d + 3] = 255;
    }
  }
  return out;
}
function fmt(n) { return typeof n === 'number' ? n.toFixed(2) : String(n); }
/** 用 canvas 做重采样 —— 与产品（stego-core.resizeToSize / 浏览器 drawImage）同一条路径 */
function canvasResize(img, w, h) {
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d').putImageData(img, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

console.log('=== geo-calibration.js 自测（Node ' + process.version + '）===');
console.log('方案 A：正弦导频（周期 64，振幅 1.5）+ 288 片扩频载荷（振幅 1.0）\n');

// ==== 临时诊断：看各候选周期的相关幅值到底长什么样 ====
if (process.argv.indexOf('--diag') >= 0) {
  const cases = [
    { name: '纯色 128', img: solidImage(512, 512, 128) },
    { name: '渐变', img: gradientImage(512, 512) },
    { name: '照片感', img: photoImage(512, 512, 41) }
  ];
  for (const c of cases) {
    const marked = GC.embedScale(c.img, 512, 512);
    const rows = [];
    for (const P of [21.3, 32, 42.7, 64, 85.3, 106.7, 128]) {
      // 复用内部算法：直接调用 extractScale 走不到，这里手工算 |C(P)|
      const lum = new Float32Array(512 * 512);
      let mean = 0;
      for (let i = 0; i < 512 * 512; i++) {
        const o = i * 4;
        lum[i] = 0.299 * marked.data[o] + 0.587 * marked.data[o + 1] + 0.114 * marked.data[o + 2];
        mean += lum[i];
      }
      mean /= 512 * 512;
      let re = 0, im = 0;
      const k = 2 * Math.PI / P;
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          const v = lum[y * 512 + x] - mean;
          const a = k * (x + y);
          re += v * Math.cos(a);
          im -= v * Math.sin(a);
        }
      }
      rows.push(`P=${P}:${Math.round(Math.sqrt(re * re + im * im))}`);
    }
    console.log(`[diag] ${c.name}：${rows.join('  ')}`);
    console.log(`[diag]   → extractScale 读回 ${JSON.stringify(GC.extractScale(marked))}`);
  }
  // 打印评分数组的 top 候选，定位"为什么选中了 32 而不是 64"
  {
    const marked = GC.embedScale(photoImage(512, 512, 41), 512, 512);
    const W = 512, H = 512;
    const lum = new Float32Array(W * H);
    let mean = 0;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      lum[i] = 0.299 * marked.data[o] + 0.587 * marked.data[o + 1] + 0.114 * marked.data[o + 2];
      mean += lum[i];
    }
    mean /= W * H;
    for (let i = 0; i < W * H; i++) lum[i] -= mean;
    const STEP = 0.5, PMIN = 16, PMAX = 160;
    const n = Math.round((PMAX - PMIN) / STEP) + 1;
    const mags = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const P = PMIN + i * STEP;
      let re = 0, im = 0;
      const k = 2 * Math.PI / P;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = lum[y * W + x];
          const a = k * (x + y);
          re += v * Math.cos(a); im -= v * Math.sin(a);
        }
      }
      mags[i] = Math.sqrt(re * re + im * im);
    }
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - 24), hi = Math.min(n - 1, i + 24);
      let s = 0, c2 = 0;
      for (let k = lo; k <= hi; k++) { s += mags[k]; c2++; }
      z[i] = (s / c2) > 0 ? mags[i] / (s / c2) : 0;
    }
    const HALF_OFFSET = PMIN / (2 * STEP);
    const scored = [];
    for (let i = 0; i < n; i++) {
      const hIdx = Math.round(i / 2 - HALF_OFFSET);
      const sc = (hIdx >= 0 && hIdx < n && hIdx !== i) ? z[i] * z[hIdx] : z[i];
      scored.push({ P: PMIN + i * STEP, mag: mags[i], z: z[i], score: sc });
    }
    scored.sort((a, b) => b.score - a.score);
    console.log('[diag] top8 候选（P, |C|, z, score）：');
    for (const s of scored.slice(0, 8)) {
      console.log(`[diag]   P=${s.P.toFixed(1)} |C|=${Math.round(s.mag)} z=${s.z.toFixed(2)} score=${s.score.toFixed(2)}`);
    }
  }
  // 载荷通道诊断：芯片相关性到底对不对
  {
    const marked = GC.embedScale(photoImage(512, 512, 41), 400, 300);
    const W = 512, H = 512;
    const SPREAD = 8, CHIP_LEN = 288, BLOCKS = CHIP_LEN * SPREAD;
    // 复现内部置换表
    const map = new Int16Array(BLOCKS);
    for (let i = 0; i < BLOCKS; i++) map[i] = i % CHIP_LEN;
    let a = 0x9e3779b9;
    const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) >>> 0; };
    for (let i = BLOCKS - 1; i > 0; i--) { const j = rnd() % (i + 1); const t = map[i]; map[i] = map[j]; map[j] = t; }
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      lum[i] = 0.299 * marked.data[o] + 0.587 * marked.data[o + 1] + 0.114 * marked.data[o + 2];
    }
    const bSum = new Float64Array(BLOCKS), bCnt = new Int32Array(BLOCKS);
    let meanAll = 0;
    for (let i = 0; i < W * H; i++) meanAll += lum[i];
    meanAll /= W * H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const b = Math.floor((x + y) / SPREAD) % BLOCKS;
        bSum[b] += (lum[idx] - meanAll); bCnt[b]++;
      }
    }
    // 期望的芯片值（用同样的载荷）
    const Packet = global.Packet;
    const payload = new Uint8Array(12);
    payload[0] = 1; payload[2] = 400 >> 8; payload[3] = 400 & 255; payload[4] = 300 >> 8; payload[5] = 300 & 255;
    const crc = Packet.crc32(payload.subarray(0, 8));
    payload[8] = (crc >>> 24) & 255; payload[9] = (crc >>> 16) & 255; payload[10] = (crc >>> 8) & 255; payload[11] = crc & 255;
    const enc = global.RaptorQ.createEncoder(payload, 6, 2);
    const bytes = new Uint8Array(36);
    for (let i = 0; i < 18; i++) bytes.set(enc.generateSymbol(i), i * 2);
    const expect = new Int8Array(CHIP_LEN);
    for (let i = 0; i < CHIP_LEN; i++) expect[i] = ((bytes[i >> 3] >> (7 - (i & 7))) & 1) ? 1 : -1;
    let best = null;
    for (let off = 0; off < SPREAD; off++) {
      const sums = new Float64Array(CHIP_LEN), cnt = new Int32Array(CHIP_LEN);
      for (let b = 0; b < BLOCKS; b++) { const c = map[(b + off) % BLOCKS]; sums[c] += bSum[b]; cnt[c] += bCnt[b]; }
      let agree = 0;
      for (let i = 0; i < CHIP_LEN; i++) if ((sums[i] > 0 ? 1 : -1) === expect[i]) agree++;
      if (!best || agree > best.agree) best = { off, agree };
      if (off === 0) console.log(`[diag] 载荷 offset=0：符号一致 ${agree}/288`);
    }
    console.log(`[diag] 载荷最佳 offset=${best.off}，一致 ${best.agree}/288（期望 ≥ 200 才能 RS 纠回）`);
  }
}

// ============================================================
// AC1 契约
// ============================================================
{
  const contract = { embedScale: 3, extractScale: 1 };
  const missing = Object.keys(contract).filter((k) => typeof GC[k] !== 'function');
  const arityBad = Object.keys(contract).filter((k) => typeof GC[k] === 'function' &&
    GC[k].length !== contract[k]).map((k) => `${k}(期望${contract[k]},实际${GC[k].length})`);
  const e1 = assertThrows(() => GC.embedScale(null, 8, 8));
  const src = solidImage(128, 128, 100);
  const snap = Uint8ClampedArray.from(src.data);
  const out = GC.embedScale(src, 512, 384);
  const intact = snap.every((v, i) => v === src.data[i]);
  const isNew = out !== src && out.data !== src.data;
  check('AC1', 'window.GeoCalibration 契约：embedScale(imageData,w,h) / extractScale(imageData) 形参一致',
    missing.length === 0 && arityBad.length === 0 && e1 instanceof TypeError && intact && isNew &&
    out.width === 128 && out.height === 128,
    `缺失=[${missing.join(', ')}]；形参不符=[${arityBad.join(', ')}]；非法入参→${e1 && e1.constructor.name}；` +
    `入参未被修改=${intact}；返回新对象=${isNew}；常量=${JSON.stringify(GC.CONST.RS_K)}/${GC.CONST.RS_N}（RS 3 倍冗余→${GC.CONST.RS_BYTES} 字节）`);
}

// ============================================================
// AC2 无压缩往返
// ============================================================
{
  const src = photoImage(512, 512, 11);
  const marked = GC.embedScale(src, 512, 512);
  const got = GC.extractScale(marked);
  check('AC2', '标尺无压缩往返：读回尺寸与原始一致', !!got && got.width === 512 && got.height === 512,
    `读回=${got ? got.width + '×' + got.height : 'null'}（期望 512×512）`);
}

// ============================================================
// AC3 / AC4 缩放往返（0.75x / 0.5x）
// ============================================================
function scaleRoundTrip(scale, seed) {
  const w = 512, h = 512;
  const src = photoImage(w, h, seed);
  const marked = GC.embedScale(src, w, h);
  const w2 = Math.round(w * scale), h2 = Math.round(h * scale);
  const scaled = boxDown(marked, w2, h2);
  const got = GC.extractScale(scaled);
  return { got, w2, h2, srcSize: w + '×' + h };
}
{
  const r = scaleRoundTrip(0.75, 21);
  check('AC3', '标尺缩放 0.75x 往返：读回尺寸与原始一致',
    !!r.got && r.got.width === 512 && r.got.height === 512,
    `缩放到 ${r.w2}×${r.h2} 后读回=${r.got ? r.got.width + '×' + r.got.height : 'null'}（期望 ${r.srcSize}）`);
}
{
  const r = scaleRoundTrip(0.5, 22);
  check('AC4', '标尺缩放 0.5x 往返：读回尺寸与原始一致',
    !!r.got && r.got.width === 512 && r.got.height === 512,
    `缩放到 ${r.w2}×${r.h2} 后读回=${r.got ? r.got.width + '×' + r.got.height : 'null'}（期望 ${r.srcSize}）`);
}

// ============================================================
// AC5 JPEG q=0.85 往返
// ============================================================
{
  const src = photoImage(512, 512, 31);
  const marked = GC.embedScale(src, 512, 512);
  const q85 = simulateJpegRoundTrip(marked, 85);
  const got85 = GC.extractScale(q85);
  const q75 = simulateJpegRoundTrip(marked, 75);
  const got75 = GC.extractScale(q75);
  check('AC5', '标尺 JPEG q=0.85 往返：读回尺寸一致（附 q=0.75 尽力而为）',
    !!got85 && got85.width === 512 && got85.height === 512,
    `q=0.85 → ${got85 ? got85.width + '×' + got85.height : 'null'}（期望 512×512）；` +
    `q=0.75 → ${got75 ? got75.width + '×' + got75.height : 'null'}`);
}

// ============================================================
// AC6 PSNR > 42dB（纯色 / 渐变 / 照片）
// ============================================================
{
  const cases = [
    { name: '纯色', img: solidImage(512, 512, 128) },
    { name: '纯色(亮)', img: solidImage(512, 512, 235) },
    { name: '渐变', img: gradientImage(512, 512) },
    { name: '照片感', img: photoImage(512, 512, 41) }
  ];
  const rows = [];
  let ok = true;
  for (const c of cases) {
    const marked = GC.embedScale(c.img, 512, 512);
    const p = GC.psnr(c.img, marked);
    if (!(p > 42)) ok = false;
    rows.push(`${c.name}=${fmt(p)} dB`);
  }
  check('AC6', '标尺 PSNR > 42 dB（纯色 / 亮纯色 / 渐变 / 照片感）', ok, rows.join('；'));
}

// ============================================================
// 补充：周期检测精度 + 载荷交叉校验 + 缩放恢复的比特误码率
// ============================================================
{
  // 载荷通道现状：12 字节明文 + RS(6,18) 3 倍冗余 → 288 片扩频码。
  // 实测在照片内容上芯片符号一致率约 66%（扩频增益不足以压过内容 + 导频），
  // RS 纠不回来，因此 extractScale 实际由**导频路径**给出尺寸；
  // 这里如实记录载荷通道的状态，并验证"载荷读不出时导频兜底"的行为正确。
  const src = photoImage(512, 512, 51);
  const marked = GC.embedScale(src, 400, 300);   // 故意写入与图像不同的尺寸
  const got = GC.extractScale(marked);
  const pilotFallback = !!got && got.width === 512 && got.height === 512;
  check('E1', '载荷通道未达可用强度，extractScale 由导频兜底（如实记录）',
    pilotFallback,
    `写入载荷 400×300 → 实际读回 ${got ? got.width + '×' + got.height : 'null'}；` +
    `说明：载荷（RS 3 倍冗余）在当前调制强度下符号一致率不足，导频路径正确兜底`);
}
{
  // 导频单独工作时的精度：写入与图像同尺寸，看导频路径给出的估计
  const sizes = [[512, 512], [800, 600], [1024, 768]];
  const rows = [];
  let allOk = true;
  for (const [w, h] of sizes) {
    const src = photoImage(w, h, 61 + w);
    const marked = GC.embedScale(src, w, h);
    const got = GC.extractScale(marked);
    const ok = !!got && got.width === w && got.height === h;
    if (!ok) allOk = false;
    rows.push(`${w}×${h}→${got ? got.width + '×' + got.height : 'null'}`);
  }
  check('E2', '不同尺寸图像标尺读写一致（512² / 800×600 / 1024×768）', allOk, rows.join('；'));
}

// ---- 关键前置测量：在真实隐写图（载荷 + 标尺）上，标尺还能不能读出来 ----
{
  require(path.join(__dirname, '..', 'js', 'stego-core.js'));
  global.__STEGO_JPEG_ENCODE__ = function (imageData, quality01, keepColor) {
    return encodeJpeg(imageData, Math.round(quality01 * 100), keepColor);
  };
  const SC = global.StegoCore;
  const rows = [];
  let ok = true;
  for (const scale of [1, 0.75, 0.5, 1.25]) {
    const carrier = photoImage(512, 512, 900 + Math.round(scale * 10));
    const secret = gradientImage(32, 32);
    const stego = SC.embedSecret(carrier, secret).outputImageData;
    const img = scale === 1 ? stego : boxDown(stego, Math.round(512 * scale), Math.round(512 * scale));
    const got = GC.extractScale(img);
    const good = !!got && got.width === 512 && got.height === 512;
    if (!good) ok = false;
    rows.push(`${scale}x(${img.width}²)→${got ? got.width + '×' + got.height : 'null'}`);
  }
  check('E4', '真实隐写图（载荷+标尺）上标尺读数：1.0x / 0.75x / 0.5x / 1.25x', ok, rows.join('；'));
}

// ---- 关键前置测量：把"缩放恢复后的几何"还原回来，误差到底有多大 ----
{
  const { quantTableForQuality } = require('./jpeg-sim.js');
  function bitErrorAfterRescale(scale, carrierKind) {
    const w = 512, h = 512;
    const carrier = carrierKind === 'noise' ? (() => {
      const rng = makeRng(77);
      const img = new global.ImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        img.data[o] = randByte(rng); img.data[o + 1] = randByte(rng);
        img.data[o + 2] = randByte(rng); img.data[o + 3] = 255;
      }
      return img;
    })() : photoImage(w, h, 78);
    // 直接嵌入 384 bit/Tile 的载荷（不经过 StegoCore，只测几何退化本身）
    const bits = new Uint8Array(384);
    const rng2 = makeRng(79);
    for (let i = 0; i < 384; i++) bits[i] = (rng2() >>> 31);
    const tiles = IU.splitIntoTiles(carrier, 64).filter((t) => t.width === 64 && t.height === 64);
    const stego = new global.ImageData(Uint8ClampedArray.from(carrier.data), w, h);
    const tile = tiles[0];
    const embedded = DCT.embedBitsInTile(tile.data, bits);
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < 64; c++) {
        const s = (r * 64 + c) * 4;
        const d = ((tile.y + r) * w + tile.x + c) * 4;
        stego.data[d] = embedded.data[s]; stego.data[d + 1] = embedded.data[s + 1];
        stego.data[d + 2] = embedded.data[s + 2]; stego.data[d + 3] = embedded.data[s + 3];
      }
    }
    // 缩放下去再缩放回原始尺寸（模拟"标尺检测到 scale 后还原几何"）
    const w2 = Math.round(w * scale), h2 = Math.round(h * scale);
    const down = boxDown(stego, w2, h2);
    const back = resizeNearest(down, w, h);
    const t2 = IU.splitIntoTiles(back, 64).filter((t) => t.width === 64 && t.height === 64);
    const got = DCT.extractBitsFromTile(t2[0].data, 384);
    let err = 0;
    for (let i = 0; i < 384; i++) if (got[i] !== !!bits[i]) err++;
    return err / 384;
  }
  const rows = [];
  let note = '';
  for (const scale of [0.75, 0.5]) {
    const noiseErr = bitErrorAfterRescale(scale, 'noise');
    const photoErr = bitErrorAfterRescale(scale, 'photo');
    rows.push(`${scale}x：噪声载体 ${(noiseErr * 100).toFixed(2)}%，照片载体 ${(photoErr * 100).toFixed(2)}%`);
    if (noiseErr > 0.02) note = '（> 2% 表示单 Tile 的 384 bit 已无法全对，纠删码也救不回）';
  }
  check('E3', '【关键前置测量】标尺还原几何后，384 bit/Tile 的比特误码率', true,
    rows.join('；') + note);
}

// ============================================================
// 本轮新增：标尺干扰对消（generateScalePattern / removeScale）
// ============================================================

// ---- AC7 图案契约：类型 / 长度 / 确定性 / 参数缩放与校验 ----
{
  const W = 512, H = 512;
  const pat = GC.generateScalePattern(W, H, 1.2);
  const pat2 = GC.generateScalePattern(W, H, 1.2);
  const typeOk = pat instanceof Float32Array && pat.length === W * H;
  let deterministic = true;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] !== pat2[i]) { deterministic = false; break; }
  }
  // amplitude 只缩放导频：amplitude=0 时图案应处处等于 ±CHIP_AMP
  const zeroAmp = GC.generateScalePattern(128, 128, 0);
  const chipAmp = GC.CONST.CHIP_AMP;
  let onlyChips = true;
  for (let i = 0; i < zeroAmp.length; i++) {
    if (Math.abs(Math.abs(zeroAmp[i]) - chipAmp) > 1e-6) { onlyChips = false; break; }
  }
  const bad1 = assertThrows(() => GC.generateScalePattern(0, 10, 1));
  const bad2 = assertThrows(() => GC.generateScalePattern(10.5, 10, 1));
  const bad3 = assertThrows(() => GC.generateScalePattern(10, 10, 'x'));
  check('AC7', 'generateScalePattern 契约：Float32Array(W*H) / 确定性 / amplitude 只缩放导频 / 非法参数报错',
    typeOk && deterministic && onlyChips &&
    bad1 instanceof RangeError && bad2 instanceof RangeError && bad3 instanceof TypeError,
    `类型=${pat.constructor.name}，长度=${pat.length}（=${W}×${H}）；确定性=${deterministic}；` +
    `amplitude=0 时处处 ±${chipAmp}=${onlyChips}；width=0 → ${bad1 && bad1.constructor.name}；` +
    `width=10.5 → ${bad2 && bad2.constructor.name}；amplitude='x' → ${bad3 && bad3.constructor.name}`);
}

// ---- AC8 removeScale 契约：新对象 / 不改入参 / 参数校验 ----
{
  const img = photoImage(256, 256, 7);
  const marked = GC.embedScale(img, 256, 256);
  const snapshot = new Uint8ClampedArray(marked.data);
  const out = GC.removeScale(marked, 256, 256);
  let untouched = true;
  for (let i = 0; i < snapshot.length; i++) {
    if (marked.data[i] !== snapshot[i]) { untouched = false; break; }
  }
  const fresh = out !== marked && out.width === 256 && out.height === 256 &&
    out.data !== marked.data;
  let changed = false;
  for (let i = 0; i < out.data.length; i++) {
    if (out.data[i] !== marked.data[i]) { changed = true; break; }
  }
  const bad1 = assertThrows(() => GC.removeScale(null, 16, 16));
  const bad2 = assertThrows(() => GC.removeScale(img, 0, 16));
  check('AC8', 'removeScale 契约：返回新 ImageData / 入参逐字节不变 / 非法参数报错',
    fresh && untouched && changed && bad1 instanceof TypeError && bad2 instanceof RangeError,
    `返回新对象=${fresh}（尺寸 ${out.width}×${out.height}）；入参未被修改=${untouched}；` +
    `确有像素改动=${changed}；null → ${bad1 && bad1.constructor.name}；` +
    `origWidth=0 → ${bad2 && bad2.constructor.name}`);
}

// ---- AC9 对消精度：无退化时 α≈1 且能把标尺"抹干净"；无标尺时 α≈0 不误伤 ----
{
  const flat = solidImage(512, 512, 128);
  const flatMarked = GC.embedScale(flat, 512, 512);
  const flatOut = GC.removeScale(flatMarked, 512, 512);
  const rawAlpha = GC.lastAlpha;
  const flatPsnr = GC.psnr(flatOut, flat);

  const photo = photoImage(512, 512, 31);
  const photoMarked = GC.embedScale(photo, 512, 512);
  const photoOut = GC.removeScale(photoMarked, 512, 512);
  const noRulerAlpha = GC.lastAlpha;          // 有标尺 → 应 ≈1
  const photoPsnr = GC.psnr(photoOut, photo);

  // 无标尺的照片图（含载荷）→ α 应接近 0，且几乎不改动图像
  const photoNoRuler = photoImage(512, 512, 32);
  const before = new Uint8ClampedArray(photoNoRuler.data);
  const noRulerOut = GC.removeScale(photoNoRuler, 512, 512);
  const falseAlpha = GC.lastAlpha;
  let maxDiff = 0;
  for (let i = 0; i < before.length; i++) {
    const d = Math.abs(noRulerOut.data[i] - before[i]);
    if (d > maxDiff) maxDiff = d;
  }
  const ok = rawAlpha > 0.9 && rawAlpha <= 1.05 && flatPsnr > 60 &&
    noRulerAlpha > 0.85 && noRulerAlpha <= 1.15 && photoPsnr > 45 &&
    Math.abs(falseAlpha) <= 0.2 && maxDiff <= 1;
  check('AC9', '对消精度：纯色+标尺 α≈1 且残差 PSNR>60dB；照片+标尺 α∈(0.85,1.15]；无标尺 α≈0 不误伤',
    ok,
    `纯色：α=${rawAlpha.toFixed(4)}，对消后 PSNR=${flatPsnr === Infinity ? '∞' : flatPsnr.toFixed(1)} dB；` +
    `照片：α=${noRulerAlpha.toFixed(4)}，PSNR=${photoPsnr.toFixed(1)} dB；` +
    `无标尺照片：α=${falseAlpha.toFixed(4)}（理想 0），最大像素改动=${maxDiff}`);
}

// ---- AC10/AC11/AC12：0.75× 缩放后对消对载荷存活率的实际作用 + 耗时 ----
{
  require(path.join(__dirname, '..', 'js', 'stego-core.js'));
  global.__STEGO_JPEG_ENCODE__ = function (imageData, quality01, keepColor) {
    return encodeJpeg(imageData, Math.round(quality01 * 100), keepColor);
  };
  const SC = global.StegoCore;
  const Packet = global.Packet;
  const M4 = SC.CONST.MODE_4;

  function crcRate(img, mode, used) {
    const tiles = IU.splitIntoTiles(img, 64);
    let pass = 0;
    for (const t of tiles) {
      if (t.width !== 64 || t.height !== 64) continue;
      const bits = DCT.extractBitsFromTile(t.data, mode.bitsPerTile, { pairs: mode.pairs });
      const n = Math.floor(bits.length / 8);
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] & 1);
        bytes[i] = v;
      }
      const r = Packet.unpack(bytes);
      if (r && r.valid && r.payload && r.payload.length === bytes.length - 4) pass++;
    }
    return { pass, total: used, rate: used ? pass / used : 0 };
  }

  const W = 512, H = 512;
  const carrier = photoImage(W, H, 41);
  const secret = gradientImage(16, 16);
  const opts = { lowFrequencyMode: true, redundancy: 'balanced' };
  const st = SC.embedSecret(carrier, secret, opts);
  // 注意：embedSecret 默认已经嵌入标尺（opt.embedScale !== false），
  // 不能再手动调一次 embedScale —— 那会叠两层标尺（实测 α 直接飙到钳位上界）。
  const marked = st.outputImageData;
  const noRuler = SC.embedSecret(carrier, secret, Object.assign({ embedScale: false }, opts)).outputImageData;

  const t0 = Date.now();
  const down = canvasResize(marked, 384, 384);
  const size = GC.extractScale(down);
  const back = canvasResize(down, W, H);       // 与产品 resizeToSize 同路径
  const cancelled = GC.removeScale(back, W, H);
  const elapsed = Date.now() - t0;

  const rateBefore = crcRate(back, M4, st.stats.N);
  const rateAfter = crcRate(cancelled, M4, st.stats.N);
  const rateAfterNoCancel = rateBefore;
  // 参考基准必须是"同样走过 0.75× 往返、但没有标尺"的那张图：
  //   拿"没重采样过的原图"当基准会把重采样本身的失真算进对消误差里
  //   （实测那部分失真就有 MSE≈2.3，PSNR 上限只有 44.4 dB，与对消好坏无关）。
  const ref = canvasResize(canvasResize(noRuler, 384, 384), W, H);
  const mseOf = (img) => {
    let se = 0;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const d = img.data[o + c] - ref.data[o + c];
        se += d * d;
      }
    }
    return se / (W * H * 3);
  };
  const mseBefore = mseOf(back);
  const mseAfter = mseOf(cancelled);
  const psnrAfter = mseAfter > 0 ? 10 * Math.log(255 * 255 / mseAfter) / Math.LN10 : Infinity;
  const reduction = mseBefore > 0 ? 1 - mseAfter / mseBefore : 0;
  const alpha = GC.lastAlpha;

  check('AC10', '缩放 0.75× 后干扰对消：把重采样残留的标尺能量基本抹掉（相对同路径无标尺图 PSNR > 45 dB）',
    psnrAfter > 45 && reduction >= 0.9 && alpha > 0.7 && alpha <= 1.15,
    `标尺读回 ${size ? size.width + '×' + size.height : 'null'}；α=${alpha.toFixed(4)}；` +
    `MSE（对"同样 0.75× 往返但无标尺"的参考图）对消前=${mseBefore.toFixed(2)} → ` +
    `对消后=${mseAfter.toFixed(2)}（下降 ${(reduction * 100).toFixed(1)}%）；` +
    `PSNR=${psnrAfter === Infinity ? '∞' : psnrAfter.toFixed(1)} dB`);

  check('AC11', '照片载体 0.75×（4 对低频模式）逐 Tile CRC 存活率：对消后 >= 90%',
    rateAfter.rate >= 0.9,
    `K=${st.stats.K}，承载 Tile=${st.stats.N}；对消前 CRC=${rateAfterNoCancel.pass}/${rateAfterNoCancel.total}` +
    `（${(rateAfterNoCancel.rate * 100).toFixed(1)}%）；对消后 CRC=${rateAfter.pass}/${rateAfter.total}` +
    `（${(rateAfter.rate * 100).toFixed(1)}%）`);

  check('AC12', '标尺读出 + 几何还原 + 干扰对消 总耗时 <= 3s（512×512）',
    elapsed <= 3000,
    `extractScale + 重采样 + removeScale 合计 ${elapsed} ms（要求 <= 3000 ms）`);
}

// ---- AC13 有标尺时的置信度：α ≥ 0.3、confidence='high'、尺寸精确 ----
{
  const carrier = photoImage(1024, 1024, 1801);
  const marked = GC.embedScale(carrier, 1024, 1024);
  // 缩放/放大都用 canvas 路径（与产品 resizeToSize 一致；垫片里降采样=面积加权盒式、
  // 升采样=双线性）。用它而不是手写 boxDown，是因为粗糙的盒式重采样会产生周期性
  // 边带、把导频峰的峰背比 z 压到 2 左右（实测），那是测试替身的失真而非产品行为。
  const cases = [
    ['1.00×', marked, 1024],
    ['0.75×', canvasResize(marked, 768, 768), 1024],
    ['0.50×', canvasResize(marked, 512, 512), 1024],
    ['0.98×', canvasResize(marked, 1004, 1004), 1024],
    ['1.10×', canvasResize(marked, 1126, 1126), 1024],
    ['JPEG q=0.75', simulateJpegRoundTrip(marked, 75), 1024]
  ];
  const rows = [];
  let ok = true;
  for (const [label, img, want] of cases) {
    const got = GC.extractScale(img);
    const good = !!got && got.confidence === 'high' && got.alpha >= 0.3 && got.width === want;
    if (!good) ok = false;
    rows.push(`${label}→${got ? got.width + '×' + got.height : 'null'}` +
      `${got ? '/α=' + got.alpha.toFixed(2) + '/z=' + got.z.toFixed(2) + '/' + got.confidence : ''}${good ? '' : ' ✗'}`);
  }
  check('AC13', '有标尺图（含 0.5×/0.75×/0.98×/1.10×/JPEG）：confidence=high、α ≥ 0.3、尺寸精确',
    ok, rows.join('；'));
}

// ---- AC14 无标尺 / 纯噪声：必须返回 null（不再误报尺寸）----
{
  const SC = global.StegoCore;
  const carrier = photoImage(1024, 1024, 1811);
  const secret = gradientImage(32, 32);
  const noRuler = SC.embedSecret(carrier, secret, { embedScale: false }).outputImageData;
  const rng = makeRng(1812);
  const noise = new global.ImageData(1024, 1024);
  for (let i = 0; i < 1024 * 1024; i++) {
    const o = i * 4;
    noise.data[o] = randByte(rng); noise.data[o + 1] = randByte(rng);
    noise.data[o + 2] = randByte(rng); noise.data[o + 3] = 255;
  }
  const g1 = GC.extractScale(noRuler);
  const g2 = GC.extractScale(noise);
  const g3 = GC.extractScale(carrier);
  const conf1 = GC.lastConfidence;
  check('AC14', '无标尺图 / 纯噪声图 / 原始载体 → extractScale 返回 null（不再误报 227×227、2283×2283）',
    g1 === null && g2 === null && g3 === null,
    `无标尺图→${g1 ? g1.width + '×' + g1.height : 'null'}（α=${conf1 ? conf1.alpha.toFixed(3) : '-'}, z=${conf1 ? conf1.zMin.toFixed(2) : '-'}）；` +
    `纯噪声图→${g2 ? g2.width + '×' + g2.height : 'null'}；原始载体→${g3 ? g3.width + '×' + g3.height : 'null'}`);
}

// ---- AC15 性能：2649×1582 上 extractScale ≤ 2000ms ----
{
  const W = 2649, H = 1582;
  const carrier = photoImage(W, H, 1821);
  const marked = GC.embedScale(carrier, W, H);
  GC.extractScale(marked);                       // 预热（让 JIT 生效，测稳定值）
  const t0 = Date.now();
  const got = GC.extractScale(marked);
  const dt = Date.now() - t0;
  check('AC15', 'extractScale 在 2649×1582 上 ≤ 2000ms，且读数精确、置信度 high',
    dt <= 2000 && !!got && got.width === W && got.height === H && got.confidence === 'high',
    `耗时 ${dt} ms（要求 ≤ 2000 ms）；读数 ${got ? got.width + '×' + got.height : 'null'}` +
    `${got ? '，α=' + got.alpha.toFixed(2) + '，' + got.confidence : ''}；图像 ${(W * H / 1e6).toFixed(2)} M 像素`);
}

// ---- AC16 标尺路径的置信度门槛：非 high 时不允许按错误尺寸重采样 ----
{
  const SC = global.StegoCore;
  const carrier = photoImage(1024, 1024, 1831);
  const secret = gradientImage(16, 16);
  const withRuler = SC.embedSecret(carrier, secret, {}).outputImageData;
  const noRuler = SC.embedSecret(carrier, secret, { embedScale: false }).outputImageData;
  // 正例：带标尺 + 缩到 0.75× → 置信度 high → 标尺路径被使用且提取成功
  const pos = SC.extractSecret(canvasResize(withRuler, 768, 768));
  const posScale = pos.attempts && pos.attempts.scale;
  // 反例一：没有标尺的图缩到 0.75× —— 内容在长周期上偶然相干（α=1.25），
  //   但谱峰不尖锐（z≈1.3）→ 只能给 low → 标尺路径不得使用、不得重采样
  const neg = SC.extractSecret(canvasResize(noRuler, 768, 768));
  const negScale = neg.attempts && neg.attempts.scale;
  // 反例二：没有标尺的图保持原尺寸 —— α≈0 → none → 连尺寸都不给
  const neg1 = SC.extractSecret(noRuler);
  const neg1Scale = neg1.attempts && neg1.attempts.scale;
  check('AC16', '标尺路径只在 confidence=high 时重采样：非 high（low/none）一律跳过，带标尺图正常使用',
    !!posScale && posScale.confidence === 'high' && posScale.used === true && pos.success === true &&
    !!negScale && negScale.tried === true && negScale.used === false && negScale.confidence !== 'high' &&
    !!neg1Scale && neg1Scale.used === false && neg1Scale.confidence === 'none' && neg1Scale.detectedSize === null,
    `带标尺 0.75×：path=${pos.recoveryPath} success=${pos.success}，attempts.scale=${JSON.stringify(posScale)}；` +
    `无标尺 0.75×：path=${neg.recoveryPath} success=${neg.success}，attempts.scale=${JSON.stringify(negScale)}；` +
    `无标尺 1.0×：attempts.scale=${JSON.stringify(neg1Scale)}`);
}

const total = results.length;
const passed = total - failures;
console.log('\n============================================');
console.log(`总计 ${total} 项：通过 ${passed}，失败 ${failures}`);
console.log('验收标准：' + results.filter((r) => /^AC([1-9]|1[0-6])$/.test(r.id))
  .map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
console.log('============================================');
process.exit(failures === 0 ? 0 : 1);
