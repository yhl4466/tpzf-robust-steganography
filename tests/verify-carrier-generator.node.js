/**
 * verify-carrier-generator.node.js —— 载体图生成器的验收测试（Node，零第三方依赖）
 *
 * 覆盖：契约 / 五种风格 / 尺寸 / 确定性 / 差异性 / 端到端存活率（零遮蔽 + 25% + 40%）/
 *       质量自检（8×8 margin 占比、纹理块占比）/ 性能 / 视觉规律性 / 载荷逐字节一致。
 *
 * 运行： node tests/verify-carrier-generator.node.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js',
  'stego-core.js', 'carrier-generator.js'].forEach((f) => require(path.join(ROOT, 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, kc) => encodeJpeg(img, Math.round(q01 * 100), kc);

const CG = global.CarrierGenerator;
const SC = global.StegoCore;
const Packet = global.Packet;

const results = [];
let failures = 0;
function check(id, name, pass, detail) {
  results.push({ id, name, pass });
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}\n        ${detail}`);
}
const pct = (x) => (x * 100).toFixed(1) + '%';

// ============================================================
// 测试用小工具（与内核同口径）
// ============================================================
function makeSecret(size, seed) {
  const img = new global.ImageData(size, size);
  let a = seed >>> 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const v = ((x * 7 + y * 13 + a) % 200) + 30;
      img.data[o] = v; img.data[o + 1] = 255 - v; img.data[o + 2] = (v * 3) % 255; img.data[o + 3] = 255;
    }
  }
  return img;
}
function cloneImageData(img) {
  return new global.ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}
/** 中心区域涂黑：与 embed.html 的"模拟损坏并测试"同几何（64 对齐） */
function blackenCenter(imageData, ratio) {
  const TS = 64;
  const W = imageData.width, H = imageData.height;
  const out = new global.ImageData(new Uint8ClampedArray(imageData.data), W, H);
  const area = ratio * W * H;
  const side = Math.sqrt(area);
  let bw = Math.max(TS, Math.floor(side / TS) * TS);
  let bh = Math.max(TS, Math.floor(area / bw / TS) * TS);
  bw = Math.min(bw, W); bh = Math.min(bh, H);
  const x0 = Math.max(0, Math.floor((W - bw) / 2 / TS) * TS);
  const y0 = Math.max(0, Math.floor((H - bh) / 2 / TS) * TS);
  const x1 = Math.min(W, x0 + bw), y1 = Math.min(H, y0 + bh);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4;
      out.data[o] = 0; out.data[o + 1] = 0; out.data[o + 2] = 0;
    }
  }
  return { image: out, area: (x1 - x0) * (y1 - y0) / (W * H) };
}

// ============================================================
// AC1 契约
// ============================================================
console.log('='.repeat(90));
console.log('verify-carrier-generator：载体图生成器验收');
console.log('='.repeat(90));

const styleList = typeof CG.styles === 'function' ? CG.styles() : [];
const r1 = (() => {
  try { return CG.generate({ width: 256, height: 256, style: 'grass', seed: 7 }); } catch (e) { return { error: e }; }
})();
const shapeOk = !!r1 && !!r1.imageData && typeof r1.seed === 'number' && typeof r1.style === 'string' &&
  !!r1.stats && typeof r1.stats.avgMargin === 'number' &&
  typeof r1.stats.minMargin === 'number' && typeof r1.stats.texturedRatio === 'number';
const stylesOk = styleList.length === 5 &&
  ['id', 'name', 'description', 'previewColors'].every((k) => styleList.every((s) => s[k] !== undefined));
check('AC1', 'CarrierGenerator 契约：generate 返回 {imageData, seed, style, stats{avgMargin,minMargin,texturedRatio}}；styles() 返回 5 项含四字段',
  shapeOk && stylesOk && typeof CG.generate === 'function' && typeof CG.styles === 'function',
  shapeOk && stylesOk
    ? `generate 返回字段齐全；stats={avgMargin:${r1.stats.avgMargin.toFixed(2)}, minMargin:${r1.stats.minMargin.toFixed(2)}, ` +
      `texturedRatio:${pct(r1.stats.texturedRatio)}}；styles()=${styleList.length} 项 [${styleList.map((s) => s.id).join(', ')}]`
    : `shapeOk=${shapeOk} stylesOk=${stylesOk}（${styleList.length} 项）`);

// ============================================================
// AC2 五种风格都能生成
// ============================================================
{
  const ids = ['grass', 'rock', 'cloud', 'wood', 'abstract'];
  const rows = [];
  let ok = true;
  for (const id of ids) {
    try {
      const r = CG.generate({ width: 256, height: 256, style: id, seed: 99 });
      const st = r.imageData.data;
      let sum = 0;
      for (let i = 0; i < st.length; i += 4) sum += st[i] + st[i + 1] + st[i + 2];
      rows.push(`${id}（均色 ${(sum / (st.length / 4 * 3)).toFixed(0)}，minMargin ${r.stats.minMargin.toFixed(1)}）`);
    } catch (e) { ok = false; rows.push(`${id}: ${e.message}`); }
  }
  let unknownErr = null;
  try { CG.generate({ style: 'no-such-style' }); } catch (e) { unknownErr = e; }
  check('AC2', '五种风格（grass/rock/cloud/wood/abstract）都能生成；未知风格抛 RangeError 并列出可选值',
    ok && !!unknownErr && unknownErr instanceof RangeError && /grass/.test(unknownErr.message),
    rows.join('；') + `；未知风格 → ${unknownErr ? unknownErr.constructor.name + '：' + unknownErr.message.slice(0, 60) : '未抛错'}`);
}

// ============================================================
// AC3 尺寸
// ============================================================
{
  const cases = [[1024, 1024], [512, 256], [1000, 700], [64, 64]];
  const rows = [];
  let ok = true;
  for (const [w, h] of cases) {
    const r = CG.generate({ width: w, height: h, seed: 5 });
    const expW = Math.max(8, w - (w % 8)), expH = Math.max(8, h - (h % 8));
    const good = r.imageData.width === expW && r.imageData.height === expH &&
      r.imageData.data.length === expW * expH * 4;
    if (!good) ok = false;
    rows.push(`${w}×${h} → ${r.imageData.width}×${r.imageData.height}`);
  }
  check('AC3', '生成尺寸与请求一致（非 8 倍数向下对齐到 8，data 长度 = w×h×4）', ok, rows.join('；'));
}

// ============================================================
// AC4/AC5 确定性 与 差异性
// ============================================================
{
  const a = CG.generate({ width: 256, height: 256, style: 'rock', seed: 20240925 });
  const b = CG.generate({ width: 256, height: 256, style: 'rock', seed: 20240925 });
  const c = CG.generate({ width: 256, height: 256, style: 'rock', seed: 20240926 });
  let same = a.imageData.data.length === b.imageData.data.length;
  for (let i = 0; same && i < a.imageData.data.length; i++) {
    if (a.imageData.data[i] !== b.imageData.data[i]) same = false;
  }
  let diffCount = 0;
  for (let i = 0; i < a.imageData.data.length; i++) {
    if (a.imageData.data[i] !== c.imageData.data[i]) diffCount++;
  }
  const diffRatio = diffCount / a.imageData.data.length;
  check('AC4', '相同种子生成完全相同的结果（逐字节一致，可复现）', same,
    `种子 20240925 两次生成：${a.imageData.data.length} 字节中不同 ${same ? 0 : '>0'} 个`);
  check('AC5', '不同种子生成不同的结果（差异字节占比应 > 50%）', diffRatio > 0.5,
    `种子 20240925 vs 20240926：${(diffRatio * 100).toFixed(1)}% 的字节不同`);
}

// ============================================================
// AC6/AC10 端到端：零遮蔽存活率、25%/40% 遮蔽、载荷逐字节一致
// ============================================================
{
  const gen = CG.generate({ width: 1024, height: 1024, style: 'grass', seed: 4242 });
  const secret = makeSecret(32, 32, 7);
  const r = SC.embedSecret(gen.imageData, secret, { redundancy: 'standard' });
  const ex = SC.extractSecret(r.outputImageData);
  const survival = ex.validTiles / r.stats.N;

  const b25 = blackenCenter(r.outputImageData, 0.25);
  const b40 = blackenCenter(r.outputImageData, 0.40);
  const e25 = SC.extractSecret(b25.image);
  const e40 = SC.extractSecret(b40.image);

  const bytesSame = !!(ex.secretJpegBytes && r.stats.secretJpegBytes === ex.secretJpegBytes.length &&
    Packet.crc32(ex.secretJpegBytes) === r.stats.secretJpegCrc32);

  check('AC6', '生成的图嵌入 32×32 秘密图：零遮蔽存活率 ≥ 95%，遮蔽 25% 与 40% 均能还原',
    survival >= 0.95 && e25.success && e40.success,
    `K=${r.stats.K}, N=${r.stats.N}；零遮蔽 ${ex.validTiles}/${r.stats.N} = ${pct(survival)}；` +
    `遮蔽 25%（实测 ${pct(b25.area)}）→ ${e25.validTiles}/${r.stats.N} success=${e25.success}；` +
    `遮蔽 40%（实测 ${pct(b40.area)}）→ ${e40.validTiles}/${r.stats.N} success=${e40.success}`);
  check('AC10', '嵌入后提取的载荷与嵌入时逐字节一致（CRC32 相同）', bytesSame,
    `嵌入 ${r.stats.secretJpegBytes} 字节（CRC32 ${r.stats.secretJpegCrc32}）；` +
    `提取 ${ex.secretJpegBytes ? ex.secretJpegBytes.length + ' 字节（CRC32 ' + Packet.crc32(ex.secretJpegBytes) + '）' : 'null'}`);
}

// ============================================================
// AC7 质量自检（五种风格 × 三个尺寸）
// ============================================================
{
  const cases = [];
  for (const id of ['grass', 'rock', 'cloud', 'wood', 'abstract']) {
    cases.push([id, 1024, 1024]);
  }
  cases.push(['grass', 512, 512], ['rock', 2048, 2048], ['wood', 1024, 576]);
  const rows = [];
  let ok = true;
  for (const [id, w, h] of cases) {
    const r = CG.generate({ width: w, height: h, style: id, seed: 1000 + w });
    const pass = r.stats.blockMarginOkRatio >= 0.95 && r.stats.texturedRatio >= 0.80 &&
      r.stats.minMargin >= 12;
    if (!pass) ok = false;
    rows.push(`${id} ${w}×${h}: minMargin=${r.stats.minMargin.toFixed(1)}, ` +
      `margin≥12 占比=${pct(r.stats.blockMarginOkRatio)}, 纹理块=${pct(r.stats.texturedRatio)}` +
      `${r.stats.retries ? '（重试 ' + r.stats.retries + ' 次）' : ''}`);
  }
  check('AC7', '质量自检达标：8×8 块 margin ≥ 12 的占比 ≥ 95%、纹理块占比 ≥ 80%、最小 margin ≥ 12（13 组配置）',
    ok, rows.join('；'));
}

// ============================================================
// AC8 性能（1024² ≤ 400ms、2048² ≤ 1.8s、4096² ≤ 8s）
// ------------------------------------------------------------
// 取多次里更快的一次：性能测试量的是墙钟时间，机器上同时跑别的重活（例如并行开
// headless 浏览器截图）时单次会超标 —— 实测遇到过两次"批量跑被判定超时、单独重跑全绿"。
// 真实回归会让每一次都变慢，所以"取最好一次"既保留把关能力，又不引入随机失败。
// ============================================================
{
  const best = (w, h, style, seed, runs) => {
    let b = Infinity;
    for (let i = 0; i < runs; i++) {
      const t = Date.now();
      CG.generate({ width: w, height: h, style: style, seed: seed + i });
      b = Math.min(b, Date.now() - t);
    }
    return b;
  };
  const dt1 = best(1024, 1024, 'grass', 8, 3);      // 小图便宜，多测两次
  const dt2 = best(2048, 2048, 'wood', 9, 3);
  const dt3 = best(4096, 4096, 'cloud', 10, 2);     // 大图一次 3~5 秒，只测两次
  check('AC8', '性能（取多次较快值）：1024×1024 ≤ 400ms、2048×2048 ≤ 1.8s、4096×4096 ≤ 8s',
    dt1 <= 400 && dt2 <= 1800 && dt3 <= 8000,
    `1024² = ${dt1} ms（≤400，取 3 次最快）；2048² = ${dt2} ms（≤1800，取 3 次最快）；` +
    `4096² = ${dt3} ms（≤8000，取 2 次最快）`);
}

// ============================================================
// AC-扩展：尺寸上限放宽到 8192（用细长条验证，避免测试跑 26 秒）
// ============================================================
{
  const c = CG.CONST || {};
  const okLimit = c.MAX_DIM === 8192;
  const wide = CG.generate({ width: 8192, height: 64, style: 'rock', seed: 3 });
  const tall = CG.generate({ width: 64, height: 8192, style: 'rock', seed: 3 });
  let threw = null;
  try { CG.generate({ width: 8193, height: 64 }); } catch (e) { threw = e; }
  check('AC-扩展', '尺寸上限放宽到 8192（8192×64 与 64×8192 可生成；8193 抛 RangeError）',
    okLimit && wide.imageData.width === 8192 && tall.imageData.height === 8192 &&
    !!threw && threw instanceof RangeError,
    `MAX_DIM=${c.MAX_DIM}；8192×64 → ${wide.imageData.width}×${wide.imageData.height}；` +
    `64×8192 → ${tall.imageData.width}×${tall.imageData.height}；8193 → ${threw ? threw.constructor.name : '未抛错'}`);
}

// ============================================================
// AC-扩展：onProgress 回调（同步接口）
// ============================================================
{
  const seen = [];
  const r = CG.generate({
    width: 512, height: 512, style: 'grass', seed: 11,
    onProgress: (phase, done, total) => seen.push([phase, done, total])
  });
  const monotonic = seen.every((s, i) => i === 0 || s[1] >= seen[i - 1][1]);
  const last = seen[seen.length - 1] || [];
  check('AC-扩展', 'onProgress(phase, done, total)：随分带推进单调递增，最后一次 done=total',
    seen.length > 0 && monotonic && last[1] === last[2] && last[0] === 'generate',
    `回调 ${seen.length} 次（512² → 64 个 8 行带）；末次 [${last.join(', ')}]；单调=${monotonic}`);
}

// ============================================================
// AC-扩展：generateAsync 分片异步——不卡死主线程、结果与同步一致
// ============================================================
(async () => {
  const ticks = { n: 0 };
  const timer = setInterval(() => { ticks.n++; }, 1);
  const progress = [];
  const t0 = Date.now();
  const async = await CG.generateAsync({
    width: 1024, height: 1024, style: 'abstract', seed: 20240925,
    onProgress: (phase, done, total) => progress.push([phase, done, total])
  });
  const dt = Date.now() - t0;
  clearInterval(timer);
  const sync = CG.generate({ width: 1024, height: 1024, style: 'abstract', seed: 20240925 });
  let same = async.imageData.data.length === sync.imageData.data.length;
  for (let i = 0; same && i < sync.imageData.data.length; i++) {
    if (async.imageData.data[i] !== sync.imageData.data[i]) same = false;
  }
  check('AC-扩展', 'generateAsync：边生成边让出主线程（期间计时器仍在跑）、进度回调完整、结果与同步 generate 逐字节一致',
    ticks.n >= 5 && progress.length > 1 && same &&
    async.stats.minMargin >= 12 && async.stats.blockMarginOkRatio >= 0.95,
    `1024² 异步耗时 ${dt} ms；期间 setInterval(1ms) 触发 ${ticks.n} 次（≥5 即证明让出了主线程）；` +
    `进度回调 ${progress.length} 次；与同步结果逐字节一致=${same}；minMargin=${async.stats.minMargin.toFixed(1)}`);

  // ============================================================
  // 汇总
  // ============================================================
  const total = results.length;
  console.log('\n' + '='.repeat(90));
  console.log(`总计 ${total} 项：通过 ${total - failures}，失败 ${failures}`);
  console.log('验收标准：' + results.map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
  console.log('='.repeat(90));
  process.exit(failures === 0 ? 0 : 1);
})();

// ============================================================
// AC9 视觉规律性：无 8×8 网格线、无周期性（自相关检验）
// ============================================================
{
  const r = CG.generate({ width: 512, height: 512, style: 'cloud', seed: 31337 });
  const img = r.imageData, W = img.width, H = img.height, d = img.data;
  // ① 8×8 网格线：块边界处的相邻像素差 vs 块内部
  let onEdge = 0, nEdge = 0, inBlock = 0, nIn = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const p = (y * W + x) * 4, q = (y * W + x - 1) * 4;
      const diff = Math.abs(d[p] - d[q]);
      if (x % 8 === 0) { onEdge += diff; nEdge++; } else { inBlock += diff; nIn++; }
    }
  }
  const edgeRatio = (onEdge / nEdge) / (inBlock / nIn);
  // ② 自相关：把每行做行内去均值后求 lag 相关，检查 8/16/32/64 没有突出尖峰
  const profile = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += d[(y * W + x) * 4];
    profile[x] = s / H;
  }
  let mean = 0;
  for (let x = 0; x < W; x++) mean += profile[x];
  mean /= W;
  for (let x = 0; x < W; x++) profile[x] -= mean;
  let var0 = 0;
  for (let x = 0; x < W; x++) var0 += profile[x] * profile[x];
  const autocorr = (lag) => {
    let acc = 0;
    for (let x = 0; x + lag < W; x++) acc += profile[x] * profile[x + lag];
    return var0 > 0 ? acc / var0 : 0;
  };
  const lags = [8, 16, 32, 64];
  const peaks = lags.map((l) => Math.abs(autocorr(l)));
  const bgLags = [5, 6, 7, 9, 10, 11, 13, 14, 15, 17];
  const bg = bgLags.map((l) => Math.abs(autocorr(l)));
  const bgMean = bg.reduce((a, b) => a + b, 0) / bg.length;
  const maxPeak = Math.max.apply(null, peaks);
  check('AC9', '视觉规律性：无 8×8 网格线（边界/内部差分比 < 1.25），且 lag=8/16/32/64 无突出自相关峰（< 1.6× 邻域均值）',
    edgeRatio < 1.25 && maxPeak < 1.6 * Math.max(0.02, bgMean),
    `块边界/内部相邻差分比 = ${edgeRatio.toFixed(3)}；自相关 lag[8,16,32,64] = ` +
    `[${peaks.map((p) => p.toFixed(3)).join(', ')}]，邻域 lag 均值 = ${bgMean.toFixed(3)}（比值 ${(maxPeak / Math.max(0.02, bgMean)).toFixed(2)}×）`);
}

