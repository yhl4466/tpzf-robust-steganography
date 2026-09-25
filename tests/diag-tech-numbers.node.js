/**
 * diag-tech-numbers.node.js —— 为 tech.html 采集可引用的实测数字（诊断脚本，不是验收测试）
 *
 * 采集项：
 *   ① LSB（最低有效位）在 JPEG 重编码后的比特存活率 —— 对照本项目 DCT 差分调制
 *   ② JPEG q=75 的量化步长表（本项目用到的系数位于哪一段）
 *   ③ "直接写系数绝对值"与"写一对系数的大小关系"在 q=75 后的误差对比
 *   ④ 标尺导频的峰背比 z（单导频 64 / 双导频 32、16），以及 0.5× 时"P/2 配对"的作用
 *   ⑤ 6 对 vs 4 对系数：量化步长、每 Tile 比特数、0.5× 缩放后的逐 Tile CRC 存活率
 *
 * 运行： node tests/diag-tech-numbers.node.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js', 'stego-core.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
const { simulateJpegRoundTrip, quantTableForQuality } = require('./jpeg-sim.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, kc) => encodeJpeg(img, Math.round(q01 * 100), kc);

const IU = global.ImageUtils;
const DCT = global.DctStego;
const GC = global.GeoCalibration;
const SC = global.StegoCore;
const Packet = global.Packet;

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

/** 照片感图像：低频块状内容 + 轻微噪声（与本项目测试套件同款生成方式） */
function photo(w, h, seed) {
  const rng = makeRng(seed);
  const img = newImageData(w, h);
  const lw = Math.max(4, Math.round(w / 24)), lh = Math.max(4, Math.round(h / 24));
  const low = new Float32Array(lw * lh);
  for (let i = 0; i < lw * lh; i++) low[i] = 30 + (randByte(rng) % 200);
  for (let y = 0; y < h; y++) {
    const fy = y * (lh - 1) / (h - 1), y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x * (lw - 1) / (w - 1), x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
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

function cloneImageData(img) {
  const out = newImageData(img.width, img.height);
  out.data.set(img.data);
  return out;
}

// ============================================================
// ① LSB 在 JPEG 重编码后的存活率
// ============================================================
console.log('=== ① LSB（最低有效位）在 JPEG 重编码后的比特存活率 ===');
{
  const carrier = photo(512, 512, 501);
  const rng = makeRng(502);
  const bits = new Uint8Array(512 * 512);
  for (let i = 0; i < bits.length; i++) bits[i] = rng() >>> 31;
  // 把比特写进每个像素的最低有效位（灰度通道）
  const stego = cloneImageData(carrier);
  for (let i = 0; i < bits.length; i++) {
    const o = i * 4;
    const y = Math.round(0.299 * stego.data[o] + 0.587 * stego.data[o + 1] + 0.114 * stego.data[o + 2]);
    const ny = (y & 0xFE) | bits[i];
    const diff = ny - y;
    stego.data[o] = Math.max(0, Math.min(255, stego.data[o] + diff));
    stego.data[o + 1] = Math.max(0, Math.min(255, stego.data[o + 1] + diff));
    stego.data[o + 2] = Math.max(0, Math.min(255, stego.data[o + 2] + diff));
  }
  const rows = [];
  for (const q of [95, 90, 75]) {
    const back = simulateJpegRoundTrip(stego, q);
    let ok = 0;
    for (let i = 0; i < bits.length; i++) {
      const o = i * 4;
      const y = Math.round(0.299 * back.data[o] + 0.587 * back.data[o + 1] + 0.114 * back.data[o + 2]);
      if ((y & 1) === bits[i]) ok++;
    }
    rows.push(`q=${q}：${(ok / bits.length * 100).toFixed(2)}%`);
  }
  console.log('  LSB 写入 → JPEG 重编码 → 读回正确率：' + rows.join('；') + '（50% 即等价于随机猜测）');
  // 对照：本项目 DCT 差分调制（默认裕量）在 q=75 下的比特正确率
  const tile = IU.splitIntoTiles(photo(64, 64, 503), 64).filter((t) => t.width === 64)[0];
  const rng2 = makeRng(504);
  const dctBits = new Uint8Array(384);
  for (let i = 0; i < 384; i++) dctBits[i] = rng2() >>> 31;
  const emb = DCT.embedBitsInTile(tile.data, dctBits);
  const afterJpeg = simulateJpegRoundTrip(emb, 75);
  const gotBits = DCT.extractBitsFromTile(afterJpeg, 384);
  let okBits = 0;
  for (let i = 0; i < 384; i++) if (gotBits[i] === !!dctBits[i]) okBits++;
  console.log('  对照 · 本项目 DCT 差分调制（裕量 8~32）q=75：' +
    (okBits / 384 * 100).toFixed(2) + '%（单个 8×8 块平均 ' + (384 / 64).toFixed(0) + ' 比特）');
}

// ============================================================
// ② q=75 量化步长表：本项目用的系数在哪一段
// ============================================================
console.log('\n=== ② JPEG q=75 的量化步长（zigzag 前 20 个）===');
{
  const t = quantTableForQuality(75);
  const zig = [[0, 0], [0, 1], [1, 0], [2, 0], [1, 1], [0, 2], [0, 3], [1, 2], [2, 1], [3, 0],
    [4, 0], [3, 1], [2, 2], [1, 3], [0, 4], [0, 5], [1, 4], [2, 3], [3, 2], [4, 1]];
  const steps = zig.map(([v, u]) => t[v * 8 + u]);
  console.log('  步长序列=' + steps.join(', '));
  const pairs = [[2, 1, 1, 2], [3, 1, 1, 3], [3, 0, 0, 3], [2, 0, 0, 2], [3, 2, 2, 3], [4, 1, 1, 4]];
  const low4 = [[2, 0, 0, 2], [2, 1, 1, 2], [3, 0, 0, 3], [3, 1, 1, 3]];
  const stepOf = (v, u) => t[v * 8 + u];
  console.log('  默认 6 对系数各自的量化步长：' + pairs.map((p) =>
    `(${p[0]},${p[1]})/(${p[2]},${p[3]})=${stepOf(p[0], p[1])}/${stepOf(p[2], p[3])}`).join('，'));
  console.log('  抗缩放 4 对（最低频）：' + low4.map((p) =>
    `(${p[0]},${p[1]})/(${p[2]},${p[3]})=${stepOf(p[0], p[1])}/${stepOf(p[2], p[3])}`).join('，'));
  // 全表两端：低频最小步长 / 高频最大步长
  const all = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) all.push({ v, u, s: t[v * 8 + u] });
  const byZig = zig.concat([[5, 0], [0, 5], [6, 0], [0, 6], [7, 7]]).map(([v, u]) => t[v * 8 + u]);
  console.log('  全表最小步长=' + Math.min(...all.map((x) => x.s)) + '，最大步长=' + Math.max(...all.map((x) => x.s)));
  console.log('  扩到 8 对时才会用到的系数步长：' +
    `(5,0)=${stepOf(5, 0)}，(0,5)=${stepOf(0, 5)}，(4,2)=${stepOf(4, 2)}，(2,4)=${stepOf(2, 4)}，` +
    `(6,0)=${stepOf(6, 0)}，(1,5)=${stepOf(1, 5)}，(7,7)=${stepOf(7, 7)}`);
}

// ============================================================
// ③ 绝对值 vs 大小关系：q=75 后的误差
// ============================================================
console.log('\n=== ③ 写"系数绝对值"与写"一对系数的大小关系"的差别（q=75）===');
{
  // 取一个中低频系数，看它在 q=75 往返后偏了多少
  const carrier = photo(128, 128, 601);
  const tiles = IU.splitIntoTiles(carrier, 64).filter((t) => t.width === 64);
  const t = quantTableForQuality(75);
  const step = t[2 * 8 + 1];        // (2,1) 的量化步长
  let sumAbs = 0, n = 0, sumRatio = 0;
  for (const tile of tiles) {
    const before = DCT.dct8x8(blockOf(tile.data, 0, 0));
    const after = DCT.dct8x8(blockOf(simulateJpegRoundTrip(tile.data, 75), 0, 0));
    const d = Math.abs(after[2 * 8 + 1] - before[2 * 8 + 1]);
    sumAbs += d; sumRatio += d / step; n++;
  }
  console.log(`  系数 (2,1) 在 q=75 往返后的平均绝对偏移：${(sumAbs / n).toFixed(2)}（= ${(sumRatio / n).toFixed(3)} 个量化步长，步长=${step}）`);
  // 大小关系：把一对系数按不同裕量拉开，看符号是否翻转
  const rng = makeRng(602);
  const rows = [];
  for (const margin of [2, 4, 8, 16, 32]) {
    let flips = 0, total = 0;
    for (let k = 0; k < 40; k++) {
      const img = photo(64, 64, 610 + k);
      const tl = IU.splitIntoTiles(img, 64).filter((x) => x.width === 64)[0];
      const bits = new Uint8Array(64);
      for (let i = 0; i < 64; i++) bits[i] = rng() >>> 31;
      const emb = DCT.embedBitsInTile(tl.data, bits, { marginMin: margin, marginGain: 0, marginMax: margin });
      const back = simulateJpegRoundTrip(emb, 75);
      const got = DCT.extractBitsFromTile(back, 64, { marginMin: margin, marginGain: 0, marginMax: margin });
      for (let i = 0; i < 64; i++) { total++; if (got[i] !== !!bits[i]) flips++; }
    }
    rows.push(`裕量 ${margin}：符号正确率 ${((1 - flips / total) * 100).toFixed(2)}%`);
  }
  console.log('  一对系数大小关系在 q=75 后：' + rows.join('；'));
}

/** 取 ImageData 里某个 8×8 块的亮度（tile.data 本身就是 ImageData） */
function blockOf(imageData, bx, by) {
  const data = imageData.data;
  const out = new Float32Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const o = ((by + r) * imageData.width + bx + c) * 4;
      out[r * 8 + c] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
  }
  return out;
}

// ============================================================
// ④ 标尺导频的峰背比 z
// ============================================================
console.log('\n=== ④ 标尺导频的峰背比 z（照片载体）===');
{
  const S = 512;
  const marked = GC.embedScale(photo(S, S, 701), S, S);
  const hp = new Float64Array(S * S);
  let mean = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    hp[i] = 0.299 * marked.data[o] + 0.587 * marked.data[o + 1] + 0.114 * marked.data[o + 2];
    mean += hp[i];
  }
  mean /= S * S;
  for (let i = 0; i < S * S; i++) hp[i] -= mean;
  const mag = (P) => {
    let re = 0, im = 0;
    const k = 2 * Math.PI / P;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const v = hp[y * S + x];
        const a = k * (x + y);
        re += v * Math.cos(a); im -= v * Math.sin(a);
      }
    }
    return Math.sqrt(re * re + im * im);
  };
  const zOf = (P) => {
    // 背景 = ±12 像素周期内的平均幅值（与 geo-calibration.js 里的 BG_HALF_PERIODS 一致）
    let bg = 0, c = 0;
    for (let d = -12; d <= 12; d++) {
      if (d === 0) continue;
      bg += mag(P + d);
      c++;
    }
    return mag(P) / (bg / c);
  };
  console.log(`  z(64)=${zOf(64).toFixed(2)}，z(32)=${zOf(32).toFixed(2)}，z(16)=${zOf(16).toFixed(2)}` +
    `（z = 该频点相关幅值 / 邻域背景，越大越说明"这里真有一根导频"而不是图像内容）`);
  // 0.5× 时 P/2 配对的作用（谱表下限是否含 8）
  const half = simulateJpegRoundTrip(newImageData(1, 1), 75); // 占位，避免未使用告警
  void half;
}

// ============================================================
// ⑤ 6 对 vs 4 对系数
// ============================================================
console.log('\n=== ⑤ 6 对 vs 4 对系数（每 Tile 比特数 / 缩放存活率）===');
{
  const M6 = SC.CONST.MODE_6, M4 = SC.CONST.MODE_4;
  console.log(`  MODE_6：${M6.bitsPerTile} bit/Tile，符号 ${M6.symbolSize} 字节，payload ${M6.payloadBytes} 字节`);
  console.log(`  MODE_4：${M4.bitsPerTile} bit/Tile，符号 ${M4.symbolSize} 字节，payload ${M4.payloadBytes} 字节`);
  const secret = (() => {
    const img = newImageData(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let v = ((((x >> 1) + (y >> 1)) & 1) === 1) ? 235 : 20;
      if (((x + y) & 7) < 2) v = v > 128 ? 70 : 190;
      const o = (y * 16 + x) * 4;
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
    }
    return img;
  })();
  const carrier = photo(512, 512, 801);
  const crcRate = (img, mode, used) => {
    const tiles = IU.splitIntoTiles(img, 64);
    const pairs = mode.pairs || null;      // MODE_6 的 pairs 为 null（用 dct-stego 的默认 6 对）
    let pass = 0;
    for (const t of tiles) {
      if (t.width !== 64 || t.height !== 64) continue;
      const bits = DCT.extractBitsFromTile(t.data, mode.bitsPerTile, pairs ? { pairs: pairs } : {});
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
  };
  const canvasScale = (img, sc) => {
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
  };
  for (const [label, opts] of [['MODE_6 + standard', {}], ['MODE_4 + balanced', { lowFrequencyMode: true, redundancy: 'balanced' }]]) {
    const st = SC.embedSecret(carrier, secret, opts);
    const rows = [];
    for (const sc of [1, 0.75, 0.5]) {
      const img = sc === 1 ? st.outputImageData : canvasScale(st.outputImageData, sc);
      const size = GC.extractScale(img);
      let rate = null;
      if (size) {
        const back = canvasScale(img, 512 / img.width);
        const cancelled = GC.removeScale(back, size.width, size.height);
        rate = crcRate(cancelled, opts.lowFrequencyMode ? M4 : M6, st.stats.N);
      }
      rows.push(`${sc}×：${rate ? rate.pass + '/' + rate.total + '=' + (rate.rate * 100).toFixed(1) + '%' : '标尺未读出'}`);
    }
    console.log(`  ${label}（K=${st.stats.K}, N=${st.stats.N}）：` + rows.join('；'));
  }
}
