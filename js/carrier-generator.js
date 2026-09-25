/**
 * carrier-generator.js —— 自动生成"适合做载体"的图片（window.CarrierGenerator）
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致）：
 *   1. 零外部依赖：只用原生 JS；
 *   2. 不使用 ES Module：没有 import / export，普通 script 标签引入，
 *      file:// 双击本地打开即可运行；
 *   3. 挂载到全局命名空间 window.CarrierGenerator（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * ============================ 为什么需要它 ============================
 * 本工具的嵌入强度来自"每个 8×8 块的纹理方差"（dct-stego 的 adaptiveMargin），
 * 可用承载块来自"每个 64×64 区块的方差 ≥ 60"。普通用户挑图时只看"图大不大、
 * 好不好看"，很容易选到"天空/水面为主"的风光照：这种图 64×64 方差或许达标，
 * 但每个 8×8 小块内部几乎是平的，margin 落到下限 8~10 —— 实测这类块过一遍
 * JPEG q=0.80 存活率为 0（见 tests/diag-clamp-loss.node.js）。
 * 自动生成器从源头把"纹理"这件事做对：整幅图按分形噪声铺设，并逐块保证
 * 8×8 最小 margin，再叠加轻微噪声让它看起来像真实材质。
 *
 * ============================ 生成流水线 ============================
 *   ① fBm（分数布朗运动）铺底：5 个八度的值噪声叠加，lacunarity = 2.0、gain = 0.5，
 *      最低频晶格间距 64 像素 —— 这样每个 64×64 区块内都必然含有跨尺度的变化；
 *   ② 色板映射：每种风格一条**亮度单调**的渐变 LUT（256 级），
 *      既保证"暗 → 亮"的方向一致，也把输出亮度压在 [40, 215] 内 ——
 *      贴近 0/255 的像素会被 clamp 削掉幅度，实测标称 margin 12.5 的块会掉回 8.0；
 *   ③ 逐块 margin 保底：对每个 8×8 块先量出它的亮度方差，再按差额补一层白噪声，
 *      差额小的块几乎不加、差额大的块多加（自适应），使每个块的 margin 都 ≥ 目标值；
 *   ④ 叠一层 ±1.5 的整体细噪声，消除"纯数学噪声"的塑料感；
 *   ⑤ 生成后**实测**自检：重新按 dct-stego 的口径统计全部 8×8 块的 margin、
 *      以及 64×64 纹理块占比；不达标就加大扰动幅度重试（最多 3 次）。
 *
 * ============================ 为什么补的是白噪声 ============================
 * 补噪声的目的是抬高"块的亮度方差"，而载波用的系数对位于中低频，白噪声的
 * 能量在各频率上均匀分布，因此对上文列出的 6 对系数一视同仁地抬高裕量；
 * 若改用周期性图案（例如棋盘、条纹）补方差，虽然同样能抬高方差，却会在频谱上
 * 留下尖峰，既可能被误认成标尺导频，也会让肉眼看到规则纹理。
 */
(function (global) {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  var DEFAULT_WIDTH = 1024;
  var DEFAULT_HEIGHT = 1024;
  var DEFAULT_STYLE = 'abstract';
  var MAX_DIM = 4096;              // 与 stego-core 的画像上限一致

  // fBm 参数（标准取值）
  var OCTAVES = 5;
  var LACUNARITY = 2.0;            // 每层频率翻倍
  var GAIN = 0.5;                  // 每层振幅减半
  var BASE_PERIOD = 64;            // 最低频层的晶格间距（像素）：保证 64×64 区块内有变化

  // margin 与 dct-stego.adaptiveMargin 同口径：margin = clamp(min + gain*√variance, min, max)
  var MARGIN_MIN = 8, MARGIN_GAIN = 1.0, MARGIN_MAX = 32;
  var MARGIN_SAFE = 12;            // 被认为"安全"的 margin 门槛（与 stego-core.MIN_BLOCK_MARGIN 一致）
  var TARGET_MARGIN = 16;          // 生成时逐块追求的目标（比门槛高 4，留出 JPEG/后处理的余量）
  var MIN_TILE_VARIANCE = 60;      // 64×64 区块算不算"纹理充足"（与 stego-core 默认门槛一致）

  var GLOBAL_NOISE_AMP = 1.5;      // 整体细噪声（±amp）
  var MAX_BLOCK_NOISE_AMP = 40;    // 逐块噪声幅度上限（防止病态图像里噪声失控）
  var MAX_RETRY = 3;               // 自检不通过时的重试次数
  var RETRY_GAIN = 1.35;           // 每次重试把逐块噪声幅度乘这个系数

  // 亮度安全区：低于 40 或高于 215 时，叠加的调制幅度容易被 clamp 吃掉
  var LUM_FLOOR = 40, LUM_CEIL = 215;

  /**
   * 五种风格。
   * ramp 是"位置 0→1 的颜色停靠点"，必须**亮度单调递增**（见文件头 ②），
   * 且两端亮度落在 [LUM_FLOOR, LUM_CEIL] 内。
   */
  var STYLES = [
    {
      id: 'grass', name: '草地苔藓',
      description: '深浅交错的绿色绒面，像俯拍的草地或苔藓，细节密集、层次自然。',
      // sx/sy：采样坐标缩放（<1 表示该方向被拉长、纹理更宽；>1 表示压扁、纹理更窄）
      sx: 1.0, sy: 1.0,
      ramp: [[0.00, [26, 52, 22]], [0.35, [58, 104, 38]], [0.70, [118, 162, 58]], [1.00, [178, 204, 96]]]
    },
    {
      id: 'rock', name: '岩石地面',
      description: '灰褐相间的粗糙石面，明暗块面分明，像风化的岩壁或砾石地。',
      sx: 0.85, sy: 1.15,
      ramp: [[0.00, [50, 48, 46]], [0.35, [104, 100, 96]], [0.70, [150, 132, 108]], [1.00, [186, 160, 122]]]
    },
    {
      id: 'cloud', name: '云层天空',
      description: '蓝灰到近白的翻滚云团，沿水平方向铺开，起伏柔和但层次清楚。',
      sx: 0.65, sy: 1.35,
      ramp: [[0.00, [52, 68, 92]], [0.35, [104, 132, 168]], [0.70, [162, 186, 208]], [1.00, [212, 222, 228]]]
    },
    {
      id: 'wood', name: '木纹年轮',
      description: '暗褐到暖橙的木质纹理，沿水平方向拉出纤维与年轮感，像木桌面或树皮。',
      sx: 0.45, sy: 2.2,
      ramp: [[0.00, [56, 34, 20]], [0.35, [112, 74, 40]], [0.70, [166, 118, 62]], [1.00, [208, 156, 92]]]
    },
    {
      id: 'abstract', name: '抽象艺术',
      description: '以紫红与橙为主、亮部偏米白的高饱和渐变，像抽象画或流体颜料，纹理最丰富。',
      sx: 1.15, sy: 1.15,
      ramp: [[0.00, [58, 34, 104]], [0.35, [148, 52, 128]], [0.70, [226, 132, 66]], [1.00, [200, 226, 214]]]
    }
  ];

  // ============================================================
  // 工具
  // ============================================================
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  function clamp(v, lo, hi) {
    if (!isFiniteNum(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /**
   * 确定性 PRNG（mulberry32）。同一 seed 必然给出同一串数字，
   * 因此"同一种子生成完全相同的图"这条契约由它保证。
   */
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 平滑插值曲线 6t⁵−15t⁴+10t³：一阶、二阶导在两端都为 0，避免晶格线可见 */
  function smooth(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  /**
   * 一层值噪声：随机晶格 + 双线性 + smoothstep 插值。
   * sx / sy 是采样时的坐标横向/纵向缩放：值越大，采样点在对应方向上跑得越快，
   *   **图案在该方向被压扁、变窄**。因此"沿水平方向拉长纹理"（如木纹、云带）
   *   应当取 sx < 1、sy > 1；取 1/1 则是各向同性的细密纹理。
   */
  function makeOctave(rng, w, h, period, sx, sy) {
    var cols = Math.ceil(w * sx / period) + 2;
    var rows = Math.ceil(h * sy / period) + 2;
    var lat = new Float32Array(cols * rows);
    for (var i = 0; i < lat.length; i++) lat[i] = rng();
    return { cols: cols, rows: rows, lat: lat, inv: 1 / period, w: w, h: h, sx: sx, sy: sy };
  }

  /**
   * 把一层噪声写进累加缓冲（带振幅与归一化）。
   * 逐像素做的是：取所在晶格单元 → 四个角上的随机值 → smoothstep 双线性混合。
   *
   * 性能要点：晶格下标与插值权重**只与坐标有关**，因此先把每一列、每一行的
   * 下标与权重预计算成小数组（长度 W 与 H），内层循环里只剩查表与三次线性插值。
   * 否则这两件事会在内层循环里对每个像素各算一遍 —— 2048² 时是 4.2M 次多余计算。
   */
  function accumulateOctave(field, oct, amp) {
    var cols = oct.cols, lat = oct.lat, w = oct.w, h = oct.h;
    var sx = oct.sx, sy = oct.sy, inv = oct.inv;
    var maxX = cols - 2, maxY = oct.rows - 2;
    var xi = new Int32Array(w), xw = new Float32Array(w), i, j;
    for (i = 0; i < w; i++) {
      var fx = i * sx * inv;
      var ix = fx | 0;
      if (ix > maxX) ix = maxX;
      xi[i] = ix;
      xw[i] = smooth(fx - ix);
    }
    var yi = new Int32Array(h), yw = new Float32Array(h);
    for (j = 0; j < h; j++) {
      var fy = j * sy * inv;
      var iy = fy | 0;
      if (iy > maxY) iy = maxY;
      yi[j] = iy;
      yw[j] = smooth(fy - iy);
    }
    for (var y = 0; y < h; y++) {
      var rowA = yi[y] * cols, rowB = rowA + cols, ty = yw[y];
      var base = y * w;
      for (var x = 0; x < w; x++) {
        var cx = xi[x], tx = xw[x];
        var a = lat[rowA + cx], b = lat[rowA + cx + 1];
        var c = lat[rowB + cx], d = lat[rowB + cx + 1];
        var top = a + (b - a) * tx;
        var bot = c + (d - c) * tx;
        field[base + x] += (top + (bot - top) * ty) * amp;
      }
    }
  }

  /** 生成 fBm 场，返回值域约为 [0,1]（各层振幅归一化后） */
  function fbmField(w, h, rng, sx, sy) {
    var field = new Float32Array(w * h);
    var amp = 1, norm = 0, period = BASE_PERIOD;
    for (var o = 0; o < OCTAVES; o++) {
      accumulateOctave(field, makeOctave(rng, w, h, period, sx, sy), amp);
      norm += amp;
      amp *= GAIN;
      period = Math.max(2, Math.round(period / LACUNARITY));
    }
    var invNorm = 1 / norm;
    // 归一化到 [0,1] 并做轻微 S 型拉伸，让色板用满而不过曝
    for (var i = 0; i < field.length; i++) {
      var v = field[i] * invNorm;
      v = clamp(v, 0, 1);
      field[i] = v * v * (3 - 2 * v);           // smoothstep：中间调更丰富
    }
    return field;
  }

  /**
   * 色板 LUT：把 0..1 的位置映射成 RGB。
   * 同时算出"亮度随位置变化的平均斜率"，用来把"需要的亮度方差"换算成
   * "需要多大的逐块噪声幅度"（斜率小意味着同样亮度变化需要更大的颜色位移）。
   */
  function buildLut(ramp) {
    var lut = new Uint8Array(256 * 3);
    var lum = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var t = i / 255;
      var k = 0;
      while (k < ramp.length - 2 && t > ramp[k + 1][0]) k++;
      var t0 = ramp[k][0], t1 = ramp[k + 1][0];
      var f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      f = clamp(f, 0, 1);
      var c0 = ramp[k][1], c1 = ramp[k + 1][1];
      var r = c0[0] + (c1[0] - c0[0]) * f;
      var g = c0[1] + (c1[1] - c0[1]) * f;
      var b = c0[2] + (c1[2] - c0[2]) * f;
      lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    var slope = (lum[255] - lum[0]) / 255;
    return { lut: lut, lum: lum, slope: slope > 0.05 ? slope : 0.05 };
  }

  /** 8×8 块的亮度方差（总体方差，与 dct-stego.varianceOf 同口径） */
  function blockVariance(data, w, bx, by) {
    var sum = 0, i, r, c, p;
    for (r = 0; r < 8; r++) {
      var row = ((by + r) * w + bx) * 4;
      for (c = 0; c < 8; c++) {
        p = row + c * 4;
        sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      }
    }
    var mean = sum / 64;
    var acc = 0;
    for (r = 0; r < 8; r++) {
      var row2 = ((by + r) * w + bx) * 4;
      for (c = 0; c < 8; c++) {
        p = row2 + c * 4;
        var y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        var d = y - mean;
        acc += d * d;
      }
    }
    return acc / 64;
  }

  /** 由块方差得到 margin（与 dct-stego 同一公式） */
  function marginOfVariance(v) {
    var m = MARGIN_MIN + MARGIN_GAIN * Math.sqrt(Math.max(0, v));
    return clamp(m, MARGIN_MIN, MARGIN_MAX);
  }

  /** 64×64 区块的亮度方差（与 image-utils.calculateTileVariance 同口径） */
  function tileVariance(data, w, h, tx, ty) {
    var n = 0, sum = 0, x, y, p;
    for (y = ty; y < ty + 64 && y < h; y++) {
      for (x = tx; x < tx + 64 && x < w; x++) {
        p = (y * w + x) * 4;
        sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        n++;
      }
    }
    if (n <= 0) return 0;
    var mean = sum / n, acc = 0;
    for (y = ty; y < ty + 64 && y < h; y++) {
      for (x = tx; x < tx + 64 && x < w; x++) {
        p = (y * w + x) * 4;
        var lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        var d = lum - mean;
        acc += d * d;
      }
    }
    return acc / n;
  }

  /** 统计整幅图的 margin 与纹理块占比（生成自检用） */
  function measure(data, w, h) {
    var blocks = 0, okBlocks = 0, sumMargin = 0, minMargin = Infinity;
    var bx, by;
    for (by = 0; by + 8 <= h; by += 8) {
      for (bx = 0; bx + 8 <= w; bx += 8) {
        var m = marginOfVariance(blockVariance(data, w, bx, by));
        blocks++;
        sumMargin += m;
        if (m < minMargin) minMargin = m;
        if (m >= MARGIN_SAFE) okBlocks++;
      }
    }
    var tiles = 0, textured = 0;
    for (by = 0; by + 64 <= h; by += 64) {
      for (bx = 0; bx + 64 <= w; bx += 64) {
        tiles++;
        if (tileVariance(data, w, h, bx, by) >= MIN_TILE_VARIANCE) textured++;
      }
    }
    return {
      blocks: blocks,
      blockMarginOkRatio: blocks ? okBlocks / blocks : 0,
      avgMargin: blocks ? sumMargin / blocks : 0,
      minMargin: isFinite(minMargin) ? minMargin : 0,
      tiles: tiles,
      texturedTiles: textured,
      texturedRatio: tiles ? textured / tiles : 0
    };
  }

  // ============================================================
  // 主流程
  // ============================================================
  function newImageData(data, w, h) {
    if (typeof ImageData === 'function') {
      try { return new ImageData(data, w, h); } catch (e) { /* 落到下面 */ }
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('CarrierGenerator: 当前环境既无 ImageData 构造器也无 DOM');
    }
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    img.data.set(data);
    return img;
  }

  function resolveStyle(id) {
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i].id === id) return STYLES[i];
    return null;
  }

  /**
   * 生成一张载体图。
   * @param {{width?:number, height?:number, style?:string, seed?:number}} [options]
   * @returns {{imageData:ImageData, seed:number, style:string, stats:object}}
   */
  function generate(options) {
    var opt = options || {};
    var w = isFiniteNum(opt.width) ? Math.round(opt.width) : DEFAULT_WIDTH;
    var h = isFiniteNum(opt.height) ? Math.round(opt.height) : DEFAULT_HEIGHT;
    if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM) {
      throw new RangeError('CarrierGenerator.generate: 尺寸必须在 1~' + MAX_DIM + ' 之间，当前 ' + w + '×' + h);
    }
    w = Math.max(8, w - (w % 8));        // 对齐到 8 的整数倍，保证 8×8 块完整
    h = Math.max(8, h - (h % 8));
    var styleId = opt.style === undefined || opt.style === null ? DEFAULT_STYLE : opt.style;
    var style = resolveStyle(styleId);
    if (!style) {
      throw new RangeError('CarrierGenerator.generate: 未知风格 "' + styleId + '"，可选：' +
        STYLES.map(function (s) { return s.id; }).join(' / '));
    }
    var seed = isFiniteNum(opt.seed) ? (Math.floor(opt.seed) >>> 0) : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);

    var t0 = Date.now();
    var lutInfo = buildLut(style.ramp);
    var lut = lutInfo.lut, lumLut = lutInfo.lum, slope = lutInfo.slope;
    // 需要的"亮度方差" → 需要的"颜色位置方差"（色板斜率小于 1 时要放大）
    var targetLumVar = Math.pow(Math.max(0, TARGET_MARGIN - MARGIN_MIN), 2);   // margin 16 → 64
    var targetIdxVar = targetLumVar / (slope * slope);
    var globalVar = (GLOBAL_NOISE_AMP * GLOBAL_NOISE_AMP) / 3;                  // 均匀分布方差

    var data = null, stats = null, attempt = 0, ampScale = 1;
    while (attempt <= MAX_RETRY) {
      var rng = makeRng((seed + attempt * 0x9e3779b9) >>> 0);
      var field = fbmField(w, h, rng, style.sx || 1, style.sy || 1);
      data = new Uint8ClampedArray(w * h * 4);

      for (var by = 0; by < h; by += 8) {
        for (var bx = 0; bx < w; bx += 8) {
          // ---- ① 先量这一块 fBm 的亮度方差（用色板映射后的真实亮度） ----
          var sum = 0, r, c, x, y, p;
          for (r = 0; r < 8; r++) {
            for (c = 0; c < 8; c++) {
              p = (by + r) * w + (bx + c);
              sum += lumLut[(field[p] * 255) | 0];
            }
          }
          var mean = sum / 64, acc = 0;
          for (r = 0; r < 8; r++) {
            for (c = 0; c < 8; c++) {
              p = (by + r) * w + (bx + c);
              var d0 = lumLut[(field[p] * 255) | 0] - mean;
              acc += d0 * d0;
            }
          }
          var lumVar = acc / 64;
          // ---- ② 差额决定这一块的噪声幅度（自适应：平块加得多、糙块几乎不加） ----
          var needLumVar = targetLumVar - lumVar - globalVar;
          var amp = 0;
          if (needLumVar > 0) {
            // 噪声在"色板位置"上加，映射到亮度要乘以斜率；再按 (需要的亮度方差)/(斜率²) 求位置方差
            var needIdxVar = needLumVar / (slope * slope);
            amp = Math.sqrt(needIdxVar * 3) * ampScale;         // 均匀分布 ±amp 的方差 = amp²/3
            if (amp > MAX_BLOCK_NOISE_AMP) amp = MAX_BLOCK_NOISE_AMP;
          }
          // ---- ③ 写像素：色板映射 + 逐块噪声 + 整体细噪声 ----
          for (y = by; y < by + 8; y++) {
            for (x = bx; x < bx + 8; x++) {
              var idx = (y * w + x);
              var t = field[idx] * 255;
              if (amp > 0) t += (rng() * 2 - 1) * amp;
              t += (rng() * 2 - 1) * GLOBAL_NOISE_AMP;
              var li = t < 0 ? 0 : (t > 255 ? 255 : t) | 0;
              var o = idx * 4;
              data[o] = lut[li * 3];
              data[o + 1] = lut[li * 3 + 1];
              data[o + 2] = lut[li * 3 + 2];
              data[o + 3] = 255;
            }
          }
        }
      }

      stats = measure(data, w, h);
      if (stats.blockMarginOkRatio >= 0.95 && stats.texturedRatio >= 0.80 && stats.minMargin >= MARGIN_SAFE) break;
      attempt++;
      ampScale *= RETRY_GAIN;
    }

    // ---- ⑥ 局部修补：只给"仍然偏弱"的那几个块单独补噪声 ----
    // 为什么需要这一步：全局幅度是按"每块的估计差额"给的，而噪声与色板映射叠加后
    // 实际落地方差会略低于估计（clip、斜率非线性），于是总有个别块停在门槛线上
    //（实测最弱块 margin = 12.0，几乎没有余量）。这里按**实测**方差逐块补差，
    // 只动这几个块，避免为了平均值把整幅图都调糙。
    var repairPasses = 0;
    for (var pass = 0; pass < 2; pass++) {
      var weakBlocks = 0;
      for (var ry = 0; ry < h; ry += 8) {
        for (var rx = 0; rx < w; rx += 8) {
          var curVar = blockVariance(data, w, rx, ry);
          if (marginOfVariance(curVar) >= TARGET_MARGIN - 1.0) continue;   // 已有余量，不动
          var needLum = targetLumVar - curVar;
          if (needLum <= 0) continue;
          var rAmp = Math.sqrt(needLum * 3) / slope;
          if (rAmp > MAX_BLOCK_NOISE_AMP) rAmp = MAX_BLOCK_NOISE_AMP;
          var rr, cc, pp;
          for (rr = 0; rr < 8; rr++) {
            for (cc = 0; cc < 8; cc++) {
              pp = ((ry + rr) * w + (rx + cc)) * 4;
              var off = (rng() * 2 - 1) * rAmp;
              data[pp] = clamp(data[pp] + off, 0, 255);
              data[pp + 1] = clamp(data[pp + 1] + off, 0, 255);
              data[pp + 2] = clamp(data[pp + 2] + off, 0, 255);
            }
          }
          weakBlocks++;
        }
      }
      repairPasses++;
      if (!weakBlocks) break;
    }
    stats = measure(data, w, h);

    var imageData = newImageData(data, w, h);
    return {
      imageData: imageData,
      seed: seed,
      style: style.id,
      stats: {
        // —— 契约要求的三项 ——
        avgMargin: stats.avgMargin,
        minMargin: stats.minMargin,
        texturedRatio: stats.texturedRatio,
        // —— 诊断与页面展示用的附加信息 ——
        width: w,
        height: h,
        blocks: stats.blocks,
        blockMarginOkRatio: stats.blockMarginOkRatio,
        texturedTiles: stats.texturedTiles,
        tiles: stats.tiles,
        marginSafeThreshold: MARGIN_SAFE,
        targetMargin: TARGET_MARGIN,
        retries: attempt,
        repairPasses: repairPasses,
        noiseAmpScale: ampScale,
        elapsedMs: Date.now() - t0
      }
    };
  }

  /** 可用风格列表（供页面渲染选项） */
  function styles() {
    return STYLES.map(function (s) {
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        previewColors: s.ramp.map(function (stop) {
          var c = stop[1];
          return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
        })
      };
    });
  }

  var CarrierGenerator = {
    generate: generate,
    styles: styles
  };

  // 附加常量（便于测试与调参，不属于函数契约的一部分）
  CarrierGenerator.CONST = {
    DEFAULT_WIDTH: DEFAULT_WIDTH,
    DEFAULT_HEIGHT: DEFAULT_HEIGHT,
    DEFAULT_STYLE: DEFAULT_STYLE,
    MAX_DIM: MAX_DIM,
    OCTAVES: OCTAVES,
    LACUNARITY: LACUNARITY,
    GAIN: GAIN,
    BASE_PERIOD: BASE_PERIOD,
    MARGIN_SAFE: MARGIN_SAFE,
    TARGET_MARGIN: TARGET_MARGIN,
    MIN_TILE_VARIANCE: MIN_TILE_VARIANCE,
    MAX_RETRY: MAX_RETRY
  };

  global.CarrierGenerator = CarrierGenerator;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
