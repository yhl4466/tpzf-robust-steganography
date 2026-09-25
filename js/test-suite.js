/**
 * test-suite.js —— 浏览器内自动化测试套件（window.TestSuite）
 *                   由开发者测试页 dev-test-suite.html 加载，普通用户无需访问
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致）：
 *   1. 零外部依赖：只用原生 JS + 浏览器 Web API；
 *   2. 不使用 ES Module：没有 import / export，普通 script 标签引入；
 *   3. 挂载到全局命名空间 window.TestSuite（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * 依赖（必须在本文件之前加载）：
 *   image-utils.js → ImageUtils ｜ dct-stego.js → DctStego ｜ packet.js → Packet
 *   raptorq.js → RaptorQ ｜ stego-core.js → StegoCore
 *
 * ================================================================
 * 这个套件测什么
 * ================================================================
 *   真实使用浏览器 Canvas 生成退化图（JPEG 重编码、真实缩放、水印合成都必须
 *   走原生 Canvas，Node 垫片做不了），然后看隐写载荷能不能扛住这些退化。
 *   每个测试都走同一套骨架：
 *     ① 生成 512×512 随机噪声载体（纹理最强，最坏情况的鲁棒性检验）
 *     ② 生成秘密图（固定图案：2px 棋盘 + 斜纹，便于肉眼与逐字节双重验证）
 *     ③ StegoCore.embedSecret 得到隐写图
 *     ④ 施加一种退化 → degradedImageData
 *     ⑤ StegoCore.extractSecret
 *     ⑥ 判定：success === true 且秘密图 Y 分量逐字节一致
 *
 *   关于尺寸的重要说明（与需求规格的偏差，已实测确认）：
 *     规格写的是 512×512 载体 + 32×32 秘密图。但载体容量是硬约束：
 *     512×512 只有 (512/64)² = 64 个对齐 Tile，单个 Tile 承载 16 字节符号，
 *     N = 2K 且 K = ceil((8 + W*H)/16)，因此可容纳的秘密像素上限是
 *     504 像素。32×32 = 1024 像素会直接触发"容量不足"异常。
 *     所以这里把秘密图取为 16×16（256 像素 → L=264 → K=17 → N=34），
 *     其余几何参数（512×512 载体、各退化的目标尺寸）与规格完全一致。
 *
 * ================================================================
 * 分组与用例（共 36 个）
 * ================================================================
 *   baseline (7)：T1~T7   JPEG q=0.95/0.85/0.75/0.60、缩放 0.75/0.50、JPEG+缩放组合
 *                 （T5~T7 用"低频回退模式 + balanced"：扛缩放必须只靠最低频的 4 对系数）
 *   blackout (5)：T8~T12 涂黑左上 25%、左半 50%、下半 50%、随机 50% Tile、55%（预期失败）
 *   crop     (4)：T13~T16 裁右半、裁下半、裁右 25%、四边各裁 32px
 *   watermark(4)：T17~T20 全图白 alpha=0.15/0.30、局部 128×128 alpha=0.5、文字水印
 *   capacity (5)：T21~T25 三种冗余档位、自动缩放、大载体容量倍数
 *   resync  (11)：T26~T36 放大 1.25×、缩放+涂黑、裁切偏移 16px/8px、
 *                 标尺独立测试（缩放 / JPEG）、未隐写图不卡死（<2s）、
 *                 标尺干扰对消精度（T33）、低频回退模式的逐 Tile CRC 存活率
 *                 （T34 无退化 100% / T35 缩放 0.5× ≥70% / T36 缩放 0.75× 对消后 ≥90%）
 *
 *   每个用例带 expect 字段：
 *     'pass' 期望提取成功且逐字节一致（默认）
 *     'fail' 期望提取失败（用于验证"失败检测"是正确的，如 T12 超过 50% 冗余边界）
 *     'any'  不设预期，只如实记录（T4 是压力测试）
 */
(function (global) {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  var CARRIER_SIZE = 512;   // 载体边长
  var SECRET_SIZE = 16;     // 秘密图边长（见文件头容量说明）
  var TILE = 64;            // 隐写 Tile 边长（与 stego-core 一致）
  var SEED = 20240601;      // 固定种子，保证每次生成的载体/随机涂黑可复现

  // ============================================================
  // 基础工具
  // ============================================================
  function now() {
    if (global.performance && typeof global.performance.now === 'function') {
      return global.performance.now();
    }
    return Date.now();
  }

  /** mulberry32：确定性 PRNG */
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  function hasCanvas() {
    return typeof document !== 'undefined' &&
      typeof document.createElement === 'function' &&
      typeof global.ImageData === 'function';
  }

  function requireCanvas() {
    if (!hasCanvas()) {
      throw new Error('当前环境不支持 Canvas / ImageData，开发者测试页（dev-test-suite.html）无法运行');
    }
  }

  function makeCanvas(w, h) {
    requireCanvas();
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function ctx2d(canvas) {
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 绘图上下文');
    return ctx;
  }

  function canvasOf(imageData) {
    var c = makeCanvas(imageData.width, imageData.height);
    ctx2d(c).putImageData(imageData, 0, 0);
    return c;
  }

  function imageDataOf(canvas) {
    return ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  }

  function newImageData(w, h) {
    return new global.ImageData(w, h);
  }

  function cloneImageData(imageData) {
    var out = newImageData(imageData.width, imageData.height);
    out.data.set(imageData.data);
    return out;
  }

  /** 取 Y（亮度）分量字节，用于"逐字节一致"判定 */
  function grayBytes(imageData) {
    var n = imageData.width * imageData.height;
    var out = new Uint8Array(n);
    var d = imageData.data;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      out[i] = Math.round(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]);
    }
    return out;
  }

  function sameGray(a, b) {
    if (!a || !b || a.width !== b.width || a.height !== b.height) return false;
    var ga = grayBytes(a), gb = grayBytes(b);
    for (var i = 0; i < ga.length; i++) {
      if (ga[i] !== gb[i]) return false;
    }
    return true;
  }

  // ============================================================
  // 素材生成（步骤 ①②）
  // ============================================================
  /** 512×512 随机噪声载体（RGB 各自随机，纹理极强） */
  function makeCarrier(size) {
    var s = size || CARRIER_SIZE;
    var img = newImageData(s, s);
    var rng = makeRng(SEED + s);
    var d = img.data;
    for (var i = 0; i < s * s; i++) {
      var o = i * 4;
      d[o] = rng() >>> 24;
      d[o + 1] = rng() >>> 24;
      d[o + 2] = rng() >>> 24;
      d[o + 3] = 255;
    }
    return img;
  }

  /** 秘密图：2px 棋盘 + 斜纹（肉眼可辨，且 Y 分量起伏明显） */
  function makeSecret() {
    var s = SECRET_SIZE;
    var img = newImageData(s, s);
    var d = img.data;
    for (var y = 0; y < s; y++) {
      for (var x = 0; x < s; x++) {
        var v = ((((x >> 1) + (y >> 1)) & 1) === 1) ? 235 : 20;
        if (((x + y) & 7) < 2) v = v > 128 ? 70 : 190; // 斜纹
        var o = (y * s + x) * 4;
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
      }
    }
    return img;
  }

  /** "照片感"秘密图：平滑渐变 + 色块 + 轻微噪声，JPEG 压缩率接近真实照片 */
  function makePhotoLikeSecret(size, seed, colorful) {
    var rng = makeRng(seed);
    var img = newImageData(size, size);
    var d = img.data;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var o = (y * size + x) * 4;
        var base = 40 + 140 * (x / size) + 60 * (y / size);
        var stripe = 22 * Math.sin(x / 23) * Math.cos(y / 31);
        var blob = (Math.abs(x - size * 0.35) < size * 0.18 && Math.abs(y - size * 0.4) < size * 0.22) ? 45 : 0;
        var v = Math.max(0, Math.min(255, base + stripe + blob + (rng() >>> 24) % 7 - 3));
        if (colorful) {
          d[o] = v;
          d[o + 1] = Math.max(0, Math.min(255, v * 0.75 + 30));
          d[o + 2] = Math.max(0, Math.min(255, 255 - v * 0.6));
        } else {
          d[o] = v; d[o + 1] = v; d[o + 2] = v;
        }
        d[o + 3] = 255;
      }
    }
    return img;
  }

  function cloneImageData(img) {
    var out = newImageData(img.width, img.height);
    out.data.set(img.data);
    return out;
  }

  /** 涂黑若干矩形（返回新 ImageData） */
  function blackenRects(img, rects) {
    var out = newImageData(img.width, img.height);
    out.data.set(img.data);
    for (var r = 0; r < rects.length; r++) {
      var rect = rects[r];
      for (var y = rect.y; y < rect.y + rect.height && y < out.height; y++) {
        for (var x = rect.x; x < rect.x + rect.width && x < out.width; x++) {
          var o = (y * out.width + x) * 4;
          out.data[o] = 0; out.data[o + 1] = 0; out.data[o + 2] = 0; out.data[o + 3] = 255;
        }
      }
    }
    return out;
  }

  /** 裁切（保持左上角原点） */
  function cropImageData(img, sx, sy, sw, sh) {
    var w = Math.min(sw, img.width - sx), h = Math.min(sh, img.height - sy);
    var out = newImageData(w, h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = ((y + sy) * img.width + (x + sx)) * 4;
        var d = (y * w + x) * 4;
        out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1];
        out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3];
      }
    }
    return out;
  }

  /** "照片感"载体：低频块状内容 + 轻微噪声（宽带频谱，重采样后可恢复） */
  function photoCarrier() {
    var s = CARRIER_SIZE;
    var rng = makeRng(SEED + 991);
    var lw = Math.round(s / 24), lh = Math.round(s / 24);
    var low = new Float32Array(lw * lh);
    var i;
    for (i = 0; i < lw * lh; i++) low[i] = 30 + (rng() >>> 24) % 200;
    var img = newImageData(s, s);
    for (var y = 0; y < s; y++) {
      var fy = y * (lh - 1) / (s - 1);
      var y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
      for (var x = 0; x < s; x++) {
        var fx = x * (lw - 1) / (s - 1);
        var x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
        var top = low[y0 * lw + x0] * (1 - tx) + low[y0 * lw + x1] * tx;
        var bot = low[y1 * lw + x0] * (1 - tx) + low[y1 * lw + x1] * tx;
        var v = Math.max(0, Math.min(255, top * (1 - ty) + bot * ty + (rng() >>> 24) % 7 - 3));
        var o = (y * s + x) * 4;
        img.data[o] = v;
        img.data[o + 1] = Math.max(0, Math.min(255, v * 0.8 + 25));
        img.data[o + 2] = Math.max(0, Math.min(255, 200 - v * 0.5));
        img.data[o + 3] = 255;
      }
    }
    return img;
  }

  /** 无解码器环境下的判定：JPEG 载荷逐字节一致（CRC32 相同即一致） */
  function payloadMatches(res, stats) {
    if (!res.success || !res.secretJpegBytes || !stats) return false;
    if (res.secretJpegBytes.length !== stats.secretJpegBytes) return false;
    var P = global.Packet;
    if (!P) return false;
    return P.crc32(res.secretJpegBytes) === stats.secretJpegCrc32;
  }

  /** 浏览器里再验证一次 JPEG 能否解码成头部声明的尺寸（Node 干跑会自动跳过） */
  function verifyDecode(res, matched) {
    var SC = global.StegoCore;
    if (!matched || !res.decodeSupported || typeof SC.decodeSecretImage !== 'function') {
      return Promise.resolve(matched ? (res.decodeSupported ? '未解码' : '无解码器（跳过）') : '载荷不一致');
    }
    return SC.decodeSecretImage(res.secretJpegBytes).then(function (img) {
      var ok = img && img.width === res.secretWidth && img.height === res.secretHeight;
      return ok ? ('解码 ' + img.width + '×' + img.height) : '解码尺寸不符';
    }, function () {
      return '解码失败';
    });
  }

  // ============================================================
  // 几何重同步 / 低频回退模式的量化工具（T33~T36 用）
  // ============================================================

  /** MSB first 的位 → 字节（与 stego-core 的位序约定一致） */
  function bitsToBytes(bits) {
    var n = Math.floor(bits.length / 8);
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var b = i * 8;
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | (bits[b + k] & 1);
      out[i] = v;
    }
    return out;
  }

  /** 逐字节完全相同（含 alpha），用于"入参是否被修改"的判定 */
  function sameBytes(a, b) {
    if (!a || !b || a.width !== b.width || a.height !== b.height) return false;
    if (a.data.length !== b.data.length) return false;
    for (var i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
    return true;
  }

  /** 用 canvas 把图像重采样回指定尺寸（与 stego-core 内部 restore 同路径） */
  function resizeToSize(imageData, w, h) {
    var dst = makeCanvas(w, h);
    var ctx = ctx2d(dst);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvasOf(imageData), 0, 0, w, h);
    return imageDataOf(dst);
  }

  /**
   * 逐 Tile CRC 通过率 —— 直接量化"某种系数对在某种几何退化下的存活率"。
   *
   * 为什么不看 extractSecret().validTiles：那里混入了"用哪种载荷模式、网格相位
   * 对不对、K 表决"等判断，测不出某一组系数对本身的存活率。这里只做两件事：
   *   ① 按 64×64 网格切 Tile；② 用给定的系数对提取比特 → 还原 payload → 校验 CRC。
   * 分母取"实际承载符号的 Tile 数"（stats.N），因为剩下的 Tile 本来就没嵌东西，
   * 把它们算成失败会低估存活率。判定意义：只要 CRC 通过的符号数 ≥ K，
   * RaptorQ 就能无损恢复出秘密图。
   */
  function tileCrcRate(imageData, pairs, bitsPerTile, usedTiles) {
    var DCT = global.DctStego, Packet = global.Packet, IU = global.ImageUtils;
    if (!DCT || !Packet || !IU) return null;
    var tiles = IU.splitIntoTiles(imageData, TILE);
    var pass = 0, aligned = 0;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.width !== TILE || t.height !== TILE) continue;
      aligned++;
      var bits = DCT.extractBitsFromTile(t.data, bitsPerTile, pairs ? { pairs: pairs } : {});
      var bytes = bitsToBytes(bits);
      var r = Packet.unpack(bytes);
      if (r && r.valid && r.payload && r.payload.length === bytes.length - 4) pass++;
    }
    var denom = usedTiles || aligned;
    return { pass: pass, total: denom, aligned: aligned, rate: denom ? pass / denom : 0 };
  }

  /** 低频回退模式的系数对与每 Tile 比特数（从 StegoCore.CONST 读，保证同源） */
  function mode4() {
    var C = global.StegoCore && global.StegoCore.CONST;
    return (C && C.MODE_4) || null;
  }

  // 低频回退模式的推荐参数组合：
  //   4 对系数只有 256 bit/Tile（6 对的 2/3），512×512 照片载体（63 个纹理 Tile）
  //   装不下 standard 档的 N=2K，因此配套用 balanced（N=1.5K）。
  var LOW_FREQ_OPTS = { lowFrequencyMode: true, redundancy: 'balanced' };

  // ============================================================
  // 退化操作（步骤 ④）
  // ============================================================

  /** Blob → ImageData（优先 createImageBitmap，退化到 Image + objectURL） */
  function decodeBlob(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).then(function (bmp) {
        var c = makeCanvas(bmp.width, bmp.height);
        ctx2d(c).drawImage(bmp, 0, 0);
        if (typeof bmp.close === 'function') bmp.close();
        return imageDataOf(c);
      });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var c = makeCanvas(img.naturalWidth, img.naturalHeight);
        ctx2d(c).drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(imageDataOf(c));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('JPEG 解码失败'));
      };
      img.src = url;
    });
  }

  /**
   * JPEG 有损重编码往返。
   * 浏览器走原生 canvas.toBlob('image/jpeg', q)（q 为 0~1）；
   * 若环境没有 toBlob（例如 Node 干跑），则使用注入的全局钩子
   * window.__TEST_SUITE_JPEG_ROUNDTRIP__(imageData, quality) 作为替身。
   * 注意钩子收到的 quality 与 canvas.toBlob 一致（0~1 刻度），
   * 替身实现需要自己换算成它习惯的刻度（仅用于无浏览器环境的预演）。
   */
  function jpegRoundTrip(imageData, quality) {
    var canvas = canvasOf(imageData);
    if (typeof canvas.toBlob === 'function') {
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) {
            reject(new Error('canvas.toBlob 返回空，JPEG 编码失败'));
            return;
          }
          decodeBlob(blob).then(resolve, reject);
        }, 'image/jpeg', quality);
      });
    }
    var hook = global.__TEST_SUITE_JPEG_ROUNDTRIP__;
    if (typeof hook === 'function') {
      return Promise.resolve(hook(imageData, quality));
    }
    return Promise.reject(new Error('当前环境不支持 JPEG 重编码（缺少 canvas.toBlob）'));
  }

  /** 真实缩放（drawImage + 高质量平滑），返回新尺寸的 ImageData */
  function scaleImage(imageData, scale) {
    var w = Math.max(1, Math.round(imageData.width * scale));
    var h = Math.max(1, Math.round(imageData.height * scale));
    var src = canvasOf(imageData);
    var dst = makeCanvas(w, h);
    var ctx = ctx2d(dst);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return imageDataOf(dst);
  }

  /** 涂黑矩形区域（返回新 ImageData，不改入参） */
  function blackoutRect(imageData, x0, y0, w, h) {
    var out = cloneImageData(imageData);
    for (var y = y0; y < y0 + h && y < out.height; y++) {
      for (var x = x0; x < x0 + w && x < out.width; x++) {
        var o = (y * out.width + x) * 4;
        out.data[o] = 0;
        out.data[o + 1] = 0;
        out.data[o + 2] = 0;
        out.data[o + 3] = 255;
      }
    }
    return out;
  }

  function blackoutRects(imageData, rects) {
    var out = cloneImageData(imageData);
    for (var r = 0; r < rects.length; r++) {
      var rect = rects[r];
      for (var y = rect.y; y < rect.y + rect.height && y < out.height; y++) {
        for (var x = rect.x; x < rect.x + rect.width && x < out.width; x++) {
          var o = (y * out.width + x) * 4;
          out.data[o] = 0;
          out.data[o + 1] = 0;
          out.data[o + 2] = 0;
          out.data[o + 3] = 255;
        }
      }
    }
    return out;
  }

  /** 裁切（保持左上角原点） */
  function cropImage(imageData, sx, sy, sw, sh) {
    var w = Math.min(sw, imageData.width - sx);
    var h = Math.min(sh, imageData.height - sy);
    var out = newImageData(w, h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = ((y + sy) * imageData.width + (x + sx)) * 4;
        var d = (y * w + x) * 4;
        out.data[d] = imageData.data[s];
        out.data[d + 1] = imageData.data[s + 1];
        out.data[d + 2] = imageData.data[s + 2];
        out.data[d + 3] = imageData.data[s + 3];
      }
    }
    return out;
  }

  /** 整图叠加半透明白色（source-over：v' = v*(1-a) + 255*a） */
  function overlayWhite(imageData, alpha) {
    var out = cloneImageData(imageData);
    var d = out.data;
    for (var i = 0; i < out.width * out.height; i++) {
      var o = i * 4;
      d[o] = Math.round(d[o] * (1 - alpha) + 255 * alpha);
      d[o + 1] = Math.round(d[o + 1] * (1 - alpha) + 255 * alpha);
      d[o + 2] = Math.round(d[o + 2] * (1 - alpha) + 255 * alpha);
    }
    return out;
  }

  /** 局部白色水印（用 Canvas 合成） */
  function watermarkRect(imageData, x, y, w, h, alpha) {
    var canvas = canvasOf(imageData);
    var ctx = ctx2d(canvas);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    return imageDataOf(canvas);
  }

  /** 文字水印（真实浏览器用原生 fillText 光栅化） */
  function watermarkText(imageData, text, x, y, alpha) {
    var canvas = canvasOf(imageData);
    var ctx = ctx2d(canvas);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
    return imageDataOf(canvas);
  }

  /** 从 debugMask 里读出承载符号的 Tile（绿色 = CRC 通过） */
  function usedTileRects(stegoImageData) {
    var res = global.StegoCore.extractSecret(stegoImageData);
    var tiles = global.ImageUtils.splitIntoTiles(res.debugMask, TILE);
    var out = [];
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.width !== TILE || t.height !== TILE) continue;
      if (t.data.data[0] === 0 && t.data.data[1] === 255) {
        out.push({ x: t.x, y: t.y, width: TILE, height: TILE });
      }
    }
    return out;
  }

  // ============================================================
  // 36 个用例定义
  // ============================================================
  function jpegCase(quality) {
    return function (c) {
      return jpegRoundTrip(c.stego, quality).then(function (img) {
        return { imageData: img, label: 'JPEG q=' + quality.toFixed(2) + '，尺寸 ' + img.width + '×' + img.height };
      });
    };
  }

  function scaleCase(scale) {
    return function (c) {
      var img = scaleImage(c.stego, scale);
      return { imageData: img, label: '缩放 ×' + scale.toFixed(2) + '，尺寸 ' + img.width + '×' + img.height };
    };
  }

  function blackoutFractionCase(fraction) {
    return function (c) {
      var greens = usedTileRects(c.stego);
      var rng = makeRng(SEED + Math.round(fraction * 1000));
      // Fisher–Yates 洗牌（固定种子 → 可复现）
      for (var i = greens.length - 1; i > 0; i--) {
        var j = rng() % (i + 1);
        var tmp = greens[i]; greens[i] = greens[j]; greens[j] = tmp;
      }
      var n = Math.ceil(greens.length * fraction);
      var img = blackoutRects(c.stego, greens.slice(0, n));
      return {
        imageData: img,
        label: '随机涂黑 ' + n + '/' + greens.length + ' 个承载符号的 Tile（' +
          Math.round(fraction * 100) + '%）'
      };
    };
  }

  var GROUPS = [
    {
      id: 'baseline',
      name: '基线退化（JPEG 压缩 / 缩放）',
      tests: [
        { id: 'T1', name: 'T1 · JPEG q=0.95 重编码', expect: 'pass', degrade: jpegCase(0.95) },
        { id: 'T2', name: 'T2 · JPEG q=0.85 重编码', expect: 'pass', degrade: jpegCase(0.85) },
        { id: 'T3', name: 'T3 · JPEG q=0.75 重编码', expect: 'pass', degrade: jpegCase(0.75) },
        { id: 'T4', name: 'T4 · JPEG q=0.60 重编码（压力测试）', expect: 'any', degrade: jpegCase(0.60) },
        // 缩放的几何恢复依赖"内容在重采样后仍然可恢复"。随机噪声载体被重采样后
        // 高频信息直接丢失（实测 384bit/Tile 的误码率 17%~28%），任何纠删码都救不回；
        // 因此 T5~T7 改用照片感载体（真实使用场景），噪声载体的结论在报告里单独说明。
        //
        // 本轮起 T5~T7 统一使用"低频回退模式 + balanced 冗余"：
        //   4 对最低频系数（(2,0)/(0,2)、(2,1)/(1,2)、(3,0)/(0,3)、(3,1)/(1,3)）
        //   在 0.5× 缩放后仍位于奈奎斯特频率以下，是能扛住缩放的唯一选择；
        //   代价是每 Tile 只剩 256 bit，容量降到 2/3，故配 balanced（N=1.5K）。
        //   实测（照片载体）：0.75× 承载 Tile 的 CRC 存活率 100%、0.5× 80%。
        {
          id: 'T5', name: 'T5 · 缩放到 0.75 倍（512→384）', expect: 'pass',
          makeCarrier: photoCarrier, embedOptions: LOW_FREQ_OPTS, degrade: scaleCase(0.75)
        },
        {
          id: 'T6', name: 'T6 · 缩放到 0.50 倍（512→256）', expect: 'pass',
          makeCarrier: photoCarrier, embedOptions: LOW_FREQ_OPTS, degrade: scaleCase(0.50)
        },
        {
          id: 'T7', name: 'T7 · JPEG q=0.85 + 缩放 0.75 倍（组合退化）', expect: 'pass',
          makeCarrier: photoCarrier, embedOptions: LOW_FREQ_OPTS,
          degrade: function (c) {
            return jpegRoundTrip(c.stego, 0.85).then(function (img) {
              var scaled = scaleImage(img, 0.75);
              return {
                imageData: scaled,
                label: 'JPEG q=0.85 → 缩放 ×0.75，尺寸 ' + scaled.width + '×' + scaled.height
              };
            });
          }
        }
      ]
    },
    {
      id: 'blackout',
      name: '涂黑',
      tests: [
        {
          id: 'T8', name: 'T8 · 涂黑左上 25% 象限（128×128）', expect: 'pass',
          degrade: function (c) {
            return { imageData: blackoutRect(c.stego, 0, 0, 128, 128), label: '涂黑 (0,0)-(128,128)' };
          }
        },
        {
          id: 'T9', name: 'T9 · 涂黑左半 50%（256×512）', expect: 'pass',
          degrade: function (c) {
            return { imageData: blackoutRect(c.stego, 0, 0, 256, 512), label: '涂黑左半 256×512' };
          }
        },
        {
          id: 'T10', name: 'T10 · 涂黑下半 50%（512×256）', expect: 'pass',
          degrade: function (c) {
            return { imageData: blackoutRect(c.stego, 0, 256, 512, 256), label: '涂黑下半 512×256' };
          }
        },
        {
          id: 'T11', name: 'T11 · 随机涂黑 50% 承载符号的 Tile', expect: 'pass',
          degrade: blackoutFractionCase(0.50)
        },
        {
          id: 'T12', name: 'T12 · 涂黑 55%（超过 50% 冗余边界，预期失败）', expect: 'fail',
          degrade: blackoutFractionCase(0.55)
        }
      ]
    },
    {
      id: 'crop',
      name: '裁切',
      tests: [
        {
          id: 'T13', name: 'T13 · 裁掉右半边（512×512 → 256×512）', expect: 'pass',
          degrade: function (c) {
            var img = cropImage(c.stego, 0, 0, 256, 512);
            return { imageData: img, label: '裁后 ' + img.width + '×' + img.height };
          }
        },
        {
          id: 'T14', name: 'T14 · 裁掉下半边（512×512 → 512×256）', expect: 'pass',
          degrade: function (c) {
            var img = cropImage(c.stego, 0, 0, 512, 256);
            return { imageData: img, label: '裁后 ' + img.width + '×' + img.height };
          }
        },
        {
          id: 'T15', name: 'T15 · 裁掉右边 25%（512×512 → 384×512）', expect: 'pass',
          degrade: function (c) {
            var img = cropImage(c.stego, 0, 0, 384, 512);
            return { imageData: img, label: '裁后 ' + img.width + '×' + img.height };
          }
        },
        {
          id: 'T16', name: 'T16 · 四边各裁 32 像素（512×512 → 448×448）', expect: 'pass',
          degrade: function (c) {
            var img = cropImage(c.stego, 32, 32, 448, 448);
            return {
              imageData: img,
              label: '裁后 ' + img.width + '×' + img.height + '（偏移 32px，非 64 的整数倍）'
            };
          }
        }
      ]
    },
    {
      id: 'watermark',
      name: '水印',
      tests: [
        {
          id: 'T17', name: 'T17 · 全图半透明白水印 alpha=0.15', expect: 'pass',
          degrade: function (c) {
            return { imageData: overlayWhite(c.stego, 0.15), label: '全图白色叠加 alpha=0.15' };
          }
        },
        {
          id: 'T18', name: 'T18 · 全图半透明白水印 alpha=0.30', expect: 'pass',
          degrade: function (c) {
            return { imageData: overlayWhite(c.stego, 0.30), label: '全图白色叠加 alpha=0.30' };
          }
        },
        {
          id: 'T19', name: 'T19 · 右下角局部水印 128×128 alpha=0.5', expect: 'pass',
          degrade: function (c) {
            var img = watermarkRect(c.stego, 384, 384, 128, 128, 0.5);
            return { imageData: img, label: '局部水印 (384,384)-(512,512) alpha=0.5' };
          }
        },
        {
          id: 'T20', name: 'T20 · 右下角文字水印 "TEST" alpha=0.6', expect: 'pass',
          degrade: function (c) {
            var img = watermarkText(c.stego, 'TEST', 340, 420, 0.6);
            return { imageData: img, label: '文字水印 TEST (340,420) alpha=0.6' };
          }
        }
      ]
    },
    {
      id: 'capacity',
      name: '容量（JPEG 秘密图 / 冗余档位 / 自动缩放）',
      tests: [
        {
          id: 'T21', name: 'T21 · 冗余档位 standard 端到端', expect: 'pass',
          embedOptions: { redundancy: 'standard' },
          degrade: function (c) { return { imageData: c.stego, label: '无退化，冗余=' + c.stats.redundancy + '（N=2K）' }; }
        },
        {
          id: 'T22', name: 'T22 · 冗余档位 balanced 端到端', expect: 'pass',
          embedOptions: { redundancy: 'balanced' },
          degrade: function (c) { return { imageData: c.stego, label: '无退化，冗余=' + c.stats.redundancy + '（N=1.5K）' }; }
        },
        {
          id: 'T23', name: 'T23 · 冗余档位 compact 端到端', expect: 'pass',
          embedOptions: { redundancy: 'compact' },
          degrade: function (c) { return { imageData: c.stego, label: '无退化，冗余=' + c.stats.redundancy + '（N=1.25K）' }; }
        },
        {
          id: 'T24', name: 'T24 · 自动缩放：512×512 载体 + 512×512 秘密图', expect: 'pass',
          embedOptions: { redundancy: 'compact' },
          makeSecret: function () { return makePhotoLikeSecret(512, 4001, false); },
          degrade: function (c) {
            var s = c.stats;
            var note = s.secretAutoResized
              ? ('已自动从 ' + s.secretOriginalSize.W + '×' + s.secretOriginalSize.H +
                 ' 缩到 ' + s.secretFinalSize.W + '×' + s.secretFinalSize.H)
              : '未触发缩放';
            return { imageData: c.stego, label: note + '，JPEG ' + s.secretJpegBytes + ' 字节' };
          }
        },
        {
          id: 'T25', name: 'T25 · 大载体 + 512×512 灰度 JPEG（容量倍数验证）', expect: 'pass',
          carrierSize: 1024,
          embedOptions: { redundancy: 'standard' },
          makeSecret: function () { return makePhotoLikeSecret(512, 4002, false); },
          degrade: function (c) {
            var s = c.stats;
            var raw = 512 * 512;
            var ratio = s.secretJpegBytes / raw;
            return {
              imageData: c.stego,
              label: '秘密图 JPEG ' + s.secretJpegBytes + ' 字节（原始 8bit 需 ' + raw +
                ' 字节，压缩率 ' + (ratio * 100).toFixed(1) + '%），K=' + s.K + '，最终 ' +
                s.secretFinalSize.W + '×' + s.secretFinalSize.H
            };
          }
        }
      ]
    },
    {
      id: 'resync',
      name: '几何重同步（相位搜索 / 尺度标尺）',
      tests: [
        {
          id: 'T26', name: 'T26 · 放大 1.25 倍（512→640）', expect: 'pass',
          makeCarrier: photoCarrier, embedOptions: LOW_FREQ_OPTS, degrade: scaleCase(1.25)
        },
        {
          id: 'T27', name: 'T27 · 缩放 0.5 倍 + 右下 25% 涂黑（组合退化）', expect: 'pass',
          makeCarrier: photoCarrier, embedOptions: LOW_FREQ_OPTS,
          degrade: function (c) {
            var scaled = scaleImage(c.stego, 0.5);
            var out = cloneImageData(scaled);
            blackenRects(out, [{
              x: Math.floor(out.width / 2), y: Math.floor(out.height / 2),
              width: Math.floor(out.width / 2), height: Math.floor(out.height / 2)
            }]);
            return { imageData: out, label: '缩放 ×0.5 → ' + out.width + '×' + out.height + '，再涂黑右下 25%' };
          }
        },
        {
          id: 'T28', name: 'T28 · 裁切偏移 16px（四边各裁 16）', expect: 'pass',
          degrade: function (c) {
            var img = cropImageData(c.stego, 16, 16, c.stego.width - 32, c.stego.height - 32);
            return { imageData: img, label: '裁后 ' + img.width + '×' + img.height + '（偏移 16px）' };
          }
        },
        {
          id: 'T29', name: 'T29 · 裁切偏移 8px（四边各裁 8）', expect: 'pass',
          degrade: function (c) {
            var img = cropImageData(c.stego, 8, 8, c.stego.width - 16, c.stego.height - 16);
            return { imageData: img, label: '裁后 ' + img.width + '×' + img.height + '（偏移 8px）' };
          }
        },
        {
          id: 'T30', name: 'T30 · 标尺独立测试：只嵌标尺 + 缩放 0.75x', expect: 'pass',
          custom: function (ctx) {
            var GC = global.GeoCalibration;
            if (!GC) return { pass: false, detail: '缺少 GeoCalibration' };
            var marked = GC.embedScale(ctx.carrier, ctx.carrier.width, ctx.carrier.height);
            var scaled = scaleImage(marked, 0.75);
            var got = GC.extractScale(scaled);
            return {
              pass: !!got && got.width === ctx.carrier.width && got.height === ctx.carrier.height,
              detail: '只嵌标尺 → 缩放到 ' + scaled.width + '×' + scaled.height + ' → 读回 ' +
                (got ? got.width + '×' + got.height : 'null') +
                '（期望 ' + ctx.carrier.width + '×' + ctx.carrier.height + '）'
            };
          }
        },
        {
          id: 'T31', name: 'T31 · 标尺 JPEG q=0.75 后读回尺寸', expect: 'pass',
          custom: function (ctx) {
            var GC = global.GeoCalibration;
            if (!GC) return { pass: false, detail: '缺少 GeoCalibration' };
            var marked = GC.embedScale(ctx.carrier, ctx.carrier.width, ctx.carrier.height);
            return jpegRoundTrip(marked, 0.75).then(function (img) {
              var got = GC.extractScale(img);
              return {
                pass: !!got && got.width === ctx.carrier.width && got.height === ctx.carrier.height,
                detail: '只嵌标尺 → JPEG q=0.75 → 读回 ' + (got ? got.width + '×' + got.height : 'null') +
                  '（期望 ' + ctx.carrier.width + '×' + ctx.carrier.height + '）'
              };
            });
          }
        },
        {
          id: 'T32', name: 'T32 · 未隐写图提取：不应卡在相位搜索（<2s）', expect: 'pass',
          custom: function (ctx, SC) {
            var plain = makeCarrier(ctx.carrier.width);
            var t0 = now();
            var res = SC.extractSecret(plain);
            var dt = now() - t0;
            return {
              pass: res.success === false && dt < 2000,
              detail: '未隐写图：success=' + res.success + '，recoveryPath=' + res.recoveryPath +
                '，耗时 ' + dt.toFixed(0) + ' ms（要求 < 2000ms）'
            };
          }
        },
        {
          id: 'T33', name: 'T33 · 标尺干扰对消：图案契约 + 对消后 PSNR > 45 dB', expect: 'pass',
          custom: function (ctx, SC) {
            var GC = global.GeoCalibration;
            if (!GC || typeof GC.generateScalePattern !== 'function' ||
                typeof GC.removeScale !== 'function') {
              return { pass: false, detail: '缺少 GeoCalibration.generateScalePattern / removeScale' };
            }
            var w = ctx.carrier.width, h = ctx.carrier.height;
            var amp = (GC.CONST && GC.CONST.PILOT_AMP) || 1.2;
            var pat = GC.generateScalePattern(w, h, amp);
            var patOk = (pat instanceof Float32Array) && pat.length === w * h;
            // 参考真值：不带标尺的隐写图（对消的目标就是"把它还原回来"）
            var noRuler = SC.embedSecret(ctx.carrier, ctx.secret, { embedScale: false }).outputImageData;
            var marked = GC.embedScale(noRuler, w, h);
            var before = cloneImageData(marked);
            var cancelled = GC.removeScale(marked, w, h);
            var untouched = sameBytes(marked, before);
            var fresh = cancelled !== marked && cancelled.width === w && cancelled.height === h;
            var psnr = GC.psnr(cancelled, noRuler);
            var alpha = GC.lastAlpha;
            return {
              pass: patOk && untouched && fresh && psnr > 45 && alpha > 0.7 && alpha <= 1.15,
              detail: '图案=Float32Array(' + pat.length + '/' + (w * h) + ')；入参未被修改=' + untouched +
                '；返回新对象=' + fresh + '；alpha=' + (alpha === undefined ? 'n/a' : alpha.toFixed(3)) +
                '；对消后 PSNR=' + (isFinite(psnr) ? psnr.toFixed(1) : psnr) +
                ' dB（相对"无标尺隐写图"，要求 > 45）'
            };
          }
        },
        {
          id: 'T34', name: 'T34 · 低频回退模式（4 对）：无退化逐 Tile CRC 通过率 100%', expect: 'pass',
          custom: function (ctx, SC) {
            var m4 = mode4();
            if (!m4) return { pass: false, detail: '缺少 StegoCore.CONST.MODE_4' };
            var st = SC.embedSecret(photoCarrier(), makeSecret(), LOW_FREQ_OPTS);
            var res = SC.extractSecret(st.outputImageData);
            var r = tileCrcRate(st.outputImageData, m4.pairs, m4.bitsPerTile, st.stats.N);
            if (!r) return { pass: false, detail: '缺少 DctStego / Packet / ImageUtils' };
            return {
              pass: r.rate === 1 && res.success && res.mode === 'mode4' &&
                payloadMatches(res, st.stats),
              detail: '4 对模式 K=' + st.stats.K + '/N=' + st.stats.N +
                '（symbol=' + st.stats.symbolSize + 'B）；逐 Tile CRC ' + r.pass + '/' + r.total +
                ' = ' + (r.rate * 100).toFixed(1) + '%（要求 100%）；端到端 success=' + res.success +
                ', mode=' + res.mode + ', recoveryPath=' + res.recoveryPath
            };
          }
        },
        {
          id: 'T35', name: 'T35 · 低频模式 + 缩放 0.5 倍：逐 Tile CRC 通过率 >= 70%', expect: 'pass',
          custom: function (ctx, SC) {
            var GC = global.GeoCalibration, m4 = mode4();
            if (!m4 || !GC) return { pass: false, detail: '缺少 MODE_4 / GeoCalibration' };
            var carrier = photoCarrier();
            var w = carrier.width, h = carrier.height;
            var st = SC.embedSecret(carrier, makeSecret(), LOW_FREQ_OPTS);
            var down = scaleImage(st.outputImageData, 0.5);
            var res = SC.extractSecret(down);
            var restored = resizeToSize(down, w, h);
            var cancelled = GC.removeScale(restored, w, h);
            var r = tileCrcRate(cancelled, m4.pairs, m4.bitsPerTile, st.stats.N);
            if (!r) return { pass: false, detail: '缺少 DctStego / Packet / ImageUtils' };
            return {
              pass: res.success && r.rate >= 0.7,
              detail: '缩放 ×0.5 → ' + down.width + '×' + down.height + '，标尺还原 ' + w + '×' + h +
                '，alpha=' + GC.lastAlpha.toFixed(3) + '；逐 Tile CRC ' + r.pass + '/' + r.total +
                ' = ' + (r.rate * 100).toFixed(1) + '%（要求 >= 70%，K=' + st.stats.K + '）；' +
                '端到端 success=' + res.success + ', path=' + res.recoveryPath + ', mode=' + res.mode
            };
          }
        },
        {
          id: 'T36', name: 'T36 · 低频模式 + 缩放 0.75 倍 + 干扰对消：逐 Tile CRC 通过率 >= 90%', expect: 'pass',
          custom: function (ctx, SC) {
            var GC = global.GeoCalibration, m4 = mode4();
            if (!m4 || !GC) return { pass: false, detail: '缺少 MODE_4 / GeoCalibration' };
            var carrier = photoCarrier();
            var w = carrier.width, h = carrier.height;
            var st = SC.embedSecret(carrier, makeSecret(), LOW_FREQ_OPTS);
            var down = scaleImage(st.outputImageData, 0.75);
            var res = SC.extractSecret(down);
            var restored = resizeToSize(down, w, h);
            var beforeRate = tileCrcRate(restored, m4.pairs, m4.bitsPerTile, st.stats.N);
            var cancelled = GC.removeScale(restored, w, h);
            var r = tileCrcRate(cancelled, m4.pairs, m4.bitsPerTile, st.stats.N);
            if (!r || !beforeRate) return { pass: false, detail: '缺少 DctStego / Packet / ImageUtils' };
            return {
              pass: res.success && r.rate >= 0.9,
              detail: '缩放 ×0.75 → ' + down.width + '×' + down.height + '，标尺还原 ' + w + '×' + h +
                '，alpha=' + GC.lastAlpha.toFixed(3) + '；对消前 CRC ' + beforeRate.pass + '/' +
                beforeRate.total + '（' + (beforeRate.rate * 100).toFixed(1) + '%）→ 对消后 ' +
                r.pass + '/' + r.total + '（' + (r.rate * 100).toFixed(1) + '%，要求 >= 90%）' +
                '；端到端 success=' + res.success + ', path=' + res.recoveryPath + ', mode=' + res.mode
            };
          }
        }
      ]
    }
  ];

  function allTests() {
    var list = [];
    for (var g = 0; g < GROUPS.length; g++) {
      for (var t = 0; t < GROUPS[g].tests.length; t++) {
        list.push({ group: GROUPS[g], test: GROUPS[g].tests[t] });
      }
    }
    return list;
  }

  function groupById(groupId) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].id === groupId) return GROUPS[i];
    }
    return null;
  }

  // ============================================================
  // 单测试执行（步骤 ①~⑥）
  // ============================================================
  function executeTest(item) {
    var SC = global.StegoCore;
    if (!SC) throw new Error('缺少 StegoCore，请确认已加载 js/stego-core.js');
    var test = item.test;

    // ①②③ 素材 + 嵌入
    var carrier = test.makeCarrier ? test.makeCarrier() : makeCarrier(test.carrierSize || CARRIER_SIZE);
    var secret = test.makeSecret ? test.makeSecret() : makeSecret();
    var embedded = SC.embedSecret(carrier, secret, test.embedOptions || {});
    var ctx = {
      carrier: carrier,
      secret: secret,
      stego: embedded.outputImageData,
      stats: embedded.stats
    };

    // 自定义用例（例如"只嵌标尺"、纯响应时间测量）自己完成判定
    if (typeof test.custom === 'function') {
      return Promise.resolve(test.custom(ctx, SC)).then(function (r) {
        var pass = (test.expect === 'any') ? true : !!r.pass;
        return {
          name: test.name, id: test.id, group: item.group.id,
          expect: test.expect || 'pass', pass: pass, elapsedMs: 0, detail: r.detail || ''
        };
      });
    }

    // ④ 退化 → ⑤ 提取 → ⑥ 判定
    return Promise.resolve(test.degrade(ctx)).then(function (degraded) {
      var imageData = degraded && degraded.imageData ? degraded.imageData : degraded;
      var label = (degraded && degraded.label) ? degraded.label : '';
      var res = SC.extractSecret(imageData);
      var matched = payloadMatches(res, ctx.stats);
      var pass;
      if (test.expect === 'fail') pass = !matched;
      else if (test.expect === 'any') pass = true;
      else pass = matched;

      return verifyDecode(res, matched).then(function (decodeInfo) {
        var detail = '有效 Tile=' + res.validTiles + '/' + res.totalTiles +
          ', K_effective=' + res.K_effective +
          ', 提取' + (res.success ? '成功' : '失败') +
          ', 载荷一致=' + matched +
          ', ' + decodeInfo +
          (label ? '；' + label : '') +
          (test.expect === 'any' ? '；压力测试不设预期，实际' + (matched ? '成功' : '失败') : '') +
          (ctx.stats.secretJpegBytes ? '；载荷 ' + ctx.stats.secretJpegBytes + 'B/K=' + ctx.stats.K +
            '/N=' + ctx.stats.N : '');
        return {
          name: test.name,
          id: test.id,
          group: item.group.id,
          expect: test.expect || 'pass',
          pass: pass,
          elapsedMs: 0,
          detail: detail
        };
      });
    });
  }

  /** 顺序执行测试列表；每个测试完成立即回调 onResult，异常记为 FAIL 不中断 */
  function runList(list, onProgress, onResult) {
    var results = [];
    var i = 0;

    function step() {
      if (i >= list.length) return Promise.resolve(results);
      var item = list[i];
      var index = i + 1;
      if (typeof onProgress === 'function') {
        onProgress(index, list.length, item.test.name);
      }
      var t0 = now();
      return Promise.resolve()
        .then(function () { return executeTest(item); })
        .catch(function (err) {
          return {
            name: item.test.name,
            id: item.test.id,
            group: item.group.id,
            expect: item.test.expect || 'pass',
            pass: false,
            elapsedMs: 0,
            detail: '执行异常：' + (err && err.message ? err.message : String(err)),
            errorMsg: err && err.message ? err.message : String(err)
          };
        })
        .then(function (result) {
          result.elapsedMs = Math.round((now() - t0) * 10) / 10;
          results.push(result);
          if (typeof onResult === 'function') onResult(result);
          i++;
          return step();
        });
    }
    return step();
  }

  // ============================================================
  // 对外命名空间
  // ============================================================
  var TestSuite = {};

  TestSuite.TEST_GROUPS = GROUPS;

  /**
   * 跑全部 20 个测试。
   * @param {(currentIndex:number, totalCount:number, testName:string)=>void} [onProgress]
   * @param {(result:object)=>void} [onResult]
   * @returns {Promise<Array<{name:string, pass:boolean, elapsedMs:number, detail:string, errorMsg?:string}>>}
   */
  TestSuite.runAll = function (onProgress, onResult) {
    return runList(allTests(), onProgress, onResult);
  };

  /**
   * 只跑某一组。
   * @param {'baseline'|'blackout'|'crop'|'watermark'} groupId
   */
  TestSuite.runGroup = function (groupId, onProgress, onResult) {
    var group = groupById(groupId);
    if (!group) {
      throw new RangeError("runGroup: 未知分组 '" + groupId +
        "'，可选值为 baseline / blackout / crop / watermark / capacity");
    }
    var list = group.tests.map(function (t) { return { group: group, test: t }; });
    return runList(list, onProgress, onResult);
  };

  // ---- 附加常量（便于测试与页面统计，不属于函数契约的一部分）----
  TestSuite.CONST = {
    CARRIER_SIZE: CARRIER_SIZE,
    SECRET_SIZE: SECRET_SIZE,
    TILE: TILE,
    SEED: SEED
  };

  global.TestSuite = TestSuite;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
