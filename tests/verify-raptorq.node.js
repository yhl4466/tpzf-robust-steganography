/**
 * verify-raptorq.node.js —— js/raptorq.js 自测（Node.js，零外部依赖）
 *
 * 覆盖 AC5~AC11，并补充：
 *   - GF(2^16) 域公理 / 本原性自检（域表错误会造成静默错误，必须验）
 *   - 契约检查、系统性检查、padding 语义、增量解码、重复符号、入参校验
 *   - 【对照实验】同参数下 Robust Soliton LT 码在零开销时的成功率，
 *     用来实证"为什么本项目不能直接用 LT/Raptor 类喷泉码"
 *
 * 运行： node tests/verify-raptorq.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LIB_PATH = path.join(__dirname, '..', 'js', 'raptorq.js');
require(LIB_PATH);
const RQ = global.RaptorQ;
if (!RQ) {
  console.error('致命错误：window.RaptorQ 未定义');
  process.exit(1);
}

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
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
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

function randByte(rng) { return rng() >>> 24; }

function randomBytes(n, rng) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = randByte(rng);
  return out;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng() % (i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function pct(v) { return (v * 100).toFixed(2) + '%'; }

// ============================================================
// 一次完整试验：编码 2K 个符号 → 按给定图案丢包 → 解码比对
// ============================================================
function runTrial(K, symbolSize, keepFn, rng) {
  const N = 2 * K;
  const src = randomBytes(K * symbolSize, rng);
  const t0 = process.hrtime.bigint();

  const enc = RQ.createEncoder(src, K, symbolSize);
  const symbols = new Array(N);
  for (let i = 0; i < N; i++) symbols[i] = enc.generateSymbol(i);
  const t1 = process.hrtime.bigint();

  const kept = keepFn(N, K, rng);
  const dec = RQ.createDecoder(K, symbolSize);
  for (let k = 0; k < kept.length; k++) dec.addSymbol(kept[k], symbols[kept[k]]);
  const out = dec.decode();
  const t2 = process.hrtime.bigint();

  const ok = !!out && out.length === src.length && bytesEqual(out, src);
  return {
    ok,
    src,
    out,
    keptCount: kept.length,
    encMs: Number(t1 - t0) / 1e6,
    decMs: Number(t2 - t1) / 1e6,
    totalMs: Number(t2 - t0) / 1e6
  };
}

// ============================================================
// 丢包图案
// ============================================================
const allIndices = (N) => { const a = new Array(N); for (let i = 0; i < N; i++) a[i] = i; return a; };
const dropFirst = (N, d) => allIndices(N).slice(d);
const dropLast = (N, d) => allIndices(N).slice(0, N - d);
const keepOdd = (N) => { const a = []; for (let i = 1; i < N; i += 2) a.push(i); return a; };
const dropRandom = (N, d, rng) => shuffle(allIndices(N), rng).slice(d).sort((a, b) => a - b);
const keepHalfRandom = (N, K, rng) => shuffle(allIndices(N), rng).slice(0, N >> 1).sort((a, b) => a - b);

/** 反复跑 trials 次，返回成功率与耗时统计 */
function measure(K, symbolSize, keepFn, trials, seedBase) {
  let ok = 0, totalMs = 0, maxMs = 0, encSum = 0, decSum = 0;
  for (let t = 0; t < trials; t++) {
    const rng = makeRng(seedBase + t * 7919);
    const r = runTrial(K, symbolSize, keepFn, rng);
    if (r.ok) ok++;
    totalMs += r.totalMs;
    encSum += r.encMs;
    decSum += r.decMs;
    if (r.totalMs > maxMs) maxMs = r.totalMs;
  }
  return {
    successRate: ok / trials,
    ok,
    trials,
    avgMs: totalMs / trials,
    maxMs,
    avgEncMs: encSum / trials,
    avgDecMs: decSum / trials
  };
}

function fmtMeasure(m) {
  return `${m.ok}/${m.trials} = ${pct(m.successRate)}；单次耗时 平均 ${m.avgMs.toFixed(1)} ms` +
    `（编码 ${m.avgEncMs.toFixed(1)} + 解码 ${m.avgDecMs.toFixed(1)}），最慢 ${m.maxMs.toFixed(1)} ms`;
}

console.log('=== raptorq.js 自测（Node ' + process.version + '）===');
console.log('方案：系统化 Reed–Solomon（GF(2^16) 求值型）· 固定 N=2K · 零开销译码\n');

// ============================================================
// AC0 契约 + GF 域自检
// ============================================================
{
  const contract = { createEncoder: 3, createDecoder: 2 };
  const missing = Object.keys(contract).filter((k) => typeof RQ[k] !== 'function');
  const arityBad = Object.keys(contract).filter((k) => typeof RQ[k] === 'function' &&
    RQ[k].length !== contract[k]).map((k) => `${k}(期望${contract[k]},实际${RQ[k].length})`);
  const e = RQ.createEncoder(new Uint8Array(8), 2, 4);
  const d = RQ.createDecoder(2, 4);
  const shapeOk = e.K === 2 && e.symbolSize === 4 && typeof e.generateSymbol === 'function' &&
    typeof d.addSymbol === 'function' && typeof d.receivedCount === 'function' &&
    typeof d.decode === 'function' && d.receivedCount() === 0;
  check('AC0', 'window.RaptorQ 契约：createEncoder/createDecoder 及返回对象方法齐全',
    missing.length === 0 && arityBad.length === 0 && shapeOk,
    `缺失=[${missing.join(', ')}]；形参不符=[${arityBad.join(', ')}]；返回对象形状/初值=${shapeOk}`);
}
{
  const GF = RQ.GF;
  const rng = makeRng(4242);
  let axiomBad = 0, checked = 0;
  for (let t = 0; t < 400; t++) {
    const a = rng() & 0xFFFF, b = rng() & 0xFFFF, c = rng() & 0xFFFF;
    checked++;
    if (GF.multiply(a, b) !== GF.multiply(b, a)) axiomBad++;                       // 交换律
    if (GF.multiply(GF.multiply(a, b), c) !== GF.multiply(a, GF.multiply(b, c))) axiomBad++; // 结合律
    if (GF.multiply(a, b ^ c) !== (GF.multiply(a, b) ^ GF.multiply(a, c))) axiomBad++;       // 分配律
    if (a !== 0 && GF.multiply(a, GF.inverse(a)) !== 1) axiomBad++;                 // 逆元
    if (GF.multiply(a, 0) !== 0 || GF.multiply(a, 1) !== a) axiomBad++;             // 单位元/零元
  }
  // 本原性：随机元素 a 的乘法阶必须恰好是 65535（否则 log 表有空洞 -> 静默错误）
  const a = (rng() & 0xFFFF) || 3;
  const order = (() => {
    let v = 1;
    for (let k = 1; k <= 65535; k++) {
      v = GF.multiply(v, a);
      if (v === 1) return k;
    }
    return -1;
  })();
  check('AC0b', 'GF(2^16) 域公理抽查 400 组 + 乘法阶 = 65535（本原多项式有效）',
    axiomBad === 0 && order === 65535,
    `公理抽查 ${checked} 组违规 ${axiomBad} 次；随机元素 ${a} 的乘法阶=${order}（期望 65535，` +
    `说明 log/exp 表覆盖全部非零元素、无空洞）；本原多项式=0x${GF.poly.toString(16).toUpperCase()}；最大符号索引=${GF.maxSymbolIndex}`);
}
{
  // 系统性 + padding 语义
  const K = 8, symbolSize = 16;
  const rng = makeRng(77);
  const srcLen = 100; // ceil(100/8)=13 <= 16 ✓
  const src = randomBytes(srcLen, rng);
  const enc = RQ.createEncoder(src, K, symbolSize);
  let systematicOk = true;
  for (let i = 0; i < K; i++) {
    const sym = enc.generateSymbol(i);
    for (let b = 0; b < symbolSize; b++) {
      const expect = (i * symbolSize + b) < srcLen ? src[i * symbolSize + b] : 0;
      if (sym[b] !== expect) systematicOk = false;
    }
  }
  // 满收解码后应按需截断得到原文
  const dec = RQ.createDecoder(K, symbolSize);
  for (let i = 0; i < 2 * K; i++) dec.addSymbol(i, enc.generateSymbol(i));
  const out = dec.decode();
  const truncOk = out && bytesEqual(out.slice(0, srcLen), src);
  check('E1', '系统性：i<K 的符号就是原始分片本身（尾部补零）；解码结果可截断还原',
    systematicOk && truncOk && out.length === K * symbolSize,
    `K=${K}, symbolSize=${symbolSize}, 源长=${srcLen}（ceil/8=13<16✓）：系统性=${systematicOk}；` +
    `解码输出长度=${out.length}（=K*symbolSize）；截断后与原文一致=${truncOk}；补零字节数=${K * symbolSize - srcLen}`);
}
{
  // 增量解码：符号不足返回 null，补足后可解
  const K = 6, symbolSize = 8;
  const rng = makeRng(88);
  const src = randomBytes(K * symbolSize, rng);
  const enc = RQ.createEncoder(src, K, symbolSize);
  const dec = RQ.createDecoder(K, symbolSize);
  for (let i = 0; i < K - 1; i++) dec.addSymbol(i, enc.generateSymbol(i));
  const before = dec.decode();
  dec.addSymbol(K - 1, enc.generateSymbol(K - 1));
  const after = dec.decode();
  // 重复添加同一符号不应增加计数
  const cnt = dec.receivedCount();
  dec.addSymbol(0, enc.generateSymbol(0));
  const cnt2 = dec.receivedCount();
  check('E2', '增量解码：不足 K 个返回 null，补齐后可解；重复索引不重复计数',
    before === null && after && bytesEqual(after, src) && cnt === K && cnt2 === K,
    `K-1 个符号时 decode()=${before}；补齐 K 个后成功=${!!after && bytesEqual(after, src)}；` +
    `receivedCount=${cnt} → 重复添加后=${cnt2}`);
}
{
  // 入参校验
  const e1 = assertThrows(() => RQ.createEncoder(new Uint8Array(4), 0, 4));
  const e2 = assertThrows(() => RQ.createEncoder(new Uint8Array(4), 2, 5));   // 奇数 symbolSize
  const e3 = assertThrows(() => RQ.createEncoder(new Uint8Array(100), 2, 4)); // 超出容量
  const e4 = assertThrows(() => RQ.createEncoder(null, 2, 4));
  const e5 = assertThrows(() => RQ.createDecoder(0, 4));
  const enc = RQ.createEncoder(new Uint8Array(8), 2, 4);
  const e6 = assertThrows(() => enc.generateSymbol(-1));
  const e7 = assertThrows(() => enc.generateSymbol(70000));
  const dec = RQ.createDecoder(2, 4);
  const e8 = assertThrows(() => dec.addSymbol(0, new Uint8Array(3)));
  const e9 = assertThrows(() => dec.addSymbol(-1, new Uint8Array(4)));
  const ok = e1 instanceof RangeError && e2 instanceof RangeError && e3 instanceof RangeError &&
    e4 instanceof TypeError && e5 instanceof RangeError && e6 instanceof RangeError &&
    e7 instanceof RangeError && e8 instanceof RangeError && e9 instanceof RangeError;
  check('E3', '非法输入抛明确错误（K=0 / 奇数 symbolSize / 超容量 / 越界索引 / 长度不符）', ok,
    `K=0→${e1 && e1.constructor.name}；symbolSize=5→${e2 && e2.constructor.name}；` +
    `超容量→${e3 && e3.constructor.name}；srcBytes=null→${e4 && e4.constructor.name}；` +
    `K=0 解码器→${e5 && e5.constructor.name}；i=-1→${e6 && e6.constructor.name}；` +
    `i=70000→${e7 && e7.constructor.name}；bytes 长度错→${e8 && e8.constructor.name}；` +
    `addSymbol i=-1→${e9 && e9.constructor.name}`);
}

// ============================================================
// AC5：K=10，N=20，全收
// ============================================================
{
  const m = measure(10, 64, (N) => allIndices(N), 20, 5000);
  check('AC5', 'K=10，N=20，全收 → 恢复原始字节 100%', m.successRate === 1,
    fmtMeasure(m));
}

// ============================================================
// AC6：K=100，N=200，全收，20 个随机种子
// ============================================================
{
  const m = measure(100, 64, (N) => allIndices(N), 20, 6000);
  check('AC6', 'K=100，N=200，全收 → 100% 恢复，20 个不同种子全部成功', m.successRate === 1,
    fmtMeasure(m));
}

// ============================================================
// AC7：K=100，N=200，随机丢 50%，30 次
// ============================================================
{
  const m = measure(100, 64, keepHalfRandom, 30, 7000);
  const verdict = m.successRate >= 0.9 ? '达标' : (m.successRate >= 0.7 ? '条件通过' : '失败');
  check('AC7', 'K=100，N=200，随机丢 50%（保留 100 个），30 次 → 成功率 >= 90%',
    m.successRate >= 0.9, `${fmtMeasure(m)}；判定=${verdict}`);
}

// ============================================================
// AC8：K=500，N=1000，丢 50%，15 次
// ============================================================
{
  const m = measure(500, 64, keepHalfRandom, 15, 8000);
  const verdict = m.successRate >= 0.85 ? '达标' : '失败';
  check('AC8', 'K=500，N=1000，丢 50%，15 次 → 成功率 >= 85%', m.successRate >= 0.85,
    `${fmtMeasure(m)}；判定=${verdict}`);
}

// ============================================================
// AC9：K=2000，N=4000，丢 50%，5 次；报告单次耗时
// ============================================================
{
  const m = measure(2000, 64, keepHalfRandom, 5, 9000);
  const verdict = m.successRate >= 0.8 ? '达标' : '失败';
  const timeOk = m.avgMs < 5000;
  check('AC9', 'K=2000，N=4000，丢 50%，5 次 → 成功率 >= 80%，单次 encode+decode < 5s',
    m.successRate >= 0.8 && timeOk,
    `${fmtMeasure(m)}；判定=${verdict}；单次耗时目标 <5000 ms → 实际 ${m.avgMs.toFixed(1)} ms（${timeOk ? '达标' : '超时'}）`);
}

// ============================================================
// AC10：K=200，四种丢包图案各 10 次
// ============================================================
{
  const K = 200, S = 64, N = 2 * K, D = 100;
  const patterns = [
    { name: '前 100 个全丢', fn: (n) => dropFirst(n, D) },
    { name: '后 100 个全丢', fn: (n) => dropLast(n, D) },
    { name: '隔一个丢一个', fn: (n) => keepOdd(n) },
    { name: '随机 100 个丢', fn: (n, k, rng) => dropRandom(n, D, rng) }
  ];
  const parts = [];
  let allOk = true;
  patterns.forEach((p, idx) => {
    const m = measure(K, S, p.fn, 10, 10000 + idx * 131);
    if (m.successRate < 0.85) allOk = false;
    parts.push(`${p.name}：${m.ok}/${m.trials}=${pct(m.successRate)}（保留 ${N - (p.name === '隔一个丢一个' ? N / 2 : D)} 个，平均 ${m.avgMs.toFixed(0)} ms）`);
  });
  check('AC10', 'K=200 四种丢包图案各 10 次 → 成功率均 >= 85%', allOk, parts.join('；'));
}

// ============================================================
// AC11：K=1/2/3，N=2K，丢 50%，各 20 次
// ============================================================
{
  const parts = [];
  let allOk = true;
  for (const K of [1, 2, 3]) {
    const m = measure(K, 64, keepHalfRandom, 20, 11000 + K * 37);
    if (m.successRate !== 1) allOk = false;
    parts.push(`K=${K}（N=${2 * K}，收到 ${Math.floor(2 * K / 2)} 个）：${m.ok}/${m.trials}=${pct(m.successRate)}`);
  }
  check('AC11', '边界 K=1/2/3，丢 50%，各 20 次全部成功', allOk, parts.join('；'));
}

// ============================================================
// 附加：K=4096 上限能力抽查（单次，报告耗时）
// ============================================================
{
  const K = 4096, S = 32;
  const rng = makeRng(31337);
  const r = runTrial(K, S, keepHalfRandom, rng);
  check('E4', 'K=4096（本实现声明的上限）单次丢 50% 可解，并报告耗时',
    r.ok,
    `K=4096, symbolSize=${S}, N=${2 * K}：成功率=${r.ok ? '100%' : '失败'}；` +
    `编码 ${r.encMs.toFixed(0)} ms + 解码 ${r.decMs.toFixed(0)} ms = ${r.totalMs.toFixed(0)} ms；` +
    `收到符号数=${r.keptCount}`);
}

// ============================================================
// 对照实验：Robust Soliton LT 码（无预编码）在零开销下的实测表现
// ============================================================
function robustSolitonCdf(K, c, delta) {
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const tau = new Float64Array(K + 1);
  const Kr = Math.max(1, Math.round(K / R));
  for (let i = 1; i < Kr && i <= K; i++) tau[i] = R / (i * K);
  if (Kr <= K) tau[Kr] += (R * Math.log(R / delta)) / K;
  const rho = new Float64Array(K + 1);
  rho[1] = 1 / K;
  for (let i = 2; i <= K; i++) rho[i] = 1 / (i * (i - 1));
  let Z = 0;
  for (let i = 1; i <= K; i++) Z += rho[i] + tau[i];
  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let i = 1; i <= K; i++) { acc += (rho[i] + tau[i]) / Z; cdf[i] = acc; }
  cdf[K] = 1;
  return cdf;
}

function pickDegree(cdf, K, x) {
  let lo = 1, hi = K;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function ltNeighbors(seed, d, K) {
  const rng = makeRng(seed);
  const set = new Set();
  let guard = 0;
  while (set.size < d && guard++ < d * 50) set.add(rng() % K);
  return Array.from(set);
}

/** LT 剥离（peeling）解码：成功返回 true */
function ltPeel(K, symbolSize, equations) {
  const solved = new Array(K).fill(null);
  const deg = new Int32Array(equations.length);
  const val = equations.map((e) => Uint8Array.from(e.v));
  const nbrs = equations.map((e) => e.nbrs.slice());
  const bySource = Array.from({ length: K }, () => []);
  equations.forEach((e, ei) => e.nbrs.forEach((j) => bySource[j].push(ei)));
  const active = new Uint8Array(equations.length).fill(1);
  const queue = [];
  for (let ei = 0; ei < equations.length; ei++) {
    deg[ei] = nbrs[ei].length;
    if (deg[ei] === 1) queue.push(ei);
  }
  let solvedCount = 0;
  while (queue.length) {
    const ei = queue.pop();
    if (!active[ei] || deg[ei] !== 1) continue;
    const list = nbrs[ei];
    let target = -1;
    for (let k = 0; k < list.length; k++) {
      if (!solved[list[k]]) { target = list[k]; break; }
    }
    if (target < 0) continue;
    solved[target] = val[ei];
    solvedCount++;
    active[ei] = 0;
    const inc = bySource[target];
    for (let m = 0; m < inc.length; m++) {
      const e2 = inc[m];
      if (!active[e2]) continue;
      const v2 = val[e2];
      const s = solved[target];
      for (let b = 0; b < symbolSize; b++) v2[b] ^= s[b];
      const lst = nbrs[e2];
      const pos = lst.indexOf(target);
      if (pos >= 0) lst.splice(pos, 1);
      deg[e2] = lst.length;
      if (deg[e2] === 1) queue.push(e2);
    }
  }
  return solvedCount === K;
}

function ltTrial(K, symbolSize, cdf, rng) {
  const N = 2 * K;
  const src = [];
  for (let j = 0; j < K; j++) src.push(randomBytes(symbolSize, rng));
  const eqs = [];
  for (let s = 0; s < N; s++) {
    const d = pickDegree(cdf, K, (rng() >>> 8) / 0x1000000);
    const nbrs = ltNeighbors(s * 2654435761 + 1, d, K);
    const v = new Uint8Array(symbolSize);
    for (let n = 0; n < nbrs.length; n++) {
      const shard = src[nbrs[n]];
      for (let b = 0; b < symbolSize; b++) v[b] ^= shard[b];
    }
    eqs.push({ nbrs, v });
  }
  // 随机丢 50%，保留 K 个 —— 与 RS 完全相同的信道条件
  const perm = shuffle(allIndices(N), rng).slice(0, N >> 1);
  const recv = perm.map((i) => eqs[i]);
  return ltPeel(K, symbolSize, recv);
}

{
  const rows = [];
  for (const K of [100, 500]) {
    const cdf = robustSolitonCdf(K, 0.03, 0.5);
    const trials = K === 100 ? 30 : 10;
    let ok = 0;
    const rng = makeRng(24680 + K);
    for (let t = 0; t < trials; t++) if (ltTrial(K, 32, cdf, rng)) ok++;
    rows.push(`K=${K}：${ok}/${trials} = ${pct(ok / trials)}`);
  }
  check('E5', '【对照实验】Robust Soliton LT 码（c=0.03, δ=0.5）零开销下的成功率',
    true,
    rows.join('；') + '  —— 这正是本项目放弃 LT/Raptor 类喷泉码、改用 MDS(RS) 的实测依据');
}

// ============================================================
// 源码约束
// ============================================================
{
  const code = fs.readFileSync(LIB_PATH, 'utf8');
  const esm = (code.match(/(^|\n)\s*(import|export)[\s({]/g) || []).length;
  const dyn = (code.match(/\bimport\s*\(/g) || []).length;
  const req = (code.match(/\brequire\s*\(/g) || []).length;
  const urls = (code.match(/https?:\/\//g) || []).length;
  const wasmUse = (code.match(/\bnew\s+WebAssembly\b|WebAssembly\s*\./g) || []).length;
  const webgl = (code.match(/\bWebGL/g) || []).length;
  check('E6', 'raptorq.js 无 import/export、无 require、无外部 URL、无 WebAssembly/WebGL 调用',
    esm === 0 && dyn === 0 && req === 0 && urls === 0 && wasmUse === 0 && webgl === 0,
    `静态 import/export=${esm}；动态 import()=${dyn}；require()=${req}；外部 URL=${urls}；` +
    `WebAssembly 实际调用=${wasmUse}（注释中提及约束不计）；WebGL=${webgl}；行数=${code.split('\n').length}`);
}

const total = results.length;
const passed = total - failures;
console.log('\n============================================');
console.log(`总计 ${total} 项：通过 ${passed}，失败 ${failures}`);
console.log('验收标准：' + results.filter((r) => /^AC(5|6|7|8|9|10|11)$/.test(r.id))
  .map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
console.log('============================================');
process.exit(failures === 0 ? 0 : 1);
