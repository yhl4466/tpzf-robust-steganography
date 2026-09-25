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
 *   ① fBm（分数布朗运动）铺底：5 个八度值噪声叠加，lacunarity = 2.0、gain = 0.5，
 *      最低频晶格间距 64 像素；每种风格另有各向异性系数（见 STYLES 的 sx/sy）；
 *   ② 色板映射：每种风格一条**亮度单调**的渐变 LUT（256 级），
 *      并把输出亮度限制在 [40, 215] —— 贴近 0/255 的像素会被 clamp 削掉调制幅度，
 *      实测标称 margin 12.5 的块在极值处只剩 8.0；
 *   ③ 逐块 margin 保底：对每个 8×8 块先量它的亮度方差，再按差额补零均值白噪声
 *      （差额小的块几乎不加、差额大的块多加）；
 *   ④ 就地局部修补 + 叠一层 ±1.5 的整体细噪声，消除"纯数学噪声"的塑料感；
 *   ⑤ 生成后**实测**自检；不达标就加大幅度重试（最多 3 次）。
 *
 * ============================ 为什么按 8 行一带流式生成 ============================
 * 早期实现先算一张与输出同尺寸的 Float32Array 场，再逐块处理。8192×8192 时
 * 光这张场就是 268 MB，加上 RGBA 输出要 500 MB 以上，手机上必崩。
 * 现在改成**按 8 行（正好一个 8×8 块行）流式处理**：
 *   · 每个八度的随机晶格只保留一份（最低频那层也才约 130×130 个浮点数）；
 *   · 每带只用两个小缓冲（8×W 的亮度与色板下标），峰值内存 ≈ RGBA 输出 + 几百 KB；
 *   · 顺带天然支持"分片让出主线程"：每处理若干带就让出一次，主线程不会卡死。
 *
 * ============================ 为什么补的是白噪声 ============================
 * 补噪声的目的是抬高"块的亮度方差"，而载波用的系数对位于中低频，白噪声的
 * 能量在各频率上均匀分布，因此对全部 6 对系数一视同仁地抬高裕量；
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
  var MAX_DIM = 8192;              // 尺寸上限（8192² 的 RGBA 输出约 268 MB，属桌面级用量）
  var WARN_DIM = 4096;             // 超过这个边长时提示调用方注意内存
  var BAND_ROWS = 8;               // 一次处理 8 行 = 一个 8×8 块行
  var CHUNK_MS = 12;               // 分片模式下每个时间片最多占用约 12 ms

  // fBm 参数（标准取值）
  // 八度取 4 而不是 5：第 5 层的振幅只有 1/16，对亮度方差的贡献约 (1/16)² ≈ 0.4%，
  // 肉眼也几乎看不出（细颗粒本来就由后面的白噪声提供），却要占掉约 20% 的计算量。
  var OCTAVES = 4;
  var LACUNARITY = 2.0;            // 每层频率翻倍
  var GAIN = 0.5;                  // 每层振幅减半
  var BASE_PERIOD = 64;            // 最低频层的晶格间距（像素）：保证 64×64 区块内有变化

  // margin 与 dct-stego.adaptiveMargin 同口径：margin = clamp(min + gain*√variance, min, max)
  var MARGIN_MIN = 8, MARGIN_GAIN = 1.0, MARGIN_MAX = 32;
  var MARGIN_SAFE = 12;            // 被认为"安全"的 margin 门槛（与 stego-core.MIN_BLOCK_MARGIN 一致）
  var TARGET_MARGIN = 16;          // 生成时逐块追求的目标（比门槛高 4，留出后处理余量）
  var MIN_TILE_VARIANCE = 60;      // 64×64 区块算不算"纹理充足"（与 stego-core 默认门槛一致）

  var GLOBAL_NOISE_AMP = 1.5;      // 整体细噪声（±amp）
  var MAX_BLOCK_NOISE_AMP = 40;    // 逐块噪声幅度上限（防止病态图像里噪声失控）
  var MAX_RETRY = 3;               // 自检不通过时的重试次数
  var RETRY_GAIN = 1.35;           // 每次重试把逐块噪声幅度乘这个系数
  var REPAIR_TARGET = TARGET_MARGIN - 1.0;   // 局部修补的触发线（margin 低于它才补）

  // 亮度安全区：低于 40 或高于 215 时，叠加的调制幅度容易被 clamp 吃掉
  var LUM_FLOOR = 40, LUM_CEIL = 215;

  /**
   * 五种风格。
   * ramp 是"位置 0→1 的颜色停靠点"，必须**亮度单调递增**（见文件头 ②），
   * 且两端亮度落在 [LUM_FLOOR, LUM_CEIL] 内。
   * sx/sy 是采样坐标缩放：**<1 表示该方向被拉长（纹理更宽）**，>1 表示压扁（纹理更窄）。
   */
  var STYLES = [
    {
      id: 'grass', name: '草地苔藓',
      description: '深浅交错的绿色绒面，像俯拍的草地或苔藓，细节密集、层次自然。',
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
      description: '蓝灰到近白的翻滚云带，沿水平方向铺开，起伏柔和但层次清楚。',
      sx: 0.65, sy: 1.35,
      ramp: [[0.00, [52, 68, 92]], [0.35, [104, 132, 168]], [0.70, [162, 186, 208]], [1.00, [212, 222, 228]]]
    },
    {
      id: 'wood', name: '木纹年轮',
      description: '暗褐到暖橙的木质纹理，横向拉出纤维与年轮感，像木桌面或树皮。',
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
   * 预建 5 层晶格，并把"每列/每行落在哪个晶格单元、插值权重多少"预先算好。
   * 这两张表只与坐标有关，长度分别是 W 与 H —— 相对于输出像素数可以忽略，
   * 但能让逐像素的内层循环只剩查表与几次乘加。
   */
  function buildOctaves(w, h, rng, sx, sy) {
    var octs = [];
    var amp = 1, norm = 0, period = BASE_PERIOD;
    for (var o = 0; o < OCTAVES; o++) {
      var cols = Math.ceil(w * sx / period) + 2;
      var rows = Math.ceil(h * sy / period) + 2;
      var lat = new Float32Array(cols * rows);
      for (var i = 0; i < lat.length; i++) lat[i] = rng();

      var xi = new Int32Array(w), xw = new Float32Array(w);
      var inv = 1 / period, maxCol = cols - 2, maxRow = rows - 2, v, idx;
      for (i = 0; i < w; i++) {
        v = i * sx * inv;
        idx = v | 0;
        if (idx > maxCol) idx = maxCol;
        xi[i] = idx;
        xw[i] = smooth(v - idx);
      }
      var yi = new Int32Array(h), yw = new Float32Array(h);
      for (var j = 0; j < h; j++) {
        v = j * sy * inv;
        idx = v | 0;
        if (idx > maxRow) idx = maxRow;
        yi[j] = idx;
        yw[j] = smooth(v - idx);
      }
      octs.push({ cols: cols, lat: lat, xi: xi, xw: xw, yi: yi, yw: yw, amp: amp });
      norm += amp;
      amp *= GAIN;
      period = Math.max(2, Math.round(period / LACUNARITY));
    }
    return { list: octs, invNorm: 1 / norm };
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

  /** 由块方差得到 margin（与 dct-stego 同一公式） */
  function marginOfVariance(v) {
    var m = MARGIN_MIN + MARGIN_GAIN * Math.sqrt(Math.max(0, v));
    return clamp(m, MARGIN_MIN, MARGIN_MAX);
  }

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

  /** 解析并校验参数（generate 与 generateAsync 共用） */
  function resolveOptions(options) {
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
    var seed = isFiniteNum(opt.seed) ? (Math.floor(opt.seed) >>> 0)
      : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    return {
      style: style, seed: seed, w: w, h: h,
      onProgress: typeof opt.onProgress === 'function' ? opt.onProgress : null
    };
  }

  /**
   * 建一次生成上下文：晶格、LUT、各类缓冲与统计累加器。
   * 全部缓冲都与 W（而不是 W×H）成正比，因此 8192² 也只多出几百 KB。
   */
  function createContext(cfg, attempt, ampScale) {
    var w = cfg.w, h = cfg.h, style = cfg.style;
    var rng = makeRng((cfg.seed + attempt * 0x9e3779b9) >>> 0);
    var octs = buildOctaves(w, h, rng, style.sx || 1, style.sy || 1);
    var lutInfo = buildLut(style.ramp);
    var tileCols = Math.floor(w / 64), tileRows = Math.floor(h / 64);
    return {
      w: w, h: h, style: style, rng: rng,
      octs: octs.list, invNorm: octs.invNorm,
      lut: lutInfo.lut, lumLut: lutInfo.lum, slope: lutInfo.slope,
      data: new Uint8ClampedArray(w * h * 4),
      bandField: new Float32Array(w * BAND_ROWS),
      bandLum: new Float32Array(w * BAND_ROWS),
      bandIdx: new Uint8Array(w * BAND_ROWS),
      bandOut: new Float32Array(w * BAND_ROWS),
      // 需要补的亮度方差（目标 margin 16 → 方差 64；再扣掉整体噪声的贡献）
      targetLumVar: Math.pow(Math.max(0, TARGET_MARGIN - MARGIN_MIN), 2),
      globalVar: (GLOBAL_NOISE_AMP * GLOBAL_NOISE_AMP) / 3,
      ampScale: ampScale || 1,
      // 统计累加器
      blocks: 0, okBlocks: 0, sumMargin: 0, minMargin: Infinity,
      tileCols: tileCols, tileRows: tileRows,
      tileSum: new Float64Array(tileCols * tileRows),
      tileSumSq: new Float64Array(tileCols * tileRows),
      tileCnt: new Float64Array(tileCols * tileRows)
    };
  }

  /** 计算一个 8 行带的 fBm，并写入 bandIdx / bandLum（不含噪声） */
  function fillBand(st, by) {
    var w = st.w, octs = st.octs, nOct = octs.length;
    var field = st.bandField, idx = st.bandIdx, lum = st.bandLum, lumLut = st.lumLut;
    var i, j, x, o, base;
    // 第 0 层直接"赋值"而不是"零填充后再累加"：省掉一整趟清零，也省掉一次读改写
    for (o = 0; o < nOct; o++) {
      var oct = octs[o], amp = oct.amp, cols = oct.cols, lat = oct.lat;
      var xi = oct.xi, xw = oct.xw, yi = oct.yi, yw = oct.yw;
      var first = (o === 0);
      for (j = 0; j < BAND_ROWS; j++) {
        var rowA = yi[by + j] * cols, rowB = rowA + cols, ty = yw[by + j];
        base = j * w;
        for (x = 0; x < w; x++) {
          var cx = xi[x], tx = xw[x];
          var a = lat[rowA + cx], b = lat[rowA + cx + 1];
          var c = lat[rowB + cx], d = lat[rowB + cx + 1];
          var top = a + (b - a) * tx;
          var bot = c + (d - c) * tx;
          var v = (top + (bot - top) * ty) * amp;
          field[base + x] = first ? v : (field[base + x] + v);
        }
      }
    }
    var invNorm = st.invNorm;
    for (j = 0; j < BAND_ROWS; j++) {
      base = j * w;
      for (x = 0; x < w; x++) {
        var n = field[base + x] * invNorm;
        n = n < 0 ? 0 : (n > 1 ? 1 : n);
        n = n * n * (3 - 2 * n);              // smoothstep：中间调更丰富
        var li = (n * 255) | 0;
        idx[base + x] = li;
        lum[base + x] = lumLut[li];
      }
    }
  }

  /** 带内 8×8 块的亮度方差（总体方差，与 dct-stego.varianceOf 同口径） */
  function blockVarianceOf(bandLum, w, bx) {
    var sum = 0, j, x, base;
    for (j = 0; j < BAND_ROWS; j++) {
      base = j * w + bx;
      for (x = 0; x < 8; x++) sum += bandLum[base + x];
    }
    var mean = sum / 64, acc = 0;
    for (j = 0; j < BAND_ROWS; j++) {
      base = j * w + bx;
      for (x = 0; x < 8; x++) { var d = bandLum[base + x] - mean; acc += d * d; }
    }
    return acc / 64;
  }

  /**
   * 处理一个 8 行带：逐块量方差 → 决定噪声幅度 → 写像素 → 就地局部修补 → 累计统计。
   * 需要"整块 64 个像素"的量都在带内即可算完，因此不需要保存整幅中间结果。
   */
  function processBand(st, by) {
    fillBand(st, by);
    var w = st.w, data = st.data, idx = st.bandIdx, lum = st.bandLum, out = st.bandOut;
    var lut = st.lut, lumLut = st.lumLut, rng = st.rng;
    var globalVar = st.globalVar, target = st.targetLumVar;
    var slope2 = st.slope * st.slope, ampScale = st.ampScale;
    var bx, x, j, base, rowBase;
    for (bx = 0; bx + 8 <= w; bx += 8) {
      // ---- ① 量本块基础亮度方差（色板映射后、未加噪声） ----
      var sum = 0;
      for (j = 0; j < BAND_ROWS; j++) {
        base = j * w + bx;
        for (x = 0; x < 8; x++) sum += lum[base + x];
      }
      var mean = sum / 64, acc = 0;
      for (j = 0; j < BAND_ROWS; j++) {
        base = j * w + bx;
        for (x = 0; x < 8; x++) { var d0 = lum[base + x] - mean; acc += d0 * d0; }
      }
      var lumVar = acc / 64;
      // ---- ② 差额决定本块噪声幅度（平块加得多、糙块几乎不加） ----
      var amp = 0, needVar = target - lumVar - globalVar;
      if (needVar > 0) {
        amp = Math.sqrt(needVar / slope2 * 3) * ampScale;
        if (amp > MAX_BLOCK_NOISE_AMP) amp = MAX_BLOCK_NOISE_AMP;
      }
      // ---- ③ 写像素 ----
      for (j = 0; j < BAND_ROWS; j++) {
        base = j * w + bx;
        rowBase = ((by + j) * w + bx) * 4;
        for (x = 0; x < 8; x++) {
          var t = idx[base + x];
          if (amp > 0) t += (rng() * 2 - 1) * amp;
          t += (rng() * 2 - 1) * GLOBAL_NOISE_AMP;
          var li = t < 0 ? 0 : (t > 255 ? 255 : t) | 0;
          var o = rowBase + x * 4;
          data[o] = lut[li * 3];
          data[o + 1] = lut[li * 3 + 1];
          data[o + 2] = lut[li * 3 + 2];
          data[o + 3] = 255;
          out[base + x] = lumLut[li];          // 记录"实际落地"的亮度，供修补与统计用
        }
      }
      // ---- ④ 就地局部修补：用**实测**方差，避免"估计够、实际差一点" ----
      //   注意：块的 sum / sumsq 只在这里算一次，后面的统计复用它们 ——
      //   早期版本为"块 margin"和"64×64 区块方差"各扫了一遍像素（还都是 Float64 累加），
      //   4096² 时要多写几百 MB，纯属浪费。
      var s1 = 0, ss1 = 0;
      for (j = 0; j < BAND_ROWS; j++) {
        base = j * w + bx;
        for (x = 0; x < 8; x++) { var v1 = out[base + x]; s1 += v1; ss1 += v1 * v1; }
      }
      var var1 = ss1 / 64 - (s1 / 64) * (s1 / 64);
      if (marginOfVariance(var1) < REPAIR_TARGET) {
        var need2 = target - var1;
        if (need2 > 0) {
          var amp2 = Math.min(MAX_BLOCK_NOISE_AMP, Math.sqrt(need2 / slope2 * 3));
          s1 = 0; ss1 = 0;
          for (j = 0; j < BAND_ROWS; j++) {
            base = j * w + bx;
            rowBase = ((by + j) * w + bx) * 4;
            for (x = 0; x < 8; x++) {
              var off = (rng() * 2 - 1) * amp2;
              var o2 = rowBase + x * 4;
              data[o2] = clamp(data[o2] + off, 0, 255);
              data[o2 + 1] = clamp(data[o2 + 1] + off, 0, 255);
              data[o2 + 2] = clamp(data[o2 + 2] + off, 0, 255);
              var lv2 = 0.299 * data[o2] + 0.587 * data[o2 + 1] + 0.114 * data[o2 + 2];
              out[base + x] = lv2;
              s1 += lv2; ss1 += lv2 * lv2;
            }
          }
          var1 = ss1 / 64 - (s1 / 64) * (s1 / 64);
        }
      }
      // ---- ⑤ 累计统计（块级 margin + 64×64 区块级方差，全部由块的 sum/sumsq 推导） ----
      var m = marginOfVariance(var1);
      st.blocks++;
      st.sumMargin += m;
      if (m < st.minMargin) st.minMargin = m;
      if (m >= MARGIN_SAFE) st.okBlocks++;
      var tc = (bx / 64) | 0, tr = (by / 64) | 0;
      if (tc < st.tileCols && tr < st.tileRows) {
        var ti = tr * st.tileCols + tc;
        st.tileSum[ti] += s1;
        st.tileSumSq[ti] += ss1;
        st.tileCnt[ti] += 64;
      }
    }
  }

  /** 汇总统计：块级 margin 与 64×64 纹理区块占比 */
  function summarize(st) {
    var tiles = 0, textured = 0;
    for (var i = 0; i < st.tileSum.length; i++) {
      var n = st.tileCnt[i];
      if (!n) continue;
      tiles++;
      var mean = st.tileSum[i] / n;
      var v = st.tileSumSq[i] / n - mean * mean;      // 总体方差
      if (v >= MIN_TILE_VARIANCE) textured++;
    }
    return {
      blocks: st.blocks,
      blockMarginOkRatio: st.blocks ? st.okBlocks / st.blocks : 0,
      avgMargin: st.blocks ? st.sumMargin / st.blocks : 0,
      minMargin: isFinite(st.minMargin) ? st.minMargin : 0,
      tiles: tiles,
      texturedTiles: textured,
      texturedRatio: tiles ? textured / tiles : 0
    };
  }

  /** 自检是否达标 */
  function qualityOk(stats) {
    return stats.blockMarginOkRatio >= 0.95 && stats.texturedRatio >= 0.80 &&
      stats.minMargin >= MARGIN_SAFE;
  }

  function buildResult(cfg, st, stats, attempt, t0) {
    return {
      imageData: newImageData(st.data, st.w, st.h),
      seed: cfg.seed,
      style: cfg.style.id,
      stats: {
        // —— 契约要求的三项 ——
        avgMargin: stats.avgMargin,
        minMargin: stats.minMargin,
        texturedRatio: stats.texturedRatio,
        // —— 诊断与页面展示用的附加信息 ——
        width: st.w,
        height: st.h,
        blocks: stats.blocks,
        blockMarginOkRatio: stats.blockMarginOkRatio,
        texturedTiles: stats.texturedTiles,
        tiles: stats.tiles,
        marginSafeThreshold: MARGIN_SAFE,
        targetMargin: TARGET_MARGIN,
        retries: attempt,
        noiseAmpScale: st.ampScale,
        memoryHintMb: Math.round(st.w * st.h * 4 / (1024 * 1024)),
        overWarnDim: Math.max(st.w, st.h) > WARN_DIM,
        elapsedMs: Date.now() - t0
      }
    };
  }

  /**
   * 生成一张载体图（**同步**）。小图（≤2048²）用它最省事。
   * @param {{width?:number, height?:number, style?:string, seed?:number,
   *          onProgress?:function(string,number,number)}} [options]
   * @returns {{imageData:ImageData, seed:number, style:string, stats:object}}
   */
  function generate(options) {
    var t0 = Date.now();
    var cfg = resolveOptions(options);
    var attempt = 0, ampScale = 1, run = null;
    while (true) {
      run = (function () {
        var st = createContext(cfg, attempt, ampScale);
        var bands = Math.ceil(st.h / BAND_ROWS);
        for (var b = 0; b < bands; b++) {
          processBand(st, b * BAND_ROWS);
          if (cfg.onProgress) cfg.onProgress('generate', b + 1, bands);
        }
        return { st: st, stats: summarize(st) };
      })();
      if (qualityOk(run.stats) || attempt >= MAX_RETRY) break;
      attempt++;
      ampScale *= RETRY_GAIN;
    }
    return buildResult(cfg, run.st, run.stats, attempt, t0);
  }

  /** 让出主线程：浏览器用 requestAnimationFrame，其它环境退回 setTimeout */
  function yieldToHost() {
    if (typeof requestAnimationFrame === 'function') {
      return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); });
    }
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  /**
   * 生成一张载体图（**分片异步**）：每占用主线程约 CHUNK_MS 毫秒就让出一次，
   * 期间通过 options.onProgress(phase, done, total) 汇报进度，界面不会卡死。
   * 大图（≥2048²）建议用这个接口，小图用同步的 generate 即可。
   * @returns {Promise<{imageData:ImageData, seed:number, style:string, stats:object}>}
   */
  function generateAsync(options) {
    var t0 = Date.now();
    return Promise.resolve().then(function () {
      var cfg = resolveOptions(options);
      var onProgress = cfg.onProgress;
      var attempt = 0, ampScale = 1;

      function runAttempt() {
        var st = createContext(cfg, attempt, ampScale);
        var bands = Math.ceil(st.h / BAND_ROWS);
        var b = 0;
        return new Promise(function (resolve, reject) {
          function step() {
            try {
              var sliceStart = Date.now();
              while (b < bands) {
                processBand(st, b * BAND_ROWS);
                b++;
                if (onProgress) onProgress('generate', b, bands);
                if (Date.now() - sliceStart >= CHUNK_MS) break;    // 让出主线程
              }
              if (b < bands) { yieldToHost().then(step, reject); return; }
              resolve({ st: st, stats: summarize(st) });
            } catch (e) { reject(e); }
          }
          step();
        });
      }

      function next() {
        return runAttempt().then(function (run) {
          if (qualityOk(run.stats) || attempt >= MAX_RETRY) return run;
          attempt++;
          ampScale = run.st.ampScale * RETRY_GAIN;
          if (onProgress) onProgress('retry', attempt, MAX_RETRY);
          return next();
        });
      }

      return next().then(function (run) {
        if (onProgress) onProgress('done', 1, 1);
        return buildResult(cfg, run.st, run.stats, attempt, t0);
      });
    });
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
    generateAsync: generateAsync,
    styles: styles
  };

  // 附加常量（便于测试与调参，不属于函数契约的一部分）
  CarrierGenerator.CONST = {
    DEFAULT_WIDTH: DEFAULT_WIDTH,
    DEFAULT_HEIGHT: DEFAULT_HEIGHT,
    DEFAULT_STYLE: DEFAULT_STYLE,
    MAX_DIM: MAX_DIM,
    WARN_DIM: WARN_DIM,
    BAND_ROWS: BAND_ROWS,
    CHUNK_MS: CHUNK_MS,
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
