/**
 * jpeg-sim.js —— 测试用 JPEG 有损压缩模拟（Node，零第三方依赖）
 *
 * 真实 JPEG 的核心步骤是：8×8 DCT → 按标准亮度量化表除以 Q 并取整
 * （这一步丢掉信息）→ 反量化 → IDCT → 像素取整/clamp。
 * 这里逐块复现这条链路，用来验证"隐写比特能否扛住 JPEG 量化"。
 *
 * 供 verify-dct-stego.node.js 与 verify-stego-core.node.js 共用。
 */
'use strict';

require('./dom-shim.js');
require(require('path').join(__dirname, '..', 'js', 'dct-stego.js'));
const DCT = global.DctStego;
if (!DCT) throw new Error('jpeg-sim: 无法加载 DctStego');

/** IJG 标准质量因子 -> 量化步长表（quality 1~100） */
function quantTableForQuality(quality) {
  const q = Math.min(100, Math.max(1, quality));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return DCT.LUMA_QUANT_TABLE.map((base) => {
    let s = Math.floor((base * scale + 50) / 100);
    if (s < 1) s = 1;
    if (s > 255) s = 255;
    return s;
  });
}

/** 取 8×8 块的亮度（与隐写内核一致：0.299R+0.587G+0.114B） */
function blockLuma(img, bx, by) {
  const buf = new Float64Array(64);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const o = ((by * 8 + r) * img.width + (bx * 8 + c)) * 4;
      buf[r * 8 + c] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
    }
  }
  return buf;
}

/**
 * 对整张图逐 8×8 块做一次 JPEG 式量化往返，返回新的 ImageData。
 * 输出强制为灰度（R=G=B=重建亮度），与真实 JPEG 解码后的 Y 通道行为一致。
 */
function simulateJpegRoundTrip(img, quality) {
  const Q = quantTableForQuality(quality);
  const out = new global.ImageData(img.width, img.height);
  out.data.set(img.data);
  const bx = img.width / 8, by = img.height / 8;
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const coeffs = DCT.dct8x8(blockLuma(img, x, y));
      const deq = new Float64Array(64);
      for (let i = 0; i < 64; i++) {
        deq[i] = Math.round(coeffs[i] / Q[i]) * Q[i]; // 量化 + 反量化
      }
      const pix = DCT.idct8x8(deq);
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          let v = Math.round(pix[r * 8 + c]);
          if (v < 0) v = 0;
          if (v > 255) v = 255; // 真实解码器会 clamp
          const o = ((y * 8 + r) * img.width + (x * 8 + c)) * 4;
          out.data[o] = v;
          out.data[o + 1] = v;
          out.data[o + 2] = v;
          out.data[o + 3] = img.data[o + 3];
        }
      }
    }
  }
  return out;
}

module.exports = { quantTableForQuality, simulateJpegRoundTrip, blockLuma };
