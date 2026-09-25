/**
 * diag-real-image.node.js —— 用用户提供的真实图做诊断（本轮**只诊断**，不改动任何产品代码）
 *
 * 输入（tests/fixtures/）：
 *   carrier_stego.png    嵌入后的隐写图，2649×1582，8bit RGBA（filter 全为 2=Up）
 *   secret_original.png  嵌入时用的秘密图
 * 目标：复现浏览器实测的 309/422 = 73.2%，找出 27% 损失的来源。
 *
 * 为什么自带一个 PNG 解码器：仓库里的 tests/png-codec.js 只支持 filter 0（它自己编码
 *   出来的图），而真实文件每行都是 filter 2，直接调用会抛"只支持 filter 类型 0"。
 *   这里是纯诊断脚本，按"不改动共享代码"的要求把解码器写在本文件内（支持 8bit 的
 *   colorType 0/2/4/6 + filter 0~4 + 非隔行）。
 *
 * 四个部分：
 *   ① 环境对比：Node 读出的 validTiles / K_effective 是否与浏览器一致
 *   ② 网格对齐检查：0~7px 全相位扫描（判断损失是"网格错位"还是"块本身太弱"）
 *   ③ margin × CRC 存活率分档表（找出存活率掉下来的临界 margin）
 *   ④ 阈值 12/14/16 的可用块数、容量与抗遮蔽推算
 *
 * 运行： node tests/diag-real-image.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js', 'stego-core.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, kc) => encodeJpeg(img, Math.round(q01 * 100), kc);

const IU = global.ImageUtils;
const DCT = global.DctStego;
const SC = global.StegoCore;
const Packet = global.Packet;
const TILE = 64, N8 = 8;

// ============================================================
// 自带的 PNG 解码（8bit / colorType 0,2,4,6 / filter 0~4 / 非隔行）
// ============================================================
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(buf) {
  if (!buf.slice(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  const filters = {};
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (crc32(buf.slice(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) {
      throw new Error('PNG 分块 CRC 失败：' + type);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const ch = colorType === 6 ? 4 : (colorType === 2 ? 3 : (colorType === 4 ? 2 : 1));
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const plane = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    filters[ft] = (filters[ft] || 0) + 1;
    const row = plane.subarray(y * stride, (y + 1) * stride);
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y > 0 ? plane.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? row[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = src[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      } else if (ft !== 0) throw new Error('未知 filter ' + ft);
      row[i] = v;
    }
  }
  // 统一转成 RGBA（ImageData 布局）
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch, d = i * 4;
    if (ch === 4) { out[d] = plane[s]; out[d + 1] = plane[s + 1]; out[d + 2] = plane[s + 2]; out[d + 3] = plane[s + 3]; }
    else if (ch === 3) { out[d] = plane[s]; out[d + 1] = plane[s + 1]; out[d + 2] = plane[s + 2]; out[d + 3] = 255; }
    else if (ch === 2) { out[d] = plane[s]; out[d + 1] = plane[s]; out[d + 2] = plane[s]; out[d + 3] = plane[s + 1]; }
    else { out[d] = plane[s]; out[d + 1] = plane[s]; out[d + 2] = plane[s]; out[d + 3] = 255; }
  }
  return { width: width, height: height, colorType: colorType, ch: ch, filters: filters, data: out };
}

// ============================================================
// 工具（与内核同口径）
// ============================================================
function tileAt(img, x, y) {
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  for (let r = 0; r < TILE; r++) {
    const s = ((y + r) * img.width + x) * 4;
    out.set(img.data.subarray(s, s + TILE * 4), r * TILE * 4);
  }
  return new global.ImageData(out, TILE, TILE);
}
/** Tile 平均亮度 */
function tileLum(t) {
  let s = 0;
  for (let i = 0; i < TILE * TILE; i++) {
    const o = i * 4;
    s += 0.299 * t.data[o] + 0.587 * t.data[o + 1] + 0.114 * t.data[o + 2];
  }
  return s / (TILE * TILE);
}
/** 64 个 8×8 块的 margin：返回 {min, avg}（公式与 dct-stego.adaptiveMargin 一致） */
function blockMargins(t) {
  const d = t.data;
  let min = Infinity, sum = 0, n = 0;
  const vals = new Float64Array(64);
  for (let by = 0; by < TILE; by += N8) {
    for (let bx = 0; bx < TILE; bx += N8) {
      let s = 0;
      for (let r = 0; r < N8; r++) {
        for (let c = 0; c < N8; c++) {
          const p = (((by + r) * TILE) + (bx + c)) * 4;
          const y = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
          vals[r * N8 + c] = y; s += y;
        }
      }
      const mean = s / 64;
      let acc = 0;
      for (let i = 0; i < 64; i++) { const dv = vals[i] - mean; acc += dv * dv; }
      const m = Math.min(32, Math.max(8, 8 + Math.sqrt(Math.max(0, acc / 64))));
      if (m < min) min = m;
      sum += m; n++;
    }
  }
  return { min: min, avg: sum / n };
}
/** 该 Tile 的载荷能否通过 CRC（6 对模式） */
function tileCrcPass(t, mode) {
  const bits = DCT.extractBitsFromTile(t, mode.bitsPerTile,
    mode.pairs ? { pairs: mode.pairs } : {});
  const n = Math.floor(bits.length / 8);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | (bits[i * 8 + k] & 1);
    bytes[i] = v;
  }
  const r = Packet.unpack(bytes);
  return !!(r && r.valid);
}
const pct = (x) => (x * 100).toFixed(1) + '%';
const pad = (s, n) => String(s).padStart(n);

// ============================================================
// 读入
// ============================================================
const stegoPath = path.join(__dirname, 'fixtures', 'carrier_stego.png');
const secretPath = path.join(__dirname, 'fixtures', 'secret_original.png');
console.log('='.repeat(96));
console.log('diag-real-image：用用户真实图复现 73.2% 存活率');
console.log('='.repeat(96));

const png = decodePng(fs.readFileSync(stegoPath));
const stego = new global.ImageData(png.data, png.width, png.height);
console.log(`carrier_stego.png ：${png.width}×${png.height}，colorType=${png.colorType}，` +
  `通道=${png.ch}，filter 分布=${JSON.stringify(png.filters)}`);
// 注意：secret_original.png 的**真实格式是 JPEG**（魔数 FF D8 FF E0，只有扩展名写着 .png）。
//   这不是小事：嵌入进载荷的就是这份 JPEG 字节流，我们因此可以做逐字节比对。
const secBuf = fs.readFileSync(secretPath);
const secIsJpeg = secBuf[0] === 0xff && secBuf[1] === 0xd8;
const secIsPng = secBuf.slice(0, 8).equals(PNG_SIG);
let payloadBytes, secretDesc;
if (secIsJpeg) {
  payloadBytes = secBuf;
  secretDesc = `JPEG 字节流（扩展名写的是 .png，实际魔数 FF D8）`;
} else if (secIsPng) {
  const secPng = decodePng(secBuf);
  secretDesc = `PNG ${secPng.width}×${secPng.height}（需按 q75 重编码成 JPEG 才能估算载荷）`;
  payloadBytes = encodeJpeg(new global.ImageData(secPng.data, secPng.width, secPng.height), 75, true);
} else {
  throw new Error('secret 文件既不是 PNG 也不是 JPEG');
}
console.log(`secret_original.png：${secBuf.length} 字节，实际是 ${secretDesc}` +
  (secIsJpeg ? `；载荷 JPEG ${payloadBytes.length} 字节` : `；重编码后 ${payloadBytes.length} 字节`));
// 载荷长度 → 该次嵌入一定用到的 K/N（标准档 N=2K，符号 40 字节 + 14 字节头）
const needK = Math.ceil((14 + payloadBytes.length) / 40);
const needN = needK * 2;
console.log(`载荷长度推算：K=${needK}，标准档 N=${needN}`);

// ============================================================
// ① 环境对比：Node 与浏览器是否一致
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('① 环境对比（Node vs 浏览器 309/422）');
console.log('='.repeat(96));
const t0 = Date.now();
const ex = SC.extractSecret(stego);
const dtExtract = Date.now() - t0;
const cols = Math.floor(png.width / TILE), rows = Math.floor(png.height / TILE);
const alignedTiles = cols * rows;
console.log(`  对齐网格          ：${cols}×${rows} = ${alignedTiles} 个 Tile`);
console.log(`  validTiles        ：${ex.validTiles}（浏览器报 309）`);
console.log(`  K_effective       ：${ex.K_effective}（浏览器报 211）`);
console.log(`  totalTiles        ：${ex.totalTiles}；success=${ex.success}；mode=${ex.mode}；path=${ex.recoveryPath}`);
console.log(`  attempts.normal6  ：${ex.attempts.normal6.validTiles} 块；normal4：${ex.attempts.normal4.validTiles} 块`);
console.log(`  attempts.phase    ：tried=${ex.attempts.phase.tried} bestPhase=${JSON.stringify(ex.attempts.phase.bestPhase)} ` +
  `bestRate=${pct(ex.attempts.phase.bestRate)}`);
console.log(`  attempts.scale    ：tried=${ex.attempts.scale.tried} size=${JSON.stringify(ex.attempts.scale.detectedSize)} ` +
  `α=${ex.attempts.scale.alpha.toFixed(3)} z=${(ex.attempts.scale.z || 0).toFixed(2)} conf=${ex.attempts.scale.confidence}`);
console.log(`  提取耗时          ：${dtExtract} ms`);
if (ex.secretJpegBytes) {
  console.log(`  载荷 CRC32        ：${Packet.crc32(ex.secretJpegBytes)}（${ex.secretJpegBytes.length} 字节）`);
}
// 秘密图原始尺寸/大小 → 推算嵌入时的 K/N
console.log(`  载荷 JPEG ${payloadBytes.length} 字节 → 推算 K=${needK}，N=${needN}` +
  `${ex.success ? '；提取整体成功（validTiles ≥ K）' : '；提取整体失败'}`);
if (ex.secretJpegBytes) {
  const same = ex.secretJpegBytes.length === payloadBytes.length &&
    Packet.crc32(ex.secretJpegBytes) === Packet.crc32(payloadBytes);
  console.log(`  与 fixture 里的秘密图逐字节一致：${same ? '是 ✓（说明数据本身完整还原）' : '否'}` +
    `（读回 ${ex.secretJpegBytes.length} 字节 vs 原始 ${payloadBytes.length} 字节）`);
}

// ============================================================
// ② 网格对齐检查：0~7px 全相位（判断损失是不是"错位"造成的）
// ------------------------------------------------------------
// 对每个 (dx,dy) 取同一批**像素位置**上的 Tile（每 64px 一个，但起点偏移 dx,dy），
// 统计 CRC 通过数。若某个非零偏移明显更好，说明这张图的网格没对齐。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('② 网格对齐检查：0~7px 相位扫描（抽样，同一批像素位置跨相位可比）');
console.log('='.repeat(96));

// 采样位置：在能容纳 64×64 的范围内均匀取 96 个格点（与相位无关，保证可比）
const sampleX = [], sampleY = [];
{
  const maxI = Math.floor((png.width - TILE) / 64), maxJ = Math.floor((png.height - TILE) / 64);
  const sx = Math.max(1, Math.floor(maxI / 12)), sy = Math.max(1, Math.floor(maxJ / 8));
  for (let j = 0; j <= maxJ; j += sy) for (let i = 0; i <= maxI; i += sx) {
    sampleX.push(i * 64); sampleY.push(j * 64);
  }
}
function phaseSamplePass(dx, dy) {
  let pass = 0, n = 0;
  for (let k = 0; k < sampleX.length; k++) {
    const x = sampleX[k] + dx, y = sampleY[k] + dy;
    if (x + TILE > png.width || y + TILE > png.height) continue;
    n++;
    if (tileCrcPass(tileAt(stego, x, y), SC.CONST.MODE_6)) pass++;
  }
  return { pass: pass, n: n };
}
const tPhase = Date.now();
let bestPhase = { dx: 0, dy: 0, pass: -1, n: 1 };
const grid = [];
for (let dy = 0; dy < 8; dy++) {
  const row = [];
  for (let dx = 0; dx < 8; dx++) {
    const r = phaseSamplePass(dx, dy);
    row.push(r);
    if (r.pass > bestPhase.pass) bestPhase = { dx: dx, dy: dy, pass: r.pass, n: r.n };
  }
  grid.push(row);
}
console.log(`  采样 ${sampleX.length} 个位置/相位，耗时 ${Date.now() - tPhase} ms\n`);
console.log('  dy\\dx  ' + Array.from({ length: 8 }, (_, i) => pad(i, 6)).join(''));
for (let dy = 0; dy < 8; dy++) {
  console.log('   ' + dy + '    ' + grid[dy].map((r) => pad(r.pass, 6)).join(''));
}
console.log(`\n  最佳相位 (${bestPhase.dx},${bestPhase.dy})：${bestPhase.pass}/${bestPhase.n} = ${pct(bestPhase.pass / bestPhase.n)}；` +
  `相位(0,0)：${grid[0][0].pass}/${grid[0][0].n} = ${pct(grid[0][0].pass / grid[0][0].n)}`);

// ============================================================
// ③ margin × CRC 存活率分档表
// ------------------------------------------------------------
// 分两张表：全部对齐 Tile（含"从没被写入过"的块，它们必然失败）与
// 只含纹理达标 Tile（方差 ≥ 60，即选块候选池）。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('③ margin × CRC 存活率（stego 图自身测得的块级最小 margin）');
console.log('='.repeat(96));

const rowsData = [];
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const t = tileAt(stego, i * TILE, j * TILE);
    const v = IU.calculateTileVariance({ width: TILE, height: TILE, data: t });
    const m = blockMargins(t);
    const ok = tileCrcPass(t, SC.CONST.MODE_6);
    rowsData.push({ x: i * TILE, y: j * TILE, var: v, margin: m.min, avgMargin: m.avg, lum: tileLum(t), ok: ok });
  }
}

// ------------------------------------------------------------
// 重建"到底哪些 Tile 被写入过"
// ------------------------------------------------------------
// extractSecret 只能告诉我们"哪些块读得回来"，读不回来的块里既有"写了但坏了"，
// 也有"从来没被选中"——直接统计会把两类混在一起。这里按内核同样的选块算法
// （棋盘分桶 + 桶内等距抽样）在 stego 图上重建一次，并用"必须覆盖全部 309 个存活块"
// 来校验重建是否可信（存活块一定是被写过的）。
function pickEvenly(list, q) {
  if (q <= 0) return [];
  if (q >= list.length) return list.slice();
  const out = new Array(q);
  for (let i = 0; i < q; i++) out[i] = list[Math.floor(i * list.length / q)];
  return out;
}
function selectSpreadTiles(texturedList, N, colsN, rowsN) {
  const K = N >> 1;
  const buckets = [[], [], [], []];
  for (const t of texturedList) {
    const col = Math.floor(t.x / TILE), row = Math.floor(t.y / TILE);
    const top = row < rowsN / 2, left = col < colsN / 2;
    buckets[(top ? 0 : 2) + (left ? 0 : 1)].push(t);
  }
  const aMax = Math.min(buckets[0].length, buckets[3].length);
  const bMax = Math.min(buckets[1].length, buckets[2].length);
  let a, b;
  if (aMax + bMax >= K) {
    a = Math.min(aMax, Math.max(K - bMax, Math.ceil(K / 2)));
    b = K - a;
  } else { a = aMax; b = bMax; }
  let chosen = [];
  chosen = chosen.concat(pickEvenly(buckets[0], a));
  chosen = chosen.concat(pickEvenly(buckets[3], a));
  chosen = chosen.concat(pickEvenly(buckets[1], b));
  chosen = chosen.concat(pickEvenly(buckets[2], b));
  if (chosen.length < N) {
    const picked = new Set(chosen);
    for (let k = 0; k < texturedList.length && chosen.length < N; k++) {
      if (!picked.has(texturedList[k])) { picked.add(texturedList[k]); chosen.push(texturedList[k]); }
    }
  }
  return chosen;
}

const varThreshold = SC.CONST.DEFAULT_VARIANCE_THRESHOLD;
const textured = rowsData.filter((r) => r.var >= varThreshold);
const Nwritten = needN;                          // 422
const reconstructed = selectSpreadTiles(textured, Nwritten, cols, rows);
const reconKeys = new Set(reconstructed.map((r) => r.x + ',' + r.y));
const passTiles = rowsData.filter((r) => r.ok);
const covered = passTiles.filter((r) => reconKeys.has(r.x + ',' + r.y)).length;
console.log(`  重建选块（按内核同一算法，N=${Nwritten}）：${reconstructed.length} 个；` +
  `覆盖存活块 ${covered}/${passTiles.length} = ${pct(covered / passTiles.length)}`);
const written = rowsData.filter((r) => reconKeys.has(r.x + ',' + r.y));
const writtenPass = written.filter((r) => r.ok).length;
console.log(`  重建出的"写入块"：${written.length} 个，其中 CRC 通过 ${writtenPass} 个 = ${pct(writtenPass / written.length)}` +
  `（浏览器口径 309/422 = ${pct(309 / 422)}）`);

console.log(`  全部对齐 Tile：${rowsData.length} 个，其中 CRC 通过 ${rowsData.filter((r) => r.ok).length} 个`);
console.log(`  纹理达标(≥${varThreshold})：${textured.length} 个，其中 CRC 通过 ${textured.filter((r) => r.ok).length} 个`);

function bucketTable(list, lo, hi, step) {
  const out = [];
  for (let a = lo; a < hi; a += step) {
    const b = a + step;
    const inB = list.filter((r) => r.margin >= a && r.margin < b);
    if (!inB.length) continue;
    const ok = inB.filter((r) => r.ok).length;
    out.push({ lo: a, hi: b, n: inB.length, ok: ok });
  }
  const rest = list.filter((r) => r.margin >= hi);
  if (rest.length) out.push({ lo: hi, hi: Infinity, n: rest.length, ok: rest.filter((r) => r.ok).length });
  return out;
}
function printBucket(title, list) {
  console.log('\n  ' + title);
  console.log('    margin 区间     块数   存活   存活率   累计块数  累计存活率');
  const buckets = bucketTable(list, 8, 24, 1);
  let cumN = 0, cumOk = 0;
  for (const b of buckets) {
    cumN += b.n; cumOk += b.ok;
    const label = b.hi === Infinity ? `≥ ${b.lo}` : `${b.lo.toFixed(1)}~${b.hi.toFixed(1)}`;
    console.log('    ' + pad(label, 14) + pad(b.n, 6) + pad(b.ok, 7) +
      pad(pct(b.ok / b.n), 9) + pad(cumN, 10) + pad(pct(cumOk / cumN), 12));
  }
}
printBucket('A. 全部对齐 Tile（含从未写入的块 → 必然失败，只看形状别看绝对值）', rowsData);
printBucket('B. 只统计纹理达标 Tile（本图 984 个全部达标，等于上一张表）', textured);
printBucket(`C. 只统计"重建出的写入块"（重建不可信，见上方覆盖率）`, written);

// 细看"存活率从 100% 掉下来"的临界点：按 margin 0.5 细分 8~20
console.log('\n  0.5 细分（写入块）：');
{
  const buckets = bucketTable(written, 8, 20, 0.5);
  let cumN = 0, cumOk = 0;
  for (const b of buckets) {
    cumN += b.n; cumOk += b.ok;
    console.log(`    ${pad(b.lo.toFixed(1) + '~' + b.hi.toFixed(1), 12)}` + pad(b.n, 6) + pad(b.ok, 7) +
      pad(pct(b.ok / b.n), 9) + '   累计 ' + pad(pct(cumOk / cumN), 8) + ` (${cumOk}/${cumN})`);
  }
}

// 失败块的 margin 分布（关键：113 个死块是不是都落在低 margin 侧）
const deadTextured = written.filter((r) => !r.ok);
const aliveTextured = written.filter((r) => r.ok);
console.log(`\n  纹理达标且失败：${deadTextured.length} 个；纹理达标且存活：${aliveTextured.length} 个`);
if (deadTextured.length) {
  const ms = deadTextured.map((r) => r.margin).sort((a, b) => a - b);
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  console.log(`    失败块 margin：最小 ${ms[0].toFixed(1)}，25% ${q(0.25).toFixed(1)}，中位 ${q(0.5).toFixed(1)}，` +
    `75% ${q(0.75).toFixed(1)}，最大 ${ms[ms.length - 1].toFixed(1)}`);
  for (const T of [12, 13, 14, 15, 16, 18, 20]) {
    const below = deadTextured.filter((r) => r.margin < T).length;
    console.log(`    失败块中 margin < ${T} 的：${below}/${deadTextured.length} = ${pct(below / deadTextured.length)}`);
  }
}
if (aliveTextured.length) {
  const ms = aliveTextured.map((r) => r.margin).sort((a, b) => a - b);
  console.log(`    存活块 margin：最小 ${ms[0].toFixed(1)}，中位 ${ms[Math.floor(ms.length / 2)].toFixed(1)}，最大 ${ms[ms.length - 1].toFixed(1)}`);
}
// 方差维度对照：失败块是不是"方差也不够"（从未被选中）
console.log('\n  方差维度：');
for (const [label, list] of [['失败块', deadTextured], ['存活块', aliveTextured]]) {
  if (!list.length) continue;
  const vs = list.map((r) => r.var).sort((a, b) => a - b);
  console.log(`    ${label} 方差：最小 ${vs[0].toFixed(0)}，中位 ${vs[Math.floor(vs.length / 2)].toFixed(0)}，最大 ${vs[vs.length - 1].toFixed(0)}`);
}
// 亮度维度
for (const [label, list] of [['失败块', deadTextured], ['存活块', aliveTextured]]) {
  if (!list.length) continue;
  const ls = list.map((r) => r.lum).sort((a, b) => a - b);
  console.log(`    ${label} 亮度：最小 ${ls[0].toFixed(1)}，中位 ${ls[Math.floor(ls.length / 2)].toFixed(1)}，最大 ${ls[ls.length - 1].toFixed(1)}`);
}

// ============================================================
// ④ 阈值 12 / 14 / 16：可用块数、容量、抗遮蔽推算
// ------------------------------------------------------------
// 说明（重要口径）：这里的 margin 是在**已经嵌过数据的 stego 图**上量的，
//   载荷自身的调制会略微抬高块方差 → 测得的 margin 是真实载体 margin 的**上界**，
//   所以"可用块数"是偏乐观的估计。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('④ 阈值 12 / 14 / 16 的可用块数与容量（同一张 2649×1582）');
console.log('='.repeat(96));
console.log(`  待嵌入的秘密图：JPEG ${payloadBytes.length} 字节 → 需要 K=${needK}，标准档 N=${needN}`);
console.log('');
console.log('   阈值   可用块   可支撑 K_max  标准档 N_max   放得下?   25%遮蔽后   40%遮蔽后   50%遮蔽后');
for (const T of [12, 13, 14, 15, 16, 18, 20, 24, 32]) {
  const avail = rowsData.filter((r) => r.var >= varThreshold && r.margin >= T).length;
  const Kmax = Math.floor(avail / 2);
  const Nmax = Kmax * 2;
  const fits = Nmax >= needK * 2;
  // 遮蔽推算：spread 策略把 N 个符号均匀铺开，遮蔽 r 面积时存活约 N(1-r)，
  //   要求 >= K。标准档 N=2K ⇒ 理论上限就是 50%。
  const n = Math.min(Nmax, needK * 2);
  const k = Math.ceil(n / 2);
  const survive = (r) => Math.floor(n * (1 - r));
  const mk = (r) => (survive(r) >= k ? '成功' : '失败') + `(${survive(r)}/${k})`;
  console.log('   ' + pad(T, 5) + pad(avail, 9) + pad(Kmax, 13) + pad(Nmax, 13) +
    pad(fits ? '是' : '否', 9) + pad(mk(0.25), 12) + pad(mk(0.4), 12) + pad(mk(0.5), 12));
}

// 用真实图直接验证一档：把现有 stego 图按 25/40/50% 涂黑后，309 个存活块还剩多少
console.log('\n  参考：对现有 stego 图做中心区域涂黑（不重新嵌入），看现有 309 个存活块剩多少');
{
  const STEP = 64;
  function blacken(ratio) {
    const out = new Uint8ClampedArray(png.data);
    const area = ratio * png.width * png.height;
    const side = Math.sqrt(area);
    let bw = Math.max(STEP, Math.floor(side / STEP) * STEP);
    let bh = Math.max(STEP, Math.floor(area / bw / STEP) * STEP);
    bw = Math.min(bw, png.width); bh = Math.min(bh, png.height);
    const x0 = Math.max(0, Math.floor((png.width - bw) / 2 / STEP) * STEP);
    const y0 = Math.max(0, Math.floor((png.height - bh) / 2 / STEP) * STEP);
    for (let y = y0; y < Math.min(png.height, y0 + bh); y++) {
      for (let x = x0; x < Math.min(png.width, x0 + bw); x++) {
        const o = (y * png.width + x) * 4;
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
      }
    }
    return { img: new global.ImageData(out, png.width, png.height), area: (bw * bh) / (png.width * png.height) };
  }
  for (const r of [0.25, 0.4, 0.5]) {
    const b = blacken(r);
    const e = SC.extractSecret(b.img);
    console.log(`    遮蔽 ${(b.area * 100).toFixed(1)}%：读出 ${e.validTiles} 块（需 ${e.K_effective}），success=${e.success}`);
  }
}

// ============================================================
// ⑤ 反推实验：拿这张真实图当载体，同一份秘密图，按不同阈值重新嵌入
// ------------------------------------------------------------
// 为什么必须做这个实验：表 A/B 里混着"从没被写入过"的块（984 个里只写了 422 个），
//   它们的存活率恒为 0，会把曲线整体压低；而按扫描序重建选块又被证实不可靠
//   （只能覆盖 42.7% 的存活块）。用同一张图重新嵌入一次，选块集合就是我们自己
//   算出来的，逐块统计才干净。
//
// 口径说明：载体是**嵌入过一次的图**，其中的旧载荷会略微抬高块方差 →
//   测得的 margin 偏大 → 阈值判据偏乐观（真实阈值应略高于这里的数字）。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('⑤ 反推实验：同一张图 + 同一份秘密图，按不同阈值重新嵌入');
console.log('='.repeat(96));

// 用一个 q75 JPEG 体积与用户秘密图相当（8402 字节）的合成秘密图，保证 K/N 一致
function makeSecretLike(targetBytes) {
  let best = null;
  // 图案类图像比纯噪声好压缩，能覆盖到 8 KB 这个量级；两种都试，取最接近的
  const build = (size, kind) => {
    const w = size, h = Math.round(size * 0.75);
    const img = new global.ImageData(w, h);
    let a = 24680;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let r, g, b;
        if (kind === 'noise') {
          a = (a * 1664525 + 1013904223) >>> 0;
          const v = a >>> 24;
          r = v; g = (v * 3) % 256; b = 255 - v;
        } else {
          const v = ((x * 7 + y * 13) % 200) + 30;
          r = v; g = 255 - v; b = (v * 3) % 255;
        }
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    return img;
  };
  for (const kind of ['pattern', 'noise']) {
    for (const size of [64, 80, 96, 112, 128, 144, 160, 192, 224, 256, 320]) {
      const img = build(size, kind);
      const bytes = encodeJpeg(img, 75, true).length;
      if (!best || Math.abs(bytes - targetBytes) < Math.abs(best.bytes - targetBytes)) {
        best = { img: img, bytes: bytes, kind: kind, size: size };
      }
    }
  }
  return best;
}
const secretLike = makeSecretLike(payloadBytes.length);
const likeK = Math.ceil((14 + secretLike.bytes) / 40);
console.log(`  合成秘密图：${secretLike.img.width}×${secretLike.img.height}（${secretLike.kind}），` +
  `JPEG q75 = ${secretLike.bytes} 字节（用户的是 ${payloadBytes.length} 字节）→ K=${likeK}，N=${likeK * 2}`);

/** 在给定图上，按某个阈值实际嵌入并逐块统计（选块用与内核同构的算法） */
function embedAndProbe(carrierImg, threshold) {
  const r = SC.embedSecret(carrierImg, secretLike.img, {
    redundancy: 'standard', minBlockMargin: threshold, minTileLum: 0, maxTileLum: 255,
    // 载体本身就是"已经叠过一份标尺"的 stego 图，再叠一次会变成双份标尺
    // （幅度翻倍会把弱块直接顶翻）→ 必须关掉，保持与提取端一致的"单份标尺"条件
    embedScale: false
  });
  const out = r.outputImageData;
  const cap = SC.analyzeCapacity(carrierImg, secretLike.bytes, {
    redundancy: 'standard', minBlockMargin: threshold, minTileLum: 0, maxTileLum: 255
  });
  // 载体侧的逐块属性（用于分档）+ 选块重建（同图同算法 → 精确）
  const props = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const t = tileAt(carrierImg, i * TILE, j * TILE);
      props.push({
        x: i * TILE, y: j * TILE,
        var: IU.calculateTileVariance({ width: TILE, height: TILE, data: t }),
        margin: blockMargins(t).min
      });
    }
  }
  // 选块池必须与内核一致：安全块够用就只用安全块，不够就回落到全部纹理块
  // （内核 embedSecret 里就是这条 fallback：pool = (!risky && safe>=N) ? safe : textured）
  const safePool = props.filter((p) => p.var >= varThreshold && p.margin >= threshold);
  const allPool = props.filter((p) => p.var >= varThreshold);
  const pool = (!(threshold > 0) || safePool.length >= r.stats.N) ? safePool : allPool;
  const used = selectSpreadTiles(pool, r.stats.N, cols, rows);
  const usedKeys = new Set(used.map((u) => u.x + ',' + u.y));
  const byKey = new Map(props.map((p) => [p.x + ',' + p.y, p]));
  // 逐块 CRC（必须从**输出图**上读）
  let pass = 0;
  const perTile = [];
  for (const u of used) {
    const t = tileAt(out, u.x, u.y);
    const ok = tileCrcPass(t, SC.CONST.MODE_6);
    if (ok) pass++;
    perTile.push({ margin: byKey.get(u.x + ',' + u.y).margin, ok: ok });
  }
  // 遮蔽：直接对输出图涂黑，再统计 used 里还剩多少能读（等价于提取端的逐块 CRC 计数）
  function surviveUnder(ratio) {
    const o2 = new Uint8ClampedArray(out.data);
    const area = ratio * out.width * out.height;
    const side = Math.sqrt(area);
    let bw = Math.max(TILE, Math.floor(side / TILE) * TILE);
    let bh = Math.max(TILE, Math.floor(area / bw / TILE) * TILE);
    bw = Math.min(bw, out.width); bh = Math.min(bh, out.height);
    const x0 = Math.max(0, Math.floor((out.width - bw) / 2 / TILE) * TILE);
    const y0 = Math.max(0, Math.floor((out.height - bh) / 2 / TILE) * TILE);
    const x1 = Math.min(out.width, x0 + bw), y1 = Math.min(out.height, y0 + bh);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * out.width + x) * 4;
        o2[o] = 0; o2[o + 1] = 0; o2[o + 2] = 0;
      }
    }
    const img2 = new global.ImageData(o2, out.width, out.height);
    let alive = 0;
    for (const u of used) if (tileCrcPass(tileAt(img2, u.x, u.y), SC.CONST.MODE_6)) alive++;
    return { area: (x1 - x0) * (y1 - y0) / (out.width * out.height), alive: alive };
  }
  return { r: r, cap: cap, used: used, pass: pass, perTile: perTile, surviveUnder: surviveUnder, out: out };
}

console.log('\n  阈值  纹理块  安全块  写入N  零遮蔽存活      25%后        40%后        50%后');
const results = {};
for (const T of [0, 10, 12, 13, 14, 15, 16]) {
  const res = embedAndProbe(stego, T);
  const K = res.r.stats.K;
  const s25 = res.surviveUnder(0.25);
  const s40 = res.surviveUnder(0.40);
  const s50 = res.surviveUnder(0.50);
  const fmt = (s) => `${s.alive}/${K}${s.alive >= K ? '✓' : '✗'}`;
  console.log('   ' + pad(T === 0 ? '0(旧)' : T, 6) + pad(res.r.stats.texturedTiles, 8) +
    pad(res.r.stats.safeTiles, 8) + pad(res.r.stats.N, 7) +
    '   ' + pad(`${res.pass}/${res.r.stats.N} = ${pct(res.pass / res.r.stats.N)}`, 16) +
    pad(fmt(s25), 13) + pad(fmt(s40), 13) + pad(fmt(s50), 13));
  results[T] = res;
}

// 用 T=0（旧行为）那次实验做"诚实的 margin×存活率表"：选块集合此时是精确已知的
if (results[0]) {
  const perTile = results[0].perTile;
  console.log('\n  旧行为（T=0）下的诚实分档表（选块集合精确已知，排除了"从未写入"的干扰）：');
  console.log('    margin 区间     写入块   存活   存活率');
  for (let a = 8; a < 24; a += 1) {
    const inB = perTile.filter((p) => p.margin >= a && p.margin < a + 1);
    if (!inB.length) continue;
    const ok = inB.filter((p) => p.ok).length;
    console.log(`    ${pad(a.toFixed(1) + '~' + (a + 1).toFixed(1), 14)}` + pad(inB.length, 6) + pad(ok, 7) + pad(pct(ok / inB.length), 9));
  }
  const hi = perTile.filter((p) => p.margin >= 24);
  if (hi.length) {
    const ok = hi.filter((p) => p.ok).length;
    console.log(`    ${pad('≥ 24', 14)}` + pad(hi.length, 6) + pad(ok, 7) + pad(pct(ok / hi.length), 9));
  }
  const alive = perTile.filter((p) => p.ok);
  const dead = perTile.filter((p) => !p.ok);
  if (alive.length) {
    const ms = alive.map((p) => p.margin).sort((a, b) => a - b);
    console.log(`    存活块 margin：最小 ${ms[0].toFixed(1)}，中位 ${ms[Math.floor(ms.length / 2)].toFixed(1)}`);
  }
  if (dead.length) {
    const ms = dead.map((p) => p.margin).sort((a, b) => a - b);
    console.log(`    失败块 margin：最小 ${ms[0].toFixed(1)}，中位 ${ms[Math.floor(ms.length / 2)].toFixed(1)}，` +
      `最大 ${ms[ms.length - 1].toFixed(1)}`);
  }
}

// ============================================================
// ⑥ 对照：同样尺寸的"干净合成载体"上做同一实验
// ------------------------------------------------------------
// ⑤ 的表里，连 margin ≥ 24 的块都掉了约 20% —— 这用 margin 解释不了。
//   最可能的原因是"载体本身是一张已经嵌过数据的 stego 图"（旧载荷残留 + 标尺），
//   所以这里用同尺寸的干净载体做一次对照，把"图的问题"和"管线的问题"分开。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('⑥ 对照实验：同尺寸（2649×1582）的干净合成载体');
console.log('='.repeat(96));
{
  const W = png.width, H = png.height;
  const clean = new global.ImageData(W, H);
  let a = 13579;
  const u01 = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // 上半：平滑云块（低 margin）；下半：细纹理（高 margin）—— 复刻用户图的两种区域
      let v;
      if (y < H / 2) {
        v = 190 + 60 * Math.sin(x / 210) * Math.cos(y / 190) + u01() * 4;
      } else {
        v = 40 + u01() * 170;
      }
      v = Math.max(0, Math.min(255, v));
      clean.data[o] = v; clean.data[o + 1] = v * 0.97; clean.data[o + 2] = Math.min(255, v * 1.05);
      clean.data[o + 3] = 255;
    }
  }
  console.log('  阈值   纹理块   安全块   写入N   零遮蔽存活');
  for (const T of [0, 12, 14]) {
    const res = embedAndProbe(clean, T);
    console.log('   ' + pad(T === 0 ? '0(旧)' : T, 6) + pad(res.r.stats.texturedTiles, 9) +
      pad(res.r.stats.safeTiles, 9) + pad(res.r.stats.N, 8) +
      '   ' + pad(`${res.pass}/${res.r.stats.N} = ${pct(res.pass / res.r.stats.N)}`, 20));
    const perTile = res.perTile;
    const lo = perTile.filter((p) => p.margin < 12);
    const hi = perTile.filter((p) => p.margin >= 24);
    const mid = perTile.filter((p) => p.margin >= 14 && p.margin < 24);
    const f = (list) => list.length ? `${list.filter((p) => p.ok).length}/${list.length} = ${pct(list.filter((p) => p.ok).length / list.length)}` : '-';
    console.log(`          margin<12：${f(lo)}；14~24：${f(mid)}；≥24：${f(hi)}`);
  }
}

// ============================================================
// ⑦ 找"高 margin 也会失败"的原因：亮度 × margin 二维表 + 去标尺对照
// ------------------------------------------------------------
// ③ 里失败块的两个特征值得追：**方差更大（中位 1982 vs 1144）、亮度更亮（176 vs 150）**。
//   方差大 ⇒ margin 大 ⇒ 本该更稳。唯一能同时解释"越强越弱"的机制是：
//   为了摆出大 margin，空间域上的波纹幅度也更大，在接近 255 的亮区被 clamp 削掉，
//   实际落地的系数差远小于标称 margin（这正是前一轮在合成图上量到的"标称 12.5 → 实际 8.0"）。
//   本节的二维表就是直接检验这个预测：**亮 + 高 margin** 的块应该最惨。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('⑦ 亮 + 高 margin 是否最惨？（旧行为 T=0 的精确选块集合）');
console.log('='.repeat(96));
{
  const base = embedAndProbe(stego, 0);
  // 重新算一遍载体侧的亮度（embedAndProbe 里只留了 margin）
  const lumOf = new Map();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const t = tileAt(stego, i * TILE, j * TILE);
      lumOf.set(i * TILE + ',' + j * TILE, tileLum(t));
    }
  }
  const used = base.used;
  const lumBands = [[0, 120], [120, 170], [170, 200], [200, 225], [225, 256]];
  const marBands = [[8, 12], [12, 16], [16, 24], [24, 33]];
  console.log('  存活率（每格 = 存活/总数）       载体平均亮度');
  console.log('   margin\\亮度   ' + lumBands.map((b) => pad(`${b[0]}~${b[1] === 256 ? '255' : b[1]}`, 14)).join(''));
  for (const mb of marBands) {
    const cells = [];
    for (const lb of lumBands) {
      // perTile 与 used 一一对应，直接按下标取
      let n = 0, ok = 0;
      for (let idx = 0; idx < used.length; idx++) {
        const m = base.perTile[idx].margin;
        const l = lumOf.get(used[idx].x + ',' + used[idx].y);
        if (m >= mb[0] && m < mb[1] && l >= lb[0] && l < lb[1]) {
          n++; if (base.perTile[idx].ok) ok++;
        }
      }
      cells.push(n ? `${ok}/${n} ${pct(ok / n)}` : '—');
    }
    console.log('   ' + pad(mb[0] + '~' + (mb[1] === 33 ? '32' : mb[1]), 12) +
      cells.map((c) => pad(c, 14)).join(''));
  }

  // 去标尺对照：把 fixture 上那份标尺按最小二乘对消掉，再走同一流程
  const GC = global.GeoCalibration;
  const noRuler = GC.removeScale(stego, png.width, png.height);
  const noRulerRes = embedAndProbe(noRuler, 0);
  console.log(`\n  对照：把 fixture 上那份标尺对消掉后再嵌入（T=0）`);
  console.log(`    带标尺：${base.pass}/${base.r.stats.N} = ${pct(base.pass / base.r.stats.N)}`);
  console.log(`    去标尺：${noRulerRes.pass}/${noRulerRes.r.stats.N} = ${pct(noRulerRes.pass / noRulerRes.r.stats.N)}`);
  const byMargin = (res) => {
    const lo = res.perTile.filter((p) => p.margin < 12);
    const hi = res.perTile.filter((p) => p.margin >= 24);
    const f = (l) => l.length ? `${l.filter((p) => p.ok).length}/${l.length}` : '-';
    return `margin<12 ${f(lo)}，≥24 ${f(hi)}`;
  };
  console.log(`    带标尺分档：${byMargin(base)}`);
  console.log(`    去标尺分档：${byMargin(noRulerRes)}`);
}

// ============================================================
// ⑧ 关键对照：复刻"真实照片的异质块"（同一 Tile 内有的块平、有的块糙）
// ------------------------------------------------------------
// 前面的干净对照全 100%，但它不够像真实照片：一块 Tile 内 64 个 8×8 小块
//   "要么都很糙、要么都很平"。真实照片里同一 Tile 内往往**混合**——
//   一个平块就足以让整块 CRC 失败（384 bit 全对才算通过）。
//   这里按每块随机分配纹理强弱来复刻，并且不加旧载荷、不加标尺。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('⑧ 异质块对照（每块随机"平/糙"，亮区 + 暗区，无旧载荷无标尺）');
console.log('='.repeat(96));
{
  const W = png.width, H = png.height;
  const het = new global.ImageData(W, H);
  let a = 24680;
  const u01 = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  for (let by = 0; by + 8 <= H; by += 8) {
    for (let bx = 0; bx + 8 <= W; bx += 8) {
      const bright = (by < H / 2);
      const base = bright ? (190 + Math.floor(u01() * 60)) : (40 + Math.floor(u01() * 50));
      const rough = u01();                        // 该块的纹理强度
      const amp = rough < 0.35 ? 0 : (rough < 0.6 ? 6 : 40);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const o = ((by + r) * W + (bx + c)) * 4;
          const v = Math.max(0, Math.min(255, Math.round(base + (u01() * 2 - 1) * amp)));
          het.data[o] = v; het.data[o + 1] = v * 0.97; het.data[o + 2] = Math.min(255, v * 1.05);
          het.data[o + 3] = 255;
        }
      }
    }
  }
  console.log('  阈值   纹理块   安全块   写入N   零遮蔽存活');
  for (const T of [0, 12, 14, 16]) {
    const res = embedAndProbe(het, T);
    console.log('   ' + pad(T === 0 ? '0(旧)' : T, 6) + pad(res.r.stats.texturedTiles, 9) +
      pad(res.r.stats.safeTiles, 9) + pad(res.r.stats.N, 8) +
      '   ' + pad(`${res.pass}/${res.r.stats.N} = ${pct(res.pass / res.r.stats.N)}`, 20));
    const band = (lo, hi) => {
      const l = res.perTile.filter((p) => p.margin >= lo && p.margin < hi);
      return l.length ? `${l.filter((p) => p.ok).length}/${l.length} = ${pct(l.filter((p) => p.ok).length / l.length)}` : '-';
    };
    console.log(`          margin<12：${band(8, 12)}；12~16：${band(12, 16)}；16~24：${band(16, 24)}；≥24：${band(24, 33)}`);
  }
}

// ============================================================
// ⑨ 决定性分析：逐块"最匹配的载荷"与汉明距离
// ------------------------------------------------------------
// 前面所有分档表都有一个绕不过去的坑：读不回来的块里，"写了但坏了"和"从来没写过"
//   混在一起，而按扫描序重建选块又被证明不可靠（覆盖率只有 42.7%）。
// 这里换一条完全不同的路子 —— **反向重建每一个块本应携带的载荷**：
//   · 提取已经成功（309 ≥ K=211），所以秘密图是逐字节已知的；
//   · RaptorQ 编码是确定性的：src = 14 字节头 + 秘密 JPEG → 每个符号唯一；
//   · 于是第 i 个 Tile 的 384 bit 载荷可以精确重建。
// 然后对每个对齐 Tile，在 422 个候选载荷里找汉明距离最小的那个：
//   距离 0        → 该块被写过且完好（就是那 309 个）
//   距离 1~30     → 该块被写过，但只有几个比特翻了（强度不足的典型特征）
//   距离 ~192     → 与该块毫无关系（从没写过）
// 这样就能把"写了但坏了"精确地挑出来，并量出损坏程度。
// ============================================================
console.log('\n' + '='.repeat(96));
console.log('⑨ 决定性分析：重建每个块的预期载荷，用汉明距离区分"写坏"与"没写"');
console.log('='.repeat(96));
{
  const Packet = global.Packet, RQ = global.RaptorQ;
  // ① 重建 src（头部 + 秘密 JPEG，且与 fixture 逐字节一致）
  const secRealW = ex.secretWidth, secRealH = ex.secretHeight;
  const head = new Uint8Array(14);
  head[0] = 2; head[1] = 1;                       // version=2, format=1（彩色 JPEG）
  head[2] = (secRealW >>> 8) & 0xFF; head[3] = secRealW & 0xFF;
  head[4] = (secRealH >>> 8) & 0xFF; head[5] = secRealH & 0xFF;
  head[6] = (payloadBytes.length >>> 24) & 0xFF; head[7] = (payloadBytes.length >>> 16) & 0xFF;
  head[8] = (payloadBytes.length >>> 8) & 0xFF; head[9] = payloadBytes.length & 0xFF;
  const hcrc = Packet.crc32(head.subarray(0, 10));
  head[10] = (hcrc >>> 24) & 0xFF; head[11] = (hcrc >>> 16) & 0xFF;
  head[12] = (hcrc >>> 8) & 0xFF; head[13] = hcrc & 0xFF;
  const src = new Uint8Array(14 + payloadBytes.length);
  src.set(head, 0); src.set(payloadBytes, 14);
  // ② RaptorQ 符号 → 每个 Tile 的候选载荷
  const enc = RQ.createEncoder(src, needK, 40);
  const candBits = [];
  for (let i = 0; i < needN; i++) {
    const sym = enc.generateSymbol(i);
    const body = new Uint8Array(44);              // MODE_6：44 字节主体（4 + 40 符号）
    body[0] = (i >>> 8) & 0xFF; body[1] = i & 0xFF;
    body[2] = (needK >>> 8) & 0xFF; body[3] = needK & 0xFF;
    body.set(sym, 4);
    const pk = Packet.pack(body);
    const bits = new Uint8Array(pk.length * 8);
    for (let b = 0; b < pk.length; b++) {
      for (let k = 0; k < 8; k++) bits[b * 8 + k] = (pk[b] >> (7 - k)) & 1;
    }
    candBits.push(bits);
  }
  console.log(`  重建了 ${candBits.length} 个候选载荷（每个 ${candBits[0].length} bit）`);
  // ③ 逐块提取 bit 并找最匹配
  const dist = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const t = tileAt(stego, i * TILE, j * TILE);
      const bits = DCT.extractBitsFromTile(t, SC.CONST.MODE_6.bitsPerTile, {});
      let bestD = 1e9, bestSeq = -1;
      for (let s = 0; s < candBits.length; s++) {
        const cand = candBits[s];
        let d = 0;
        for (let k = 0; k < bits.length; k++) if ((bits[k] ? 1 : 0) !== cand[k]) d++;
        if (d < bestD) { bestD = d; bestSeq = s; if (d === 0) break; }
      }
      const m = blockMargins(t);
      dist.push({ x: i * TILE, y: j * TILE, d: bestD, seq: bestSeq, margin: m.min, lum: tileLum(t) });
    }
  }
  const buckets = { exact: 0, near: 0, far: 0 };
  for (const r of dist) {
    if (r.d === 0) buckets.exact++;
    else if (r.d <= 60) buckets.near++;
    else buckets.far++;
  }
  console.log(`  距离 = 0（完好）        ：${buckets.exact} 个（= 提取端报的 validTiles）`);
  console.log(`  距离 1~60（写过但坏了） ：${buckets.near} 个`);
  console.log(`  距离 > 60（从没写过）   ：${buckets.far} 个`);
  console.log(`  → 推断被写入的块数 = 0 距离 + 近距 = ${buckets.exact + buckets.near}（对照 N = ${needN}）`);
  const near = dist.filter((r) => r.d > 0 && r.d <= 60);
  if (near.length) {
    const ds = near.map((r) => r.d).sort((a, b) => a - b);
    console.log(`  写坏块的汉明距离分布：最小 ${ds[0]}，25% ${ds[Math.floor(ds.length * 0.25)]}，` +
      `中位 ${ds[Math.floor(ds.length / 2)]}，75% ${ds[Math.floor(ds.length * 0.75)]}，最大 ${ds[ds.length - 1]}`);
    const ms = near.map((r) => r.margin).sort((a, b) => a - b);
    const ls = near.map((r) => r.lum).sort((a, b) => a - b);
    console.log(`  写坏块 margin：最小 ${ms[0].toFixed(1)}，中位 ${ms[Math.floor(ms.length / 2)].toFixed(1)}，最大 ${ms[ms.length - 1].toFixed(1)}`);
    console.log(`  写坏块 亮度：最小 ${ls[0].toFixed(1)}，中位 ${ls[Math.floor(ls.length / 2)].toFixed(1)}，最大 ${ls[ls.length - 1].toFixed(1)}`);
    // 写坏块的 margin 分布（与"完好块"对照）
    console.log('    margin 区间    写坏块数   完好块数');
    for (let a = 8; a < 24; a += 2) {
      const nBad = near.filter((r) => r.margin >= a && r.margin < a + 2).length;
      const nOk = dist.filter((r) => r.d === 0 && r.margin >= a && r.margin < a + 2).length;
      console.log(`    ${pad(a.toFixed(1) + '~' + (a + 2).toFixed(1), 12)}` + pad(nBad, 10) + pad(nOk, 11));
    }
    const nBadHi = near.filter((r) => r.margin >= 24).length;
    const nOkHi = dist.filter((r) => r.d === 0 && r.margin >= 24).length;
    console.log(`    ${pad('≥ 24', 12)}` + pad(nBadHi, 10) + pad(nOkHi, 11));
  }
  // ④ 错误"指纹"：翻掉的比特落在**哪些系数对**和**哪些块**上
  //    这个分布能区分两类原因：
  //      · 局部强度不足（margin 太小）→ 错误均匀散布在 6 对 / 64 块上
  //      · 图像被"重新保存"过（JPEG 之类的高频衰减）→ 错误集中在最高频的那几对上
  const pairHist = new Array(6).fill(0);
  const pairTotal = new Array(6).fill(0);
  const blkHist = new Array(64).fill(0);
  let flips = 0;
  for (const r of dist) {
    if (r.d === 0 || r.d > 60) continue;
    const t = tileAt(stego, r.x, r.y);
    const bits = DCT.extractBitsFromTile(t, SC.CONST.MODE_6.bitsPerTile, {});
    const cand = candBits[r.seq];
    for (let k = 0; k < bits.length; k++) {
      const pair = k % 6, blk = Math.floor(k / 6);
      pairTotal[pair]++;
      if ((bits[k] ? 1 : 0) !== cand[k]) { pairHist[pair]++; blkHist[blk]++; flips++; }
    }
  }
  console.log(`\n  113 个写坏块共翻 ${flips} 个比特，按系数对分布（对 0 = (2,1)-(1,2) … 对 5 = (4,1)-(1,4)）：`);
  console.log('    对序号  ' + pairHist.map((_, i) => pad(i, 7)).join(''));
  console.log('    翻错数  ' + pairHist.map((v) => pad(v, 7)).join(''));
  console.log('    占比    ' + pairHist.map((v, i) => pad(pct(v / Math.max(1, pairTotal[i])), 7)).join(''));
  const blkTop = blkHist.map((v, i) => ({ i: i, v: v })).sort((a, b) => b.v - a.v).slice(0, 6);
  console.log('    块序号分布最集中的 6 个：' + blkTop.map((b) => `#${b.i}:${b.v}`).join(' '));

  // ⑤ 对照：把这张 fixture 过一遍 JPEG 再提取，看"翻错的对分布"是否同型
  const { simulateJpegRoundTrip } = require('./jpeg-sim.js');
  console.log('\n  对照：把 fixture 过一遍 JPEG（替身）后，写坏块与翻错分布如何变化');
  for (const q of [98, 95, 92, 90]) {
    const deg = simulateJpegRoundTrip(stego, q);
    let d0 = 0, dNear = 0, flipsQ = 0;
    const ph = new Array(6).fill(0);
    for (let idx = 0; idx < dist.length; idx++) {
      const r = dist[idx];
      if (r.d > 60) continue;                     // 只看原本被写入的 422 个块
      const t = tileAt(deg, r.x, r.y);
      const bits = DCT.extractBitsFromTile(t, SC.CONST.MODE_6.bitsPerTile, {});
      const cand = candBits[r.seq];
      let d = 0;
      for (let k = 0; k < bits.length; k++) {
        if ((bits[k] ? 1 : 0) !== cand[k]) { d++; flipsQ++; ph[k % 6]++; }
      }
      if (d === 0) d0++; else if (d <= 60) dNear++;
    }
    console.log(`    JPEG q=${q}：完好 ${d0}/422，写坏 ${dNear}，翻错总数 ${flipsQ}；` +
      `按对分布 [${ph.join(', ')}]`);
  }
  console.log(`    （fixture 自身：完好 309/422，写坏 113，翻错总数 ${flips}；` +
    `按对分布 [${pairHist.join(', ')}]）`);
}

console.log('\n（诊断结束）');