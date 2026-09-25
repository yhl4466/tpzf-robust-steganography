/**
 * image-utils.js —— 纯前端图片隐写工具：图像基础工具库
 * ---------------------------------------------------------------
 * 硬性约束（本项目全局约束，请勿破坏）：
 *   1. 零外部依赖：只使用原生 JS + 浏览器 Web API；
 *   2. 不使用 ES Module：没有 import / export，通过普通 script 标签引入，
 *      保证 file:// 双击本地打开即可运行；
 *   3. 所有工具函数挂载到全局命名空间 window.ImageUtils；
 *   4. 不使用任何构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * 设计要点：
 *   - 画布像素数据 (ImageData) 是 Uint8ClampedArray，天然会做 [0,255] 截断
 *     与四舍五入，但由于它采用「银行家舍入（round-half-to-even）」，
 *     为避免歧义，本文件在写入前统一用 Math.round 显式取整。
 *   - 所有浮点运算都做了 NaN / Infinity 防护，保证返回值为有限数。
 *
 * 接口一览（函数名与签名不可更改）：
 *   ImageUtils.loadImage(file)                        -> Promise<HTMLImageElement>
 *   ImageUtils.getImageData(image)                    -> ImageData
 *   ImageUtils.resizeImage(image, maxLongSide)        -> HTMLCanvasElement
 *   ImageUtils.imageDataToFloatArray(imageData)       -> Float32Array   (RGBA 归一化 0~1)
 *   ImageUtils.floatArrayToImageData(f, width, height)-> ImageData
 *   ImageUtils.splitIntoTiles(imageData, tileSize)    -> Tile[]
 *   ImageUtils.calculateTileVariance(tile)            -> number
 *   ImageUtils.filterTexturedTiles(tiles, threshold)  -> Tile[]
 *   ImageUtils.canvasToBlob(canvas, type, quality)    -> Promise<Blob>
 *   ImageUtils.downloadBlob(blob, filename)           -> void
 */
(function (global) {
  'use strict';

  // ============================================================
  // 内部辅助函数（不对外暴露）
  // ============================================================

  /** 是否为有限数字（过滤 NaN / Infinity / 字符串） */
  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** 数值裁剪到 [min, max] */
  function clamp(v, min, max) {
    if (!isFiniteNumber(v)) return min; // NaN / Infinity 一律当作下界，避免污染整张图
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  /**
   * 解析一个「图像类对象」的真实像素尺寸。
   * 兼容 HTMLImageElement(naturalWidth)、HTMLCanvasElement、ImageBitmap(宽高直接可用)。
   * 返回 { width, height }，无法解析时抛错。
   */
  function resolveSourceSize(source, fnName) {
    if (!source) {
      throw new TypeError(fnName + ': 图像对象为空');
    }
    var naturalW = source.naturalWidth, naturalH = source.naturalHeight;
    var w = (isFiniteNumber(naturalW) && naturalW > 0) ? naturalW : source.width;
    var h = (isFiniteNumber(naturalH) && naturalH > 0) ? naturalH : source.height;
    w = Math.floor(w);
    h = Math.floor(h);
    if (!isFiniteNumber(w) || !isFiniteNumber(h) || w <= 0 || h <= 0) {
      throw new Error(fnName + ': 图像宽高无效（宽=' + w + '，高=' + h + '），可能尚未加载完成');
    }
    return { width: w, height: h };
  }

  /** 创建一个指定尺寸的离屏 canvas */
  function createCanvas(width, height, fnName) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error((fnName || 'createCanvas') + ': 当前环境不支持 DOM，无法创建 canvas');
    }
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /** 取得 2D 上下文，失败时抛明确错误 */
  function get2dContext(canvas, fnName) {
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error((fnName || 'getContext') + ': 无法获取 2D 绘图上下文');
    }
    return ctx;
  }

  /**
   * 构造 ImageData。优先使用原生构造器（速度最快），
   * 若环境不支持则退化为 canvas.createImageData + set()。
   */
  function makeImageData(data, width, height) {
    if (typeof ImageData === 'function') {
      try {
        return new ImageData(data, width, height);
      } catch (e) {
        // 某些实现要求 data 必须是 Uint8ClampedArray，落到下面的降级分支
      }
    }
    var canvas = createCanvas(width, height, 'makeImageData');
    var ctx = get2dContext(canvas, 'makeImageData');
    var imgData = ctx.createImageData(width, height);
    imgData.data.set(data);
    return imgData;
  }

  /** dataURL(base64) 转 Blob，用于 canvas.toBlob 不可用时的降级方案 */
  function dataURLToBlob(dataURL) {
    var parts = String(dataURL).split(',');
    if (parts.length < 2) throw new Error('canvasToBlob: dataURL 格式非法');
    var meta = parts[0];
    var isBase64 = /;base64/i.test(meta);
    var mimeMatch = /data:([^;,]+)/i.exec(meta);
    var mime = mimeMatch ? mimeMatch[1] : 'image/png';
    var body = parts[1];
    var binary;
    if (isBase64) {
      if (typeof atob !== 'function') throw new Error('canvasToBlob: 当前环境不支持 atob，无法解码 dataURL');
      binary = atob(body);
    } else {
      binary = decodeURIComponent(body);
    }
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }
    return new Blob([bytes], { type: mime });
  }

  // ============================================================
  // 对外命名空间
  // ============================================================
  var ImageUtils = {};

  /**
   * 读取本地图片文件为 HTMLImageElement。
   *
   * 原理：File/Blob 不能直接给 img.src，需要先由浏览器分配一个临时对象 URL
   * （blob: 协议，同源，因此后续 drawImage 到 canvas 不会污染画布）。
   * 加载完成后立刻 revokeObjectURL 释放内存，避免内存泄漏。
   *
   * @param {File|Blob} file
   * @returns {Promise<HTMLImageElement>}
   */
  ImageUtils.loadImage = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new TypeError('loadImage: 需要传入 File 或 Blob 对象'));
        return;
      }
      if (typeof Image !== 'function') {
        reject(new Error('loadImage: 当前环境不支持 Image 构造器'));
        return;
      }
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        reject(new Error('loadImage: 当前环境不支持 URL.createObjectURL'));
        return;
      }

      var objectURL;
      try {
        objectURL = URL.createObjectURL(file);
      } catch (e) {
        reject(new Error('loadImage: 创建对象 URL 失败 —— ' + e.message));
        return;
      }

      var img = new Image();
      var settled = false;

      function release() {
        try {
          URL.revokeObjectURL(objectURL);
        } catch (e) {
          /* 释放失败不影响主流程 */
        }
      }

      img.onload = function () {
        if (settled) return;
        settled = true;
        // 图片已完成解码，对象 URL 使命结束，立即释放
        release();
        if (!img.naturalWidth || !img.naturalHeight) {
          reject(new Error('loadImage: 图片尺寸为 0，文件可能已损坏'));
          return;
        }
        resolve(img);
      };

      img.onerror = function () {
        if (settled) return;
        settled = true;
        release();
        reject(new Error('loadImage: 图片解码失败，请确认文件是有效的图片格式'));
      };

      img.src = objectURL;
    });
  };

  /**
   * 把任意可绘制对象（img / canvas / ImageBitmap）画到离屏 canvas 上，读回 ImageData。
   *
   * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} image
   * @returns {ImageData}
   */
  ImageUtils.getImageData = function (image) {
    var size = resolveSourceSize(image, 'getImageData');
    var canvas = createCanvas(size.width, size.height, 'getImageData');
    var ctx = get2dContext(canvas, 'getImageData');
    ctx.drawImage(image, 0, 0, size.width, size.height);
    // 注意：若 image 来自跨域资源，这里会抛 SecurityError（画布被污染）
    return ctx.getImageData(0, 0, size.width, size.height);
  };

  /**
   * 等比缩放图片，返回新的 canvas。
   * 长边不超过 maxLongSide；若原图长边本来就 <= maxLongSide，则按原尺寸导出（不放大）。
   *
   * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} image
   * @param {number} maxLongSide
   * @returns {HTMLCanvasElement}
   */
  ImageUtils.resizeImage = function (image, maxLongSide) {
    if (!isFiniteNumber(maxLongSide) || maxLongSide <= 0) {
      throw new RangeError('resizeImage: maxLongSide 必须是大于 0 的有限数值，当前为 ' + maxLongSide);
    }
    var size = resolveSourceSize(image, 'resizeImage');
    var longSide = Math.max(size.width, size.height);
    // scale <= 1：只缩小不放大，避免引入插值模糊
    var scale = longSide > maxLongSide ? (maxLongSide / longSide) : 1;
    var targetW = Math.max(1, Math.round(size.width * scale));
    var targetH = Math.max(1, Math.round(size.height * scale));

    var canvas = createCanvas(targetW, targetH, 'resizeImage');
    var ctx = get2dContext(canvas, 'resizeImage');
    // 高质量降采样：浏览器内部会做多级滤波，比手写最近邻更平滑
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) {
      ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(image, 0, 0, targetW, targetH);
    return canvas;
  };

  /**
   * ImageData -> Float32Array，RGBA 各通道除以 255 归一化到 0~1。
   * 不做通道分离，保持 [R,G,B,A, R,G,B,A, ...] 交错排列，长度 = width*height*4。
   *
   * @param {ImageData} imageData
   * @returns {Float32Array}
   */
  ImageUtils.imageDataToFloatArray = function (imageData) {
    if (!imageData || !imageData.data || typeof imageData.data.length !== 'number') {
      throw new TypeError('imageDataToFloatArray: 需要传入有效的 ImageData');
    }
    var src = imageData.data;
    var len = src.length;
    var out = new Float32Array(len); // 长度为 0 时返回空数组，属于合理空值
    for (var i = 0; i < len; i++) {
      // Uint8ClampedArray 的元素必然是 0~255 的整数，除法不会产生 NaN
      out[i] = src[i] / 255;
    }
    return out;
  };

  /**
   * Float32Array -> ImageData。
   *
   * 语义（固定，不做尺度猜测）：输入一律视为「已归一化到 0~1 的 RGBA」，
   *   byte = Math.round(clamp(v, 0, 1) * 255)
   * 即超出 [0,1] 的值先被 clamp 到 0 或 1，再乘 255 取整，
   * 因此 1.5 → 255、-3 → 0，绝不会出现溢出或整图变黑/变白。
   * NaN / ±Infinity 统一按 0 处理，绝不写出 NaN。
   *
   * 这是 imageDataToFloatArray 的严格逆运算（往返误差 0）。
   *
   * @param {Float32Array|Array|number[]} floatArray
   * @param {number} width
   * @param {number} height
   * @returns {ImageData}
   */
  ImageUtils.floatArrayToImageData = function (floatArray, width, height) {
    if (!floatArray || typeof floatArray.length !== 'number') {
      throw new TypeError('floatArrayToImageData: 需要传入类数组（Float32Array / Array）');
    }
    if (!isFiniteNumber(width) || !isFiniteNumber(height) ||
        width <= 0 || height <= 0 ||
        Math.floor(width) !== width || Math.floor(height) !== height) {
      throw new RangeError('floatArrayToImageData: width / height 必须是大于 0 的整数，当前为 ' +
        width + ' x ' + height);
    }

    var w = width, h = height;
    var need = w * h * 4;
    if (floatArray.length < need) {
      throw new RangeError('floatArrayToImageData: 数据长度不足，需要 ' + need +
        ' 个元素（' + w + 'x' + h + 'x4），实际只有 ' + floatArray.length);
    }

    var bytes = new Uint8ClampedArray(need);
    for (var i = 0; i < need; i++) {
      var v = floatArray[i];
      if (!isFiniteNumber(v)) v = 0; // NaN / Infinity 防护
      // 固定归一化语义：先 clamp 到 [0,1]，再 ×255 取整
      bytes[i] = Math.round(clamp(v, 0, 1) * 255);
    }
    return makeImageData(bytes, w, h);
  };

  /**
   * 把一张 ImageData 切成 tileSize x tileSize 的方块（Tile 网格）。
   *
   * 布局规则：
   *   - 遍历顺序为「y 外 x 内」（先行后列），与普通图像扫描顺序一致；
   *   - 边界处不足 tileSize 的 Tile 保留实际宽高，不补零
   *     （补零会凭空引入 0 亮度像素，严重污染方差计算）；
   *   - 每个 Tile 独立创建一个与其同尺寸的 canvas，把该区域的像素拷进去后
   *     用 getImageData 读回，因此 tile.data 是「局部坐标」的 ImageData，
   *     其 width/height 等于 tile.width/tile.height。
   *
   * @param {ImageData} imageData
   * @param {number} [tileSize=64]
   * @returns {Array<{x:number,y:number,width:number,height:number,data:ImageData}>}
   */
  ImageUtils.splitIntoTiles = function (imageData, tileSize) {
    if (!imageData || !imageData.data || typeof imageData.data.length !== 'number') {
      throw new TypeError('splitIntoTiles: 需要传入有效的 ImageData');
    }
    if (tileSize === undefined || tileSize === null) tileSize = 64;
    if (!isFiniteNumber(tileSize) || tileSize <= 0) {
      throw new RangeError('splitIntoTiles: tileSize 必须是大于 0 的有限数值，当前为 ' + tileSize);
    }
    tileSize = Math.floor(tileSize);
    if (tileSize < 1) {
      throw new RangeError('splitIntoTiles: tileSize 取整后必须 >= 1');
    }

    var W = Math.floor(imageData.width) || 0;
    var H = Math.floor(imageData.height) || 0;
    var tiles = [];

    // 宽或高为 0：没有可切的像素，返回空数组（合理空值）
    if (W <= 0 || H <= 0) return tiles;

    var src = imageData.data;
    var srcLen = src.length;

    for (var y = 0; y < H; y += tileSize) {
      var th = Math.min(tileSize, H - y); // 边界行高
      for (var x = 0; x < W; x += tileSize) {
        var tw = Math.min(tileSize, W - x); // 边界列宽

        // —— 每个 Tile 一个独立 canvas ——
        var canvas = createCanvas(tw, th, 'splitIntoTiles');
        var ctx = get2dContext(canvas, 'splitIntoTiles');

        // 先把源图对应矩形区域的像素按行拷贝到临时 ImageData
        var region = ctx.createImageData(tw, th);
        var dst = region.data;
        for (var ry = 0; ry < th; ry++) {
          var srcRow = ((y + ry) * W + x) * 4;
          var dstRow = ry * tw * 4;
          for (var c = 0; c < tw * 4; c++) {
            var si = srcRow + c;
            var di = dstRow + c;
            // 源数据可能被截断，越界读到的 undefined 会被 Uint8ClampedArray 归零
            dst[di] = si < srcLen ? src[si] : 0;
          }
        }

        ctx.putImageData(region, 0, 0);
        var tileData = ctx.getImageData(0, 0, tw, th);

        tiles.push({
          x: x,
          y: y,
          width: tw,
          height: th,
          data: tileData
        });
      }
    }
    return tiles;
  };

  /**
   * 计算单个 Tile 的亮度方差（纹理丰富度指标）。
   *
   * 原理：隐写/抗干扰场景下，纹理越复杂的区域（高方差）越适合嵌入信息，
   * 因为人眼对平坦区域的扰动更敏感。
   *   亮度 lum = (R + G + B) / 3        （忽略 alpha，透明通道不携带视觉亮度）
   *   方差 Var = Σ(lum_i - mean)² / N    （总体方差，除以 N 而不是 N-1）
   *
   * 数值稳定性说明（很重要）：
   *   1) 不用「E[x²] - E[x]²」的一次遍历公式，它会带来灾难性抵消（catastrophic
   *      cancellation），大图上方差甚至可能算出负数；
   *   2) 均值也不直接累加小数 lum，而是先累加整数亮度和 s = R+G+B（精确整数，
   *      在 2^53 内无误差），再除以 N 得到 meanS = S/N —— 这样对纯色 Tile 有
   *      meanS 恰好等于每个像素的 s（(s*N)/N 在 IEEE-754 下精确还原），
   *      于是偏差恒为 0，方差严格等于 0，而不是浮点残差 1e-20；
   *   3) 最后用 Var = Σ(s_i - meanS)² / (9N) 还原（因为 lum = s/3，
   *      提出 1/9 因子可全程避免除法误差累积）。
   *
   * @param {{width:number,height:number,data:ImageData}} tile
   * @returns {number} 方差，永远返回有限非负数
   */
  ImageUtils.calculateTileVariance = function (tile) {
    if (!tile || !tile.data || !tile.data.data) {
      throw new TypeError('calculateTileVariance: 需要传入有效的 Tile（含 data: ImageData）');
    }
    var d = tile.data.data;
    var w = Math.floor(isFiniteNumber(tile.width) ? tile.width : tile.data.width) || 0;
    var h = Math.floor(isFiniteNumber(tile.height) ? tile.height : tile.data.height) || 0;
    var n = w * h;
    if (n <= 0 || d.length < n * 4) {
      // 尺寸信息缺失或数据不完整时，按可用像素数计算
      n = Math.floor(d.length / 4);
    }
    if (n <= 0) return 0; // 空 Tile：方差定义为 0

    // 第一遍：累加整数亮度和 S = Σ(R+G+B)
    var S = 0;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      var r = d[o], g = d[o + 1], b = d[o + 2];
      if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b)) continue; // 双保险
      S += r + g + b;
    }
    if (!isFiniteNumber(S)) return 0;
    var meanS = S / n; // 亮度均值的 3 倍
    if (!isFiniteNumber(meanS)) return 0;

    // 第二遍：累加 (3*lum - 3*mean)²，即 (s_i - meanS)²
    var acc = 0;
    for (var j = 0; j < n; j++) {
      var p = j * 4;
      var r2 = d[p], g2 = d[p + 1], b2 = d[p + 2];
      if (!isFiniteNumber(r2) || !isFiniteNumber(g2) || !isFiniteNumber(b2)) continue;
      var diff = (r2 + g2 + b2) - meanS;
      acc += diff * diff;
    }

    // lum 的偏差 = diff/3，故方差 = acc / (9 * n)
    var variance = acc / (9 * n);
    if (!isFiniteNumber(variance) || variance < 0) return 0; // 防御性：绝不给负数
    return variance;
  };

  /**
   * 过滤出纹理丰富的 Tile：保留方差 >= threshold 的 Tile。
   * 阈值非有限数时按 0 处理（等价于全部保留）；tiles 不是数组时返回空数组。
   *
   * @param {Array} tiles
   * @param {number} threshold
   * @returns {Array} 原数组元素的子集（不复制 Tile 对象）
   */
  ImageUtils.filterTexturedTiles = function (tiles, threshold) {
    if (!Array.isArray(tiles)) return [];
    var th = isFiniteNumber(threshold) ? threshold : 0;
    var out = [];
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (!tile) continue;
      var variance;
      try {
        variance = ImageUtils.calculateTileVariance(tile);
      } catch (e) {
        continue; // 非法 Tile 直接跳过，不打断整体流程
      }
      if (variance >= th) out.push(tile);
    }
    return out;
  };

  /**
   * canvas 导出为 Blob（异步）。
   * 优先使用 canvas.toBlob；不支持时退化为 toDataURL + 手工 base64 解码。
   * 注意：若画布被跨域图片污染（tainted），浏览器会抛 SecurityError，此处统一转成 reject。
   *
   * @param {HTMLCanvasElement} canvas
   * @param {string} [type='image/png']
   * @param {number} [quality=0.92]
   * @returns {Promise<Blob>}
   */
  ImageUtils.canvasToBlob = function (canvas, type, quality) {
    if (type === undefined || type === null) type = 'image/png';
    if (quality === undefined || quality === null) quality = 0.92;

    return new Promise(function (resolve, reject) {
      if (!canvas) {
        reject(new TypeError('canvasToBlob: canvas 为空'));
        return;
      }

      if (typeof canvas.toBlob === 'function') {
        try {
          // PNG 是无损格式，quality 对它无意义，仅对 jpeg/webp 传参
          var isLossless = /png$/i.test(type);
          var cb = function (blob) {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('canvasToBlob: 导出失败，画布可能为 0 尺寸或被跨域内容污染'));
            }
          };
          if (isLossless) {
            canvas.toBlob(cb, type);
          } else {
            canvas.toBlob(cb, type, quality);
          }
        } catch (e) {
          reject(new Error('canvasToBlob: ' + e.message));
        }
        return;
      }

      // 降级方案
      if (typeof canvas.toDataURL === 'function') {
        try {
          var dataURL = canvas.toDataURL(type, quality);
          resolve(dataURLToBlob(dataURL));
        } catch (e2) {
          reject(new Error('canvasToBlob: ' + e2.message));
        }
        return;
      }

      // 区分两类失败：长得像 canvas 但环境不支持导出 vs 根本不是 canvas
      var looksLikeCanvas = typeof canvas.getContext === 'function' ||
        (typeof canvas.width === 'number' && typeof canvas.height === 'number');
      if (looksLikeCanvas) {
        reject(new Error('canvasToBlob: 当前环境不支持 canvas 导出（缺少 toBlob / toDataURL）'));
      } else {
        reject(new TypeError('canvasToBlob: 传入对象不是 canvas'));
      }
    });
  };

  /**
   * 触发浏览器下载。
   * 原理：把 Blob 变成 blob: URL，挂到一个带 download 属性的 <a> 上并模拟点击。
   * 对象 URL 不能立即 revoke（部分浏览器会取消正在进行的下载），因此延迟释放。
   *
   * @param {Blob} blob
   * @param {string} filename
   * @returns {void}
   */
  ImageUtils.downloadBlob = function (blob, filename) {
    if (!blob || typeof blob.size !== 'number') {
      throw new TypeError('downloadBlob: 需要传入有效的 Blob');
    }
    if (typeof document === 'undefined' || typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function') {
      throw new Error('downloadBlob: 当前环境不支持文件下载（缺少 DOM / URL API）');
    }
    var name = filename || ('download-' + Date.now());
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    (document.body || document.documentElement).removeChild(a);
    // 延迟释放，确保下载已开始
    setTimeout(function () {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* 忽略 */
      }
    }, 2000);
  };

  // 暴露到全局命名空间：浏览器为 window，测试环境退化为 globalThis
  global.ImageUtils = ImageUtils;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
