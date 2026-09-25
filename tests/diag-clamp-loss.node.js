/**
 * diag-clamp-loss.node.js —— 诊断脚本（不是验收测试）
 *
 * 目的：量化"像素被 clamp 到 [0,255] 边界"对承载块存活率的影响，复现用户实测的
 *   「标准档、零遮蔽，2649×1582 明亮天空载体只能读出 434/756 = 57.4%」。
 *
 * 做法：
 *   ① 造四类 512×512 图（各 64 个 64×64 Tile）：
 *        A 明亮图（200~255，模拟天空）  B 正常图（30~225，模拟普通照片）
 *        C 混合图（一半 220~255、一半 30~80）  D 极暗图（0~30）
 *   ② 对**每一个** Tile 单独做一次真实嵌入（DctStego.embedBitsInTile），统计：
 *        · 该 Tile 的平均亮度
 *        · 单独嵌入后能否通过 CRC（等价于"它作为承载块时能否被读出"）
 *        · 复刻 embedBitsInTile 的逐像素改写过程，统计有多少次
 *          outData[c] + ΔY 落到 [0,255] 之外（即被 clampByte 吞掉）
 *        · 嵌入→提取的比特错误率（比特层面的损坏程度）
 *   ③ 再用真实流水线（StegoCore.embedSecret + extractSecret）跑一遍端到端，
 *      给出"零遮蔽存活率"，并对比"关闭亮度门槛（修复前）"与"开启（修复后）"。
 *
 * 为什么必须逐个 Tile 单独测：端到端只会告诉你"总共读回多少个"，而选择算法
 *   （spread 分桶）会让某些 Tile 根本没被选中，于是"没读回"和"没用到"混在一起，
 *   分不清是损坏还是没选。逐个测才能把"这个 Tile 本身能不能承载"量出来。
 *
 * 运行： node tests/diag-clamp-loss.node.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js', 'stego-core.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
const { simulateJpegRoundTrip } = require('./jpeg-sim.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, kc) => encodeJpeg(img, Math.round(q01 * 100), kc);

const IU = global.ImageUtils;
const DCT = global.DctStego;
const SC = global.StegoCore;
const Packet = global.Packet;

const TILE = 64;
const N8 = 8;
const BLOCK_PIXELS = 64;
const M6 = SC.CONST.MODE_6;
const MARGIN = DCT.DEFAULT_MARGIN;

// ============================================================
// 工具
// ============================================================
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;   // 归一化到 [0,1)
  };
}

function newImageData(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const img = c.getContext('2d').createImageData(w, h);
  return img;
}

/** 在 [x0,y0,w,h) 区域填均匀随机灰度（三通道相同 → 纯灰，方差可控） */
function fillNoise(img, x0, y0, w, h, lo, hi, rng) {
  const d = img.data, W = img.width;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const v = lo + Math.floor(rng() * (hi - lo + 1));
      const o = (y * W + x) * 4;
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
    }
  }
}

/** 取 (x,y) 处 64×64 局部 ImageData */
function tileAt(img, x, y) {
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  for (let r = 0; r < TILE; r++) {
    const s = ((y + r) * img.width + x) * 4;
    out.set(img.data.subarray(s, s + TILE * 4), r * TILE * 4);
  }
  return new global.ImageData(out, TILE, TILE);
}

/** Tile 平均亮度（0.299R + 0.587G + 0.114B） */
function avgLuminance(tileData) {
  const d = tileData.data;
  let sum = 0;
  for (let i = 0; i < TILE * TILE; i++) {
    const o = i * 4;
    sum += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  }
  return sum / (TILE * TILE);
}

function bytesToBits(bytes) {
  const bits = new Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let k = 0; k < 8; k++) bits[i * 8 + k] = (bytes[i] >> (7 - k)) & 1;
  }
  return bits;
}

/** 造一个 CRC 合法的 payload（与内核 buildPayloadFor 同构：seq/K/symbol + CRC） */
function makePayloadBytes(seed) {
  const body = new Uint8Array(M6.bodyBytes);
  body[0] = 0; body[1] = 0;
  const K = 7;
  body[2] = (K >>> 8) & 0xFF; body[3] = K & 0xFF;
  const rng = makeRng(seed);
  for (let i = 4; i < M6.bodyBytes; i++) body[i] = Math.floor(rng() * 256) & 0xFF;
  return Packet.pack(body);
}

/** 该 Tile 单独嵌入后，`bitCount` 个比特里能读回几个（CRC 是否通过由调用方判断） */
function tileCrcPass(tileData, mode) {
  const bits = DCT.extractBitsFromTile(tileData, mode.bitsPerTile, { pairs: mode.pairs || DCT.DEFAULT_PAIRS });
  const n = Math.floor(bits.length / 8);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] & 1);
    bytes[i] = v;
  }
  const r = Packet.unpack(bytes);
  return !!(r && r.valid && r.payload && r.payload.length === bytes.length - 4);
}

/**
 * 复刻 embedBitsInTile 的逐像素改写过程，并统计 clamp 发生次数。
 *
 * 与内核唯一的区别是：这里把"加完 ΔY 之后落到 [0,255] 之外"的像素单独数出来。
 *   clampedWrites ：R/G/B 三个通道里被 clamp 的写入次数（一个像素最多 3 次）
 *   clampedPixels ：至少有一个通道被 clamp 的像素数（一个 8×8 块 最多 64）
 *   lostMagnitude ：被 clamp 吞掉的 |超出量| 之和（用来衡量"想改但改不动"的幅度）
 * 返回值里同时给出真实嵌入结果 out（与内核 embedBitsInTile 的输出逐字节一致）。
 */
function embedWithClampStats(tileImageData, bits, pairs) {
  const w = tileImageData.width, h = tileImageData.height;
  const src = tileImageData.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);

  const y = new Float64Array(BLOCK_PIXELS);
  let clampedWrites = 0, clampedPixels = 0, lostMagnitude = 0;
  let marginSum = 0, blockCount = 0;
  let bitCursor = 0;
  const blocksX = w / N8, blocksY = h / N8;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (bitCursor >= bits.length) break;
      const baseX = bx * N8, baseY = by * N8;

      for (let r = 0; r < N8; r++) {
        for (let c = 0; c < N8; c++) {
          const p = ((baseY + r) * w + (baseX + c)) * 4;
          y[r * N8 + c] = 0.299 * out[p] + 0.587 * out[p + 1] + 0.114 * out[p + 2];
        }
      }
      const coeffs = DCT.dct8x8(y);
      // 与内核一致：margin = clamp(min + gain*sqrt(variance), min, max)
      let sum = 0;
      for (let i = 0; i < BLOCK_PIXELS; i++) sum += y[i];
      const mean = sum / BLOCK_PIXELS;
      let acc = 0;
      for (let i = 0; i < BLOCK_PIXELS; i++) { const dv = y[i] - mean; acc += dv * dv; }
      const variance = acc / BLOCK_PIXELS;
      const margin = Math.min(MARGIN.marginMax,
        Math.max(MARGIN.marginMin, MARGIN.marginMin + MARGIN.marginGain * Math.sqrt(Math.max(0, variance))));

      for (let k = 0; k < pairs.length && bitCursor < bits.length; k++, bitCursor++) {
        const pr = pairs[k];
        const ia = pr[1] * N8 + pr[0], ib = pr[3] * N8 + pr[2];
        const a = coeffs[ia], b = coeffs[ib];
        const diff = a - b, mid = (a + b) / 2, half = margin / 2;
        if (bits[bitCursor] === 1) {
          if (!(diff >= margin)) { coeffs[ia] = mid + half; coeffs[ib] = mid - half; }
        } else if (!(-diff >= margin)) { coeffs[ia] = mid - half; coeffs[ib] = mid + half; }
      }

      const yPrime = DCT.idct8x8(coeffs);
      for (let r = 0; r < N8; r++) {
        for (let c = 0; c < N8; c++) {
          const q = ((baseY + r) * w + (baseX + c)) * 4;
          const dv = yPrime[r * N8 + c] - y[r * N8 + c];
          let touched = false;
          for (let ch = 0; ch < 3; ch++) {
            const v = out[q + ch] + dv;
            if (v < 0 || v > 255) {
              clampedWrites++;
              touched = true;
              lostMagnitude += (v < 0 ? -v : v - 255);
            }
            out[q + ch] = v < 0 ? 0 : (v > 255 ? 255 : Math.round(v));
          }
          if (touched) clampedPixels++;
        }
      }
      marginSum += margin;
      blockCount++;
    }
  }
  return {
    out: new global.ImageData(out, w, h),
    clampedWrites: clampedWrites,
    clampedPixels: clampedPixels,
    lostMagnitude: lostMagnitude,
    marginAvg: blockCount ? marginSum / blockCount : 0
  };
}

// ============================================================
// 四类测试图
// ============================================================
function buildImages() {
  const W = 512, H = 512;                       // 8×8 = 64 个 Tile

  const bright = newImageData(W, H);
  fillNoise(bright, 0, 0, W, H, 200, 255, makeRng(101));

  const normal = newImageData(W, H);
  fillNoise(normal, 0, 0, W, H, 30, 225, makeRng(102));

  const mixed = newImageData(W, H);
  fillNoise(mixed, 0, 0, W / 2, H, 220, 255, makeRng(103));      // 左半：极亮
  fillNoise(mixed, W / 2, 0, W / 2, H, 30, 80, makeRng(104));    // 右半：极暗

  const dark = newImageData(W, H);
  fillNoise(dark, 0, 0, W, H, 0, 30, makeRng(105));

  // A2 明亮"弱纹理"：范围 228~255 → 方差 ≈ 60，刚好过 60 的纹理门槛。
  //    这是最像真实天空的一类：云层只有很淡的明暗变化，margin 只能取到 ~16，
  //    余量小到 clamp 造成的失真就有机会掀翻符号。
  const brightWeak = newImageData(W, H);
  fillNoise(brightWeak, 0, 0, W, H, 228, 255, makeRng(106));

  // F 极亮"弱到不达标"：范围 240~255 → 方差 ≈ 18 < 60，本来就不会被选为承载块
  const brightFlat = newImageData(W, H);
  fillNoise(brightFlat, 0, 0, W, H, 240, 255, makeRng(107));

  // A3 彩色明亮：R/G 有纹理、B 通道饱和（255）—— 真实蓝天/白云就是这个样子。
  //    B 一旦饱和，ΔY 落到 B 上的那 0.114 份额会被 clamp 吃掉，三通道加权和
  //    不再等于 ΔY，亮度失真与灰度图不同。
  const brightColor = newImageData(W, H);
  {
    const rng = makeRng(108);
    const d = brightColor.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const r = 200 + Math.floor(rng() * 40);
        const g = 215 + Math.floor(rng() * 30);
        d[o] = r; d[o + 1] = Math.min(255, g); d[o + 2] = 255; d[o + 3] = 255;
      }
    }
  }

  return [
    { name: 'A  明亮强纹理(200~255)', img: bright },
    { name: 'A2 明亮弱纹理(228~255)', img: brightWeak },
    { name: 'G  平滑斜坡(每块内 span=27)', img: ladderGradient(27, 0) },
    { name: 'G2 平滑斜坡+微噪声(span=27)', img: ladderGradient(27, 3) },
    { name: 'H  平滑斜坡(每块内 span=54)', img: ladderGradient(54, 0) },
    { name: 'B  正常图(30~225)', img: normal },
    { name: 'C  混合图(左亮右暗)', img: mixed },
    { name: 'D  极暗图(0~30)', img: dark },
    { name: 'F  极亮弱纹理(240~255，本就不达标)', img: brightFlat }
  ];
}

/**
 * "阶梯斜坡"图：整图按 Tile 行分成 8 档基础亮度（20/50/80/110/140/170/200/230），
 * 每个 Tile 内部是一条**平滑斜坡**（跨度为 span，从基础亮度升到 基础亮度+span）。
 *
 * 为什么需要它：真实天空的难点不在于"亮"，而在于"**又亮又平滑**"——
 *   平滑 ⇒ 块内中频系数≈0 ⇒ 嵌入端必须**从零创建**那 6 对系数（mid≈0，
 *   两个系数各摆到 ±margin/2），空间域上是一个满幅的低频波纹；
 *   而噪声纹理块里中频能量本来就大，`modulatePair` 经常发现"符号已经对了"
 *   就直接跳过，或者只需微调，clamp 削掉一点也不影响符号。
 *   阶梯图把"纹理统计（同一张图内每块的方差几乎相同）"固定住，只让**亮度**从
 *   20 变到 230 —— 于是"通过率随亮度怎么变"就成了一个干净的对照实验。
 *
 * span=27 时块内方差 ≈ 27²/12 ≈ 61（刚过 60 门槛，margin ≈ 16，余量最小）；
 * span=54 时方差 ≈ 243（margin ≈ 24）。
 */
function ladderGradient(span, noiseAmp) {
  const W = 512, H = 512;
  const img = newImageData(W, H);
  const bases = [20, 50, 80, 110, 140, 170, 200, 230];
  const rng = makeRng(span * 7 + noiseAmp);
  const d = img.data;
  for (let ty = 0; ty < 8; ty++) {
    const base = bases[ty];
    for (let ly = 0; ly < TILE; ly++) {
      for (let x = 0; x < W; x++) {
        const o = ((ty * TILE + ly) * W + x) * 4;
        let v = base + (ly / (TILE - 1)) * span;
        if (noiseAmp) v += rng() * noiseAmp * 2 - noiseAmp;
        v = Math.max(0, Math.min(255, Math.round(v)));
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
      }
    }
  }
  return img;
}

/**
 * 平滑竖直渐变图：模拟"天空/水面这种大面积平滑过渡"。
 *   这是最关键的对照类：块内几乎没有中频内容（渐变在 DCT 上只有 DC 与 (0,1)），
 *   于是嵌入端必须**从零创建**那 6 对系数（mid ≈ 0，全部按 margin/2 摆位置），
 *   空间域上就是一个满幅的低频波纹 —— 一旦这个波纹在亮部被 clamp 削掉一半，
 *   系数对的符号就可能被掀翻。噪声类图像不会这样：块内本来就有大量中频能量，
 *   `modulatePair` 常常发现"符号已经对了"直接跳过，改动量小得多。
 *
 * 渐变跨度决定方差：范围 r 的均匀分布方差 = r²/12，所以
 *   228→255（r=27）→ 方差 ≈ 61，刚好越过 60 的门槛，margin ≈ 16（余量最小）；
 *   190→255（r=65）→ 方差 ≈ 352，margin ≈ 27。
 */
function smoothGradient(lo, hi, noiseAmp) {
  const W = 512, H = 512;
  const img = newImageData(W, H);
  const rng = makeRng(lo * 1000 + hi);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let v = lo + (y / (H - 1)) * (hi - lo);
      if (noiseAmp) v += rng() * noiseAmp * 2 - noiseAmp;
      v = Math.max(0, Math.min(255, Math.round(v)));
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
    }
  }
  return img;
}

/**
 * 交叉验证：本脚本复刻的 clamp 统计必须与内核 embedBitsInTile 的输出**逐字节一致**，
 * 否则"被 clamp 了多少次"这套数字就不可信。
 */
function crossValidateReplica() {
  const img = smoothGradient(228, 255, 1);
  const bits = bytesToBits(makePayloadBytes(9001));
  const tile = tileAt(img, 0, 0);
  const kernel = DCT.embedBitsInTile(tile, bits, { pairs: DCT.DEFAULT_PAIRS });
  const mine = embedWithClampStats(tile, bits, DCT.DEFAULT_PAIRS).out;
  let diff = 0;
  for (let i = 0; i < kernel.data.length; i++) if (kernel.data[i] !== mine.data[i]) diff++;
  return { diff: diff, len: kernel.data.length };
}

/** 512×512 秘密图（16×16 图案） */
function secretImage(size) {
  const img = newImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const v = ((x * 7 + y * 13) % 200) + 30;
      d[o] = v; d[o + 1] = 255 - v; d[o + 2] = (v * 3) % 255; d[o + 3] = 255;
    }
  }
  return img;
}

// ============================================================
// ① 逐 Tile 单独嵌入：CRC 通过率 与 clamp 统计
// ============================================================
console.log('='.repeat(96));
console.log('diag-clamp-loss：像素 clamp 对承载块存活率的影响');
console.log('='.repeat(96));
console.log('每个 512×512 图含 64 个 64×64 Tile；对**每一个** Tile 单独嵌入同一份 CRC 合法载荷，');
console.log('再原地提取并校验 CRC。clamp 统计来自复刻 embedBitsInTile 的逐像素改写过程。\n');

const images = buildImages();
const perTileRows = [];

{
  const cv = crossValidateReplica();
  console.log(`【交叉验证】本脚本复刻的嵌入结果 vs 内核 DctStego.embedBitsInTile：` +
    `${cv.len} 字节中不同 ${cv.diff} 个 → ${cv.diff === 0 ? '逐字节一致 ✓' : '不一致 ✗（下面的 clamp 统计不可信）'}\n`);
}

for (const item of images) {
  const img = item.img;
  const bits = bytesToBits(makePayloadBytes(9001));
  let crcPass = 0, lumSum = 0, clampWrites = 0, clampPixels = 0, lost = 0, bitErr = 0, bitTotal = 0;
  let marginSum = 0;
  let failLumSum = 0, failCount = 0, okLumSum = 0, okCount = 0;
  const variance = [];
  let skipped = 0;

  for (let ty = 0; ty + TILE <= img.height; ty += TILE) {
    for (let tx = 0; tx + TILE <= img.width; tx += TILE) {
      const tile = tileAt(img, tx, ty);
      const lum = avgLuminance(tile);
      // 与内核同一套方差口径（ImageUtils.calculateTileVariance）
      const v = IU.calculateTileVariance({ width: TILE, height: TILE, data: tile });
      variance.push(v);
      if (v < SC.CONST.DEFAULT_VARIANCE_THRESHOLD) { skipped++; continue; }
      const sim = embedWithClampStats(tile, bits, MCT_PAIRS());
      const ok = tileCrcPass(sim.out, M6);
      const back = DCT.extractBitsFromTile(sim.out, bits.length, { pairs: MCT_PAIRS() });
      let err = 0;
      for (let i = 0; i < bits.length; i++) if ((back[i] ? 1 : 0) !== bits[i]) err++;

      lumSum += lum;
      marginSum += sim.marginAvg;
      clampWrites += sim.clampedWrites;
      clampPixels += sim.clampedPixels;
      lost += sim.lostMagnitude;
      bitErr += err; bitTotal += bits.length;
      if (ok) { crcPass++; okLumSum += lum; okCount++; } else { failLumSum += lum; failCount++; }
    }
    }
  const tested = 64 - skipped;
  const rows = {
    name: item.name,
    tested: tested,
    skipped: skipped,
    crcPass: crcPass,
    avgLum: lumSum / Math.max(1, tested),
    marginAvg: marginSum / Math.max(1, tested),
    avgVar: variance.reduce((s, x) => s + x, 0) / variance.length,
    clampWritesPerTile: clampWrites / Math.max(1, tested),
    clampPixelsPerTile: clampPixels / Math.max(1, tested),
    lostPerTile: lost / Math.max(1, tested),
    bitErrPct: bitTotal ? bitErr / bitTotal * 100 : 0,
    failAvgLum: failCount ? failLumSum / failCount : NaN,
    okAvgLum: okCount ? okLumSum / okCount : NaN
  };
  perTileRows.push(rows);
  console.log(`--- ${item.name} ---`);
  console.log(`  纹理达标块              ：${tested}/64（方差均值 ${rows.avgVar.toFixed(0)}，门槛 ${SC.CONST.DEFAULT_VARIANCE_THRESHOLD}）`);
  console.log(`  CRC 通过（单独嵌入后）  ：${crcPass}/${tested} = ${tested ? (crcPass / tested * 100).toFixed(1) : '-'}%`);
  console.log(`  平均亮度 / 平均 margin  ：${rows.avgLum.toFixed(1)} / ${rows.marginAvg.toFixed(1)}` +
    `（通过块亮度均值 ${isNaN(rows.okAvgLum) ? '-' : rows.okAvgLum.toFixed(1)}，` +
    `失败块 ${isNaN(rows.failAvgLum) ? '-' : rows.failAvgLum.toFixed(1)}）`);
  console.log(`  被 clamp 的写入/块      ：${rows.clampWritesPerTile.toFixed(1)} 次` +
    `（受影响像素 ${rows.clampPixelsPerTile.toFixed(1)}/64，吞掉幅度合计 ${rows.lostPerTile.toFixed(1)}）`);
  console.log(`  比特错误率              ：${rows.bitErrPct.toFixed(2)}%（384 bit/Tile）`);
  console.log('');
}

function MCT_PAIRS() { return DCT.DEFAULT_PAIRS; }

// ============================================================
// ①b 阶梯图逐行明细：亮度扫描（同一张图内，纹理统计相同，只有亮度不同）
// ============================================================
console.log('='.repeat(96));
console.log('亮度扫描（阶梯斜坡图：每块内是同样的平滑斜坡，只有基础亮度不同）');
console.log('='.repeat(96));
for (const cfg of [{ span: 27, noise: 0 }, { span: 54, noise: 0 }]) {
  const img = ladderGradient(cfg.span, cfg.noise);
  const bits = bytesToBits(makePayloadBytes(9001));
  console.log(`\nspan=${cfg.span}（块内方差 ≈ ${(cfg.span * cfg.span / 12).toFixed(0)}）：` +
    `Tile行  平均亮度  margin  CRC通过/8  clamp写入/块  比特错误率`);
  for (let ty = 0; ty < 8; ty++) {
    let pass = 0, lumSum = 0, clampSum = 0, errSum = 0, bitSum = 0, marginSum = 0;
    for (let tx = 0; tx < 8; tx++) {
      const tile = tileAt(img, tx * TILE, ty * TILE);
      const sim = embedWithClampStats(tile, bits, MCT_PAIRS());
      lumSum += avgLuminance(tile);
      clampSum += sim.clampedWrites;
      marginSum += sim.marginAvg;
      if (tileCrcPass(sim.out, M6)) pass++;
      const back = DCT.extractBitsFromTile(sim.out, bits.length, { pairs: MCT_PAIRS() });
      for (let i = 0; i < bits.length; i++) if ((back[i] ? 1 : 0) !== bits[i]) errSum++;
      bitSum += bits.length;
    }
    console.log(`        ${ty}      ${(lumSum / 8).toFixed(1).padStart(7)}` +
      `${(marginSum / 8).toFixed(1).padStart(8)}` +
      `${String(pass + '/8').padStart(11)}` +
      `${(clampSum / 8).toFixed(1).padStart(14)}` +
      `${(errSum / bitSum * 100).toFixed(2).padStart(12)}%`);
  }
}

console.log('='.repeat(96));
console.log('对照表（逐 Tile 单独嵌入；只统计方差达标的块）');
console.log('='.repeat(96));
console.log('图类型'.padEnd(34) + '达标   CRC通过  平均亮度  平均margin  clamp写入/块  比特错误率');
for (const r of perTileRows) {
  console.log(r.name.padEnd(30) +
    `${r.tested}/64`.padStart(7) +
    `${r.crcPass}/${r.tested}`.padStart(10) +
    r.avgLum.toFixed(1).padStart(10) +
    r.marginAvg.toFixed(1).padStart(11) +
    r.clampWritesPerTile.toFixed(1).padStart(13) +
    (r.bitErrPct.toFixed(2) + '%').padStart(12));
}

// ============================================================
// ② 端到端：真实流水线的零遮蔽存活率（修复前 / 修复后对照）
// ============================================================
const GATE_SUPPORTED = typeof SC.CONST.MIN_TILE_LUM === 'number' &&
  typeof SC.CONST.MAX_TILE_LUM === 'number' &&
  typeof SC.CONST.MIN_BLOCK_MARGIN === 'number';
// "修复前"= 把三条判据全部关掉，复现老的选块行为
const BEFORE_OPTS = { minTileLum: 0, maxTileLum: 255, minBlockMargin: 0 };
const secret16 = secretImage(16);
const secret32 = secretImage(32);

function endToEnd(item, opts) {
  const st = SC.embedSecret(item.img, secret16, Object.assign({ redundancy: 'standard' }, opts || {}));
  const ex = SC.extractSecret(st.outputImageData);
  const cap = SC.analyzeCapacity(item.img, st.stats.secretJpegBytes, Object.assign({ redundancy: 'standard' }, opts || {}));
  return {
    K: st.stats.K, N: st.stats.N, textured: st.stats.texturedTiles,
    valid: ex.validTiles, total: ex.totalTiles,
    survival: st.stats.N ? ex.validTiles / st.stats.N : 0,
    success: ex.success,
    darkRejected: cap.darkRejected, brightRejected: cap.brightRejected,
    lowMarginRejected: cap.lowMarginRejected, safeTiles: cap.safeTiles,
    riskyTilesUsed: st.stats.riskyTilesUsed,
    capTextured: cap.texturedTiles
  };
}

/** 端到端包一层：某些（极亮/极暗）合成图可能连一个纹理块都没有，如实记为"嵌入失败" */
function endToEndSafe(item, opts) {
  try {
    return endToEnd(item, opts);
  } catch (e) {
    return { error: e.message, K: 0, N: 0, valid: 0, survival: 0, success: false, capTextured: 0 };
  }
}

console.log('\n' + '='.repeat(96));
console.log('端到端：标准档 + 16×16 秘密图，零遮蔽提取的承载块存活率');
console.log('='.repeat(96));
if (!GATE_SUPPORTED) {
  console.log('（当前内核尚无亮度门槛 → 下表两列相同，这就是"修复前"的基线）');
} else {
  console.log('（"修复前"用 minTileLum=0/maxTileLum=255 关闭门槛复现旧行为）');
}
console.log('图类型'.padEnd(30) + '阶段    读回/写入  存活率   纹理块  安全块  过暗拒/过亮拒/低margin拒  结果');
const endRows = [];
for (const item of images) {
  const before = endToEndSafe(item, GATE_SUPPORTED ? BEFORE_OPTS : null);
  const after = endToEndSafe(item, null);
  endRows.push({ name: item.name, before: before, after: after });
  for (const [label, r] of [['修复前', before], ['修复后', after]]) {
    if (r.error) {
      console.log(item.name.padEnd(26) + ` ${label}  嵌入失败：${r.error.slice(0, 40)}…`);
      continue;
    }
    console.log(item.name.padEnd(26) + ` ${label} ` +
      `${r.valid}/${r.N}`.padStart(10) +
      ` ${(r.survival * 100).toFixed(1)}%`.padStart(8) +
      ` ${String(r.capTextured).padStart(7)}` +
      ` ${String(r.safeTiles === undefined ? '-' : r.safeTiles).padStart(6)}` +
      ` ${((r.darkRejected === undefined ? '-' : r.darkRejected) + '/' +
        (r.brightRejected === undefined ? '-' : r.brightRejected) + '/' +
        (r.lowMarginRejected === undefined ? '-' : r.lowMarginRejected)).padStart(24)}` +
      `  ${r.success ? '成功' : '失败'}`);
  }
}

// ============================================================
// ③ 用户场景复刻：上半明亮天空（渐变 + 云状纹理）+ 下半深色水面
// ------------------------------------------------------------
// 用 1024×1024：512×512 只有 64 个 64×64 Tile，而 32×32 秘密图（JPEG ~1.4 KB）
// 在标准档下需要 N≈72 个 Tile —— 载具本身放不下，与 clamp 无关（这一条也打印出来）。
// 天空用"渐变 + 云纹理"而不是纯渐变：真实云层有很淡的明暗起伏，方差刚好越过 60
// 的门槛，于是会被选为承载块，这正是用户掩码里"顶部全红"的那些块。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('用户场景复刻：1024×1024（上半明亮天空渐变+云纹理，下半深色水面）+ 32×32 秘密图');
console.log('='.repeat(96));

function skyWaterImage(size) {
  const W = size, H = size;
  const img = newImageData(W, H);
  const rng = makeRng(4242);
  const d = img.data;
  // 天空：**大尺度云块**（每 64 px 一个云块亮度 190~255，双线性铺开）+ 轻微噪声。
  //   关键在"块间差大、块内平"：64×64 的 Tile 方差来自块与块之间的亮度台阶（够 60 门槛，
  //   所以会被选为承载块），但每个 8×8 块内部几乎是平的 → margin 只能取到下限 8~10。
  //   这正是用户那张图"头顶亮天空被选中却读不回"的成因。
  const gh = Math.ceil((H / 2) / 64) + 2, gw = Math.ceil(W / 64) + 2;
  const grid = new Float64Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = 190 + rng() * 65;
  const sample = (fx, fy) => {
    const x0 = Math.min(gw - 2, Math.max(0, Math.floor(fx)));
    const y0 = Math.min(gh - 2, Math.max(0, Math.floor(fy)));
    const tx = fx - x0, ty = fy - y0;
    const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
    const c = grid[(y0 + 1) * gw + x0], e = grid[(y0 + 1) * gw + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let r, g, b;
      if (y < H / 2) {
        const v = sample(x / 64, y / 64) + (rng() * 4 - 2);
        r = v * 0.92; g = v * 0.97; b = Math.min(255, v * 1.04);
      } else {
        const v = 30 + (rng() * 50) + 6 * Math.sin((x - y) / 9.0);
        r = v * 0.8; g = v * 0.95; b = Math.min(255, v * 1.15);
      }
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  return img;
}

/** 逐 8×8 块算 margin（与内核公式一致），返回最小的那个 */
function minBlockMarginOf(tile) {
  const d = tile.data;
  let worst = Infinity;
  for (let by = 0; by < TILE; by += 8) {
    for (let bx = 0; bx < TILE; bx += 8) {
      const vals = new Float64Array(64);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const p = ((by + r) * TILE + (bx + c)) * 4;
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
  return worst === Infinity ? 0 : worst;
}

/** 按上下半区统计"纹理块 / 安全块"，并给出该区平均亮度 */
function regionStats(img) {
  const W = img.width, H = img.height;
  const out = { top: { tex: 0, safe: 0, lum: 0, n: 0 }, bottom: { tex: 0, safe: 0, lum: 0, n: 0 } };
  for (let y = 0; y + TILE <= H; y += TILE) {
    for (let x = 0; x + TILE <= W; x += TILE) {
      const t = tileAt(img, x, y);
      const box = (y < H / 2) ? out.top : out.bottom;
      box.n++;
      box.lum += avgLuminance(t);
      const v = IU.calculateTileVariance({ width: TILE, height: TILE, data: t });
      if (v < SC.CONST.DEFAULT_VARIANCE_THRESHOLD) continue;
      box.tex++;
      if (minBlockMarginOf(t) >= SC.CONST.MIN_BLOCK_MARGIN) box.safe++;
    }
  }
  return out;
}

function scenarioReport(label, img, opts) {
  const st = SC.embedSecret(img, secret32, Object.assign({ redundancy: 'standard' }, opts || {}));
  const ex = SC.extractSecret(st.outputImageData);
  const ex90 = SC.extractSecret(simulateJpegRoundTrip(st.outputImageData, 90));
  const ex80 = SC.extractSecret(simulateJpegRoundTrip(st.outputImageData, 80));
  const rs = regionStats(img);
  console.log(`\n【${label}】`);
  console.log(`  写入 N=${st.stats.N}（K=${st.stats.K}）纹理块=${st.stats.texturedTiles} ` +
    `安全块=${st.stats.safeTiles}（低margin拒 ${st.stats.lowMarginRejected}，` +
    `过暗拒 ${st.stats.darkRejected}，过亮拒 ${st.stats.brightRejected}）` +
    ` 用安全块=${st.stats.usedSafeTiles} 回落用脆弱块=${st.stats.riskyTilesUsed}` +
    ` 秘密图 ${st.stats.secretFinalSize.W}×${st.stats.secretFinalSize.H}`);
  console.log(`  存活率：零遮蔽 ${ex.validTiles}/${st.stats.N} = ${(ex.validTiles / st.stats.N * 100).toFixed(1)}%` +
    ` ｜ JPEG q0.90 ${ex90.validTiles}/${st.stats.N} = ${(ex90.validTiles / st.stats.N * 100).toFixed(1)}%` +
    ` ｜ JPEG q0.80 ${ex80.validTiles}/${st.stats.N} = ${(ex80.validTiles / st.stats.N * 100).toFixed(1)}%` +
    `（success=${ex80.success}）`);
  console.log(`  上半（明亮天空）：平均亮度 ${(rs.top.lum / Math.max(1, rs.top.n)).toFixed(1)}，` +
    `纹理块 ${rs.top.tex} → 安全块 ${rs.top.safe}`);
  console.log(`  下半（深色水面）：平均亮度 ${(rs.bottom.lum / Math.max(1, rs.bottom.n)).toFixed(1)}，` +
    `纹理块 ${rs.bottom.tex} → 安全块 ${rs.bottom.safe}`);
  const cap = SC.analyzeCapacity(img, st.stats.secretJpegBytes, Object.assign({ redundancy: 'standard' }, opts || {}));
  console.log(`  容量分析：纹理块 ${cap.texturedTiles} / 安全块 ${cap.safeTiles}，` +
    `可装秘密图 JPEG ${cap.maxSecretBytes} → ${cap.maxSafeSecretBytes} 字节（按安全块）`);
  return { st: st, ex: ex, ex90: ex90, ex80: ex80 };
}

const sky = skyWaterImage(1024);
if (GATE_SUPPORTED) {
  scenarioReport('修复前（关闭全部安全判据）', sky, BEFORE_OPTS);
  scenarioReport('修复后（块级 margin ≥ 12 的安全块优先）', sky, null);
} else {
  scenarioReport('当前内核（尚无安全判据）', sky, null);
}

// 512×512 版本：容量本身就不够（与 clamp 无关），如实记录
console.log('\n--- 附：512×512 版本的容量限制（与 clamp 无关）---');
try {
  scenarioReport('512² 天空/水面 + 32×32 秘密图', skyWaterImage(512), null);
} catch (e) {
  console.log(`  嵌入直接失败：${e.message}`);
}

console.log('\n（诊断结束）');
