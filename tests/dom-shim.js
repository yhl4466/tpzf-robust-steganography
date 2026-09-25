/**
 * dom-shim.js —— 测试专用的最小 DOM / Canvas / ImageData 垫片（Node 环境）
 *
 * 目的：在没有浏览器的 Node 里跑 js/image-utils.js、js/dct-stego.js 的逻辑。
 * 只实现被测代码真正用到的 API：canvas 元素、2D 上下文、ImageData。
 * 不引入任何 npm 包，符合项目「零外部依赖」约束。
 *
 * 用法：const { ImageDataShim, CanvasShim } = require('./dom-shim.js');
 *       require 时会自动把 window / document / ImageData 挂到 globalThis。
 */
'use strict';

class ImageDataShim {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      // new ImageData(width, height)
      this.width = a | 0;
      this.height = b | 0;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      // new ImageData(data, width, height)
      this.data = a instanceof Uint8ClampedArray ? a : new Uint8ClampedArray(a);
      this.width = b | 0;
      this.height = c | 0;
    }
  }
}

class Ctx2DShim {
  constructor(canvas) {
    this.canvas = canvas;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'high';
    // 以下属性用于浏览器测试套件（水印退化）的干跑
    this.globalAlpha = 1;
    this.fillStyle = '#000000';
    this.font = '10px sans-serif';
    this.textBaseline = 'top';
  }

  createImageData(w, h) {
    return new ImageDataShim(w, h);
  }

  /** 把 fillStyle 解析成 [r,g,b]（支持 #rgb / #rrggbb / rgb(r,g,b)） */
  _fillRGB() {
    const s = String(this.fillStyle).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
      const v = parseInt(m[1], 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) {
      const v = parseInt(m[1], 16);
      return [((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17];
    }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3]];
    if (/^white$/i.test(s)) return [255, 255, 255];
    if (/^black$/i.test(s)) return [0, 0, 0];
    return [0, 0, 0];
  }

  /** source-over 半透明填充（与浏览器 globalAlpha 行为一致） */
  fillRect(x, y, w, h) {
    const cv = this.canvas;
    const rgb = this._fillRGB();
    let a = this.globalAlpha;
    if (!(a >= 0)) a = 0;
    if (a > 1) a = 1;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(cv._w, Math.round(x + w));
    const y1 = Math.min(cv._h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const o = (yy * cv._w + xx) * 4;
        for (let c = 0; c < 3; c++) {
          cv._buf[o + c] = Math.round(cv._buf[o + c] * (1 - a) + rgb[c] * a);
        }
      }
    }
  }

  measureText(text) {
    const size = parseInt(this.font, 10) || 10;
    return { width: String(text).length * size * 0.6 };
  }

  /**
   * 垫片没有字体光栅化能力，这里用"覆盖文字包围盒的矩形"近似，
   * 仅用于 Node 干跑（真实浏览器会走原生 fillText）。
   */
  fillText(text, x, y) {
    const size = parseInt(this.font, 10) || 10;
    const w = Math.max(8, this.measureText(text).width);
    this.fillRect(x, y, w, size * 1.2);
  }

  save() {}
  restore() {}

  putImageData(img, dx, dy) {
    const cv = this.canvas;
    if (cv._w === 0 || cv._h === 0) cv._resize(img.width, img.height);
    for (let y = 0; y < img.height; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= cv._h) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= cv._w) continue;
        const s = (y * img.width + x) * 4;
        const d = (ty * cv._w + tx) * 4;
        cv._buf[d] = img.data[s];
        cv._buf[d + 1] = img.data[s + 1];
        cv._buf[d + 2] = img.data[s + 2];
        cv._buf[d + 3] = img.data[s + 3];
      }
    }
  }

  getImageData(sx, sy, sw, sh) {
    const cv = this.canvas;
    const out = new ImageDataShim(sw | 0, sh | 0);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const sxp = sx + x;
        const syp = sy + y;
        if (sxp < 0 || syp < 0 || sxp >= cv._w || syp >= cv._h) continue; // 越界 -> 透明
        const s = (syp * cv._w + sxp) * 4;
        const d = (y * sw + x) * 4;
        out.data[d] = cv._buf[s];
        out.data[d + 1] = cv._buf[s + 1];
        out.data[d + 2] = cv._buf[s + 2];
        out.data[d + 3] = cv._buf[s + 3];
      }
    }
    return out;
  }

  /**
   * 仅实现被测代码用得到的 drawImage 形式。
   *
   * 重采样保真度很关键（本轮 T5/T6/T7 的结论直接依赖它）：
   *   · 降采样（dw<sw 或 dh<sh）→ **盒式面积平均**，等价于浏览器
   *     imageSmoothingEnabled=true + imageSmoothingQuality='high' 的降采样行为。
   *     早期版本这里用最近邻点采样，会把图像的高频全部折叠（混叠）回来，
   *     连低频载波都被破坏，使 T5/T6/T7 在 Node 里"看起来"必然失败 ——
   *     那是测试替身的失真，不是产品缺陷（真实浏览器降采样不会这样）。
   *   · 上采样 → **双线性插值**（像素中心约定），比点采样更接近浏览器，
   *     对载荷的高频系数有轻微低通，属于更保守的替身。
   *   · 同尺寸 → 逐像素拷贝（恒等）。
   */
  drawImage(src, dx, dy, dw, dh) {
    const cv = this.canvas;
    const sw = src._w !== undefined ? src._w : src.width;
    const sh = src._h !== undefined ? src._h : src.height;
    const sBuf = src._buf !== undefined ? src._buf : (src.data ? src.data : null);
    if (!sBuf) throw new Error('drawImage shim: 不支持的源对象');
    if (dw === undefined) {
      dw = sw;
      dh = sh;
      dx = dx || 0;
      dy = dy || 0;
    }
    if (cv._w === 0 || cv._h === 0) cv._resize(Math.max(1, dw), Math.max(1, dh));
    const out = cv._buf;
    const cw = cv._w, chh = cv._h;

    const put = (tx, ty, r, g, b, a) => {
      if (tx < 0 || tx >= cw || ty < 0 || ty >= chh) return;
      const d = (ty * cw + tx) * 4;
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    };

    if (dw === sw && dh === sh) {
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const s = (y * sw + x) * 4;
          put(dx + x, dy + y, sBuf[s], sBuf[s + 1], sBuf[s + 2], sBuf[s + 3]);
        }
      }
      return;
    }

    if (dw < sw || dh < sh) {
      // ---- 盒式面积平均降采样（带面积权重，支持任意非整数倍率）----
      const sxr = sw / dw, syr = sh / dh;
      for (let y = 0; y < dh; y++) {
        const sy0 = y * syr, sy1 = (y + 1) * syr;
        const iy0 = Math.floor(sy0), iy1 = Math.min(sh - 1, Math.ceil(sy1) - 1);
        for (let x = 0; x < dw; x++) {
          const sx0 = x * sxr, sx1 = (x + 1) * sxr;
          const ix0 = Math.floor(sx0), ix1 = Math.min(sw - 1, Math.ceil(sx1) - 1);
          let r = 0, g = 0, b = 0, a = 0, wsum = 0;
          for (let yy = iy0; yy <= iy1; yy++) {
            const wy = Math.min(sy1, yy + 1) - Math.max(sy0, yy);
            if (wy <= 0) continue;
            for (let xx = ix0; xx <= ix1; xx++) {
              const wx = Math.min(sx1, xx + 1) - Math.max(sx0, xx);
              if (wx <= 0) continue;
              const w = wx * wy;
              const s = (yy * sw + xx) * 4;
              r += sBuf[s] * w; g += sBuf[s + 1] * w; b += sBuf[s + 2] * w; a += sBuf[s + 3] * w;
              wsum += w;
            }
          }
          if (wsum > 0) put(dx + x, dy + y, r / wsum, g / wsum, b / wsum, a / wsum);
        }
      }
      return;
    }

    // ---- 双线性插值上采样（像素中心对齐）----
    const sxr = sw / dw, syr = sh / dh;
    for (let y = 0; y < dh; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * syr - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sxr - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        const s00 = (y0 * sw + x0) * 4, s01 = (y0 * sw + x1) * 4;
        const s10 = (y1 * sw + x0) * 4, s11 = (y1 * sw + x1) * 4;
        const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty);
        const w10 = (1 - tx) * ty, w11 = tx * ty;
        put(dx + x, dy + y,
          sBuf[s00] * w00 + sBuf[s01] * w01 + sBuf[s10] * w10 + sBuf[s11] * w11,
          sBuf[s00 + 1] * w00 + sBuf[s01 + 1] * w01 + sBuf[s10 + 1] * w10 + sBuf[s11 + 1] * w11,
          sBuf[s00 + 2] * w00 + sBuf[s01 + 2] * w01 + sBuf[s10 + 2] * w10 + sBuf[s11 + 2] * w11,
          sBuf[s00 + 3] * w00 + sBuf[s01 + 3] * w01 + sBuf[s10 + 3] * w10 + sBuf[s11 + 3] * w11);
      }
    }
  }
}

class CanvasShim {
  constructor() {
    this._w = 300;
    this._h = 150;
    this._buf = new Uint8ClampedArray(this._w * this._h * 4);
    this._ctx = new Ctx2DShim(this);
  }
  get width() { return this._w; }
  set width(v) { this._resize(Math.max(0, Math.floor(v) || 0), this._h); }
  get height() { return this._h; }
  set height(v) { this._resize(this._w, Math.max(0, Math.floor(v) || 0)); }
  _resize(w, h) {
    this._w = w;
    this._h = h;
    this._buf = new Uint8ClampedArray(Math.max(0, w * h * 4)); // 浏览器 resize 会清空画布
  }
  getContext(type) { return type === '2d' ? this._ctx : null; }
}

// ---- 安装到全局，使被测库中的 document / ImageData 引用可用 ----
global.window = global;
global.ImageData = ImageDataShim;
global.document = {
  createElement(tag) {
    if (tag === 'canvas') return new CanvasShim();
    return { style: {}, appendChild() {}, removeChild() {}, click() {} };
  },
  body: { appendChild() {}, removeChild() {} },
  documentElement: { appendChild() {}, removeChild() {} }
};

module.exports = { ImageDataShim, CanvasShim, Ctx2DShim };
