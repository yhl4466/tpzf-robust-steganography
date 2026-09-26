/**
 * verify-zip-pack.node.js —— ZIP 打包功能的验收测试（Node，零第三方依赖）
 *
 * 覆盖：契约 / 结构合规 / 往返一致 / 确定性 / 错误处理 / 与 packet.js 的 CRC 一致性 /
 *       PNG 打包 / 端到端（嵌入 → 打包 → 解包 → 提取）。
 *
 * 运行： node tests/verify-zip-pack.node.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js',
  'stego-core.js', 'carrier-generator.js', 'zip-pack.js'].forEach((f) => require(path.join(ROOT, 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
const { pngEncode, pngDecode } = require('./png-codec.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, kc) => encodeJpeg(img, Math.round(q01 * 100), kc);
global.__STEGO_PNG_ENCODE__ = (img) => pngEncode(img.width, img.height, Buffer.from(img.data));

const ZipPack = global.ZipPack;
const Packet = global.Packet;
const SC = global.StegoCore;

let failures = 0;
const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass });
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}\n        ${detail}`);
}

/** 小工具：读小端整数 */
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function makeImageData(w, h, seed) {
  const img = new global.ImageData(w, h);
  let a = seed >>> 0;
  for (let i = 0; i < w * h; i++) {
    a = (a * 1664525 + 1013904223) >>> 0;
    img.data[i * 4] = a >>> 24;
    img.data[i * 4 + 1] = (a >>> 16) & 255;
    img.data[i * 4 + 2] = (a >>> 8) & 255;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

console.log('='.repeat(92));
console.log('verify-zip-pack：ZIP 打包功能验收');
console.log('='.repeat(92));

// ============================================================
// AC1 契约
// ============================================================
{
  const names = ['pack', 'unpack', 'packImage', 'isZip'];
  const ok = names.every((n) => typeof ZipPack[n] === 'function');
  const r = ZipPack.pack([{ name: 'a.txt', bytes: new Uint8Array([1, 2, 3]) }]);
  const u = ZipPack.unpack(r);
  const pi = ZipPack.packImage(makeImageData(8, 8, 7), 'x.png');
  check('AC1', 'Contract: pack / unpack / packImage / isZip all present and callable',
    ok && r instanceof Uint8Array && Array.isArray(u) && u[0].bytes instanceof Uint8Array &&
    pi.zipBytes instanceof Uint8Array && typeof pi.fileName === 'string' && ZipPack.isZip(r) === true,
    `函数齐全=${ok}；pack → Uint8Array(${r.length})；unpack → 数组(${u.length})；` +
    `packImage → {zipBytes:${pi.zipBytes.length}B, fileName:"${pi.fileName}"}；isZip=${ZipPack.isZip(r)}`);
}

// ============================================================
// AC2 ZIP 结构合规（PKZIP APPNOTE 存储模式）
// ============================================================
{
  const files = [
    { name: 'stego.png', bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]) },
    { name: '中文名 空格.txt', bytes: new Uint8Array(300).fill(7) },
    { name: 'empty.bin', bytes: new Uint8Array(0) }
  ];
  const zip = ZipPack.pack(files);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  // 本地头在第一处
  const sigLocal = u32(zip, 0) === 0x04034b50;
  const flags0 = u16(zip, 6);
  const method0 = u16(zip, 8);
  const time0 = u16(zip, 10), date0 = u16(zip, 12);
  const nameLen0 = u16(zip, 26), extraLen0 = u16(zip, 28);
  const name0 = Buffer.from(zip.subarray(30, 30 + nameLen0)).toString('utf8');
  const crc0 = u32(zip, 14), size0 = u32(zip, 18), raw0 = u32(zip, 22);
  const data0 = zip.subarray(30 + nameLen0 + extraLen0, 30 + nameLen0 + extraLen0 + size0);

  // 中央目录 + EOCD 位置
  const cdOffset = (() => {
    // 从尾部找 EOCD
    for (let p = zip.length - 22; p >= 0; p--) if (u32(zip, p) === 0x06054b50) return p;
    return -1;
  })();
  const eocdOk = cdOffset >= 0;
  const count = eocdOk ? u16(zip, cdOffset + 10) : -1;
  const cdSize = eocdOk ? u32(zip, cdOffset + 12) : -1;
  const cdOff = eocdOk ? u32(zip, cdOffset + 16) : -1;
  const centralSig = cdOff >= 0 && u32(zip, cdOff) === 0x02014b50;
  const centralFlags = cdOff >= 0 ? u16(zip, cdOff + 8) : -1;
  const centralMethod = cdOff >= 0 ? u16(zip, cdOff + 10) : -1;
  const localOffInCd = cdOff >= 0 ? u32(zip, cdOff + 42) : -1;

  const pass = sigLocal && eocdOk && centralSig &&
    (flags0 & 0x0800) === 0x0800 && (centralFlags & 0x0800) === 0x0800 &&
    method0 === 0 && centralMethod === 0 &&
    time0 === ZipPack.CONST.DOS_TIME && date0 === ZipPack.CONST.DOS_DATE &&
    count === files.length && cdOff === (zip.length - cdSize - 22) &&
    localOffInCd === 0 && name0 === 'stego.png' &&
    crc0 === Packet.crc32(files[0].bytes) && size0 === 8 && raw0 === 8 &&
    bytesEq(data0, files[0].bytes);
  check('AC2', 'ZIP structure: local header / central directory / EOCD signatures, store mode, UTF-8 flag, fixed timestamp, correct offsets and CRC',
    pass,
    `本地头签名=${sigLocal}；中央目录签名=${centralSig}；EOCD=${eocdOk}；` +
    `UTF-8 标志(本地/中央)=0x${flags0.toString(16)}/0x${centralFlags.toString(16)}；` +
    `method=0/0=${method0}/${centralMethod}；时间戳=${time0}/${date0}（DOS 固定值 ${ZipPack.CONST.DOS_TIME}/${ZipPack.CONST.DOS_DATE}）；` +
    `条目数=${count}；中央目录偏移=${cdOff}（校验 ${zip.length - cdSize - 22}）；` +
    `首个本地头偏移=${localOffInCd}；CRC 与 Packet.crc32 一致=${crc0 === Packet.crc32(files[0].bytes)}`);
}

// ============================================================
// AC4 往返一致（含中文名 / 空文件 / 二进制）
// ============================================================
{
  const cases = [
    { name: 'stego.png', bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10, 0, 1, 2, 255]) },
    { name: '中文 文件名.zip', bytes: makeImageData(4, 4, 3).data.slice(0, 64) },
    { name: 'zero.bin', bytes: new Uint8Array(0) },
    { name: 'big.bin', bytes: new Uint8Array(4096).map((_, i) => (i * 31) & 255) }
  ];
  const back = ZipPack.unpack(ZipPack.pack(cases));
  const sameNames = back.map((f) => f.name).join('|') === cases.map((f) => f.name).join('|');
  const sameBytes = cases.every((f, i) => bytesEq(back[i].bytes, f.bytes));
  check('AC4', 'Round-trip: pack then unpack returns the same names (UTF-8) and byte-identical content, including an empty file',
    back.length === cases.length && sameNames && sameBytes,
    `文件数=${back.length}/${cases.length}；名称一致=${sameNames}；字节一致=${sameBytes}；` +
    `名称=[${back.map((f) => f.name).join(', ')}]；大小=[${back.map((f) => f.bytes.length).join(', ')}]`);
}

// ============================================================
// AC6 确定性（同输入两次 pack 逐字节相同）
// ============================================================
{
  const files = [{ name: 'a.png', bytes: makeImageData(6, 6, 9).data }];
  const z1 = ZipPack.pack(files);
  const z2 = ZipPack.pack(files);
  const pi1 = ZipPack.packImage(makeImageData(6, 6, 9), 'a.png');
  const pi2 = ZipPack.packImage(makeImageData(6, 6, 9), 'a.png');
  check('AC6', 'Determinism: same input produces byte-identical ZIP (pack twice, packImage twice)',
    bytesEq(z1, z2) && bytesEq(pi1.zipBytes, pi2.zipBytes) && pi1.fileName === pi2.fileName,
    `pack 两次一致=${bytesEq(z1, z2)}（${z1.length} 字节）；packImage 两次一致=${bytesEq(pi1.zipBytes, pi2.zipBytes)}；` +
    `下载名一致=${pi1.fileName === pi2.fileName}（"${pi1.fileName}"）`);
}

// ============================================================
// AC5 错误处理：损坏 / 非法输入必须抛明确错误
// ============================================================
{
  const good = ZipPack.pack([{ name: 'stego.png', bytes: makeImageData(8, 8, 11).data }]);
  const cases = [];

  const tryUnpack = (label, bytes) => {
    try {
      ZipPack.unpack(bytes);
      cases.push(`${label} → 未抛错`);
      return null;
    } catch (e) {
      const okType = e instanceof Error && typeof e.message === 'string' && e.message.length > 8;
      cases.push(`${label} → ${okType ? '抛出：' + e.message.slice(0, 46) + '…' : '错误对象不规范'}`);
      return e;
    }
  };

  const e1 = tryUnpack('随机字节', makeImageData(16, 16, 5).data);
  const e2 = tryUnpack('空数组', new Uint8Array(0));
  const e3 = tryUnpack('截断（砍掉尾部 40 字节）', good.subarray(0, good.length - 40));
  const e4 = tryUnpack('EOCD 之后篡改数据（CRC 应失败）', (() => {
    const bad = good.slice();
    bad[40] = (bad[40] + 1) & 255;      // 改动文件数据区
    return bad;
  })());
  const e5 = tryUnpack('中央目录签名被破坏', (() => {
    const bad = good.slice();
    // 找到中央目录并把签名改成别的
    for (let p = bad.length - 22; p >= 0; p--) {
      if (u32(bad, p) === 0x06054b50) {
        const cdOff = u32(bad, p + 16);
        bad[cdOff] = 0x00;
        break;
      }
    }
    return bad;
  })());
  // 构造一个 method=8（deflate）的 ZIP：把本地头与中央目录的 method 字段都改成 8
  const e6 = tryUnpack('method=8（deflate）的 ZIP', (() => {
    const bad = good.slice();
    bad[8] = 8;                            // 本地头 method
    for (let p = bad.length - 22; p >= 0; p--) {
      if (u32(bad, p) === 0x06054b50) {
        const cdOff = u32(bad, p + 16);
        bad[cdOff + 10] = 8;               // 中央目录 method
        break;
      }
    }
    return bad;
  })());

  const nonError = cases.filter((c) => c.indexOf('未抛错') !== -1 || c.indexOf('不规范') !== -1);
  const msgQuality = [e1, e2, e3, e4, e5, e6].every((e) => e && /ZIP|zip|CRC|截断|压缩|签名|中央目录/.test(e.message));
  check('AC5', 'Error handling: random bytes / empty / truncated / bit-flipped / broken central directory / deflate ZIP all throw clear errors (no crash, no silent bad data)',
    nonError.length === 0 && msgQuality,
    cases.join('；') + `；错误信息可读=${msgQuality}`);
}

// ============================================================
// isZip：只认 ZIP，且对任意输入都不抛错
// ============================================================
{
  const zip = ZipPack.pack([{ name: 'a.bin', bytes: new Uint8Array([1]) }]);
  const png = pngEncode(4, 4, Buffer.from(makeImageData(4, 4, 1).data));
  const empty = new Uint8Array([0x50, 0x4B, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const weird = [null, undefined, 42, 'PK', new Uint8Array([0x50]), new Uint8Array([0x50, 0x4B, 0x07, 0x08])];
  const noThrow = weird.every((w) => {
    try { return ZipPack.isZip(w) === false; } catch (e) { return false; }
  });
  check('isZip', '真 ZIP/空档案为 true，PNG 与各种非法输入为 false（且从不抛错）',
    ZipPack.isZip(zip) && ZipPack.isZip(empty) && !ZipPack.isZip(png) && noThrow,
    `ZIP=${ZipPack.isZip(zip)}；空档案=${ZipPack.isZip(empty)}；PNG=${ZipPack.isZip(png)}；` +
    `非法输入(${weird.length} 种：null/undefined/数字/残缺头/0x0708)均返回 false 且不抛错=${noThrow}`);
}

// ============================================================
// 与 packet.js 的 CRC32 完全一致（同表同口径）
// ============================================================
{
  // 注意：Packet.crc32 只接受 Uint8Array；ImageData.data 是 Uint8ClampedArray，
  // 这里显式转换一次（ZipPack.pack 内部会自动转换，属于它的便利行为，下面单独验证）。
  const clamped = makeImageData(32, 32, 21).data;
  const fromClamped = new Uint8Array(clamped);
  const samples = [
    new Uint8Array(0),
    new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]),
    fromClamped
  ];
  // "123456789" 的标准 CRC32 是 0xCBF43926
  const std = Packet.crc32(samples[1]) === 0xCBF43926;
  // ZIP 内记录的 CRC 必须等于同一份实现算出来的值
  const zip = ZipPack.pack([{ name: 'x.bin', bytes: samples[2] }]);
  const inZip = u32(zip, 14);
  // 便利行为：直接传 Uint8ClampedArray（ImageData.data）也能打包
  const zipClamped = ZipPack.pack([{ name: 'y.bin', bytes: clamped }]);
  const clampedOk = u32(zipClamped, 14) === Packet.crc32(fromClamped) &&
    bytesEq(ZipPack.unpack(zipClamped)[0].bytes, fromClamped);
  check('CRC32', '复用 packet.js：标准向量 0xCBF43926 通过，ZIP 内记录值一致，且 pack 能自动接受 Uint8ClampedArray',
    std && inZip === Packet.crc32(samples[2]) && clampedOk,
    `"123456789" → 0x${Packet.crc32(samples[1]).toString(16).toUpperCase()}（期望 0xCBF43926）；` +
    `ZIP 内 CRC=0x${inZip.toString(16)}，Packet.crc32=0x${Packet.crc32(samples[2]).toString(16)}；` +
    `直接传 Uint8ClampedArray 亦可=${clampedOk}`);
}

// ============================================================
// packImage：PNG 编码 + 单文件 ZIP
// ============================================================
{
  const img = makeImageData(24, 16, 33);
  const r = ZipPack.packImage(img, 'stego.png');
  const files = ZipPack.unpack(r.zipBytes);
  const isPng = files[0].bytes[0] === 0x89 && files[0].bytes[1] === 0x50 &&
    files[0].bytes[2] === 0x4E && files[0].bytes[3] === 0x47;
  const decoded = pngDecode(Buffer.from(files[0].bytes));
  const sameSize = decoded.width === img.width && decoded.height === img.height;
  let same = sameSize;
  for (let i = 0; same && i < img.data.length; i++) if (decoded.data[i] !== img.data[i]) same = false;
  const overhead = r.zipBytes.length - files[0].bytes.length;
  check('packImage', 'PNG 编码正确（魔数 + 像素往返一致），ZIP 内为单文件，开销符合 100 字节/文件量级',
    files.length === 1 && files[0].name === 'stego.png' && r.fileName === 'stego.zip' &&
    isPng && sameSize && same && overhead < 120,
    `内层文件=${files[0].name}（${files[0].bytes.length} B，PNG 魔数=${isPng}）；` +
    `像素往返一致=${same}（${decoded.width}×${decoded.height}）；下载名=${r.fileName}；` +
    `ZIP 比原图多 ${overhead} 字节（30+46+22+2×9=116 的理论值附近，含名称长度）`);
}

// ============================================================
// AC9 端到端：嵌入 → 打包 ZIP → 解包 → 提取
// ============================================================
{
  const CG = global.CarrierGenerator;
  const carrier = CG.generate({ width: 1024, height: 1024, style: 'grass', seed: 4242 }).imageData;
  const secret = makeImageData(32, 32, 77);

  const t0 = Date.now();
  const emb = SC.embedSecret(carrier, secret, { redundancy: 'standard' });
  const tEmbed = Date.now() - t0;

  const t1 = Date.now();
  const packed = ZipPack.packImage(emb.outputImageData, 'stego.png');
  const tZip = Date.now() - t1;

  const t2 = Date.now();
  const files = ZipPack.unpack(packed.zipBytes);
  const img2 = pngDecode(Buffer.from(files[0].bytes));
  const imageData2 = new global.ImageData(new Uint8ClampedArray(img2.data), img2.width, img2.height);
  const tUnzip = Date.now() - t2;

  const t3 = Date.now();
  const ex = SC.extractSecret(imageData2);
  const tExtract = Date.now() - t3;

  const payloadSame = !!(ex.success && emb.stats.secretJpegBytes === ex.secretJpegBytes.length &&
    Packet.crc32(ex.secretJpegBytes) === emb.stats.secretJpegCrc32);
  const noLoss = bytesEq(imageData2.data, emb.outputImageData.data);

  check('AC9', 'End-to-end: embed secret → pack PNG into ZIP → unpack → PNG decode → extract succeeds with byte-identical payload',
    payloadSame && noLoss && ZipPack.isZip(packed.zipBytes),
    `载体 1024² 合成图 + 32×32 秘密图；嵌入 ${tEmbed} ms → 打包 ${tZip} ms → 解包 + PNG 解码 ${tUnzip} ms → ` +
    `提取 ${tExtract} ms（合计 ${tEmbed + tZip + tUnzip + tExtract} ms）；` +
    `ZIP ${(packed.zipBytes.length / 1024).toFixed(1)} KB；解包后 PNG 与嵌入结果逐字节一致=${noLoss}；` +
    `负载 CRC 一致=${payloadSame}（K=${emb.stats.K} N=${emb.stats.N}）`);
}

// ============================================================
// 汇总
// ============================================================
console.log('\n' + '='.repeat(92));
console.log(`总计 ${results.length} 项：通过 ${results.length - failures}，失败 ${failures}`);
console.log('验收：' + results.map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
console.log('='.repeat(92));
process.exit(failures === 0 ? 0 : 1);
