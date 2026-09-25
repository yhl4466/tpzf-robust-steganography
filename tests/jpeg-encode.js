/**
 * jpeg-encode.js —— 测试用基线 JPEG 编码器（Node 内置能力，零第三方依赖）
 *
 * 为什么需要它：v2 隐写流程会把秘密图先用 canvas 编成 JPEG 再嵌入。
 * Node 里没有 canvas，所以这里实现一个真实的基线（SOF0）JPEG 编码器，
 * 让 Node 测试也能用"真实大小、真实字节流"的 JPEG，而不是靠估算：
 *   - 灰度（单分量）与彩色（YCbCr 4:4:4，无子采样）都支持
 *   - 标准 JPEG 亮度/色度量化表 + 标准 Huffman 表（Annex K）
 *   - 质量按 IJG 公式缩放量化表，与浏览器 canvas.toDataURL('image/jpeg', q) 同一套参数
 * 所以它算出来的字节数与浏览器编码器是同一量级，用它做的容量结论是可信的。
 *
 * 局限：只做编码（Node 端不需要解码，提取侧按契约降级为返回 JPEG 字节流）。
 */
'use strict';

require('./dom-shim.js');
require(require('path').join(__dirname, '..', 'js', 'dct-stego.js'));
const DCT = global.DctStego;
if (!DCT) throw new Error('jpeg-encode: 无法加载 DctStego');

// ------------------------------------------------------------
// 标准表
// ------------------------------------------------------------
/** zigzag 顺序表：ZIGZAG[k] = 第 k 个 zigzag 系数在行优先矩阵里的下标 */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
];

const LUMA_Q = DCT.LUMA_QUANT_TABLE.slice();

const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99
];

// Annex K 标准 Huffman 表
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];

/** 自检：BITS 描述的码长分布必须与 HUFFVAL 数量一致，否则说明表抄错了 */
function verifyTable(name, bits, vals) {
  let total = 0;
  for (const b of bits) total += b;
  if (total !== vals.length) {
    throw new Error(`jpeg-encode: ${name} Huffman 表不一致（BITS 合计 ${total}，HUFFVAL ${vals.length}）`);
  }
}
verifyTable('DC luma', DC_LUMA_BITS, DC_LUMA_VALS);
verifyTable('AC luma', AC_LUMA_BITS, AC_LUMA_VALS);
verifyTable('DC chroma', DC_CHROMA_BITS, DC_CHROMA_VALS);
verifyTable('AC chroma', AC_CHROMA_BITS, AC_CHROMA_VALS);

/** BITS/HUFFVAL → { codeOf[symbol] = {code, len} } */
function buildHuffTable(bits, vals) {
  const codeOf = new Map();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      codeOf.set(vals[k++], { code, len });
      code++;
    }
    code <<= 1;
  }
  return codeOf;
}

const HUFF = {
  dcLuma: buildHuffTable(DC_LUMA_BITS, DC_LUMA_VALS),
  acLuma: buildHuffTable(AC_LUMA_BITS, AC_LUMA_VALS),
  dcChroma: buildHuffTable(DC_CHROMA_BITS, DC_CHROMA_VALS),
  acChroma: buildHuffTable(AC_CHROMA_BITS, AC_CHROMA_VALS)
};

// ------------------------------------------------------------
// 位写入器（JPEG 熵编码要求：字节 0xFF 后面补 0x00）
// ------------------------------------------------------------
class BitWriter {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.len = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  _push(b) {
    if (this.len >= this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.len++] = b;
  }
  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this._push(this.acc & 0xFF);
        if ((this.acc & 0xFF) === 0xFF) this._push(0x00); // 填充
        this.acc = 0;
        this.nbits = 0;
      }
    }
  }
  /** 用 1 补齐最后一个字节（JPEG 规定） */
  flush() {
    while (this.nbits !== 0) this.writeBits(1, 1);
  }
  toUint8Array() {
    return this.buf.slice(0, this.len);
  }
}

// ------------------------------------------------------------
// 质量 → 量化表缩放（IJG 公式，与浏览器实现一致）
// ------------------------------------------------------------
function scaleQuantTable(base, quality) {
  const q = Math.min(100, Math.max(1, quality));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const out = new Array(64);
  for (let i = 0; i < 64; i++) {
    let s = Math.floor((base[i] * scale + 50) / 100);
    if (s < 1) s = 1;
    if (s > 255) s = 255;
    out[i] = s;
  }
  return out;
}

/** 数值 → (category, bits) */
function categorize(v) {
  let abs = Math.abs(v);
  let size = 0;
  while (abs > 0) { size++; abs >>= 1; }
  if (size === 0) return { size: 0, bits: 0 };
  const bits = v > 0 ? v : v + (1 << size) - 1;
  return { size, bits };
}

/** 写一个量化后的 8×8 块（zigzag 顺序 + Huffman） */
function writeBlock(bw, coefNat, qNat, prevDC, dcTable, acTable) {
  const zz = new Array(64);
  for (let k = 0; k < 64; k++) {
    const nat = ZIGZAG[k];
    zz[k] = Math.round(coefNat[nat] / qNat[nat]);
  }
  // DC：差分编码
  const diff = zz[0] - prevDC;
  const dc = categorize(diff);
  const dcCode = dcTable.get(dc.size);
  bw.writeBits(dcCode.code, dcCode.len);
  if (dc.size > 0) bw.writeBits(dc.bits, dc.size);

  // AC：RLE + Huffman
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = zz[k];
    if (v === 0) { run++; continue; }
    while (run > 15) {
      const zrl = acTable.get(0xF0);
      bw.writeBits(zrl.code, zrl.len);
      run -= 16;
    }
    const ac = categorize(v);
    const sym = (run << 4) | ac.size;
    const code = acTable.get(sym);
    if (!code) throw new Error('jpeg-encode: AC 符号缺失 ' + sym.toString(16));
    bw.writeBits(code.code, code.len);
    bw.writeBits(ac.bits, ac.size);
    run = 0;
  }
  if (run > 0) {
    const eob = acTable.get(0x00);
    bw.writeBits(eob.code, eob.len);
  }
  return zz[0];
}

// ------------------------------------------------------------
// 主编码函数
// ------------------------------------------------------------
/**
 * 把 ImageData 编码为基线 JPEG。
 * @param {ImageData} imageData
 * @param {number} quality 1~100（与 canvas.toDataURL 的 0~1 刻度不同，调用方换算）
 * @param {boolean} keepColor true=YCbCr 彩色（4:4:4），false=灰度
 * @returns {Uint8Array} JPEG 字节流
 */
function encodeJpeg(imageData, quality, keepColor) {
  const w = imageData.width, h = imageData.height;
  const comps = keepColor ? 3 : 1;
  const qLuma = scaleQuantTable(LUMA_Q, quality);
  const qChroma = scaleQuantTable(CHROMA_Q, quality);

  // 分量平面
  const planes = [];
  for (let c = 0; c < comps; c++) planes.push(new Float32Array(w * h));
  const d = imageData.data;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    if (comps === 1) {
      planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b;
    } else {
      planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b;
      planes[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      planes[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }
  }

  const out = [];
  const push = (v) => out.push(v & 0xFF);
  const pushMarker = (m) => { push(0xFF); push(m); };
  const pushU16 = (v) => { push((v >> 8) & 0xFF); push(v & 0xFF); };

  // SOI
  pushMarker(0xD8);
  // APP0 / JFIF
  pushMarker(0xE0);
  pushU16(16);
  for (const ch of 'JFIF\0') push(ch.charCodeAt(0));
  push(1); push(1); push(0);
  pushU16(1); pushU16(1);
  push(0); push(0);
  // DQT
  pushMarker(0xDB);
  pushU16(2 + 65 * (comps === 1 ? 1 : 2));
  const writeQT = (table, id) => {
    push(id);
    for (let k = 0; k < 64; k++) push(table[ZIGZAG[k]]);
  };
  writeQT(qLuma, 0);
  if (comps === 3) writeQT(qChroma, 1);
  // SOF0
  pushMarker(0xC0);
  pushU16(8 + 3 * comps);
  push(8); pushU16(h); pushU16(w); push(comps);
  for (let c = 0; c < comps; c++) {
    push(c + 1);
    push(0x11);                    // 4:4:4
    push(c === 0 ? 0 : 1);         // 量化表 id
  }
  // DHT
  const writeDHT = (cls, id, bits, vals) => {
    pushMarker(0xC4);
    pushU16(2 + 1 + 16 + vals.length);
    push((cls << 4) | id);
    for (const b of bits) push(b);
    for (const v of vals) push(v);
  };
  writeDHT(0, 0, DC_LUMA_BITS, DC_LUMA_VALS);
  writeDHT(1, 0, AC_LUMA_BITS, AC_LUMA_VALS);
  if (comps === 3) {
    writeDHT(0, 1, DC_CHROMA_BITS, DC_CHROMA_VALS);
    writeDHT(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS);
  }
  // SOS
  pushMarker(0xDA);
  pushU16(6 + 2 * comps);
  push(comps);
  for (let c = 0; c < comps; c++) {
    push(c + 1);
    push(c === 0 ? 0x00 : 0x11);   // DC/AC 表选择
  }
  push(0); push(63); push(0);

  // 熵编码数据
  const bw = new BitWriter();
  const prevDC = new Array(comps).fill(0);
  const block = new Float64Array(64);
  const bx = Math.ceil(w / 8), by = Math.ceil(h / 8);
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      for (let c = 0; c < comps; c++) {
        // 取 8×8 块（越界用边缘像素重复填充）
        for (let r = 0; r < 8; r++) {
          const sy = Math.min(h - 1, y * 8 + r);
          for (let cc = 0; cc < 8; cc++) {
            const sx = Math.min(w - 1, x * 8 + cc);
            block[r * 8 + cc] = planes[c][sy * w + sx] - 128; // 电平搬移
          }
        }
        const coef = DCT.dct8x8(block);
        prevDC[c] = writeBlock(bw, coef, c === 0 ? qLuma : qChroma, prevDC[c],
          c === 0 ? HUFF.dcLuma : HUFF.dcChroma,
          c === 0 ? HUFF.acLuma : HUFF.acChroma);
      }
    }
  }
  bw.flush();
  const data = bw.toUint8Array();
  for (let i = 0; i < data.length; i++) push(data[i]);

  // EOI
  pushMarker(0xD9);

  return new Uint8Array(out);
}

module.exports = { encodeJpeg, scaleQuantTable, ZIGZAG };
