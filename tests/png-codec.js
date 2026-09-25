/**
 * png-codec.js —— 测试用真 PNG 编解码（Node 内置 zlib，零第三方依赖）
 *
 * 为什么需要它：AC 要求验证"隐写图经过 PNG 无损往返后仍能正确提取"。
 * Node 里没有 canvas，所以这里手写一个最小的真 PNG 编解码器：
 *   PNG 签名 + IHDR(8bit/RGBA/colorType=6) + IDAT(zlib deflate) + IEND，
 * 每个分块带标准 CRC32。这不是"假装无损"，而是真的走了一遍 PNG 字节流。
 *
 * 局限（够用即可）：只支持 8bit RGBA、filter 类型 0（编码器自己也只写 0）。
 */
'use strict';

const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 字节 -> PNG Buffer（8bit / colorType 6 / filter None） */
function pngEncode(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 过滤器类型 0 (None)
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = rgba[y * stride + i];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** PNG Buffer -> { width, height, data:Uint8ClampedArray } */
function pngDecode(buf) {
  if (!Buffer.from(buf.slice(0, 8)).equals(PNG_SIG)) throw new Error('PNG 签名不匹配');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    const crcGot = buf.readUInt32BE(off + 8 + len);
    const crcWant = crc32(buf.slice(off + 4, off + 8 + len));
    if (crcGot !== crcWant) throw new Error('PNG 分块 CRC 校验失败: ' + type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('只支持 8bit RGBA PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    if (f !== 0) throw new Error('只支持 filter 类型 0，实际为 ' + f);
    for (let i = 0; i < stride; i++) out[y * stride + i] = raw[y * (stride + 1) + 1 + i];
  }
  return { width, height, data: out };
}

module.exports = { pngEncode, pngDecode, crc32 };
