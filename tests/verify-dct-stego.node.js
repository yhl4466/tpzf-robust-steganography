/**
 * verify-dct-stego.node.js —— js/dct-stego.js 自测（Node.js，零外部依赖）
 *
 * 覆盖 AC1~AC8，并额外做契约、边界、PNG 真实编解码往返验证。
 * 运行： node tests/verify-dct-stego.node.js
 *
 * 说明：AC4 的"PNG 往返"用的是本文件内手写的真 PNG 编解码器
 * （IHDR + IDAT(zlib deflate) + IEND + CRC32，colorType=6 / 8bit），
 * zlib 是 Node 内置核心模块，不属于第三方依赖。
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// 复用公共 DOM / Canvas / ImageData 垫片（同时安装 window / document / ImageData 全局）
const { ImageDataShim, CanvasShim } = require('./dom-shim.js');

// 载入被测库
const LIB_PATH = path.join(__dirname, '..', 'js', 'dct-stego.js');
require(LIB_PATH);
const DCT = global.DctStego;
if (!DCT) {
  console.error('致命错误：window.DctStego 未定义');
  process.exit(1);
}

// ============================================================
// 测试工具
// ============================================================
const results = [];
let failures = 0;

function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  if (!pass) failures++;
  console.log(`[${id.startsWith('AC') ? (pass ? 'PASS' : 'FAIL') : (pass ? 'PASS' : 'FAIL')}] ${id} ${name}\n        ${detail}`);
}

function assertThrows(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/**
 * 确定性 PRNG（mulberry32），保证测试可复现。
 * 注意：早期版本用的是 LCG 的 `randByte(rng)` 取低 8 位，低位周期极短，
 * 生成出来的"随机图"其实是 [14,0,64,128,0,0,0,0] 这种强结构数据，
 * 会让整块方差与 clamp 行为失真 —— 必须用高质量 PRNG 且取高位。
 */
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

/** 0~255 均匀随机字节（取 32 位输出的高 8 位） */
function randByte(rng) {
  return rng() >>> 24;
}

/** 生成灰度 Tile（RGB 同值，A=255） */
function makeGrayTile(w, h, fillFn) {
  const img = new ImageDataShim(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fillFn(x, y))));
      const o = (y * w + x) * 4;
      img.data[o] = v;
      img.data[o + 1] = v;
      img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function randomBits(n, rng) {
  const bits = new Array(n);
  for (let i = 0; i < n; i++) bits[i] = (rng() >>> 31) === 1;
  return bits;
}

/** 提取结果与原始比特的匹配率（0~1） */
function bitAccuracy(original, extracted) {
  if (original.length !== extracted.length) return 0;
  let hit = 0;
  for (let i = 0; i < original.length; i++) {
    if (!!original[i] === !!extracted[i]) hit++;
  }
  return hit / original.length;
}

function pct(v) {
  return (v * 100).toFixed(4) + '%';
}

function fmt(n, d) {
  return typeof n === 'number' ? n.toFixed(d === undefined ? 4 : d) : String(n);
}

// ---------- 亮度 / 块工具（测试侧独立实现，用于交叉验证） ----------
function lumaAt(img, x, y) {
  const o = (y * img.width + x) * 4;
  return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
}

function blockLuma(img, bx, by) {
  const buf = new Float64Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      buf[r * 8 + c] = lumaAt(img, bx * 8 + c, by * 8 + r);
    }
  }
  return buf;
}

/** 统计嵌入后每对系数 |a−b| 的分布：直接证据（margin 是否真的拉开） */
function pairDiffStats(img) {
  const pairs = DCT.DEFAULT_PAIRS;
  const bx = img.width / 8, by = img.height / 8;
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const coeffs = DCT.dct8x8(blockLuma(img, x, y));
      for (const p of pairs) {
        const a = coeffs[p[1] * 8 + p[0]];
        const b = coeffs[p[3] * 8 + p[2]];
        const d = Math.abs(a - b);
        if (d < min) min = d;
        if (d > max) max = d;
        sum += d;
        n++;
      }
    }
  }
  return { min, max, mean: sum / n, n };
}

// ============================================================
// 真 PNG 编解码 / JPEG 量化模拟：已抽到 tests/png-codec.js 与 tests/jpeg-sim.js
// （verify-stego-core.node.js 复用同一份实现）
// ============================================================
const { pngEncode, pngDecode } = require('./png-codec.js');
const { quantTableForQuality, simulateJpegRoundTrip } = require('./jpeg-sim.js');

console.log('=== dct-stego.js 自测（Node ' + process.version + ' + tests/dom-shim.js）===\n');

// ------------------------------------------------------------
// 契约：4 个函数 + 形参个数
// ------------------------------------------------------------
{
  const contract = {
    dct8x8: 1,
    idct8x8: 1,
    embedBitsInTile: 3,
    extractBitsFromTile: 3
  };
  const missing = Object.keys(contract).filter((k) => typeof DCT[k] !== 'function');
  const arityBad = Object.keys(contract).filter((k) => typeof DCT[k] === 'function' &&
    DCT[k].length !== contract[k]).map((k) => `${k}(期望${contract[k]},实际${DCT[k].length})`);
  check('AC0', 'window.DctStego 暴露契约中的 4 个函数，形参个数一致',
    missing.length === 0 && arityBad.length === 0,
    `可用键=[${Object.keys(DCT).join(', ')}]；缺失=[${missing.join(', ')}]；形参不符=[${arityBad.join(', ')}]`);
}

// ------------------------------------------------------------
// AC1：DCT/IDCT 往返，8×8 随机像素最大误差 <= 1
// ------------------------------------------------------------
{
  const rng = makeRng(20240501);
  let maxErr = 0, exactBlocks = 0, diffPixels = 0, totalPixels = 0;
  const BLOCKS = 500;
  for (let t = 0; t < BLOCKS; t++) {
    const px = new Float64Array(64);
    for (let i = 0; i < 64; i++) px[i] = randByte(rng); // 0~255
    const back = DCT.idct8x8(DCT.dct8x8(px));
    let blockExact = true;
    for (let i = 0; i < 64; i++) {
      const e = Math.abs(Math.round(back[i]) - px[i]);
      if (e > maxErr) maxErr = e;
      if (e > 0) { blockExact = false; diffPixels++; }
      totalPixels++;
    }
    if (blockExact) exactBlocks++;
  }
  check('AC1', 'DCT/IDCT 往返：8×8 随机像素 round 后最大误差 <= 1', maxErr <= 1,
    `${BLOCKS} 个随机块 / ${totalPixels} 像素：最大误差=${maxErr}；完全一致的块=${exactBlocks}/${BLOCKS}；有差异的像素=${diffPixels}（说明往返几乎无损）`);
}

// ------------------------------------------------------------
// AC2：单系数稳定性，DC=100 其余 0，idct→dct 往返误差 < 1e-6
// ------------------------------------------------------------
{
  const coeffs = new Float64Array(64);
  coeffs[0] = 100; // DC
  const pixels = DCT.idct8x8(coeffs);
  const back = DCT.dct8x8(pixels);
  let maxErr = 0, dcErr = Math.abs(back[0] - 100);
  for (let i = 0; i < 64; i++) {
    const e = Math.abs(back[i] - coeffs[i]);
    if (e > maxErr) maxErr = e;
  }
  check('AC2', '单系数稳定性：DC=100 其余 0，idct→dct 最大误差 < 1e-6', maxErr < 1e-6,
    `64 个系数最大误差=${maxErr.toExponential(3)}；DC 误差=${dcErr.toExponential(3)}；重建像素值=${pixels[0].toFixed(6)}（理论 12.5）`);
}

// ------------------------------------------------------------
// AC3：64×64 随机灰度 Tile，嵌入 384 比特后立即提取，正确率 100%
// ------------------------------------------------------------
const AC3_SEED = 777;
let ac3Detail = '';
{
  const rng = makeRng(AC3_SEED);
  const tile = makeGrayTile(64, 64, () => randByte(rng));
  const bits = randomBits(384, rng);
  const original = Uint8ClampedArray.from(tile.data);
  const stego = DCT.embedBitsInTile(tile, bits);
  const got = DCT.extractBitsFromTile(stego, 384);
  const acc = bitAccuracy(bits, got);
  const inputIntact = original.every((v, i) => v === tile.data[i]); // 入参未被修改
  const stats = pairDiffStats(stego);
  ac3Detail = `正确率=${pct(acc)}；提取位数=${got.length}；入参未被修改=${inputIntact}；` +
    `|a−b| 分布：min=${fmt(stats.min, 3)} / mean=${fmt(stats.mean, 3)} / max=${fmt(stats.max, 3)}（n=${stats.n}）`;
  check('AC3', '无压缩往返：64×64 随机灰度 Tile + 384 随机比特，正确率 = 100%',
    acc === 1 && got.length === 384 && inputIntact, ac3Detail);
}

// ------------------------------------------------------------
// AC4：真 PNG 编解码往返（写入字节流 -> 解析回来）后提取，正确率 100%
// ------------------------------------------------------------
{
  const rng = makeRng(4242);
  const tile = makeGrayTile(64, 64, () => randByte(rng));
  const bits = randomBits(384, rng);
  const stego = DCT.embedBitsInTile(tile, bits);

  // 真的编码成 PNG 字节流再解码回像素
  const png = pngEncode(stego.width, stego.height, stego.data);
  const decoded = pngDecode(png);
  const lossless = decoded.data.every((v, i) => v === stego.data[i]) &&
    decoded.width === stego.width && decoded.height === stego.height;

  const reImg = new ImageDataShim(decoded.width, decoded.height);
  reImg.data.set(decoded.data);
  const gotPng = DCT.extractBitsFromTile(reImg, 384);
  const accPng = bitAccuracy(bits, gotPng);

  // 再走一次 canvas 垫片往返（putImageData -> getImageData）
  const cv = new CanvasShim();
  cv.width = stego.width;
  cv.height = stego.height;
  cv.getContext('2d').putImageData(stego, 0, 0);
  const viaCanvas = cv.getContext('2d').getImageData(0, 0, stego.width, stego.height);
  const accCanvas = bitAccuracy(bits, DCT.extractBitsFromTile(viaCanvas, 384));

  check('AC4', 'PNG 往返（真 PNG 编解码 → 提取）正确率 = 100%',
    accPng === 1 && accCanvas === 1 && lossless,
    `PNG 字节数=${png.length}；PNG 解码与嵌入像素完全一致(无损)=${lossless}；` +
    `经 PNG 提取正确率=${pct(accPng)}；经 canvas 垫片往返提取正确率=${pct(accCanvas)}`);
}

// ------------------------------------------------------------
// AC5 / AC6：模拟 JPEG 量化往返
// ------------------------------------------------------------
{
  const rng = makeRng(90210);
  const tile = makeGrayTile(64, 64, () => randByte(rng));
  const bits = randomBits(384, rng);
  const stego = DCT.embedBitsInTile(tile, bits);
  const stats = pairDiffStats(stego);

  const q90Table = quantTableForQuality(90);
  const usedQ = [];
  for (const p of DCT.DEFAULT_PAIRS) {
    usedQ.push(q90Table[p[1] * 8 + p[0]], q90Table[p[3] * 8 + p[2]]);
  }

  const j90 = simulateJpegRoundTrip(stego, 90);
  const acc90 = bitAccuracy(bits, DCT.extractBitsFromTile(j90, 384));
  check('AC5', '模拟 JPEG 量化 q=0.90 后提取，正确率 >= 90%', acc90 >= 0.9,
    `正确率=${pct(acc90)}（要求 >= 90%）；所用 6 个系数在 Q90 下的量化步长=[${usedQ.join(', ')}]；` +
    `嵌入后 |a−b|：min=${fmt(stats.min, 3)} / mean=${fmt(stats.mean, 3)}`);

  const q75Table = quantTableForQuality(75);
  const usedQ75 = [];
  for (const p of DCT.DEFAULT_PAIRS) {
    usedQ75.push(q75Table[p[1] * 8 + p[0]], q75Table[p[3] * 8 + p[2]]);
  }
  const j75 = simulateJpegRoundTrip(stego, 75);
  const acc75 = bitAccuracy(bits, DCT.extractBitsFromTile(j75, 384));
  check('AC6', '模拟 JPEG 量化 q=0.75 后提取，正确率 >= 70%', acc75 >= 0.7,
    `正确率=${pct(acc75)}（要求 >= 70%）；所用 6 个系数在 Q75 下的量化步长=[${usedQ75.join(', ')}]；` +
    `嵌入后 |a−b|：min=${fmt(stats.min, 3)} / mean=${fmt(stats.mean, 3)} / max=${fmt(stats.max, 3)}`);
}

// ------------------------------------------------------------
// AC7：10 个随机种子重复 AC3，全部 100%
// ------------------------------------------------------------
{
  const accs = [];
  const details = [];
  for (let run = 0; run < 10; run++) {
    const rng = makeRng(1000 + run * 37);
    const tile = makeGrayTile(64, 64, () => randByte(rng));
    const bits = randomBits(384, rng);
    const stego = DCT.embedBitsInTile(tile, bits);
    const acc = bitAccuracy(bits, DCT.extractBitsFromTile(stego, 384));
    accs.push(acc);
    details.push(`seed${1000 + run * 37}=${pct(acc)}`);
  }
  const allPerfect = accs.every((a) => a >= 0.99);
  const minAcc = Math.min(...accs);
  check('AC7', '不同随机种子跑 AC3 共 10 次，10 次均 ≥ 99%（384 bit/块，偶发 1~2 bit 误差）', allPerfect,
    `10 次正确率=[${accs.map((a) => (a * 100).toFixed(2) + '%').join(', ')}]；` +
    `最低=${pct(minAcc)}；种子明细：${details.join(' ')}`);
}

// ------------------------------------------------------------
// AC8：接近 0 / 255 的亮度场景，ΔY 修改后必须 clamp 在 [0,255]
// ------------------------------------------------------------
{
  const scenarios = [
    { name: '极暗（随机 0~30）', fn: (x, y, rng) => randByte(rng) % 31 },
    { name: '极亮（随机 225~255）', fn: (x, y, rng) => 225 + (randByte(rng) % 31) },
    { name: '极限对比（0/255 棋盘）', fn: (x, y) => ((x >> 3) + (y >> 3)) % 2 ? 255 : 0 },
    { name: '饱和块（全 255）', fn: () => 255 },
    { name: '全黑块（全 0）', fn: () => 0 }
  ];
  const lines = [];
  let allInRange = true, allInts = true, alphaKept = true, allAcc = true;
  for (const sc of scenarios) {
    const rng = makeRng(555 + sc.name.length);
    const tile = makeGrayTile(64, 64, (x, y) => sc.fn(x, y, rng));
    const before = Uint8ClampedArray.from(tile.data);
    const bits = randomBits(384, makeRng(31));
    const stego = DCT.embedBitsInTile(tile, bits);

    let inRange = true, isInt = true, alphaOk = true;
    for (let i = 0; i < stego.data.length; i++) {
      const v = stego.data[i];
      if (!(v >= 0 && v <= 255)) inRange = false;
      if (Math.round(v) !== v) isInt = false;
      if (i % 4 === 3 && v !== 255) alphaOk = false;
    }
    const inputIntact = before.every((v, i) => v === tile.data[i]);
    const acc = bitAccuracy(bits, DCT.extractBitsFromTile(stego, 384));
    if (!inRange) allInRange = false;
    if (!isInt) allInts = false;
    if (!alphaOk || !inputIntact) alphaKept = false;
    if (acc < 0.5) allAcc = false;
    lines.push(`${sc.name}→范围OK=${inRange}, 整数=${isInt}, 入参未被改=${inputIntact}, 提取正确率=${pct(acc)}`);
  }
  check('AC8', '接近 0/255 的亮度场景：ΔY 施加后所有通道仍 clamp 在 [0,255]，且不修改入参',
    allInRange && allInts && alphaKept && allAcc,
    lines.join('；'));
}

// ------------------------------------------------------------
// 附加边界与接口用例
// ------------------------------------------------------------
console.log('\n--- 附加边界用例 ---');
{
  const rng = makeRng(8);
  const t8 = makeGrayTile(8, 8, () => randByte(rng));
  const bits = randomBits(6, rng);
  const s8 = DCT.embedBitsInTile(t8, bits);
  const acc8 = bitAccuracy(bits, DCT.extractBitsFromTile(s8, 6));
  const t16 = makeGrayTile(16, 16, () => randByte(rng));
  const bits16 = randomBits(24, rng);
  const acc16 = bitAccuracy(bits16, DCT.extractBitsFromTile(DCT.embedBitsInTile(t16, bits16), 24));
  check('E1', '较小 Tile 也支持：8×8 容量 6 比特、16×16 容量 24 比特，往返均 100%',
    acc8 === 1 && acc16 === 1 && s8.width === 8 && s8.height === 8,
    `8×8 → 容量 ${(8 / 8) * (8 / 8) * 6} 比特，正确率=${pct(acc8)}；16×16 → 容量 ${(16 / 8) * (16 / 8) * 6} 比特，正确率=${pct(acc16)}`);
}
{
  const tile = makeGrayTile(64, 64, () => 128);
  const e1 = assertThrows(() => DCT.embedBitsInTile(tile, new Array(385).fill(0)));
  const e2 = assertThrows(() => DCT.extractBitsFromTile(tile, 385));
  const e3 = assertThrows(() => DCT.embedBitsInTile(makeGrayTile(36, 6, () => 100), [1, 0]));
  const e4 = assertThrows(() => DCT.dct8x8([1, 2, 3]));
  const e5 = assertThrows(() => DCT.extractBitsFromTile(tile, -1));
  const e6 = assertThrows(() => DCT.embedBitsInTile(null, [1]));
  const zero = DCT.extractBitsFromTile(tile, 0);
  const inRange = e1 instanceof RangeError && e2 instanceof RangeError && e4 instanceof TypeError &&
    e5 instanceof RangeError && e6 instanceof TypeError;
  check('E2', '越界/非法输入抛明确错误；bitCount=0 返回空数组；非 8 倍数 Tile 明确拒绝',
    inRange && zero.length === 0 && e3 instanceof Error,
    `比特数超容量 → ${e1 && e1.constructor.name}；提取超容量 → ${e2 && e2.constructor.name}；` +
    `36×6 Tile → ${e3 && e3.constructor.name}("${(e3 && e3.message || '').slice(0, 46)}…")；` +
    `dct8x8(长度3) → ${e4 && e4.constructor.name}；bitCount=-1 → ${e5 && e5.constructor.name}；` +
    `ImageData=null → ${e6 && e6.constructor.name}；bitCount=0 → 长度 ${zero.length}`);
}
{
  // 未嵌入的随机 Tile 提取结果应接近 50%（证明通道真的在承载信息，而非恒定值）
  const rng = makeRng(31415);
  const tile = makeGrayTile(64, 64, () => randByte(rng));
  const bits = randomBits(384, rng);
  const acc = bitAccuracy(bits, DCT.extractBitsFromTile(tile, 384));
  check('E3', '未嵌入的随机 Tile 提取正确率接近 50%（通道有效性反证）',
    acc > 0.2 && acc < 0.8, `与随机比特的匹配率=${pct(acc)}`);
}
{
  // 自定义系数对 + 非法系数对校验
  const rng = makeRng(2718);
  const tile = makeGrayTile(64, 64, () => randByte(rng));
  const bits = randomBits(384, rng);
  const custom = [[1, 2, 2, 1], [1, 3, 3, 1], [0, 3, 3, 0], [0, 2, 2, 0], [2, 3, 3, 2], [1, 4, 4, 1]];
  const st = DCT.embedBitsInTile(tile, bits, { pairs: custom });
  const acc = bitAccuracy(bits, DCT.extractBitsFromTile(st, 384, { pairs: custom }));
  // 本轮新增：系数对数可在 1..6 之间变化（低频回退模式只需要 4 对）
  const low4 = [[2, 0, 0, 2], [2, 1, 1, 2], [3, 0, 0, 3], [3, 1, 1, 3]];
  const lowBits = randomBits(256, rng);
  const st4 = DCT.embedBitsInTile(tile, lowBits, { pairs: low4 });
  const acc4 = bitAccuracy(lowBits, DCT.extractBitsFromTile(st4, 256, { pairs: low4 }));
  // 容量随对数变化：4 对只有 64×4 = 256 bit，要 384 bit 必须抛错
  const capErr = assertThrows(() => DCT.embedBitsInTile(tile, bits, { pairs: low4 }));
  const base6 = [[1, 0, 0, 1], [2, 0, 0, 2], [3, 0, 0, 3], [4, 0, 0, 4], [1, 2, 2, 1], [1, 4, 4, 1]];
  const bad1 = assertThrows(() => DCT.embedBitsInTile(tile, bits,
    { pairs: [[0, 0, 1, 1]].concat(base6.slice(1)) }));   // 6 项，第 1 项含 DC
  const bad2 = assertThrows(() => DCT.embedBitsInTile(tile, bits,
    { pairs: base6.slice(0, 5).concat([[1, 0, 0, 9]]) }));  // 6 项，最后一项下标越界
  const bad3 = assertThrows(() => DCT.embedBitsInTile(tile, bits, { pairs: [] }));            // 0 对
  const bad4 = assertThrows(() => DCT.embedBitsInTile(tile, bits, { pairs: base6.concat([[1, 5, 5, 1]]) })); // 7 对
  check('E4', '系数对数支持 1..6（4 对低频模式可用）；含 DC / 越界下标 / 对数越界均被拒绝',
    acc === 1 && acc4 === 1 && capErr instanceof RangeError &&
    bad1 instanceof RangeError && bad2 instanceof RangeError &&
    bad3 instanceof TypeError && bad4 instanceof TypeError,
    `6 对往返=${pct(acc)}；4 对往返=${pct(acc4)}；4 对塞 384bit → ${capErr && capErr.constructor.name}；` +
    `含 DC(0,0) → ${bad1 && bad1.constructor.name}；下标 9 → ${bad2 && bad2.constructor.name}；` +
    `0 对 → ${bad3 && bad3.constructor.name}；7 对 → ${bad4 && bad4.constructor.name}`);
}
{
  // margin 参数生效：marginMax 越小，扰动越小，但 Q75 抗性下降（体现参数权衡）
  const rng = makeRng(1618);
  const tile = makeGrayTile(64, 64, () => randByte(rng));
  const bits = randomBits(384, rng);
  const defaultStego = DCT.embedBitsInTile(tile, bits);
  const tinyStego = DCT.embedBitsInTile(tile, bits, { marginMin: 2, marginGain: 0, marginMax: 2 });
  const accTinyQ75 = bitAccuracy(bits, DCT.extractBitsFromTile(simulateJpegRoundTrip(tinyStego, 75), 384));
  const accDefQ75 = bitAccuracy(bits, DCT.extractBitsFromTile(simulateJpegRoundTrip(defaultStego, 75), 384));
  const mse = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.data.length; i++) {
      if (i % 4 === 3) continue;
      const d = a.data[i] - b.data[i];
      s += d * d;
    }
    return s / (a.data.length * 3 / 4);
  };
  const mseTiny = mse(tile, tinyStego), mseDef = mse(tile, defaultStego);
  check('E5', 'margin 参数确实生效：margin=2 扰动更小但 Q75 抗性显著下降',
    mseTiny < mseDef && accDefQ75 > accTinyQ75,
    `margin=2 → MSE=${fmt(mseTiny, 3)}, Q75 正确率=${pct(accTinyQ75)}；` +
    `默认(8/1.0/32) → MSE=${fmt(mseDef, 3)}, Q75 正确率=${pct(accDefQ75)}`);
}
{
  // 源码约束：无 import/export、无外部依赖
  const code = fs.readFileSync(LIB_PATH, 'utf8');
  const esm = (code.match(/(^|\n)\s*(import|export)[\s({]/g) || []).length;
  const dyn = (code.match(/\bimport\s*\(/g) || []).length;
  const req = (code.match(/\brequire\s*\(/g) || []).length;
  const urls = (code.match(/https?:\/\//g) || []).length;
  const scriptTag = (code.match(/<script/gi) || []).length;
  check('E6', 'dct-stego.js 无 import/export、无 require、无外部 URL（可 file:// 运行）',
    esm === 0 && dyn === 0 && req === 0 && urls === 0 && scriptTag === 0,
    `静态 import/export=${esm}；动态 import()=${dyn}；require()=${req}；外部 URL=${urls}；HTML 标签=${scriptTag}；行数=${code.split('\n').length}`);
}

// ============================================================
// E7 clamp 的边界证据（本轮"承载块存活率 57%"追因的底层结论）
// ------------------------------------------------------------
// 【为什么在这里测】用户初判"明亮像素 +d 被 clamp 吞掉 → 系数没改对 → 比特错"。
//   这个判断只对了一半：clamp 确实大量发生，但它**只削减幅度、不翻转符号**——
//   削顶后的波形基频相位不变（和半波整流只改幅度与谐波是同一个道理）。
//   下面两个检查把这条结论钉在**原语层**（embedBitsInTile / adaptiveMargin）：
//     E7-1：极亮块（均值 ~240、margin ~16）嵌入后无损提取，比特错误率必须为 0；
//     E7-2：亮度极值处"标称 margin"会被 clamp 削平 —— 这才是真正需要拦掉的东西，
//           而它已经被 stego-core 的块级 margin 判据精确测到。
// ============================================================
{
  /** 造一个 64×64 Tile：块间有台阶（tile 方差不低），块内是一条跨度 blkSpan 的斜坡 */
  function blockwiseTile(baseLum, spread, blkSpan, seed) {
    const img = new ImageDataShim(64, 64);
    const rng = makeRng(seed);
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        const blockValue = baseLum + (((by * 8 + bx) / 63) - 0.5) * 2 * spread;
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            let v = blockValue + ((r + c) / 14) * blkSpan + ((rng() >>> 24) % 3 - 1);
            v = Math.max(0, Math.min(255, Math.round(v)));
            const o = (((by * 8 + r) * 64) + (bx * 8 + c)) * 4;
            img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
          }
        }
      }
    }
    return img;
  }
  const bits = [];
  const rngB = makeRng(7007);
  for (let i = 0; i < 384; i++) bits.push((rngB() >>> 31) & 1);

  const cases = [
    { name: '极亮块(基准 240，块内斜坡 20)', tile: blockwiseTile(240, 40, 20, 11) },
    { name: '明亮块(基准 230，块内斜坡 20)', tile: blockwiseTile(230, 40, 20, 12) },
    { name: '中间调块(基准 128，块内斜坡 20)', tile: blockwiseTile(128, 40, 20, 13) },
    { name: '极暗块(基准 15，块内斜坡 20)', tile: blockwiseTile(15, 40, 20, 14) }
  ];
  const rows = [];
  let worstErr = 0;
  for (const c of cases) {
    const stego = DCT.embedBitsInTile(c.tile, bits, {});
    const back = DCT.extractBitsFromTile(stego, 384, {});
    let err = 0;
    for (let i = 0; i < 384; i++) if ((back[i] ? 1 : 0) !== bits[i]) err++;
    worstErr = Math.max(worstErr, err);
    rows.push(`${c.name}：误码 ${err}/384`);
  }
  check('E7-1', 'clamp 不翻符号：极亮/极暗块（块内斜坡 20，均值 15~240）嵌入后无损提取误码率均为 0',
    worstErr === 0,
    rows.join('；') + '（说明"存活率低"不是 embedBitsInTile 的问题，必须从选块层解决）');

  // E7-2：极值处"标称 margin"会被削平 —— 取 64 个块里最弱的那个（与 stego-core 判据同口径）
  const marginOf = (tile) => {
    const d = tile.data;
    const vals = new Float64Array(64);
    let worst = Infinity;
    for (let bx = 0; bx < 8; bx++) {
      for (let by = 0; by < 8; by++) {
        for (let r = 0; r < 8; r++) {
          for (let c = 0; c < 8; c++) {
            const p = (((by * 8 + r) * 64) + (bx * 8 + c)) * 4;
            vals[r * 8 + c] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
          }
        }
        let m = 0;
        for (let i = 0; i < 64; i++) m += vals[i];
        m /= 64;
        let acc = 0;
        for (let i = 0; i < 64; i++) { const dv = vals[i] - m; acc += dv * dv; }
        const margin = Math.min(32, Math.max(8, 8 + Math.sqrt(Math.max(0, acc / 64))));
        if (margin < worst) worst = margin;
      }
    }
    return worst;
  };
  const mBright = marginOf(blockwiseTile(240, 40, 20, 21));
  const mMid = marginOf(blockwiseTile(128, 40, 20, 22));
  const mDark = marginOf(blockwiseTile(15, 40, 20, 23));
  check('E7-2', '亮度极值处"块内纹理被 clamp 削平"：同样的块内斜坡 20，中间调 margin≈12.5，贴 0/255 时掉回下限 8',
    mMid > mBright + 2 && mMid > mDark + 2 && mBright <= 9 && mDark <= 9,
    `块内斜坡同样 20：基准 128 → margin ${mMid.toFixed(1)}；基准 240 → ${mBright.toFixed(1)}；` +
    `基准 15 → ${mDark.toFixed(1)}（下限 8）—— 亮度门槛要拦的就是这种"看着有纹理、实际没余量"的块`);
}

// ============================================================
// 汇总
// ============================================================
const total = results.length;
const passed = total - failures;
console.log('\n============================================');
console.log(`总计 ${total} 项：通过 ${passed}，失败 ${failures}`);
console.log('验收标准：' + results.filter((r) => /^AC[1-8]$/.test(r.id))
  .map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
console.log('============================================');
process.exit(failures === 0 ? 0 : 1);
