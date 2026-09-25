/**
 * diag-blackout.node.js —— 诊断脚本（记录上一轮"局部纯色遮盖导致 0/N 全红"的复现与结论）
 *
 * 目的：复现该现象，并抓取**每条恢复路径的中间数据**：
 *   ① 常规路径：MODE_6 与 MODE_4 各自的 CRC 通过数。上一轮内核失败时返回的是
 *      **最后尝试的那个模式**（MODE_4），于是界面上恒显示 0；该口径**本轮已修复**
 *      （失败时取有效块更多的模式，并把两条路径的读数放进 attempts），
 *      因此这里同时打印"内核现在回显什么"与"两个模式各自读了多少"以便对照。
 *   ② 相位搜索：8px 粒度 63 个相位各自的通过率（复刻当前内核：粗探 8 块、取每段中点），
 *      同时跑一遍**旧实现**（粗探 2 块、采样点第 0 个与中间那个）作对照；
 *      另有 1px 粒度下的真实最优相位（用来判断"偏移不是 8 的倍数"这种情况）
 *   ③ 标尺路径：拦截 GeoCalibration.extractScale，记录它到底返回了什么
 *      （null？还是错误的尺寸？），以及是否发生了"按错误尺寸重采样"
 *   ④ 纯色 vs 噪声：白 / 黑 / 灰 / 随机噪声块在同样大小下的差异
 *   ⑤ 全局扰动对照：JPEG 重编码 / 8bit 调色板 / 1~7px 全局平移 / 亮度±2% / gamma 1.02
 *      —— 用来判断"纯色块本身"能否解释 0/N，还是必须有一个全局变换
 *
 * 运行： node tests/diag-blackout.node.js
 * 规模：1024×1024 载体（按任务要求缩小规模以加快迭代）
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
const GC = global.GeoCalibration;
const SC = global.StegoCore;
const Packet = global.Packet;
const M6 = SC.CONST.MODE_6, M4 = SC.CONST.MODE_4;
const TILE = 64;

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
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const randByte = (r) => r() >>> 24;

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

/** 照片感载体：低频块状内容 + 轻微噪声（与本项目测试套件同款，纹理足够丰富） */
function photoCarrier(w, h, seed) {
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

/** 中等秘密图：96×96 照片感图案（含斜纹与色块，JPEG 后约几 KB） */
function mediumSecret(size, seed) {
  const rng = makeRng(seed);
  const img = newImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const base = 40 + 140 * (x / size) + 60 * (y / size);
      const stripe = 22 * Math.sin(x / 9) * Math.cos(y / 11);
      const blob = (Math.abs(x - size * 0.35) < size * 0.18 && Math.abs(y - size * 0.4) < size * 0.22) ? 45 : 0;
      const v = Math.max(0, Math.min(255, base + stripe + blob + (randByte(rng) % 7) - 3));
      img.data[o] = v;
      img.data[o + 1] = Math.max(0, Math.min(255, v * 0.75 + 30));
      img.data[o + 2] = Math.max(0, Math.min(255, 255 - v * 0.6));
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function fillRect(img, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h && y < img.height; y++) {
    for (let x = x0; x < x0 + w && x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
    }
  }
}
function noisyRect(img, x0, y0, w, h, seed) {
  const rng = makeRng(seed);
  for (let y = y0; y < y0 + h && y < img.height; y++) {
    for (let x = x0; x < x0 + w && x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = randByte(rng); img.data[o + 1] = randByte(rng); img.data[o + 2] = randByte(rng);
      img.data[o + 3] = 255;
    }
  }
}
/** 居中矩形遮盖 */
function withCenterRect(img, size, kind, seed) {
  const out = cloneImageData(img);
  const x0 = Math.floor((img.width - size) / 2), y0 = Math.floor((img.height - size) / 2);
  if (kind === 'white') fillRect(out, x0, y0, size, size, [255, 255, 255]);
  else if (kind === 'black') fillRect(out, x0, y0, size, size, [0, 0, 0]);
  else if (kind === 'gray') fillRect(out, x0, y0, size, size, [128, 128, 128]);
  else if (kind === 'noise') noisyRect(out, x0, y0, size, size, seed || 7);
  return { img: out, rect: { x: x0, y: y0, size } };
}

// ============================================================
// 复刻内核探针：按相位统计 CRC 通过数（含 1px 粒度版本）
// ============================================================
function readTile(img, x, y) {
  if (x < 0 || y < 0 || x + TILE > img.width || y + TILE > img.height) return null;
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  const rowBytes = TILE * 4;
  for (let r = 0; r < TILE; r++) {
    const srcRow = ((y + r) * img.width + x) * 4;
    for (let c = 0; c < rowBytes; c++) out[r * rowBytes + c] = img.data[srcRow + c];
  }
  return new global.ImageData(out, TILE, TILE);
}
function tileCrcPass(tileData, mode) {
  const opt = mode.pairs ? { pairs: mode.pairs } : {};
  const bits = DCT.extractBitsFromTile(tileData, mode.bitsPerTile, opt);
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
 * 在 (dx,dy) 相位上统计 CRC 通过数；want=null 表示扫描全部对齐 Tile。
 * legacySampling=true 复刻**旧实现**的采样点 floor(i·总数/探针数)（第 0 个 + 中间那个），
 * 默认 false 用内核现在的写法 floor((i+0.5)·总数/探针数)（每段中点）。
 */
function phaseStats(img, dx, dy, mode, want, legacySampling) {
  const cols = Math.floor((img.width - dx) / TILE), rows = Math.floor((img.height - dy) / TILE);
  const total = cols * rows;
  if (cols <= 0 || rows <= 0) return { pass: 0, total: 0, cols: cols, rows: rows };
  const n = want ? Math.min(want, total) : total;
  let pass = 0;
  for (let i = 0; i < n; i++) {
    const t = legacySampling
      ? Math.floor(i * total / n)
      : Math.min(total - 1, Math.floor((i + 0.5) * total / n));
    const x = dx + (t % cols) * TILE, y = dy + Math.floor(t / cols) * TILE;
    const tile = readTile(img, x, y);
    if (!tile) continue;
    if (tileCrcPass(tile, mode)) pass++;
  }
  return { pass: pass, total: n, cols: cols, rows: rows };
}
/**
 * 复刻相位搜索：8px 步长，跳过 (0,0)，粗探 coarseTiles 个 Tile，命中后用 refine 个复核。
 * 默认参数与内核一致（粗探 8 / 精探 16 / 中点采样）；传 (2, true) 可以复现**旧实现**。
 */
function replicaPhaseSearch(img, mode, coarseTiles, legacy) {
  const COARSE = coarseTiles || 8;
  const REFINE = legacy ? 8 : 16;
  const rows = [];
  for (let dy = 0; dy < TILE; dy += 8) {
    for (let dx = 0; dx < TILE; dx += 8) {
      if (dx === 0 && dy === 0) continue;
      const coarse = phaseStats(img, dx, dy, mode, COARSE, legacy);
      rows.push({ dx: dx, dy: dy, coarse: coarse.pass, coarseTotal: coarse.total, refine: null, rate: coarse.total ? coarse.pass / coarse.total : 0 });
    }
  }
  rows.sort((a, b) => b.coarse - a.coarse || a.dx - b.dx || a.dy - b.dy);
  const limit = Math.min(8, rows.length);
  let best = { dx: 0, dy: 0, rate: 0, pass: 0, total: REFINE };
  for (let i = 0; i < limit; i++) {
    if (rows[i].coarse <= 0) break;
    const rr = phaseStats(img, rows[i].dx, rows[i].dy, mode, REFINE, legacy);
    rows[i].refine = rr.pass;
    rows[i].rate = rr.total ? rr.pass / rr.total : 0;
    if (rr.pass > best.pass) best = { dx: rows[i].dx, dy: rows[i].dy, rate: rows[i].rate, pass: rr.pass, total: rr.total };
  }
  const hits = rows.filter((r) => r.coarse > 0).slice(0, 5);
  return {
    best: best,
    accept: best.rate >= 0.1,          // 内核的接受阈值
    hits: hits.map((h) => `(${h.dx},${h.dy}) 粗${h.coarse}/${COARSE} 精${h.refine === null ? '-' : h.refine}/${REFINE}`)
  };
}
/** 1px 粒度扫描（限定窗口），用来暴露"偏移不是 8 的倍数"时内核网格够不到的最优相位 */
function finePhaseScan(img, mode, radius) {
  let best = { dx: 0, dy: 0, rate: -1 };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx < 0 || dy < 0) continue;
      const r = phaseStats(img, dx, dy, mode, 8);
      const rate = r.total ? r.pass / r.total : 0;
      if (rate > best.rate) best = { dx: dx, dy: dy, rate: rate, pass: r.pass, total: r.total };
    }
  }
  return best;
}

// ============================================================
// 内核调用的拦截器：记录标尺读数 / 对消
// ============================================================
const rulerLog = [];
const origExtractScale = GC.extractScale;
const origRemoveScale = GC.removeScale;
GC.extractScale = function (img) {
  const r = origExtractScale.call(GC, img);
  rulerLog.push({ call: 'extractScale', inSize: img.width + 'x' + img.height, out: r ? r.width + 'x' + r.height : 'null' });
  return r;
};
GC.removeScale = function (img, w, h) {
  const r = origRemoveScale.call(GC, img, w, h);
  rulerLog.push({ call: 'removeScale', sz: w + 'x' + h, alpha: Number(GC.lastAlpha.toFixed(3)) });
  return r;
};

// ============================================================
// 一次带完整中间数据的提取
// ============================================================
function probe(label, img, mode) {
  rulerLog.length = 0;
  const phases = [];
  const t0 = Date.now();
  const res = SC.extractSecret(img, { onProgress: function (p, cur, total) { phases.push(p); } });
  const dt = Date.now() - t0;

  // 复刻的每模式常规读取（内核失败时的口径已修正为"取有效块更多的模式"，这里把两个都量出来对照）
  const m6 = phaseStats(img, 0, 0, M6, null);
  const m4 = phaseStats(img, 0, 0, M4, null);
  const psCurrent = replicaPhaseSearch(img, mode, 8, false);   // 与内核一致（粗探 8 块 + 中点采样）
  const psOld = replicaPhaseSearch(img, mode, 2, true);        // 旧实现（粗探 2 块 + 第 0 个/中间采样）
  const fine = finePhaseScan(img, mode, 7);

  console.log(`\n--- ${label} ---`);
  console.log(`  内核结果：success=${res.success} recoveryPath=${res.recoveryPath} mode=${res.mode} ` +
    `validTiles=${res.validTiles}/${res.totalTiles} K_effective=${res.K_effective} 耗时=${dt}ms`);
  if (res.phaseOffset) console.log(`  内核选中的相位：(${res.phaseOffset.dx},${res.phaseOffset.dy})`);
  if (res.restoredSize) console.log(`  内核恢复的尺寸：${res.restoredSize.width}×${res.restoredSize.height}` +
    `（原图 ${img.width}×${img.height}）${res.restoredSize.width !== img.width ? '  ← 按非原尺寸重采样过！' : ''}`);
  console.log(`  ① 常规路径（复刻，全部对齐 Tile）：MODE_6 ${m6.pass}/${m6.total}，MODE_4 ${m4.pass}/${m4.total}；` +
    `网格 ${m6.cols}×${m6.rows}`);
  console.log(`     内核现在的回显口径：mode=${res.mode} validTiles=${res.validTiles}/${res.totalTiles} ` +
    `（失败时取两模式中**有效块更多**的那个；attempts.normal6=${res.attempts ? res.attempts.normal6.validTiles : '-'} ` +
    `/ attempts.normal4=${res.attempts ? res.attempts.normal4.validTiles : '-'}）`);
  const ps = psCurrent;
  console.log(`  ② 相位搜索（复刻内核 8px 网格、粗探 8 块）：最佳相位 (${ps.best.dx},${ps.best.dy}) ` +
    `通过率 ${(ps.best.rate * 100).toFixed(1)}%（${ps.best.pass}/${ps.best.total}）` +
    `，是否达到内核阈值 10% = ${ps.accept}`);
  console.log(`     旧实现（粗探 2 块、采样点为第 0 个与中间那个）：最佳相位 ` +
    `(${psOld.best.dx},${psOld.best.dy}) 通过率 ${(psOld.best.rate * 100).toFixed(1)}%` +
    `，达到阈值 = ${psOld.accept}`);
  console.log(`     粗探有命中的相位：${ps.hits.length ? ps.hits.join('；') : '无'}`);
  console.log(`     1px 粒度真实最优相位：(${fine.dx},${fine.dy}) 通过率 ${(fine.rate * 100).toFixed(1)}%` +
    `${(fine.dx % 8 !== 0 || fine.dy % 8 !== 0) ? '  ← 不在 8px 网格上，内核搜不到！' : ''}`);
  console.log(`  ③ 标尺路径调用记录：${rulerLog.length ? JSON.stringify(rulerLog) : '未调用 extractScale'}`);
  console.log(`     onProgress 阶段序列：${[...new Set(phases)].join(' → ')}（共 ${phases.length} 次回调）`);

  return { res: res, dt: dt, m6: m6, m4: m4, phase: ps, fine: fine, ruler: rulerLog.slice() };
}

// ============================================================
// 全局扰动（用来判断"纯色块本身"能否解释 0/984）
// ============================================================
function quantize3_3_2(img) {
  const out = cloneImageData(img);
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const bits = c === 2 ? 2 : 3;
      const levels = (1 << bits) - 1;
      out.data[o + c] = Math.round(Math.round(out.data[o + c] / 255 * levels) / levels * 255);
    }
  }
  return out;
}
function shiftPixels(img, dx, dy) {
  const out = newImageData(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    const sy = y - dy;
    for (let x = 0; x < img.width; x++) {
      const sx = x - dx;
      const o = (y * img.width + x) * 4;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) {
        out.data[o] = 255; out.data[o + 1] = 255; out.data[o + 2] = 255; out.data[o + 3] = 255;
        continue;
      }
      const s = (sy * img.width + sx) * 4;
      out.data[o] = img.data[s]; out.data[o + 1] = img.data[s + 1];
      out.data[o + 2] = img.data[s + 2]; out.data[o + 3] = img.data[s + 3];
    }
  }
  return out;
}
function toneChange(img, kind, amount) {
  const out = cloneImageData(img);
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = out.data[o + c];
      let nv;
      if (kind === 'linear') nv = (v - 128) * (1 + amount) + 128;
      else nv = 255 * Math.pow(v / 255, 1 + amount);          // gamma
      out.data[o + c] = Math.max(0, Math.min(255, Math.round(nv)));
    }
  }
  return out;
}

// ============================================================
// 主流程
// ============================================================
const W = 1024, H = 1024;
console.log('=== diag-blackout：局部遮盖 / 全局扰动 对提取的影响（1024×1024 载体）===');
const carrier = photoCarrier(W, H, 9001);
const secret = mediumSecret(96, 9002);
const capInfo = SC.analyzeCapacity(carrier, 3000, {});
console.log(`载体 ${W}×${H}：对齐 Tile=${capInfo.alignedTiles}，纹理 Tile=${capInfo.texturedTiles}` +
  `（阈值 ${SC.CONST.DEFAULT_VARIANCE_THRESHOLD}）`);

const runs = [
  { tag: '6 对（lowFrequencyMode:false）', opts: {}, mode: M6 },
  { tag: '4 对（lowFrequencyMode:true）', opts: { lowFrequencyMode: true, redundancy: 'balanced' }, mode: M4 }
];
for (const run of runs) {
  const st = SC.embedSecret(carrier, secret, run.opts);
  console.log(`\n########## ${run.tag} ##########`);
  console.log(`嵌入：K=${st.stats.K} N=${st.stats.N} mode=${st.stats.mode} ` +
    `symbol=${st.stats.symbolSize}B usedTiles=${st.stats.usedTiles} JPEG=${st.stats.secretJpegBytes}B`);
  const stego = st.outputImageData;

  probe('基线（无遮盖）', stego, run.mode);

  for (const size of [50, 100, 200, 400]) {
    const box = withCenterRect(stego, size, 'white', 0);
    const area = (size * size) / (W * H);
    probe(`白块 ${size}×${size}（占面积 ${(area * 100).toFixed(1)}%，中心 ${box.rect.x},${box.rect.y}）`,
      box.img, run.mode);
  }
}

// ---- 颜色对比（200×200） ----
{
  const st = SC.embedSecret(carrier, secret, {});
  console.log('\n########## 颜色对比：同样 200×200（占面积 3.8%）##########');
  for (const kind of ['white', 'black', 'gray', 'noise']) {
    const box = withCenterRect(st.outputImageData, 200, kind, 4242);
    probe(`${kind} 块 200×200`, box.img, M6);
  }
}

// ---- 全局扰动对照（都基于"白块 400×400"那张图） ----
{
  const st = SC.embedSecret(carrier, secret, {});
  const white = withCenterRect(st.outputImageData, 400, 'white', 0).img;
  console.log('\n########## 全局扰动对照（全部基于 400×400 白块图）##########');
  probe('G0 只有白块（不额外扰动）', white, M6);
  probe('G1 JPEG q=90', simulateJpegRoundTrip(white, 90), M6);
  probe('G2 8bit 调色板量化（3-3-2）', quantize3_3_2(white), M6);
  probe('G3 全局平移 1px（内容右移 1）', shiftPixels(white, 1, 0), M6);
  probe('G3b 全局平移 2px', shiftPixels(white, 2, 0), M6);
  probe('G4 线性亮度 +2%', toneChange(white, 'linear', 0.02), M6);
  probe('G5 gamma 1.02', toneChange(white, 'gamma', 0.02), M6);
}

// ---- 无标尺场景（任务步骤 3） ----
{
  console.log('\n########## 无标尺场景：图像里没有嵌入标尺时，标尺路径的行为 ##########');
  const stNoRuler = SC.embedSecret(carrier, secret, { embedScale: false });
  const stWithRuler = SC.embedSecret(carrier, secret, {});
  const direct1 = origExtractScale.call(GC, stNoRuler.outputImageData);
  const direct2 = origExtractScale.call(GC, stWithRuler.outputImageData);
  console.log(`  无标尺图上 extractScale 直接调用 → ${direct1 ? direct1.width + '×' + direct1.height : 'null'}` +
    `（真实尺寸 ${W}×${H}）${direct1 && direct1.width !== W ? '  ← 误报尺寸！' : ''}`);
  console.log(`  有标尺图上 extractScale 直接调用 → ${direct2 ? direct2.width + '×' + direct2.height : 'null'}`);
  // 纯噪声图（完全没有隐写，也没有标尺）作为极端对照
  const noiseImg = newImageData(W, H);
  const rng = makeRng(31);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    noiseImg.data[o] = randByte(rng); noiseImg.data[o + 1] = randByte(rng);
    noiseImg.data[o + 2] = randByte(rng); noiseImg.data[o + 3] = 255;
  }
  const direct3 = origExtractScale.call(GC, noiseImg);
  console.log(`  纯噪声图 extractScale → ${direct3 ? direct3.width + '×' + direct3.height : 'null'}` +
    `${direct3 && direct3.width !== W ? '  ← 误报尺寸！' : ''}`);
  // 无标尺图被破坏后，内核是否会走"按误报尺寸重采样"的分支
  const broken = withCenterRect(stNoRuler.outputImageData, 400, 'white', 0).img;
  probe('无标尺 + 白块 400×400（看 recoveryPath 与是否重采样）', broken, M6);
}

// ---- 报告用：内核回显口径（本轮已修正为"取有效块更多的模式"） ----
{
  console.log('\n########## 内核回显口径验证：把大量承载块涂黑，让 6 对读取失败 ##########');
  const st = SC.embedSecret(carrier, secret, {});
  const stego = st.outputImageData;
  const m6All = phaseStats(stego, 0, 0, M6, null);
  // 找出承载符号的 Tile（CRC 通过的那些），涂黑其中 60%
  const tiles = [];
  const cols = Math.floor(W / TILE), rows = Math.floor(H / TILE);
  for (let t = 0; t < cols * rows; t++) {
    const x = (t % cols) * TILE, y = Math.floor(t / cols) * TILE;
    const tile = readTile(stego, x, y);
    if (tileCrcPass(tile, M6)) tiles.push({ x: x, y: y });
  }
  const black = cloneImageData(stego);
  const nBlack = Math.ceil(tiles.length * 0.6);
  for (let i = 0; i < nBlack; i++) fillRect(black, tiles[i].x, tiles[i].y, TILE, TILE, [0, 0, 0]);
  console.log(`  承载块共 ${tiles.length} 个（整图 CRC 通过 ${m6All.pass}/${m6All.total}），涂黑其中 ${nBlack} 个`);
  probe('涂黑 60% 承载块（K 无法满足，必然失败）', black, M6);
}

// ============================================================
// H. 相位搜索可靠性：裁切偏移（8 的倍数，理论可搜）与全局平移（非 8 倍数）
// ============================================================
{
  const st = SC.embedSecret(carrier, secret, {});
  const stego = st.outputImageData;
  console.log('\n########## H. 相位搜索可靠性（复刻内核 8px 网格、粗探 8 块、精探 16 块；另附旧实现 2 块对照）##########');
  console.log('偏移类型     真实相位   8px 网格内最佳相位   通过率   粗探命中   内核会接受吗   1px 网格真实最优');
  // H1: 裁掉四边各 off 像素（off 是 8 的倍数 → 真相位落在搜索网格上）
  //     注意"裁后的真相位"是 (64−off)%64，不是 (off,off)：裁掉 off 像素后，
  //     原图 x=64 处的网格线落在裁后图的 64−off 处。
  for (const off of [8, 16, 24, 32, 40, 48, 56]) {
    const img = cropImage(stego, off, off, W - 2 * off, H - 2 * off);
    const ps = replicaPhaseSearch(img, M6);
    const fine = finePhaseScan(img, M6, Math.min(off + 4, 60));
    const tp = (64 - off) % 64;
    console.log(`裁边 ${String(off).padStart(2)}px    (${tp},${tp})   ` +
      `(${ps.best.dx},${ps.best.dy})`.padEnd(20) +
      `${(ps.best.rate * 100).toFixed(1)}%`.padStart(8) +
      `   ${ps.hits.length ? ps.hits[0] : '无命中'}`.padEnd(22) +
      `${ps.accept ? '是' : '否'}`.padEnd(8) +
      `  (${fine.dx},${fine.dy}) ${(fine.rate * 100).toFixed(1)}%`);
  }
  // H2: 全局平移（非 8 的倍数 → 真相位不在搜索网格上）
  console.log('--- 全局平移（非 8 的倍数）---');
  for (const sh of [1, 2, 3, 4, 5, 6, 7]) {
    const img = shiftPixels(stego, sh, 0);
    const ps = replicaPhaseSearch(img, M6);
    const fine = finePhaseScan(img, M6, 8);
    console.log(`平移 ${sh}px       (${sh},0)      ` +
      `(${ps.best.dx},${ps.best.dy})`.padEnd(20) +
      `${(ps.best.rate * 100).toFixed(1)}%`.padStart(8) +
      `   ${ps.hits.length ? ps.hits[0] : '无命中'}`.padEnd(22) +
      `${ps.accept ? '是' : '否'}`.padEnd(8) +
      `  (${fine.dx},${fine.dy}) ${(fine.rate * 100).toFixed(1)}%`);
  }
  // H3: 粗探块数对真相位命中率的影响（旧实现 2 块 vs 现在 8 块）
  console.log('--- 粗探块数：旧实现 2 块 vs 现在 8 块（承载块越少越容易漏）---');
  const m6All = phaseStats(stego, 0, 0, M6, null);
  const carry = m6All.pass / m6All.total;
  let missOld = 0, missNew = 0, missRefine = 0, trials = 0;
  for (const off of [8, 16, 24, 32, 40, 48, 56]) {
    const img = cropImage(stego, off, off, W - 2 * off, H - 2 * off);
    const tp = (64 - off) % 64;                        // 裁后图上的真相位
    const cOld = phaseStats(img, tp, tp, M6, 2, true); // 旧实现：2 块 + 第 0 个/中间采样
    const cNew = phaseStats(img, tp, tp, M6, 8, false); // 现在：8 块 + 中点采样
    const r = phaseStats(img, tp, tp, M6, 16, false);
    trials++;
    if (cOld.pass === 0) missOld++;
    if (cNew.pass === 0) missNew++;
    if (r.pass / r.total < 0.1) missRefine++;
    console.log(`  偏移 ${String(off).padStart(2)}px（真相位 ${tp}）：粗探 旧 ${cOld.pass}/2 / 新 ${cNew.pass}/8，` +
      `精探 ${r.pass}/16 = ${(r.pass / r.total * 100).toFixed(1)}%`);
  }
  console.log(`  承载块占比 ${(carry * 100).toFixed(1)}%（${m6All.pass}/${m6All.total}）；` +
    `真相位粗探零命中：旧实现 ${missOld}/${trials} 次 → 现在 ${missNew}/${trials} 次；` +
    `精探不足 10% ${missRefine}/${trials} 次`);
  // H4: 内核在这些裁切图上到底怎么走的（recoveryPath / phaseOffset / 耗时）
  console.log('--- H4 内核实际行为（裁切偏移，都是 8 的倍数）---');
  for (const off of [8, 16, 24, 32, 40, 48, 56]) {
    const img = cropImage(stego, off, off, W - 2 * off, H - 2 * off);
    rulerLog.length = 0;
    const t0 = Date.now();
    const res = SC.extractSecret(img);
    const dt = Date.now() - t0;
    const atTrue = phaseStats(img, (64 - off) % 64, (64 - off) % 64, M6, 16, false);
    console.log(`  裁 ${String(off).padStart(2)}px：success=${res.success} path=${res.recoveryPath}` +
      ` valid=${res.validTiles}/${res.totalTiles}` +
      `${res.phaseOffset ? ' 选中相位(' + res.phaseOffset.dx + ',' + res.phaseOffset.dy + ')' : ''}` +
      ` 耗时=${dt}ms；真相位(${(64 - off) % 64},${(64 - off) % 64})精探 ${atTrue.pass}/16；` +
      `标尺调用=${rulerLog.length ? JSON.stringify(rulerLog) : '无'}`);
  }
}

// ============================================================
// J. 缩放 + 标尺读数精度：检验"标尺恢复成功但按错误尺寸重采样"
// ============================================================
{
  const st = SC.embedSecret(carrier, secret, {});
  const stego = st.outputImageData;
  console.log('\n########## J. 缩放后的标尺读数与恢复结果（检验"按错误尺寸重采样"）##########');
  console.log('缩放   图像尺寸        标尺读数      读数精确?   恢复尺寸      path/valid            耗时');
  for (const sc of [0.98, 0.9, 0.75, 0.5, 1.02, 1.1]) {
    const img = canvasScale(stego, sc);
    rulerLog.length = 0;
    const t0 = Date.now();
    const res = SC.extractSecret(img);
    const dt = Date.now() - t0;
    const read = rulerLog.find((r) => r.call === 'extractScale');
    const readW = read ? parseInt(read.out, 10) : NaN;
    const exact = read && read.out === W + 'x' + H;
    console.log(`${sc.toFixed(2)}   ${(img.width + 'x' + img.height).padEnd(13)} ` +
      `${(read ? read.out : '未调用').padEnd(12)} ` +
      `${(exact ? '是' : (isNaN(readW) ? '—' : '否(差' + (readW - W) + 'px)'))}`.padEnd(40) +
      `${(res.restoredSize ? res.restoredSize.width + 'x' + res.restoredSize.height : '-').padEnd(12)} ` +
      `${(res.recoveryPath + ' valid=' + res.validTiles).padEnd(21)} ${dt}ms`);
  }
}

/** 用 canvas 缩放（与产品 resizeToSize 同路径：垫片里降采样=面积平均、升采样=双线性） */
function canvasScale(img, sc) {
  const w = Math.max(1, Math.round(img.width * sc)), h = Math.max(1, Math.round(img.height * sc));
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

// ============================================================
// I. 全局扰动扫描：哪些变换会把 MODE_6 读取打成 0
// ============================================================
{
  const st = SC.embedSecret(carrier, secret, {});
  const stego = st.outputImageData;
  console.log('\n########## I. 全局扰动扫描（MODE_6 常规读取的有效块数）##########');
  const rows = [['无扰动', stego]];
  for (const q of [95, 92, 90, 85]) rows.push([`JPEG q=${q}`, simulateJpegRoundTrip(stego, q)]);
  rows.push(['8bit 调色板 3-3-2', quantize3_3_2(stego)]);
  for (const sh of [1, 2, 4, 8]) rows.push([`平移 ${sh}px`, shiftPixels(stego, sh, 0)]);
  rows.push(['线性亮度 +2%', toneChange(stego, 'linear', 0.02)]);
  rows.push(['gamma 1.02', toneChange(stego, 'gamma', 0.02)]);
  rows.push(['线性亮度 +10%', toneChange(stego, 'linear', 0.10)]);
  for (const [label, img] of rows) {
    const m6 = phaseStats(img, 0, 0, M6, null);
    const fine = finePhaseScan(img, M6, 8);
    const res = SC.extractSecret(img);
    console.log(`  ${label.padEnd(18)} MODE_6 ${String(m6.pass).padStart(3)}/${m6.total}` +
      `（${(m6.pass / m6.total * 100).toFixed(1)}%）  1px 最优相位 (${fine.dx},${fine.dy}) ` +
      `${(fine.rate * 100).toFixed(1)}%  内核 success=${res.success} path=${res.recoveryPath}`);
  }
}

/** 裁掉四边各 off 像素 */
function cropImage(img, x0, y0, w, h) {  const out = newImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcRow = ((y + y0) * img.width + x0) * 4;
    const dstRow = y * w * 4;
    for (let c = 0; c < w * 4; c++) out.data[dstRow + c] = img.data[srcRow + c];
  }
  return out;
}

// ============================================================
// K. 相位搜索的采样行为：为什么 7/7 个裁切偏移都漏掉
// ============================================================
{
  const st = SC.embedSecret(carrier, secret, {});
  const stego = st.outputImageData;
  console.log('\n########## K. 相位搜索采样行为分析 ##########');
  console.log('裁切   全量扫描 8px 网格前三位（通过数/总数）        真相位通过数   2Tile 粗探   8Tile 探针');
  for (const off of [8, 16, 32, 56]) {
    const img = cropImage(stego, off, off, W - 2 * off, H - 2 * off);
    const truthPhase = (64 - off) % 64;
    // 全量扫描全部 8px 网格相位（每个相位读全部对齐块）—— 这是"真相位是否可被检出"的判据
    const grid = [];
    for (let dy = 0; dy < 64; dy += 8) {
      for (let dx = 0; dx < 64; dx += 8) {
        if (dx === 0 && dy === 0) continue;
        const r = phaseStats(img, dx, dy, M6, null);
        grid.push({ dx: dx, dy: dy, pass: r.pass, total: r.total });
      }
    }
    grid.sort((a, b) => b.pass - a.pass);
    const top = grid.slice(0, 3).map((g) => `(${g.dx},${g.dy}) ${g.pass}/${g.total}`).join('  ');
    const truth = grid.find((g) => g.dx === truthPhase && g.dy === truthPhase);
    const coarse2 = phaseStats(img, truthPhase, truthPhase, M6, 2);
    const probe8 = phaseStats(img, truthPhase, truthPhase, M6, 8);
    console.log(`  ${String(off).padStart(2)}px   ${top.padEnd(46)} ` +
      `${(truth ? truth.pass + '/' + truth.total : '-').padEnd(13)} ` +
      `${(coarse2.pass + '/2').padEnd(11)} ${probe8.pass}/8`);
  }
  console.log('--- 粗探两个采样点在原图中的位置（不同裁切量采到的是同一批块）---');
  for (const off of [8, 16, 32, 56]) {
    const img = cropImage(stego, off, off, W - 2 * off, H - 2 * off);
    const truthPhase = (64 - off) % 64;
    const cols = Math.floor((img.width - truthPhase) / TILE);
    const total = cols * Math.floor((img.height - truthPhase) / TILE);
    const pts = [0, Math.floor(total / 2)].map((t) => {
      const cx = t % cols, cy = Math.floor(t / cols);
      return `原图(${off + truthPhase + cx * TILE},${off + truthPhase + cy * TILE})`;
    });
    console.log(`  裁 ${String(off).padStart(2)}px（真相位 ${truthPhase}）：采样点 ${pts.join('，')}；该图对齐块 ${total} 个`);
  }
}

console.log('\n=== 诊断结束 ===');
