/**
 * diag-preview.node.js —— 预览 bug 的复现与回归（Node，零第三方依赖）
 *
 * 现场（用户浏览器实测）：
 *   提取成功、下载的 JPEG 完整，但预览区显示
 *   "数据已还原，但预览显示失败：Failed to execute 'getImageData' on
 *    'CanvasRenderingContext2D': The source width is 0."
 *
 * 根因：decodeSecretImage 旧实现把"解码器给出的宽高"直接交给 getImageData，
 *   一旦某个解码器（createImageBitmap / Image）给出 0×0，就会抛出上面那句
 *   DOMException —— 它既掩盖了真正的原因，也不会去尝试另一个解码器。
 *
 * 本脚本做两件事：
 *   ① 字节流合法性（真实 fixture + 端到端产物都要是结构合法的 JPEG）；
 *   ② 用**假浏览器原语**把现场复现出来，再验证修复后的行为：
 *      · createImageBitmap 返回 0×0 → 必须自动退化到 Image 路径并成功；
 *      · 两个解码器都坏 → 必须给出可操作的中文错误，且不再出现 getImageData/source width；
 *      · 完全没有解码器（Node） → 明确说明"不支持解码 + 可直接下载"；
 *      · 非 JPEG 字节 → 解码前就拒绝，并指出前两字节不对。
 *
 * 运行： node tests/diag-preview.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js', 'stego-core.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));
const { encodeJpeg } = require('./jpeg-encode.js');
global.__STEGO_JPEG_ENCODE__ = (img, q01, kc) => encodeJpeg(img, Math.round(q01 * 100), kc);

const SC = global.StegoCore;

const results = [];
let failures = 0;
function check(id, name, pass, detail) {
  results.push({ id, name, pass });
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}\n        ${detail}`);
}

/** 解析 JPEG 段结构：SOI / SOF 宽高 / EOI */
function inspectJpeg(bytes) {
  const out = { len: bytes.length, soi: bytes[0] === 0xFF && bytes[1] === 0xD8, eoi: false, w: 0, h: 0, sof: 0 };
  if (bytes.length > 1 && bytes[bytes.length - 2] === 0xFF && bytes[bytes.length - 1] === 0xD9) out.eoi = true;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const m = bytes[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      out.sof = m;
      out.h = (bytes[i + 5] << 8) | bytes[i + 6];
      out.w = (bytes[i + 7] << 8) | bytes[i + 8];
      break;
    }
    if (m === 0xDA) break;
    i += 2 + len;
  }
  return out;
}

// ============================================================
// ① 字节流合法性
// ============================================================
console.log('='.repeat(90));
console.log('diag-preview：预览失败的根因复现与回归');
console.log('='.repeat(90));

// 1a 端到端产物
function makeNoiseCarrier(w, h, seed) {
  const img = new global.ImageData(w, h);
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a >>> 24; };
  for (let i = 0; i < w * h; i++) {
    const v = 30 + (rnd() % 196);
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  return img;
}
function makeSecret(w, h) {
  const img = new global.ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = ((x * 7 + y * 13) % 200) + 30;
      img.data[o] = v; img.data[o + 1] = 255 - v; img.data[o + 2] = (v * 3) % 255; img.data[o + 3] = 255;
    }
  }
  return img;
}
{
  const carrier = makeNoiseCarrier(512, 512, 77);
  const secret = makeSecret(16, 16);
  const r = SC.embedSecret(carrier, secret, { redundancy: 'standard' });
  const ex = SC.extractSecret(r.outputImageData);
  const info = ex.secretJpegBytes ? inspectJpeg(ex.secretJpegBytes) : { len: 0 };
  check('P1', '端到端提取出的 secretJpegBytes 是结构合法的 JPEG（SOI + SOF 宽高 + EOI）',
    !!ex.secretJpegBytes && info.soi && info.eoi && info.w === 16 && info.h === 16 &&
    info.len === r.stats.secretJpegBytes,
    `提取成功=${ex.success}，字节数 ${info.len}（嵌入时 ${r.stats.secretJpegBytes}）；` +
    `SOI=${info.soi}，EOI=${info.eoi}，SOF 宽高=${info.w}×${info.h}（期望 16×16）`);
}

// 1b 用户提供的真实 fixture（注意：它的真实格式就是 JPEG）
{
  const p = path.join(__dirname, 'fixtures', 'secret_original.png');
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    const info = inspectJpeg(buf);
    check('P2', 'fixtures/secret_original.png（实为 JPEG）结构合法，SOF 宽高可解析',
      info.soi && info.w > 0 && info.h > 0,
      `${info.len} 字节；SOI=${info.soi}，EOI=${info.eoi}，SOF 宽高=${info.w}×${info.h}`);
  } else {
    check('P2', 'fixtures/secret_original.png 存在', false, '文件不存在（可选检查）');
  }
}

// ============================================================
// ② 用假浏览器原语复现现场并验证修复
// ============================================================
const GOOD = fs.existsSync(path.join(__dirname, 'fixtures', 'secret_original.png'))
  ? new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'secret_original.png')))
  : (function () {
    const st = SC.embedSecret(makeNoiseCarrier(512, 512, 91), makeSecret(48, 32), {});
    return SC.extractSecret(st.outputImageData).secretJpegBytes;
  })();
const GOODINFO = inspectJpeg(GOOD);

/** 装一套假的浏览器原语：bitmap 尺寸可控、Image 是否成功可控 */
function installFakes(opt) {
  const state = { revoked: 0, objectURLs: 0, bitmapCalls: 0, imageCalls: 0, getImageDataCalls: [] };
  global.createImageBitmap = function () {
    state.bitmapCalls++;
    if (opt.bitmapThrows) return Promise.reject(new Error(opt.bitmapThrows));
    return Promise.resolve({
      width: opt.bitmapW, height: opt.bitmapH,
      close: function () { state.closed = true; },
      data: new Uint8ClampedArray(Math.max(1, opt.bitmapW * opt.bitmapH * 4))
    });
  };
  global.URL = global.URL || {};
  global.URL.createObjectURL = function () { state.objectURLs++; return 'blob:fake/' + state.objectURLs; };
  global.URL.revokeObjectURL = function () { state.revoked++; };
  global.Blob = global.Blob || function (parts, o) { this.parts = parts; this.type = o && o.type; };
  global.Image = function () {
    const self = this;
    Object.defineProperty(self, 'src', {
      set: function () {
        state.imageCalls++;
        setTimeout(function () {
          if (opt.imageFails) { if (self.onerror) self.onerror(new Error('boom')); return; }
          self.naturalWidth = opt.imageW; self.naturalHeight = opt.imageH;
          self.width = opt.imageW; self.height = opt.imageH;
          // dom-shim 的 drawImage 需要 .data（或 _buf）
          self.data = new Uint8ClampedArray(Math.max(1, opt.imageW * opt.imageH * 4));
          if (self.onload) self.onload();
        }, 0);
      }
    });
  };
  // 记录 getImageData 的调用参数，用来证明"再也不会有 source width 0"
  const Ctx = require('./dom-shim.js').Ctx2DShim;
  const origGet = Ctx.prototype.getImageData;
  Ctx.prototype.getImageData = function (sx, sy, sw, sh) {
    state.getImageDataCalls.push(sw + 'x' + sh);
    return origGet.call(this, sx, sy, sw, sh);
  };
  return state;
}
function uninstallFakes() {
  delete global.createImageBitmap;
  delete global.Image;
  delete global.Blob;
}

(async function main() {
  // 2a 现场复现：createImageBitmap 返回 0×0，Image 路径正常 → 必须自动退化并成功
  {
    const st = installFakes({ bitmapW: 0, bitmapH: 0, imageW: GOODINFO.w, imageH: GOODINFO.h });
    let img = null, err = null;
    try { img = await SC.decodeSecretImage(GOOD); } catch (e) { err = e; }
    const okDims = !!img && img.width === GOODINFO.w && img.height === GOODINFO.h;
    check('P3', '【现场复现 → 修复】createImageBitmap 给出 0×0 时自动退化到 Image 路径并成功解码',
      okDims && st.bitmapCalls === 1 && st.imageCalls === 1 && st.revoked === 1 &&
      st.getImageDataCalls.every((s) => !/^0x/.test(s)),
      `bitmap 调用 ${st.bitmapCalls} 次（返回 0×0），Image 调用 ${st.imageCalls} 次；` +
      `解码结果 ${img ? img.width + '×' + img.height : '失败'}（期望 ${GOODINFO.w}×${GOODINFO.h}）；` +
      `getImageData 参数=[${st.getImageDataCalls.join(', ')}]；objectURL 已回收=${st.revoked}；err=${err && err.message}`);
    uninstallFakes();
  }

  // 2b 两个解码器都坏 → 必须给出可操作的中文错误，且不再出现 getImageData/source width
  {
    const st = installFakes({ bitmapW: 0, bitmapH: 0, imageFails: true });
    let err = null;
    try { await SC.decodeSecretImage(GOOD); } catch (e) { err = e; }
    const msg = err ? err.message : '';
    check('P4', '两个解码器都不可用时：给出中文可操作错误，且不再冒出 getImageData / source width 这类 DOMException',
      !!err && /decodeSecretImage/.test(msg) && /解码失败/.test(msg) && /可直接下载/.test(msg) &&
      !/getImageData/.test(msg) && !/source width/i.test(msg),
      `错误信息："${msg}"；bitmap 调用 ${st.bitmapCalls}，Image 调用 ${st.imageCalls}`);
    uninstallFakes();
  }

  // 2c 完全没有解码器（Node 现场）→ 明确"不支持解码"，且提到可直接下载
  {
    uninstallFakes();
    let err = null;
    try { await SC.decodeSecretImage(GOOD); } catch (e) { err = e; }
    const msg = err ? err.message : '';
    check('P5', '无解码器环境（Node）：明确拒绝并提示可直接下载（保持 AC18 口径）',
      !!err && /decodeSecretImage/.test(msg) && /解码失败/.test(msg) && /可直接下载/.test(msg),
      `错误信息："${msg}"`);
  }

  // 2d 非 JPEG 字节 → 解码前拒绝，并指出前两字节不对
  {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    let err = null;
    try { await SC.decodeSecretImage(png); } catch (e) { err = e; }
    const msg = err ? err.message : '';
    check('P6', '非 JPEG 字节流在解码前就被拒绝，错误信息指出 FF D8 缺失',
      !!err && /不是合法的 JPEG/.test(msg) && /FF D8/.test(msg),
      `错误信息："${msg}"`);
    let err2 = null;
    const truncated = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    try { await SC.decodeSecretImage(truncated); } catch (e) { err2 = e; }
    check('P7', '截断的 JPEG（只有段头、没有 SOF）也被提前拒绝并说明原因',
      !!err2 && /不是合法的 JPEG/.test(err2.message) && /SOF/.test(err2.message),
      `错误信息："${err2 && err2.message}"`);
  }

  // 2e 字节流合法但两个解码器都坏时，extract.html 仍能下载（字节流未受影响）
  {
    const st = SC.embedSecret(makeNoiseCarrier(512, 512, 55), makeSecret(16, 16), {});
    const ex = SC.extractSecret(st.outputImageData);
    const info = inspectJpeg(ex.secretJpegBytes);
    check('P8', '预览失败不影响下载：提取出的字节流本身始终是完整 JPEG（下载按钮可用的前提）',
      ex.success && info.soi && info.eoi && info.len === st.stats.secretJpegBytes,
      `success=${ex.success}，${info.len} 字节，SOI=${info.soi}，EOI=${info.eoi}`);
  }

  console.log('\n' + '='.repeat(90));
  console.log(`总计 ${results.length} 项：通过 ${results.length - failures}，失败 ${failures}`);
  console.log('='.repeat(90));
  process.exit(failures === 0 ? 0 : 1);
})();
