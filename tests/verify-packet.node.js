/**
 * verify-packet.node.js —— js/packet.js 自测（Node.js，零外部依赖）
 *
 * 覆盖 AC1~AC4，并补充：入参不被修改、返回 payload 是副本、大包一致性、
 * 与 Node 内置 zlib.crc32 的交叉验证（Node >= 20.15 提供 zlib.crc32）。
 *
 * 运行： node tests/verify-packet.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LIB_PATH = path.join(__dirname, '..', 'js', 'packet.js');
require(LIB_PATH);
const Packet = global.Packet;
if (!Packet) {
  console.error('致命错误：window.Packet 未定义');
  process.exit(1);
}

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

function hex(n) {
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** mulberry32：确定性高质量 PRNG */
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

function randomBytes(n, rng) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() >>> 24;
  return out;
}

console.log('=== packet.js 自测（Node ' + process.version + '）===\n');

// ------------------------------------------------------------
// 契约检查
// ------------------------------------------------------------
{
  const contract = { crc32: 1, pack: 1, unpack: 1 };
  const keys = Object.keys(Packet).sort();
  const missing = Object.keys(contract).filter((k) => typeof Packet[k] !== 'function');
  const arityBad = Object.keys(contract).filter((k) => typeof Packet[k] === 'function' &&
    Packet[k].length !== contract[k]).map((k) => `${k}(期望${contract[k]},实际${Packet[k].length})`);
  check('AC0', 'window.Packet 暴露 crc32 / pack / unpack 三个函数，形参个数一致',
    missing.length === 0 && arityBad.length === 0,
    `可用键=[${keys.join(', ')}]；缺失=[${missing.join(', ')}]；形参不符=[${arityBad.join(', ')}]`);
}

// ------------------------------------------------------------
// AC1：标准 CRC32 测试向量
// ------------------------------------------------------------
{
  const v1 = Packet.crc32(new TextEncoder().encode('123456789'));
  const v2 = Packet.crc32(new Uint8Array(0));
  const v3 = Packet.crc32(new Uint8Array([0x00]));
  const v4 = Packet.crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'));
  const ok = v1 === 0xCBF43926 && v2 === 0x00000000 && v3 === 0xD202EF8D && v4 === 0x414FA339;
  check('AC1', 'CRC32 标准测试向量全部匹配', ok,
    `"123456789" → ${hex(v1)}（期望 0xCBF43926）${v1 === 0xCBF43926 ? '✓' : '✗'}；` +
    `空数组 → ${hex(v2)}（期望 0x00000000）${v2 === 0 ? '✓' : '✗'}；` +
    `[0x00] → ${hex(v3)}（期望 0xD202EF8D）${v3 === 0xD202EF8D ? '✓' : '✗'}；` +
    `"The quick brown fox…" → ${hex(v4)}（期望 0x414FA339）${v4 === 0x414FA339 ? '✓' : '✗'}`);
}

// ------------------------------------------------------------
// 交叉验证：与 Node 内置 zlib.crc32 对比（如果可用）
// ------------------------------------------------------------
{
  if (typeof zlib.crc32 === 'function') {
    const rng = makeRng(2024);
    let mismatch = 0, n = 0, firstBad = '';
    const sizes = [1, 2, 3, 7, 64, 255, 256, 1000, 4096, 65537];
    for (const size of sizes) {
      for (let rep = 0; rep < 5; rep++) {
        const buf = Buffer.from(randomBytes(size, rng));
        const mine = Packet.crc32(new Uint8Array(buf));
        const theirs = zlib.crc32(buf) >>> 0;
        n++;
        if (mine !== theirs) {
          mismatch++;
          if (!firstBad) firstBad = `size=${size} 我=${hex(mine)} zlib=${hex(theirs)}`;
        }
      }
    }
    check('E1', '与 Node 内置 zlib.crc32 交叉验证（50 组随机数据）', mismatch === 0,
      `比对 ${n} 组（长度 1~65537）：不一致 ${mismatch} 组${firstBad ? '；首个不一致：' + firstBad : ''}`);
  } else {
    console.log('[SKIP] E1 当前 Node 无 zlib.crc32，跳过交叉验证');
  }
}

// ------------------------------------------------------------
// AC2：pack/unpack 往返
// ------------------------------------------------------------
{
  const rng = makeRng(1234);
  const payload = randomBytes(1000, rng);
  const snapshot = Uint8Array.from(payload);
  const packet = Packet.pack(payload);
  const r = Packet.unpack(packet);
  const roundTrip = r.valid && r.payload && r.payload.length === 1000 &&
    r.payload.every((v, i) => v === payload[i]);
  const inputIntact = payload.every((v, i) => v === snapshot[i]);
  // 返回的 payload 必须是副本：改它不能影响原包与原始 payload
  const reallyCopy = (() => {
    const r2 = Packet.unpack(packet);
    r2.payload[0] ^= 0xFF;
    return Packet.unpack(packet).payload[0] === payload[0];
  })();
  check('AC2', 'pack/unpack 往返：1000 字节 payload 完全一致', roundTrip && inputIntact && reallyCopy,
    `payload 长度=${payload.length}；packet 长度=${packet.length}（= payload+4 ✓ ${packet.length === 1004}）；` +
    `往返逐字节一致=${roundTrip}；入参未被修改=${inputIntact}；返回 payload 是副本=${reallyCopy}`);
}

// ------------------------------------------------------------
// AC3：CRC 检测（翻转任意一比特都判无效）
// ------------------------------------------------------------
{
  const rng = makeRng(99);
  const payload = randomBytes(64, rng);
  const packet = Packet.pack(payload);
  let flipped = 0, detected = 0, falseAccept = 0;
  for (let byteIdx = 0; byteIdx < packet.length; byteIdx++) {
    for (let bit = 0; bit < 8; bit++) {
      const bad = Uint8Array.from(packet);
      bad[byteIdx] ^= (1 << bit);
      flipped++;
      const r = Packet.unpack(bad);
      if (!r.valid && r.payload === null) detected++;
      else falseAccept++;
    }
  }
  check('AC3', 'pack 后翻转任意 1 比特，unpack.valid 均为 false', falseAccept === 0,
    `共翻转 ${flipped} 个比特（${packet.length} 字节 × 8），检出 ${detected} 个，漏检/误收 ${falseAccept} 个`);
}

// ------------------------------------------------------------
// AC4：长度边界 0~4
// ------------------------------------------------------------
{
  const errs = [];
  const rows = [];
  for (let len = 0; len <= 6; len++) {
    for (const fill of [0x00, 0xFF]) {
      const p = new Uint8Array(len).fill(fill);
      let r;
      try {
        r = Packet.unpack(p);
      } catch (e) {
        errs.push(`len=${len} 抛错 ${e.message}`);
        continue;
      }
      const isInvalid = r && r.valid === false && r.payload === null;
      if (len < 5) {
        if (!isInvalid) errs.push(`len=${len} 应无效但得到 valid=${r.valid}`);
        rows.push(`len=${len}→${r.valid ? 'valid' : 'invalid'}`);
      }
    }
  }
  // 额外：长度 5 且内容随机 -> 大概率 CRC 不匹配（这里构造必然不匹配的包）
  const p5 = new Uint8Array([1, 2, 3, 4, 5]);
  const r5 = Packet.unpack(p5);
  // 非 Uint8Array 输入也不应抛错
  let weird = true;
  try {
    weird = Packet.unpack(null).valid === false && Packet.unpack(undefined).valid === false;
  } catch (e) {
    weird = false;
  }
  // 编程错误仍应抛 TypeError
  const t1 = assertThrows(() => Packet.pack('abc'));
  const t2 = assertThrows(() => Packet.crc32([1, 2, 3]));
  check('AC4', 'packet 长度 0~4 时 unpack 返回 {valid:false,payload:null} 且不抛错',
    errs.length === 0 && r5.valid === false && weird && t1 instanceof TypeError && t2 instanceof TypeError,
    `长度 0~4 全部返回 invalid=[${rows.join(', ')}]；异常=${errs.length}；` +
    `长度 5 随机内容 → valid=${r5.valid}；null/undefined 输入返回 invalid=${weird}；` +
    `pack(字符串)/crc32(普通数组) 抛 TypeError=${t1 instanceof TypeError}/${t2 instanceof TypeError}`);
}

// ------------------------------------------------------------
// 补充：大包、空 payload 的行为说明、payload 长度边界
// ------------------------------------------------------------
{
  const rng = makeRng(555);
  const big = randomBytes(200000, rng);
  const t0 = Date.now();
  const packed = Packet.pack(big);
  const r = Packet.unpack(packed);
  const dt = Date.now() - t0;
  const ok = r.valid && r.payload.every((v, i) => v === big[i]);
  check('E2', '200KB 大包往返正确且速度可接受', ok,
    `200000 字节：pack+unpack 耗时 ${dt} ms；逐字节一致=${ok}；packet 长度=${packed.length}`);
}
{
  // 长度 1 的 payload
  const r1 = Packet.unpack(Packet.pack(new Uint8Array([0xAB])));
  // 空 payload：pack 得到 4 字节，按契约 unpack 判无效（长度 < 5）
  const empty = Packet.pack(new Uint8Array(0));
  const re = Packet.unpack(empty);
  check('E3', '1 字节 payload 正常往返；空 payload 按契约被判无效（长度 4 < 5）',
    r1.valid && r1.payload.length === 1 && r1.payload[0] === 0xAB &&
    empty.length === 4 && re.valid === false,
    `1 字节：valid=${r1.valid}, payload=[${r1.payload}]；空 payload：pack 长度=${empty.length}，unpack.valid=${re.valid}（契约要求长度<5 无效）`);
}

// ------------------------------------------------------------
// 源码约束
// ------------------------------------------------------------
{
  const code = fs.readFileSync(LIB_PATH, 'utf8');
  const esm = (code.match(/(^|\n)\s*(import|export)[\s({]/g) || []).length;
  const dyn = (code.match(/\bimport\s*\(/g) || []).length;
  const req = (code.match(/\brequire\s*\(/g) || []).length;
  const urls = (code.match(/https?:\/\//g) || []).length;
  check('E4', 'packet.js 无 import/export、无 require、无外部 URL', 
    esm === 0 && dyn === 0 && req === 0 && urls === 0,
    `静态 import/export=${esm}；动态 import()=${dyn}；require()=${req}；外部 URL=${urls}；行数=${code.split('\n').length}`);
}

const total = results.length;
const passed = total - failures;
console.log('\n============================================');
console.log(`总计 ${total} 项：通过 ${passed}，失败 ${failures}`);
console.log('验收标准：' + results.filter((r) => /^AC[1-4]$/.test(r.id))
  .map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
console.log('============================================');
process.exit(failures === 0 ? 0 : 1);
