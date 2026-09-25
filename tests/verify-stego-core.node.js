/**
 * verify-stego-core.node.js —— js/stego-core.js 端到端自测（v2，Node 零第三方依赖）
 *
 * v2 变化：秘密图先用 JPEG 压缩再嵌入，单 Tile 载荷 24→48 字节，新增容错档位与自动缩放。
 * 因此判定标准也从"还原像素逐字节一致"改为"**JPEG 载荷逐字节一致**"
 * （JPEG 是有损压缩，还原像素本就不该与原图完全相同）。
 *
 * Node 里没有 canvas，所以：
 *   · 用 tests/jpeg-encode.js 注入真实 JPEG 编码器（window.__STEGO_JPEG_ENCODE__）
 *   · 提取端按契约降级：不做 JPEG 解码，直接返回字节流（AC18 验证这条路径）
 *
 * 运行： node tests/verify-stego-core.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 依赖顺序与浏览器 <script> 顺序一致
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'stego-core.js']
  .forEach((f) => require(path.join(__dirname, '..', 'js', f)));

const { encodeJpeg } = require('./jpeg-encode.js');
const { simulateJpegRoundTrip } = require('./jpeg-sim.js');

const SC = global.StegoCore;
const IU = global.ImageUtils;
const Packet = global.Packet;
if (!SC || !IU || !Packet) {
  console.error('致命错误：StegoCore / ImageUtils / Packet 未定义');
  process.exit(1);
}

// Node 端注入 JPEG 编码器（浏览器会用 canvas.toDataURL，不需要这个钩子）
global.__STEGO_JPEG_ENCODE__ = function (imageData, quality01, keepColor) {
  return encodeJpeg(imageData, Math.round(quality01 * 100), keepColor);
};

// ============================================================
// 工具
// ============================================================
const results = [];
let failures = 0;

function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}\n        ${detail}`);
}

function assertThrows(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const randByte = (rng) => rng() >>> 24;

function makeNoiseCarrier(w, h, seed) {
  const rng = makeRng(seed);
  const img = new global.ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    img.data[o] = randByte(rng);
    img.data[o + 1] = randByte(rng);
    img.data[o + 2] = randByte(rng);
    img.data[o + 3] = 255;
  }
  return img;
}

/** 简单图案秘密图（棋盘 + 斜纹），JPEG 压得比较小 */
function makePatternSecret(w, h, seed) {
  const rng = makeRng(seed);
  const img = new global.ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let v = ((((x >> 1) + (y >> 1)) & 1) === 1) ? 235 : 20;
      if (((x + y) & 7) < 2) v = v > 128 ? 70 : 190;
      v = Math.max(0, Math.min(255, v + (randByte(rng) % 9) - 4));
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
    }
  }
  return img;
}

/** "照片感"秘密图：平滑渐变 + 几个色块 + 轻微噪声（JPEG 压缩率接近真实照片） */
function makePhotoLikeSecret(w, h, seed, colorful) {
  const rng = makeRng(seed);
  const img = new global.ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const base = 40 + 140 * (x / w) + 60 * (y / h);
      const stripe = 22 * Math.sin(x / 23) * Math.cos(y / 31);
      const blob = (Math.abs(x - w * 0.35) < w * 0.18 && Math.abs(y - h * 0.4) < h * 0.22) ? 45 : 0;
      const v = Math.max(0, Math.min(255, base + stripe + blob + (randByte(rng) % 7) - 3));
      if (colorful) {
        img.data[o] = v;
        img.data[o + 1] = Math.max(0, Math.min(255, v * 0.75 + 30));
        img.data[o + 2] = Math.max(0, Math.min(255, 255 - v * 0.6));
      } else {
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v;
      }
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function snapshot(img) { return Uint8ClampedArray.from(img.data); }
function sameAs(img, snap) {
  if (img.data.length !== snap.length) return false;
  for (let i = 0; i < snap.length; i++) if (img.data[i] !== snap[i]) return false;
  return true;
}
function cloneImageData(img) {
  return new global.ImageData(Uint8ClampedArray.from(img.data), img.width, img.height);
}
function pct(v) { return (v * 100).toFixed(2) + '%'; }
function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

/** 判定"秘密载荷是否被完整还原"：JPEG 字节流 CRC32 必须与嵌入时一致 */
function payloadOk(res, stats) {
  return !!(res.success && res.secretJpegBytes &&
    res.secretJpegBytes.length === stats.secretJpegBytes &&
    Packet.crc32(res.secretJpegBytes) === stats.secretJpegCrc32);
}

function greenTileRects(maskImageData) {
  const out = [];
  for (const t of IU.splitIntoTiles(maskImageData, 64)) {
    if (t.width !== 64 || t.height !== 64) continue;
    if (t.data.data[0] === 0 && t.data.data[1] === 255) {
      out.push({ x: t.x, y: t.y, width: 64, height: 64 });
    }
  }
  return out;
}

function blackenRects(img, rects, value = 0) {
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.height && y < img.height; y++) {
      for (let x = r.x; x < r.x + r.width && x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        img.data[o] = value; img.data[o + 1] = value; img.data[o + 2] = value; img.data[o + 3] = 255;
      }
    }
  }
}
function blackenHalf(img, axis, side) {
  const out = cloneImageData(img);
  if (axis === 'x') {
    const x0 = side === 'left' ? 0 : Math.floor(out.width / 2);
    const w = Math.floor(out.width / 2);
    blackenRects(out, [{ x: x0, y: 0, width: w, height: out.height }]);
  } else {
    const y0 = side === 'top' ? 0 : Math.floor(out.height / 2);
    const h = Math.floor(out.height / 2);
    blackenRects(out, [{ x: 0, y: y0, width: out.width, height: h }]);
  }
  return out;
}
function cropImage(img, sx, sy, sw, sh) {
  const out = new global.ImageData(sw, sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const s = ((y + sy) * img.width + (x + sx)) * 4;
      const d = (y * sw + x) * 4;
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

console.log('=== stego-core.js v2 端到端自测（Node ' + process.version + '）===');
console.log('载荷：48B/Tile（seq2 + K2 + symbol40 + CRC4）· 秘密图 JPEG 压缩 · 可配冗余档位\n');

// ============================================================
// AC0 契约
// ============================================================
{
  const contract = { toGrayscale: 1, analyzeCapacity: 3, embedSecret: 3, extractSecret: 2, decodeSecretImage: 1 };
  const missing = Object.keys(contract).filter((k) => typeof SC[k] !== 'function');
  const arityBad = Object.keys(contract).filter((k) => typeof SC[k] === 'function' &&
    SC[k].length !== contract[k]).map((k) => `${k}(期望${contract[k]},实际${SC[k].length})`);
  const saved = global.ImageUtils;
  global.ImageUtils = undefined;
  const missingDep = assertThrows(() => SC.analyzeCapacity(new global.ImageData(8, 8), 0));
  global.ImageUtils = saved;
  check('AC0', 'window.StegoCore 契约：5 个函数形参一致；依赖缺失时给出明确提示',
    missing.length === 0 && arityBad.length === 0 && missingDep && /依赖缺失/.test(missingDep.message),
    `缺失=[${missing.join(', ')}]；形参不符=[${arityBad.join(', ')}]；` +
    `摘掉 ImageUtils 后报错="${missingDep && missingDep.message}"`);
}

// ============================================================
// AC1 容量分析（v2：入参是 JPEG 字节数）
// ============================================================
{
  const a1 = SC.analyzeCapacity(makeNoiseCarrier(512, 512, 11), 100);
  const a2 = SC.analyzeCapacity(makeNoiseCarrier(256, 256, 12), 2000);
  const ok1 = a1.totalTiles === 64 && a1.alignedTiles === 64 && a1.texturedTiles === 64 &&
    a1.K === 3 && a1.N === 6 && a1.fits === true && a1.symbolSize === 40;
  const ok2 = a2.alignedTiles === 16 && a2.K === 51 && a2.N === 102 && a2.fits === false;
  check('AC1', 'analyzeCapacity（v2）：512²/100B → K=3,N=6,fits=true；256²/2000B → K=51,N=102,fits=false',
    ok1 && ok2,
    `512×512：totalTiles=${a1.totalTiles}, aligned=${a1.alignedTiles}, textured=${a1.texturedTiles}, ` +
    `K=${a1.K}, N=${a1.N}, symbolSize=${a1.symbolSize}, fits=${a1.fits}, maxSecretBytes=${a1.maxSecretBytes}（JPEG 字节）；` +
    `256×256：aligned=${a2.alignedTiles}, K=${a2.K}, N=${a2.N}, fits=${a2.fits}`);
}

// ============================================================
// JPEG 编码器自检（Node 侧替身的可信度）
// ============================================================
{
  const grad = makePhotoLikeSecret(256, 256, 301, false);
  const noise = makeNoiseCarrier(256, 256, 302);
  const g75 = encodeJpeg(grad, 75, false);
  const n75 = encodeJpeg(noise, 75, false);
  const c75 = encodeJpeg(makePhotoLikeSecret(256, 256, 303, true), 75, true);
  const raw = 256 * 256;
  const structOk = g75[0] === 0xFF && g75[1] === 0xD8 && g75[g75.length - 2] === 0xFF && g75[g75.length - 1] === 0xD9;
  const plausible = g75.length < raw * 0.5 && n75.length > g75.length && c75.length > g75.length;
  check('E0', 'JPEG 编码器自检：结构合法 + 大小合理（照片感 << 噪声，彩色 > 灰度）',
    structOk && plausible,
    `256×256 原始 ${kb(raw)}：照片感灰度 JPEG=${kb(g75.length)}（压缩率 ${pct(g75.length / raw)}）；` +
    `随机噪声=${kb(n75.length)}；彩色=${kb(c75.length)}；SOI/EOI 合法=${structOk}`);
}

// ============================================================
// AC2 端到端（v2：JPEG 载荷逐字节一致）
// ============================================================
let ac2 = null;
{
  const carrier = makeNoiseCarrier(512, 512, 21);
  const secret = makePatternSecret(16, 16, 22);
  const r = SC.embedSecret(carrier, secret);
  const ex = SC.extractSecret(r.outputImageData);
  const ok = payloadOk(ex, r.stats);
  ac2 = { carrier, secret, stego: r.outputImageData, stats: r.stats };
  check('AC2', '端到端：512×512 载体 + 16×16 秘密图，JPEG 载荷逐字节一致',
    ok,
    `K=${r.stats.K}, N=${r.stats.N}, symbolSize=${r.stats.symbolSize}, textured=${r.stats.texturedTiles}, ` +
    `JPEG=${r.stats.secretJpegBytes} 字节（${r.stats.secretKeepColor ? '彩色' : '灰度'} q=${r.stats.secretJpegQuality}）；` +
    `提取 success=${ex.success}, validTiles=${ex.validTiles}/${ex.totalTiles}, K_effective=${ex.K_effective}, ` +
    `载荷 CRC 一致=${ok}；解码能力=${ex.decodeSupported}`);
}

// ============================================================
// AC3 PNG 无损往返
// ============================================================
{
  const { pngEncode, pngDecode } = require('./png-codec.js');
  const png = pngEncode(ac2.stego.width, ac2.stego.height, ac2.stego.data);
  const dec = pngDecode(png);
  const lossless = dec.data.every((v, i) => v === ac2.stego.data[i]);
  const back = new global.ImageData(new Uint8ClampedArray(dec.data), dec.width, dec.height);
  const ex = SC.extractSecret(back);
  check('AC3', 'PNG 无损往返后提取：载荷逐字节一致',
    lossless && payloadOk(ex, ac2.stats),
    `PNG ${kb(png.length)}；解码与嵌入像素一致=${lossless}；validTiles=${ex.validTiles}/${ex.totalTiles}, ` +
    `K_effective=${ex.K_effective}, 载荷一致=${payloadOk(ex, ac2.stats)}`);
}

// ============================================================
// AC4 JPEG Q90（对隐写图再压缩）
// ============================================================
{
  const carrier = makeNoiseCarrier(1024, 1024, 41);
  const secret = makePatternSecret(32, 32, 42);
  const r = SC.embedSecret(carrier, secret);
  const j90 = simulateJpegRoundTrip(r.outputImageData, 90);
  const ex = SC.extractSecret(j90);
  const ok = payloadOk(ex, r.stats) && ex.validTiles >= r.stats.K;
  check('AC4', '隐写图经 JPEG Q90 后提取：有效 Tile ≥ K 且载荷一致',
    ok,
    `K=${r.stats.K}, N=${r.stats.N}；Q90 后 validTiles=${ex.validTiles}/${ex.totalTiles}（要求 ≥ K=${r.stats.K}），` +
    `K_effective=${ex.K_effective}, 载荷一致=${payloadOk(ex, r.stats)}`);
}

// ============================================================
// AC5 / AC6 涂黑 50% / 50%+1 个已用 Tile
// ============================================================
{
  const carrier = makeNoiseCarrier(1024, 1024, 51);
  const secret = makePatternSecret(32, 32, 52);
  const r = SC.embedSecret(carrier, secret);
  const rects = greenTileRects(SC.extractSecret(r.outputImageData).debugMask);
  const N = r.stats.N, K = r.stats.K;

  const half = cloneImageData(r.outputImageData);
  blackenRects(half, rects.slice(0, Math.floor(N / 2)));
  const exHalf = SC.extractSecret(half);

  const over = cloneImageData(r.outputImageData);
  blackenRects(over, rects.slice(0, Math.floor(N / 2) + 1));
  const exOver = SC.extractSecret(over);

  check('AC5', `涂黑 N/2=${Math.floor(N / 2)} 个已用 Tile 后仍能解出载荷`,
    payloadOk(exHalf, r.stats),
    `K=${K}, N=${N}；涂黑 ${Math.floor(N / 2)} 个；validTiles=${exHalf.validTiles}, ` +
    `K_effective=${exHalf.K_effective}, success=${exHalf.success}, 载荷一致=${payloadOk(exHalf, r.stats)}`);

  check('AC6', `涂黑 N/2+1=${Math.floor(N / 2) + 1} 个已用 Tile 后应失败`,
    !exOver.success && exOver.secretJpegBytes === null,
    `涂黑 ${Math.floor(N / 2) + 1} 个；validTiles=${exOver.validTiles}（< K=${K}）；` +
    `success=${exOver.success}, secretJpegBytes=${exOver.secretJpegBytes}`);
}

// ============================================================
// AC7 裁切右半边（spread，跑 10 次）
// ============================================================
{
  const RUNS = 10;
  let ok = 0;
  let firstDetail = '';
  for (let i = 0; i < RUNS; i++) {
    const carrier = makeNoiseCarrier(1024, 1024, 610 + i);
    const secret = makePatternSecret(32, 32, 710 + i);
    const r = SC.embedSecret(carrier, secret);
    const cropped = cropImage(r.outputImageData, 0, 0, 512, 1024);
    const ex = SC.extractSecret(cropped);
    const good = payloadOk(ex, r.stats);
    if (good) ok++;
    if (i === 0) {
      firstDetail = `K=${r.stats.K}, N=${r.stats.N}, 裁后 validTiles=${ex.validTiles}/${ex.totalTiles}, ` +
        `K_effective=${ex.K_effective}, success=${ex.success}`;
    }
  }
  check('AC7', `裁掉右半边（同时裁掉一半面积），${RUNS} 次成功率 ≥ 60%`, ok / RUNS >= 0.6,
    `${ok}/${RUNS} = ${pct(ok / RUNS)}；首次数据：${firstDetail}`);
}

// ============================================================
// AC12 / AC13 涂黑左半 / 下半：spread 与 scan 的差异
// ============================================================
{
  const carrier = makeNoiseCarrier(1024, 1024, 811);
  const secret = makePatternSecret(32, 32, 812);

  const rSpread = SC.embedSecret(carrier, secret);
  const exSpread = SC.extractSecret(blackenHalf(rSpread.outputImageData, 'x', 'left'));
  const rScan = SC.embedSecret(carrier, secret, { tileStrategy: 'scan' });
  const exScan = SC.extractSecret(blackenHalf(rScan.outputImageData, 'x', 'left'));

  check('AC12', '涂黑左半（50% 面积）：spread 成功、scan 失败',
    payloadOk(exSpread, rSpread.stats) && !exScan.success,
    `K=${rSpread.stats.K}, N=${rSpread.stats.N}；spread：validTiles=${exSpread.validTiles}, ` +
    `K_effective=${exSpread.K_effective}, success=${exSpread.success}；` +
    `scan：validTiles=${exScan.validTiles}, K_effective=${exScan.K_effective}, success=${exScan.success}`);

  const rSpread2 = SC.embedSecret(carrier, secret);
  const exBottom = SC.extractSecret(blackenHalf(rSpread2.outputImageData, 'y', 'bottom'));
  check('AC13', '涂黑下半（50% 面积）：spread 成功',
    payloadOk(exBottom, rSpread2.stats),
    `K=${rSpread2.stats.K}, N=${rSpread2.stats.N}；validTiles=${exBottom.validTiles}, ` +
    `K_effective=${exBottom.K_effective}, success=${exBottom.success}, 载荷一致=${payloadOk(exBottom, rSpread2.stats)}`);
}

// ============================================================
// AC8 小秘密图 8×8
// ============================================================
{
  const carrier = makeNoiseCarrier(512, 512, 71);
  const secret = makePatternSecret(8, 8, 72);
  const r = SC.embedSecret(carrier, secret);
  const ex = SC.extractSecret(r.outputImageData);
  check('AC8', '边界：秘密图 8×8 完整流程正确',
    payloadOk(ex, r.stats) && r.stats.secretFinalSize.W === 8,
    `K=${r.stats.K}, N=${r.stats.N}, JPEG=${r.stats.secretJpegBytes} 字节；` +
    `validTiles=${ex.validTiles}/${ex.totalTiles}, K_effective=${ex.K_effective}, 载荷一致=${payloadOk(ex, r.stats)}`);
}

// ============================================================
// AC9 容量不足 / 载体太小（v2 会先自动缩放，缩到底仍不行才抛错）
// ============================================================
{
  const carrier = makeNoiseCarrier(256, 256, 81);   // 4×4=16 个 Tile
  const secret = makePatternSecret(64, 64, 82);
  const err = assertThrows(() => SC.embedSecret(carrier, secret));
  const a = SC.analyzeCapacity(carrier, 4000);
  check('AC9', '载体太小：自动缩放到底仍放不下时抛明确错误（含数字）',
    err instanceof Error && /载体太小，无法嵌入/.test(err.message) && /16/.test(err.message) && a.fits === false,
    `抛出 ${err && err.constructor.name}："${err && err.message}"；` +
    `analyzeCapacity(4000B)：K=${a.K}, N=${a.N}, texturedTiles=${a.texturedTiles}, fits=${a.fits}`);
}

// ============================================================
// AC10 不修改入参
// ============================================================
{
  const carrier = makeNoiseCarrier(512, 512, 91);
  const secret = makePatternSecret(16, 16, 92);
  const cSnap = snapshot(carrier), sSnap = snapshot(secret);
  const r = SC.embedSecret(carrier, secret);
  const afterEmbed = sameAs(carrier, cSnap) && sameAs(secret, sSnap);
  const stegoSnap = snapshot(r.outputImageData);
  SC.extractSecret(r.outputImageData);
  const afterExtract = sameAs(r.outputImageData, stegoSnap);
  const distinct = r.outputImageData !== carrier && r.outputImageData.data !== carrier.data;
  check('AC10', '嵌入/提取均不修改入参，输出是全新 ImageData',
    afterEmbed && afterExtract && distinct,
    `嵌入后 carrier 不变=${sameAs(carrier, cSnap)}，secret 不变=${sameAs(secret, sSnap)}；` +
    `提取后隐写图不变=${afterExtract}；输出与载体非同一对象=${distinct}`);
}

// ============================================================
// AC11 K 自描述（随机丢弃 50%）
// ============================================================
{
  const carrier = makeNoiseCarrier(1024, 1024, 101);
  const secret = makePhotoLikeSecret(48, 48, 102, true); // 彩色 JPEG 约 2~3KB → K 落在 50~70
  const r = SC.embedSecret(carrier, secret);
  const rects = greenTileRects(SC.extractSecret(r.outputImageData).debugMask);
  const K = r.stats.K, N = r.stats.N;

  const rng = makeRng(103);
  const shuffled = rects.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng() % (i + 1);
    const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
  }
  const keep = cloneImageData(r.outputImageData);
  blackenRects(keep, shuffled.slice(0, Math.floor(N / 2)));
  const ex = SC.extractSecret(keep);

  check('AC11', 'K 自描述：随机丢弃 50% 符号后 K_effective 仍能正确多数表决',
    ex.K_effective === K && payloadOk(ex, r.stats),
    `嵌入 K=${K}, N=${N}（JPEG ${r.stats.secretJpegBytes} 字节）；随机丢弃 ${Math.floor(N / 2)}/${N}；` +
    `提取 validTiles=${ex.validTiles}, K_effective=${ex.K_effective}（应等于 ${K}）, ` +
    `success=${ex.success}, 载荷一致=${payloadOk(ex, r.stats)}`);
}

// ============================================================
// 附加：边界错误 / 无隐写图 / 非 64 倍数 / 确定性 / 进度 / 源码约束
// ============================================================
{
  const e1 = assertThrows(() => SC.embedSecret(makeNoiseCarrier(256, 256, 1), new global.ImageData(0, 0)));
  const e2 = assertThrows(() => SC.embedSecret(makeNoiseCarrier(256, 256, 1), new global.ImageData(4097, 1)));
  const e3 = assertThrows(() => SC.toGrayscale(null));
  const e4 = assertThrows(() => SC.extractSecret(null));
  const e5 = assertThrows(() => SC.embedSecret(makeNoiseCarrier(512, 512, 1),
    makePatternSecret(16, 16, 2), { redundancy: 'nope' }));
  check('E1', '边界错误：空秘密图 / 尺寸超限 / 非法入参 / 非法冗余档位 均抛明确 Error',
    e1 instanceof Error && /秘密图为空/.test(e1.message) &&
    e2 instanceof Error && /超限/.test(e2.message) &&
    e3 instanceof TypeError && e4 instanceof TypeError && e5 instanceof RangeError,
    `空秘密图 → ${e1 && e1.constructor.name}；4097 宽 → ${e2 && e2.constructor.name}；` +
    `toGrayscale(null) → ${e3 && e3.constructor.name}；extractSecret(null) → ${e4 && e4.constructor.name}；` +
    `redundancy='nope' → ${e5 && e5.constructor.name}`);
}
{
  const ex = SC.extractSecret(makeNoiseCarrier(512, 512, 111));
  const tiles = IU.splitIntoTiles(ex.debugMask, 64);
  let allRed = true;
  for (const t of tiles) {
    if (t.data.data[0] !== 255 || t.data.data[1] !== 0) allRed = false;
  }
  check('E2', '对无隐写的随机图提取：success=false、不抛错、debugMask 全红、alpha=102',
    ex.success === false && ex.secretJpegBytes === null && ex.validTiles === 0 &&
    ex.K_effective === 0 && allRed && ex.debugMask.data[3] === 102,
    `success=${ex.success}, validTiles=${ex.validTiles}, totalTiles=${ex.totalTiles}, ` +
    `K_effective=${ex.K_effective}, 全红=${allRed}, alpha=${ex.debugMask.data[3]}`);
}
{
  const odd = makeNoiseCarrier(300, 200, 122);
  const a = SC.analyzeCapacity(odd, 100);
  const exOdd = SC.extractSecret(odd);
  let gray = 0;
  for (const t of IU.splitIntoTiles(exOdd.debugMask, 64)) {
    if (t.data.data[0] === 128 && t.data.data[1] === 128) gray++;
  }
  check('E3', '非 64 倍数尺寸：边界 Tile 判灰、alignedTiles 只算 64×64',
    a.totalTiles === 20 && a.alignedTiles === 12 && gray === 8,
    `300×200：totalTiles=${a.totalTiles}（=20）, alignedTiles=${a.alignedTiles}（=12）, 灰=${gray}（=8）`);
}
{
  const carrier = makeNoiseCarrier(512, 512, 131);
  const secret = makePatternSecret(16, 16, 132);
  const a = SC.embedSecret(carrier, secret).outputImageData;
  const b = SC.embedSecret(carrier, secret).outputImageData;
  check('E4', '确定性：同输入两次嵌入输出逐字节相同', sameAs(a, b.data),
    `两次输出一致=${sameAs(a, b.data)}`);
}
{
  const phases = { encode: 0, embed: 0, extract: 0, decode: 0 };
  const carrier = makeNoiseCarrier(512, 512, 141);
  const secret = makePatternSecret(16, 16, 142);
  const stego = SC.embedSecret(carrier, secret, {
    onProgress: (p) => { phases[p] = (phases[p] || 0) + 1; }
  }).outputImageData;
  SC.extractSecret(stego, { onProgress: (p) => { phases[p] = (phases[p] || 0) + 1; } });
  check('E5', 'onProgress 四阶段回调（encode/embed/extract/decode）',
    phases.encode > 0 && phases.embed > 0 && phases.extract > 0 && phases.decode > 0,
    `回调次数：encode=${phases.encode}, embed=${phases.embed}, extract=${phases.extract}, decode=${phases.decode}`);
}
{
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'stego-core.js'), 'utf8');
  const esm = (code.match(/(^|\n)\s*(import|export)[\s({]/g) || []).length;
  const req = (code.match(/\brequire\s*\(/g) || []).length;
  const urls = (code.match(/https?:\/\//g) || []).length;
  check('E6', 'stego-core.js 无 import/export、无 require、无外部 URL',
    esm === 0 && req === 0 && urls === 0,
    `import/export=${esm}；require=${req}；外部 URL=${urls}；行数=${code.split('\n').length}`);
}
{
  const a = SC.analyzeCapacity(makeNoiseCarrier(512, 512, 901), 100);
  const b = SC.analyzeCapacity(makeNoiseCarrier(512, 512, 901), 100, { tileStrategy: 'scan' });
  const c = SC.analyzeCapacity(makeNoiseCarrier(512, 512, 901), 100, { redundancy: 'compact' });
  check('E7', "tileStrategy / redundancy 回显与容量联动（compact 容量更大）",
    a.tileStrategy === 'spread' && b.tileStrategy === 'scan' &&
    c.redundancy === 'compact' && c.maxSecretBytes > a.maxSecretBytes,
    `默认：strategy=${a.tileStrategy}, redundancy=${a.redundancy}, maxSecretBytes=${a.maxSecretBytes}；` +
    `scan 回显=${b.tileStrategy}；compact：maxSecretBytes=${c.maxSecretBytes}（标准 ${a.maxSecretBytes}）`);
}
{
  // 门限放宽后，平坦图也应有可用 Tile：方差阈值 60 vs 200 的可用数对比
  const rng = makeRng(911);
  const flat = new global.ImageData(512, 512);
  for (let i = 0; i < 512 * 512; i++) {
    const o = i * 4;
    const v = 100 + (randByte(rng) % 41);   // 均匀分布 [100,140] → 方差约 140
    flat.data[o] = v; flat.data[o + 1] = v; flat.data[o + 2] = v; flat.data[o + 3] = 255;
  }
  const t60 = SC.analyzeCapacity(flat, 100).texturedTiles;
  const t200 = SC.analyzeCapacity(flat, 100, { varianceThreshold: 200 }).texturedTiles;
  check('E8', '阈值放宽（默认 60）让更多 Tile 可用：中等对比图可用 Tile 数提升',
    t60 > t200,
    `中等对比噪声图（方差约 140）：threshold=60 → 可用 ${t60} 个；threshold=200 → ${t200} 个`);
}

// ============================================================
// AC18 Node 降级路径：无 JPEG 解码能力时不报错
// ============================================================
{
  const ex = SC.extractSecret(ac2.stego);
  const canDecode = typeof createImageBitmap !== 'undefined';
  let decodeErr = null;
  SC.decodeSecretImage(ex.secretJpegBytes).then(
    () => { decodeErr = 'resolved'; },
    (e) => { decodeErr = e; }
  );
  setTimeout(() => {
    const ok = !canDecode
      ? (ex.success && ex.secretJpegBytes && ex.decodeSupported === false &&
         ex.secretImageData === null && decodeErr && /decodeSecretImage/.test(decodeErr.message))
      : true;
    check('AC18', 'Node 环境无 createImageBitmap：提取只返回字节流不报错，解码助手给出明确拒绝',
      ok,
      `createImageBitmap 可用=${canDecode}；extractSecret success=${ex.success}, ` +
      `decodeSupported=${ex.decodeSupported}, secretImageData=${ex.secretImageData}, ` +
      `secretJpegBytes=${ex.secretJpegBytes ? ex.secretJpegBytes.length + ' 字节' : 'null'}；` +
      `decodeSecretImage → ${decodeErr && decodeErr.message ? decodeErr.message : decodeErr}`);

    // ==========================================================
    // AC3-容量：2000×2000 载体能藏多大的秘密图（关键指标）
    // ==========================================================
    const carrier = makeNoiseCarrier(2000, 2000, 1001);   // 31×31 = 961 个对齐 Tile
    const secret = makePhotoLikeSecret(512, 512, 1002, false); // 512×512 灰度"照片"
    const t0 = Date.now();
    let r = null, err = null;
    try {
      r = SC.embedSecret(carrier, secret);                 // 默认 standard 冗余
    } catch (e) {
      err = e;
    }
    const tEmbed = Date.now() - t0;
    const ex2 = r ? SC.extractSecret(r.outputImageData) : null;
    const tTotal = Date.now() - t0;
    check('AC3', '容量提升关键指标：2000×2000 载体 + 512×512 灰度图 → 成功（必要时自动缩放）',
      !!r && payloadOk(ex2, r.stats),
      (r
        ? `载体对齐 Tile=${SC.analyzeCapacity(carrier, 0).alignedTiles}；K=${r.stats.K}, N=${r.stats.N}, ` +
          `使用 Tile=${r.stats.usedTiles}；秘密图原始 ${r.stats.secretOriginalSize.W}×${r.stats.secretOriginalSize.H} ` +
          `→ 最终 ${r.stats.secretFinalSize.W}×${r.stats.secretFinalSize.H}` +
          `（自动缩放=${r.stats.secretAutoResized}）；JPEG ${kb(r.stats.secretJpegBytes)}；` +
          `提取 validTiles=${ex2.validTiles}, 载荷一致=${payloadOk(ex2, r.stats)}；` +
          `嵌入+提取耗时 ${tTotal} ms（嵌入 ${tEmbed} ms）`
        : `抛出：${err && err.message}`));

    // ==========================================================
    // AC4-冗余档位：三档容量对比 + 端到端
    // ==========================================================
    const tiers = ['standard', 'balanced', 'compact'];
    const rows = [];
    let allTierOk = true;
    for (const t of tiers) {
      const a = SC.analyzeCapacity(carrier, 20000, { redundancy: t });
      const rr = SC.embedSecret(carrier, makePatternSecret(64, 64, 1003 + t.length), { redundancy: t });
      const ee = SC.extractSecret(rr.outputImageData);
      if (!payloadOk(ee, rr.stats)) allTierOk = false;
      rows.push(`${t}(N=${a.redundancyFactor}K)：可用秘密 JPEG 上限 ${kb(a.maxSecretBytes)}，` +
        `本次 K=${rr.stats.K}/N=${rr.stats.N}，提取 validTiles=${ee.validTiles} 载荷一致=${payloadOk(ee, rr.stats)}`);
    }
    check('AC4', '三种冗余档位：容量递增且端到端均成功', allTierOk,
      rows.join('；'));

    // ==========================================================
    // AC5-自动缩放：小载体 + 大秘密图 → 必须自动缩小并成功
    // ==========================================================
    const smallCarrier = makeNoiseCarrier(512, 512, 1011);   // 64 个 Tile
    const bigSecret = makePhotoLikeSecret(512, 512, 1012, false);
    const rr2 = SC.embedSecret(smallCarrier, bigSecret, { redundancy: 'compact' });
    const ee2 = SC.extractSecret(rr2.outputImageData);
    check('AC5', '自动缩放：512×512 载体 + 512×512 秘密图 → 自动缩小后仍成功',
      rr2.stats.secretAutoResized === true &&
      rr2.stats.secretFinalSize.W < rr2.stats.secretOriginalSize.W &&
      payloadOk(ee2, rr2.stats),
      `原始 ${rr2.stats.secretOriginalSize.W}×${rr2.stats.secretOriginalSize.H} → ` +
      `最终 ${rr2.stats.secretFinalSize.W}×${rr2.stats.secretFinalSize.H}（缩放=${rr2.stats.secretAutoResized}）；` +
      `JPEG ${kb(rr2.stats.secretJpegBytes)}；K=${rr2.stats.K}, N=${rr2.stats.N}（载体只有 64 个 Tile）；` +
      `提取 validTiles=${ee2.validTiles}, 载荷一致=${payloadOk(ee2, rr2.stats)}`);

    // ==========================================================
    // E9 公开选项全量传入（回归防护）
    // ----------------------------------------------------------
    // 【为什么必须测这一条】embedSecret 的 secretJpegQuality 分支藏在
    //   isFiniteNum(opt.secretJpegQuality) ? clamp(...) : 默认值
    // 的三元里，而 stego-core.js 曾经漏定义 clamp：只要调用方传了
    // secretJpegQuality 就会 ReferenceError（embed.html 正是这么传的）。
    // 因为此前所有测试都没传这个参数，测试全绿却在浏览器里必崩。
    // 这里把所有公开选项一次性传进去，把"只有页面才会走到的分支"纳入测试。
    // ==========================================================
    {
      const optCarrier = makeNoiseCarrier(1024, 1024, 1101);
      const optSecret = makePatternSecret(32, 32, 1102);
      const run = (opts) => {
        try { return { ok: true, r: SC.embedSecret(optCarrier, optSecret, opts) }; }
        catch (e) { return { ok: false, e }; }
      };
      const q1 = run({
        secretJpegQuality: 0.6, secretKeepColor: false, varianceThreshold: 20,
        tileStrategy: 'scan', redundancy: 'compact', lowFrequencyMode: true,
        embedScale: false, onProgress: function () {}
      });
      const q2 = run({ secretJpegQuality: 5 });      // 超上界 → 夹到 1
      const q3 = run({ secretJpegQuality: -1 });     // 超下界 → 夹到 0.01
      const q4 = run({ secretJpegQuality: 'x' });    // 非数值 → 走默认
      const ex1 = q1.ok ? SC.extractSecret(q1.r.outputImageData) : null;
      const payloadGood = q1.ok && payloadOk(ex1, q1.r.stats);
      const ok = q1.ok && q2.ok && q3.ok && q4.ok &&
        q1.r.stats.secretJpegQuality === 0.6 && q1.r.stats.secretKeepColor === false &&
        q2.r.stats.secretJpegQuality === 1 && q3.r.stats.secretJpegQuality === 0.01 &&
        q4.r.stats.secretJpegQuality === SC.CONST.DEFAULT_SECRET_JPEG_QUALITY &&
        payloadGood;
      check('E9', '公开选项全量传入不抛错（含 secretJpegQuality 分支）：质量夹取正确且端到端可还原',
        ok,
        `全选项：q=${q1.ok ? q1.r.stats.secretJpegQuality : '抛错 ' + q1.e.message}，` +
        `灰度=${q1.ok ? !q1.r.stats.secretKeepColor : '-'}，` +
        `提取载荷一致=${payloadGood}；q=5→${q2.ok ? q2.r.stats.secretJpegQuality : '抛错'}，` +
        `q=-1→${q3.ok ? q3.r.stats.secretJpegQuality : '抛错'}，` +
        `q='x'→${q4.ok ? q4.r.stats.secretJpegQuality : '抛错'}（默认 ${SC.CONST.DEFAULT_SECRET_JPEG_QUALITY}）`);
    }

    // ==========================================================
    // E10 attempts 字段（失败口径修正的回归防护）
    // ----------------------------------------------------------
    // 【为什么必须测】旧实现失败时返回"最后尝试的模式"（MODE_4）的结果，
    // 而 6 对嵌入的图用 MODE_4 读永远是 0 个有效块 —— 界面上于是恒显示
    // "0/N 全红"，与损坏程度无关，严重误导使用者。现在要求：
    //   ① 无论成功失败都带 attempts，且四个子字段齐全；
    //   ② 失败时主结果取**有效块更多**的那个模式。
    // ==========================================================
    {
      const carrier = makeNoiseCarrier(1024, 1024, 1301);
      const secret = makePatternSecret(32, 32, 1302);
      const r = SC.embedSecret(carrier, secret);           // 6 对（默认）
      const good = SC.extractSecret(r.outputImageData);
      // 涂黑 60% 承载块：必然失败，但 6 对模式仍应读出几十个有效块
      const rects = greenTileRects(SC.extractSecret(r.outputImageData).debugMask);
      const broken = cloneImageData(r.outputImageData);
      blackenRects(broken, rects.slice(0, Math.ceil(rects.length * 0.6)));
      const bad = SC.extractSecret(broken);

      const okShape = !!(bad.attempts && bad.attempts.normal6 && bad.attempts.normal4 &&
        bad.attempts.phase && bad.attempts.scale &&
        typeof bad.attempts.normal6.validTiles === 'number' &&
        typeof bad.attempts.normal6.K_effective === 'number' &&
        typeof bad.attempts.normal4.validTiles === 'number' &&
        typeof bad.attempts.normal4.K_effective === 'number' &&
        // tried 字段是界面文案的依据：只有真跑过的那条才允许写"读出 N 块"，
        // 没跑过的那条要说"已成功，未再试"，否则又会误导成"该模式读出 0 块"。
        bad.attempts.normal6.tried === true && bad.attempts.normal4.tried === true &&
        good.attempts.normal6.tried === true && good.attempts.normal4.tried === false &&
        typeof bad.attempts.phase.tried === 'boolean' &&
        typeof bad.attempts.phase.bestRate === 'number' &&
        typeof bad.attempts.scale.tried === 'boolean' &&
        typeof bad.attempts.scale.confidence === 'string' &&
        typeof bad.attempts.scale.z === 'number' &&
        typeof bad.attempts.scale.alpha === 'number');
      const bestMode = bad.mode === 'mode6' && bad.validTiles === bad.attempts.normal6.validTiles &&
        bad.attempts.normal6.validTiles > bad.attempts.normal4.validTiles;
      check('E10', 'attempts 结构完整；失败时主结果取有效块更多的模式（不再恒为 0）',
        good.success && okShape && bestMode && bad.success === false,
        `成功结果带 attempts=${!!good.attempts}；失败结果 attempts={normal6:${bad.attempts.normal6.validTiles}块/K${bad.attempts.normal6.K_effective}, ` +
        `normal4:${bad.attempts.normal4.validTiles}块/K${bad.attempts.normal4.K_effective}, ` +
        `phase:tried=${bad.attempts.phase.tried}/bestRate=${pct(bad.attempts.phase.bestRate)}, ` +
        `scale:tried=${bad.attempts.scale.tried}/confidence=${bad.attempts.scale.confidence}}；` +
        `主结果 mode=${bad.mode} validTiles=${bad.validTiles}（旧实现会显示 0）`);
    }

    // ==========================================================
    // AC14 相位搜索：7 种裁切偏移 × 3 张载体图 = 21 次全部通过
    // ----------------------------------------------------------
    // 【为什么是 21 次】旧实现每个相位只粗探 2 个块，且采样点是确定性的
    // （t=0 与 t=总数/2），于是不同裁切量采到**同一批原图块**；这两个块不承载
    // 数据时，真相位在粗探阶段恒为 0/2，永远进不了精探 —— 实测当时 7/7 全失败。
    // 现在粗探 8 块且采每段中点，要求对多张载体都能稳定找到真相位
    // （单张载体容易"碰巧过"，所以这里用 3 张纹理分布不同的载体）。
    // ==========================================================
    {
      // 三张载体的纹理分布刻意做得不一样（相位搜索的成败与"哪几块承载数据"强相关）
      const carriers = [
        ['纯噪声载体', makeNoiseCarrier(512, 512, 1401)],
        ['强弱相间的噪声载体', (function () {
          const rng = makeRng(1403);
          const img = new global.ImageData(512, 512);
          for (let y = 0; y < 512; y++) {
            for (let x = 0; x < 512; x++) {
              const o = (y * 512 + x) * 4;
              const amp = 0.35 + 0.65 * Math.abs(Math.sin(x / 37) * Math.cos(y / 53));
              const v = Math.round(128 + (randByte(rng) - 128) * amp);
              img.data[o] = v;
              img.data[o + 1] = Math.max(0, Math.min(255, v * 0.9 + 12));
              img.data[o + 2] = 255 - v;
              img.data[o + 3] = 255;
            }
          }
          return img;
        })()],
        ['块状纹理载体', (function () {
          const rng = makeRng(1404);
          const img = new global.ImageData(512, 512);
          const lw = 8, lh = 8;
          const blk = new Float32Array((512 / lw) * (512 / lh));
          for (let i = 0; i < blk.length; i++) blk[i] = randByte(rng);
          for (let y = 0; y < 512; y++) {
            for (let x = 0; x < 512; x++) {
              const o = (y * 512 + x) * 4;
              const v = blk[Math.floor(y / lh) * (512 / lw) + Math.floor(x / lw)];
              img.data[o] = v;
              img.data[o + 1] = (v * 1.7 + 37) % 256;
              img.data[o + 2] = 255 - v;
              img.data[o + 3] = 255;
            }
          }
          return img;
        })()]
      ];
      const offsets = [8, 16, 24, 32, 40, 48, 56];
      const rows = [];
      let passAll = true, total = 0;
      for (const [cname, carrier] of carriers) {
        const secret = makePatternSecret(16, 16, 1409);
        // 用 standard（N=2K=40）：裁切本身会丢掉边缘的承载块，冗余太紧会出现
        // "相位找对了但符号数不够 K"的假失败（compact 的 N=25 实测正是如此）。
        const r = SC.embedSecret(carrier, secret, { redundancy: 'standard' });
        const base = SC.extractSecret(r.outputImageData);
        if (!payloadOk(base, r.stats)) { passAll = false; rows.push(`${cname}: 基线提取失败`); continue; }
        const per = [];
        for (const off of offsets) {
          total++;
          const cropped = cropImage(r.outputImageData, off, off, 512 - 2 * off, 512 - 2 * off);
          const ex = SC.extractSecret(cropped);
          const wantPhase = (64 - off) % 64;
          const phaseOk = ex.phaseOffset && ex.phaseOffset.dx === wantPhase && ex.phaseOffset.dy === wantPhase;
          const ok = ex.success && ex.recoveryPath === 'phase' && phaseOk && payloadOk(ex, r.stats);
          if (!ok) passAll = false;
          per.push(`${off}px:${ok ? '✓' : '✗' + (ex.recoveryPath || '-')}`);
        }
        rows.push(`${cname}（K=${r.stats.K}/N=${r.stats.N}，纹理块=${r.stats.texturedTiles}）→ ${per.join(' ')}`);
      }
      check('AC14', '相位搜索：7 种裁切偏移 × 3 张载体图 = 21 次全部通过（recoveryPath=phase 且相位正确）',
        passAll && total === 21,
        rows.join('；') + `；共 ${total} 例`);
    }

    // ==========================================================
    // E11 embed.html 第 4 步"模拟损坏并测试"：直接运行**页面里的那段源码**
    // ----------------------------------------------------------
    // 这里刻意不做"照着页面重写一遍"的复刻测试 —— 复刻版即使写错了也测不出页面出错。
    // 做法是把 embed.html 里 blackenCenter 的源码原样抠出来求值，再用它跑四个档位，
    // 于是被测的就是页面真正会执行的那段代码（涂黑几何 + 只改副本 + 64 对齐）。
    // ==========================================================
    {
      const html = fs.readFileSync(path.join(__dirname, '..', 'embed.html'), 'utf8');
      const src = html.match(/function blackenCenter\(imageData, ratio\) \{[\s\S]*?\n  \}/);
      let bc = null, srcErr = '';
      try {
        if (src) bc = new Function('CONST', src[0] + '; return blackenCenter;')(SC.CONST);
      } catch (e) { srcErr = e.message; }

      const carrier = makeNoiseCarrier(512, 512, 7001);
      const secret = makePatternSecret(8, 8, 9);
      const r = SC.embedSecret(carrier, secret);
      const snap = snapshot(r.outputImageData);
      const rows = [];
      let untouched = true, areaOk = true, allOk = true;
      if (bc) {
        for (const ratio of [0.1, 0.25, 0.4, 0.5]) {
          const dmg = bc(r.outputImageData, ratio);
          if (!sameAs(r.outputImageData, snap)) untouched = false;
          if (Math.abs(dmg.area - ratio) > 0.06) areaOk = false;
          const t0 = Date.now();
          const ex = SC.extractSecret(dmg.image);
          const dt = Date.now() - t0;
          if (!payloadOk(ex, r.stats)) allOk = false;
          rows.push(`${Math.round(ratio * 100)}%→实际遮住 ${(dmg.area * 100).toFixed(1)}%，` +
            `读出 ${ex.validTiles} 块（需 ${ex.K_effective}）${ex.success ? '成功' : '失败'}，${dt}ms`);
        }
      }
      check('E11', 'embed.html 的"模拟损坏并测试"源码可独立运行：10/25/40/50% 遮挡下标准档全部可还原，且不改动原图',
        !!bc && untouched && areaOk && allOk,
        bc ? `K=${r.stats.K}, N=${r.stats.N}；${rows.join('；')}；原图未被改动=${untouched}`
          : `未能从 embed.html 取出 blackenCenter（${srcErr || '正则没匹配到'}）`);

      // ========================================================
      // E12 extract.html 的诊断文案：同样把页面里的 describeAttempts 抠出来跑
      // --------------------------------------------------------
      // 【为什么必须测】界面要能区分"6 对模式读出多少块"和"4 对低频模式读出多少块"。
      // 只用正则检查页面源码里有没有这两句话是不够的 —— 那句"已成功，未再试 4 对
      // 低频模式"是否出现，取决于 tried 字段；这里用真实提取结果跑一遍页面函数，
      // 直接看它到底吐出了什么文字。
      // ========================================================
      const exHtml = fs.readFileSync(path.join(__dirname, '..', 'extract.html'), 'utf8');
      const pctSrc = exHtml.match(/function pctText\(x\) \{[\s\S]*?\n  \}/);
      const descSrc = exHtml.match(/function describeAttempts\(result\) \{[\s\S]*?\n  \}/);
      let describe = null, descErr = '';
      try {
        if (pctSrc && descSrc) {
          describe = new Function(pctSrc[0] + '\n' + descSrc[0] + '; return describeAttempts;')();
        }
      } catch (e) { descErr = e.message; }

      if (!describe) {
        check('E12', 'extract.html 的诊断文案函数可从页面取出并运行', false,
          `未能取出 describeAttempts（${descErr || '正则没匹配到'}）`);
      } else {
        const goodEx = SC.extractSecret(r.outputImageData);
        const badImg = cloneImageData(r.outputImageData);
        blackenRects(badImg, greenTileRects(SC.extractSecret(r.outputImageData).debugMask).slice(0, 24));
        const badEx = SC.extractSecret(badImg);
        const g = describe(goodEx);
        const b = describe(badEx);
        const goodOk = g.normal.indexOf('6 对模式读出 ') === 0 &&
          g.normal.indexOf('未再试 4 对低频模式') !== -1 &&
          g.brief.indexOf('常规提取 ') === 0 && /^常规提取 \d+\/\d+ 块/.test(g.brief) &&
          g.phase.indexOf('未进行') === 0 && g.scale.indexOf('未进行') === 0;
        const badOk = b.normal.indexOf('6 对模式读出 ') === 0 &&
          b.normal.indexOf('4 对低频模式读出 ') !== -1 && b.normal.indexOf('需要 ') !== -1 &&
          /^常规提取 \d+\/\d+ 块/.test(b.brief) && b.brief.indexOf('相位搜索') !== -1;
        check('E12', 'extract.html 诊断文案：成功时说"未再试 4 对低频模式"，失败时两种模式的读数都给出（不再单报 0 块）',
          goodOk && badOk && !badEx.success,
          `成功：${g.normal}｜摘要：${g.brief}；失败：${b.normal}｜摘要：${b.brief}`);
      }
    }

    // ==========================================================
    // G 组：承载块"存活率"修复（低 margin 块 + JPEG）
    // ----------------------------------------------------------
    // 【背景】用户实测 2649×1582 标准档、零遮蔽只读回 434/756 = 57.4%，掩码显示
    //   顶部亮天空全红、中下部深色水面绿。追因结论（详见 diag-clamp-loss.node.js）：
    //     · 不是 clamp：明亮块即使每块被 clamp 3000+ 次，嵌入后无损提取误码率仍 0.00%
    //       —— clamp 只降幅度、不翻符号（饱和波形被削顶后基频相位不变）；
    //     · 真因是"选块口径"与"嵌入强度口径"不一致：选块看 64×64 Tile 方差，margin 看
    //       8×8 块方差 —— 天空这种"块间差大、块内平"的区域 tile 方差达标、块级 margin
    //       只有 8~10，实测这些块在 JPEG q=0.80 下存活 0%，而 margin ≥12.4 的块 100%。
    //   修复：classifyTiles 增加 safe 子集（块级最小 margin ≥ 12，亮度判据默认关闭），
    //         embedSecret 优先只用 safe，装不下才回落到全部纹理块并标注 riskyTilesUsed。
    // ==========================================================

    /** 用户场景载体：上半"云块状明亮天空"（块间差大、块内平），下半深色水面（细纹理） */
    function makeCloudySkyWater(size) {
      const img = new global.ImageData(size, size);
      // 云块：每 64px 一个亮度台阶，双线性铺开 → 块内平、块间差大
      const gw = Math.ceil(size / 64) + 2, gh = Math.ceil((size / 2) / 64) + 2;
      const rng = makeRng(4242);
      const u01 = () => rng() / 4294967296;          // 本套件的 makeRng 返回 uint32
      const grid = new Float64Array(gw * gh);
      for (let i = 0; i < grid.length; i++) grid[i] = 190 + u01() * 65;
      const sample = (fx, fy) => {
        const x0 = Math.min(gw - 2, Math.max(0, Math.floor(fx)));
        const y0 = Math.min(gh - 2, Math.max(0, Math.floor(fy)));
        const tx = fx - x0, ty = fy - y0;
        const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
        const c = grid[(y0 + 1) * gw + x0], e = grid[(y0 + 1) * gw + x0 + 1];
        return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
      };
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const o = (y * size + x) * 4;
          let r, g, b;
          if (y < size / 2) {
            const v = sample(x / 64, y / 64) + (u01() * 4 - 2);
            r = v * 0.92; g = v * 0.97; b = Math.min(255, v * 1.04);
          } else {
            const v = 30 + u01() * 50 + 6 * Math.sin((x - y) / 9.0);
            r = v * 0.8; g = v * 0.95; b = Math.min(255, v * 1.15);
          }
          img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
        }
      }
      return img;
    }

    // ---- G1：用户场景复现（修复前 50% → 修复后 100%） ----
    {
      const carrier = makeCloudySkyWater(1024);
      const secret = makePatternSecret(32, 32, 5150);
      const NO_GATE = { minTileLum: 0, maxTileLum: 255, minBlockMargin: 0 };
      const before = SC.embedSecret(carrier, secret, Object.assign({ redundancy: 'standard' }, NO_GATE));
      const after = SC.embedSecret(carrier, secret, { redundancy: 'standard' });
      const jb = simulateJpegRoundTrip(before.outputImageData, 80);
      const ja = simulateJpegRoundTrip(after.outputImageData, 80);
      const eb = SC.extractSecret(jb);
      const ea = SC.extractSecret(ja);
      const zb = SC.extractSecret(before.outputImageData);
      const za = SC.extractSecret(after.outputImageData);
      const survB = eb.validTiles / before.stats.N;
      const survA = ea.validTiles / after.stats.N;
      check('G1', '用户场景（云块状亮天空 + 深色水面）：关闭安全判据时 JPEG q0.80 存活 ~50%；开启后 ≥ 90% 且能还原',
        survB < 0.75 && survA >= 0.9 && payloadOk(ea, after.stats) && za.success && zb.success,
        `修复前：纹理块 ${before.stats.texturedTiles}、安全块 ${before.stats.safeTiles}，` +
        `零遮蔽 ${zb.validTiles}/${before.stats.N}，JPEG q0.80 ${eb.validTiles}/${before.stats.N} = ${pct(survB)}；` +
        `修复后：纹理块 ${after.stats.texturedTiles}、安全块 ${after.stats.safeTiles}` +
        `（低margin拒 ${after.stats.lowMarginRejected}）、用安全块=${after.stats.usedSafeTiles}，` +
        `零遮蔽 ${za.validTiles}/${after.stats.N}，JPEG q0.80 ${ea.validTiles}/${after.stats.N} = ${pct(survA)}，` +
        `载荷一致=${payloadOk(ea, after.stats)}`);
    }

    // ---- G2：明亮载体（用户点名的用例）：零遮蔽 ≥ 90% 且遮蔽 25% 仍成功 ----
    {
      const carrier = makeNoiseCarrier(512, 512, 5201);
      // 把整张图抬到明亮区（200~255）—— 明亮但纹理充足
      const d = carrier.data;
      for (let i = 0; i < 512 * 512; i++) {
        const o = i * 4;
        const v = 200 + (d[o] & 0x3F) * 55 / 63;
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
      }
      const secret = makePatternSecret(16, 16, 5202);
      const r = SC.embedSecret(carrier, secret, { redundancy: 'standard' });
      const ex = SC.extractSecret(r.outputImageData);
      const damaged = cloneImageData(r.outputImageData);
      blackenRects(damaged, greenTileRects(SC.extractSecret(r.outputImageData).debugMask)
        .slice(0, Math.ceil(r.stats.N * 0.25)));
      const exD = SC.extractSecret(damaged);
      check('G2', '明亮载体（200~255，纹理充足）：零遮蔽存活率 ≥ 90%（实测 100%），遮蔽 25% 承载块后仍能还原',
        ex.validTiles / r.stats.N >= 0.9 && exD.success && payloadOk(exD, r.stats),
        `纹理块 ${r.stats.texturedTiles}、安全块 ${r.stats.safeTiles}；` +
        `零遮蔽 ${ex.validTiles}/${r.stats.N} = ${pct(ex.validTiles / r.stats.N)}；` +
        `遮蔽 25%（${Math.ceil(r.stats.N * 0.25)} 块）后 success=${exD.success}` +
        `（${exD.validTiles}/${r.stats.N}，K_effective=${exD.K_effective}）`);
    }

    // ---- G3：容量分析新增字段自洽 ----
    {
      const skyWater = makeCloudySkyWater(1024);
      const noise = makeNoiseCarrier(512, 512, 5301);
      const capSky = SC.analyzeCapacity(skyWater, 1400, { redundancy: 'standard' });
      const capNoise = SC.analyzeCapacity(noise, 1400, { redundancy: 'standard' });
      const fieldsOk = ['safeTiles', 'darkRejected', 'brightRejected', 'lowMarginRejected',
        'minTileLum', 'maxTileLum', 'minBlockMargin', 'fitsSafe', 'maxSafeSecretBytes']
        .every((k) => capSky[k] !== undefined);
      const sumOk = capSky.safeTiles + capSky.darkRejected + capSky.brightRejected + capSky.lowMarginRejected
        === capSky.texturedTiles;
      const skyRejected = capSky.lowMarginRejected > 0 && capSky.safeTiles < capSky.texturedTiles;
      const noiseUntouched = capNoise.safeTiles === capNoise.texturedTiles &&
        capNoise.lowMarginRejected === 0 && capNoise.darkRejected === 0 && capNoise.brightRejected === 0;
      check('G3', 'analyzeCapacity 上报 安全块/过暗拒/过亮拒/低margin拒/门槛值，且三者之和等于纹理块数；满纹理图不受影响',
        fieldsOk && sumOk && skyRejected && noiseUntouched,
        `字段齐全=${fieldsOk}；云块天空：纹理 ${capSky.texturedTiles} = 安全 ${capSky.safeTiles} + 暗 ${capSky.darkRejected}` +
        ` + 亮 ${capSky.brightRejected} + 低margin ${capSky.lowMarginRejected}（门槛 margin≥${capSky.minBlockMargin}，` +
        `亮度 ${capSky.minTileLum}~${capSky.maxTileLum}）；噪声图：安全=${capNoise.safeTiles}/纹理=${capNoise.texturedTiles}，` +
        `可装 ${capNoise.maxSafeSecretBytes} 字节`);
    }

    // ---- G4：亮度判据作为可选开关（用户方案 A 的原样口径）确实生效 ----
    {
      const bright = new global.ImageData(512, 512);
      const rngB = makeRng(5400);
      for (let i = 0; i < 512 * 512; i++) {
        const v = (200 + (rngB() / 4294967296) * 55) | 0;
        const o = i * 4;
        bright.data[o] = v; bright.data[o + 1] = v; bright.data[o + 2] = v; bright.data[o + 3] = 255;
      }
      const off = SC.analyzeCapacity(bright, 1400, { redundancy: 'standard' });
      const on = SC.analyzeCapacity(bright, 1400, { redundancy: 'standard', minTileLum: 40, maxTileLum: 215 });
      check('G4', '亮度判据（minTileLum/maxTileLum）可选开启：默认关闭时不误杀亮块，开启后过亮块被计入 brightRejected',
        off.brightRejected === 0 && off.safeTiles === off.texturedTiles &&
        on.brightRejected > 0 && on.safeTiles === on.texturedTiles - on.brightRejected - on.lowMarginRejected - on.darkRejected,
        `默认（0~255）：安全 ${off.safeTiles}/纹理 ${off.texturedTiles}、过亮拒 ${off.brightRejected}；` +
        `开启 40~215：安全 ${on.safeTiles}、过亮拒 ${on.brightRejected}、低margin拒 ${on.lowMarginRejected}` +
        `（实测亮块 margin 足够时 JPEG q0.75 仍 42/42，故默认不误杀）`);
    }

    // ---- G5：不回归：满纹理载体仍然 100% 存活且用的就是安全块 ----
    {
      const carrier = makeNoiseCarrier(512, 512, 5501);
      const secret = makePatternSecret(16, 16, 5502);
      const r = SC.embedSecret(carrier, secret, { redundancy: 'standard' });
      const ex = SC.extractSecret(r.outputImageData);
      check('G5', '不回归：噪声载体安全块=纹理块、usedSafeTiles=true、零遮蔽存活 100%',
        r.stats.safeTiles === r.stats.texturedTiles && r.stats.usedSafeTiles === true &&
        r.stats.riskyTilesUsed === false && ex.validTiles === r.stats.N && payloadOk(ex, r.stats),
        `纹理 ${r.stats.texturedTiles} = 安全 ${r.stats.safeTiles}；usedSafeTiles=${r.stats.usedSafeTiles}、` +
        `riskyTilesUsed=${r.stats.riskyTilesUsed}；读回 ${ex.validTiles}/${r.stats.N}`);
    }

    // ---- G6：安全块不够时的回落行为（不因为修复而直接嵌不进去） ----
    {
      // 整张图都是低 margin 的平滑块（块内是常数、块间有台阶）→ 无一处安全 → 必须回落
      const smooth = new global.ImageData(512, 512);
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          const o = (y * 512 + x) * 4;
          const v = 60 + Math.floor((y % 64) / 8) * 17;   // 块内常数、块间 17 级台阶
          smooth.data[o] = v; smooth.data[o + 1] = v; smooth.data[o + 2] = v; smooth.data[o + 3] = 255;
        }
      }
      const secret = makePatternSecret(16, 16, 5602);
      const cap = SC.analyzeCapacity(smooth, 900, { redundancy: 'standard' });
      let r = null, err = null;
      try { r = SC.embedSecret(smooth, secret, { redundancy: 'standard' }); } catch (e) { err = e; }
      const fellBack = !!r && r.stats.safeTiles === 0 && r.stats.riskyTilesUsed === true;
      check('G6', '极端情况（整图无安全块）：回落到全部纹理块继续嵌入，并如实标注 riskyTilesUsed=true',
        fellBack && r.stats.N > 0,
        err ? `嵌入抛错：${err.message}`
          : `纹理 ${cap.texturedTiles}、安全 ${r.stats.safeTiles}、低margin拒 ${r.stats.lowMarginRejected}；` +
            `回落=${r.stats.riskyTilesUsed}、写入 N=${r.stats.N}`);
    }

    const total = results.length;
    const passedAll = total - failures;
    console.log('\n============================================');
    console.log(`总计 ${total} 项：通过 ${passedAll}，失败 ${failures}`);
    console.log('关键验收：' + results.filter((r) => /^AC([1-9]|1[0-8])$/.test(r.id))
      .map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
    console.log('============================================');
    process.exit(failures === 0 ? 0 : 1);
  }, 60);
}
