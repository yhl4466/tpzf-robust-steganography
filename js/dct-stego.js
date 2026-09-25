/**
 * dct-stego.js —— DCT 差分隐写内核（纯前端，零依赖）
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致，请勿破坏）：
 *   1. 零外部依赖：只用原生 JS + Web API；
 *   2. 不使用 ES Module：没有 import / export，普通 script 标签引入，
 *      file:// 双击本地打开即可运行；
 *   3. 挂载到全局命名空间 window.DctStego（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * ============================ 算法原理 ============================
 * 目标：把比特藏进"人眼不敏感"的地方，并且能在 JPEG 有损压缩后仍然读出来。
 *
 * (1) 频域嵌入
 *     把 8×8 像素块做二维 DCT-II 变到频域。低频系数（尤其 DC）决定块的
 *     平均亮度，改动极易被察觉；高频系数在 JPEG 里会被量化表直接抹平。
 *     所以选择"中低频"的一对系数做差分调制。
 *
 * (2) 差分（符号）调制
 *     对选定的系数对 (a, b)，不改它们的和 mid=(a+b)/2，只改它们的差：
 *       bit=1 → a−b ≥ margin（a 大于 b）
 *       bit=0 → b−a ≥ margin（b 大于 a）
 *     提取时只看 a 与 b 的大小关系（a>b → 1）。
 *     因为 a+b 保持不变，块的直流能量不变，视觉扰动最小；
 *     又因为"差值"远大于 JPEG 量化步长，量化后符号依旧保留 —— 这就是
 *     抗 JPEG 压缩的根源。
 *
 * (3) 自适应 margin
 *     平坦区域（低方差）里，任何频域扰动都很显眼，所以 margin 取小值；
 *     纹理丰富区域（高方差）本身就"嘈杂"，可以用大 margin 换取更强的
 *     抗压缩能力：margin = clamp(marginMin + marginGain*√variance, min, max)。
 *
 * (4) 只调制亮度 Y
 *     Y = 0.299R + 0.587G + 0.114B。嵌完后得到 Y'，令 ΔY = Y' − Y，
 *     把同一个 ΔY 加到 R、G、B 上（因为 0.299+0.587+0.114 = 1，加相同量
 *     等于只平移亮度，色度基本不变），最后 clamp 到 [0,255] 并四舍五入。
 *
 * (5) 为什么无压缩时能 100% 提取
 *     DCT/IDCT 用双精度浮点 + 正交归一矩阵，往返误差约 1e-13；
 *     真正引入误差的是"像素取整"（每像素 ≤0.5）。正交 DCT 会把这点
 *     噪声均摊到 64 个系数上，单系数误差标准差约 0.3，远小于 margin/2，
 *     因此符号不会被翻转。
 *
 * ============================ 尺寸约定 ============================
 * 本实现的 Tile 宽高必须是 8 的整数倍（8×8、16×16、32×32、64×64 …）。
 * 一个 64×64 Tile = 8×8 = 64 个 DCT 块，每块 6 比特（6 对系数），
 * 共 384 比特 = 48 字节。
 * 非 8 整数倍的 Tile（例如 image-utils 切出的边界 Tile 36×6）会抛出
 * 明确错误 —— 补零会凭空制造高频，反而破坏提取；如需支持请先自行补齐
 * 到 8 的倍数再做嵌入。
 */
(function (global) {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================

  var N = 8;                    // DCT 块边长
  var BLOCK_PIXELS = N * N;     // 每块 64 个像素 / 系数
  var BITS_PER_BLOCK = 6;       // 每块承载 6 比特（下面 6 对系数）

  /**
   * 默认系数对，每项 4 个数：[u1, v1, u2, v2]
   * 索引约定 index = v * 8 + u（行优先：v 是垂直频率=行，u 是水平频率=列）
   *
   * 6 对分别是：(2,1)-(1,2)、(3,1)-(1,3)、(3,0)-(0,3)、
   *            (2,0)-(0,2)、(3,2)-(2,3)、(4,1)-(1,4)
   *
   * 选取依据（标准 JPEG 亮度量化表 Q[v][u]，数值越小越"抗量化"）：
   *   ① 每对两个系数在量化表上数值接近（差值 ≤ 4）——因为 JPEG 对两个系数
   *      用各自的步长独立量化，只有步长接近时，量化后"差值的符号"才不容易翻转：
   *        (2,1)=Q[1][2]=14 vs (1,2)=Q[2][1]=13  差 1
   *        (3,1)=Q[1][3]=19 vs (1,3)=Q[3][1]=17  差 2
   *        (3,0)=Q[0][3]=16 vs (0,3)=Q[3][0]=14  差 2
   *        (2,0)=Q[0][2]=10 vs (0,2)=Q[2][0]=14  差 4
   *        (3,2)=Q[2][3]=24 vs (2,3)=Q[3][2]=22  差 2
   *        (4,1)=Q[1][4]=26 vs (1,4)=Q[4][1]=22  差 4
   *   ② 12 个位置互不重复（否则同一系数会被两对比特争抢，互相破坏）；
   *   ③ 全部位于中低频（u,v ≤ 4，且都不是 DC(0,0)）——高频会被量化表抹平，
   *      DC 改动会直接改变块的平均亮度、肉眼极易察觉。
   *   ④ 6 对在同一块里互相独立：每对只改自己两个系数，且都保持该对的
   *      和 mid 不变，因此 6 对叠加后块的整体能量（DC）不变。
   *
   * Q75 下这 6 对的量化步长依次是：(7,7)、(9,10)、(7,8)、(5,7)、(11,12)、(11,13)，
   * 最大 13，仍远小于默认 margin 上限 32，所以量化后差值符号基本不会被翻转。
   */
  var DEFAULT_PAIRS = [
    [2, 1, 1, 2],
    [3, 1, 1, 3],
    [3, 0, 0, 3],
    [2, 0, 0, 2],
    [3, 2, 2, 3],
    [4, 1, 1, 4]
  ];

  /**
   * 标准 JPEG 亮度量化表（行优先，index = v*8+u）。
   * 本文件内部不直接用它做嵌入，但对外暴露：测试模拟 JPEG 压缩、
   * 以及以后调参评估"哪些系数对更抗量化"都要用到同一张表。
   */
  var LUMA_QUANT_TABLE = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99
  ];

  /** margin 自适应默认参数 */
  var DEFAULT_MARGIN_MIN = 8;    // 平坦块的最小 margin（再小会被 JPEG 量化抹平）
  var DEFAULT_MARGIN_GAIN = 1.0; // 每单位 √variance 增加的 margin
  var DEFAULT_MARGIN_MAX = 32;   // 上限：margin 太大时会明显改变像素，且开始溢出

  // ============================================================
  // 预计算正交 DCT-II 余弦矩阵
  //   T[u][x] = C(u) * cos((2x+1)uπ/16) / 2,  C(0)=1/√2, C(u>0)=1
  // 该矩阵是正交归一矩阵，满足 T·Tᵀ = I，因此 IDCT 就是 F·Tᵀ... 的转置乘法，
  // 且正反变换的数值误差极小（这是"无压缩 100% 提取"的前提）。
  // ============================================================
  var COS = (function () {
    var T = [];
    for (var u = 0; u < N; u++) {
      var row = new Float64Array(N);
      var c = (u === 0) ? Math.SQRT1_2 : 1; // C(u)
      for (var x = 0; x < N; x++) {
        row[x] = 0.5 * c * Math.cos((2 * x + 1) * u * Math.PI / 16);
      }
      T.push(row);
    }
    return T;
  })();

  // ============================================================
  // 内部工具
  // ============================================================

  /** 系数在 8×8 矩阵中的行优先下标：index = v*8 + u */
  function idx(u, v) {
    return v * N + u;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    if (!isFiniteNumber(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 浮点像素值 -> [0,255] 整数（先 round 再 clamp，绝不产生越界值） */
  function clampByte(v) {
    if (!isFiniteNumber(v)) return 0;
    var b = Math.round(v);
    return b < 0 ? 0 : (b > 255 ? 255 : b);
  }

  /** 校验"长得像 ImageData"的对象 */
  function isImageData(o) {
    return !!o && !!o.data && typeof o.data.length === 'number' &&
      typeof o.width === 'number' && typeof o.height === 'number';
  }

  /** 校验 Tile 宽高为 8 的整数倍，返回 { w, h, blocksX, blocksY, capacity } */
  function resolveGeometry(width, height, fnName) {
    var w = Math.floor(width), h = Math.floor(height);
    if (!(w > 0) || !(h > 0)) {
      throw new Error(fnName + ': Tile 宽高必须大于 0，当前为 ' + w + 'x' + h);
    }
    if (w % N !== 0 || h % N !== 0) {
      throw new Error(fnName + ': Tile 宽高必须是 ' + N + ' 的整数倍（当前 ' + w + 'x' + h +
        '）。本实现对非 ' + N + ' 倍数尺寸不做补零，因为补零会引入虚假高频、破坏提取。');
    }
    var blocksX = w / N, blocksY = h / N;
    return {
      w: w,
      h: h,
      blocksX: blocksX,
      blocksY: blocksY,
      capacity: blocksX * blocksY * BITS_PER_BLOCK
    };
  }

  /** 校验并规范化比特数组（接受 boolean[] 或 0/1 数字数组），返回 Uint8Array */
  function normalizeBits(bitArray, fnName) {
    if (!bitArray || typeof bitArray.length !== 'number') {
      throw new TypeError(fnName + ': bitArray 必须是数组或类数组');
    }
    var n = bitArray.length;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = bitArray[i] ? 1 : 0; // true/1 -> 1，false/0 -> 0
    }
    return out;
  }

  /** 校验自定义系数对（1 ~ BITS_PER_BLOCK 对；少于 6 对即"低频回退模式"） */
  function validatePairs(pairs, fnName) {
    if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > BITS_PER_BLOCK) {
      throw new TypeError(fnName + ': options.pairs 必须是 1 ~ ' + BITS_PER_BLOCK + ' 项的数组');
    }
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (!Array.isArray(p) || p.length !== 4) {
        throw new TypeError(fnName + ': options.pairs[' + i + '] 必须是 [u1,v1,u2,v2] 形式的数组');
      }
      for (var k = 0; k < 4; k++) {
        var val = p[k];
        if (!isFiniteNumber(val) || Math.floor(val) !== val || val < 0 || val > N - 1) {
          throw new RangeError(fnName + ': options.pairs[' + i + '][' + k + '] 必须是 0~' +
            (N - 1) + ' 的整数，当前为 ' + val);
        }
      }
      // 禁止使用 DC(0,0)：改 DC 会直接改变块的平均亮度，肉眼极易察觉
      if ((p[0] === 0 && p[1] === 0) || (p[2] === 0 && p[3] === 0)) {
        throw new RangeError(fnName + ': 系数对不得包含 DC(0,0)');
      }
      out.push([p[0], p[1], p[2], p[3]]);
    }
    return out;
  }

  /** 解析 options: { marginMin, marginGain, marginMax, pairs? } */
  function resolveOptions(options, fnName) {
    if (options !== undefined && options !== null && typeof options !== 'object') {
      throw new TypeError(fnName + ': options 必须是对象或省略');
    }
    var o = options || {};
    var min = isFiniteNumber(o.marginMin) ? o.marginMin : DEFAULT_MARGIN_MIN;
    var gain = isFiniteNumber(o.marginGain) ? o.marginGain : DEFAULT_MARGIN_GAIN;
    var max = isFiniteNumber(o.marginMax) ? o.marginMax : DEFAULT_MARGIN_MAX;
    if (min < 0) min = 0;
    if (gain < 0) gain = 0;
    if (max < 0) max = 0;
    if (max < min) max = min; // 保证 clamp 区间合法
    var pairs = (o.pairs === undefined) ? DEFAULT_PAIRS : validatePairs(o.pairs, fnName);
    return { marginMin: min, marginGain: gain, marginMax: max, pairs: pairs };
  }

  /**
   * 计算一组亮度值的总体方差（两遍法，避免 E[x²]−E[x]² 的灾难性抵消）。
   * 入参是 double 亮度值，不属于"必须严格为 0"的场景，但同样做负数/NaN 防护。
   */
  function varianceOf(values, n) {
    if (n <= 0) return 0;
    var sum = 0, i;
    for (i = 0; i < n; i++) {
      var v = values[i];
      if (isFiniteNumber(v)) sum += v;
    }
    var mean = sum / n;
    if (!isFiniteNumber(mean)) return 0;
    var acc = 0;
    for (i = 0; i < n; i++) {
      var d = values[i] - mean;
      if (!isFiniteNumber(d)) continue;
      acc += d * d;
    }
    var variance = acc / n;
    return (isFiniteNumber(variance) && variance > 0) ? variance : 0;
  }

  /**
   * 自适应 margin：纹理越强 margin 越大（更抗压缩），
   * 平坦区域用 marginMin 限制扰动。
   */
  function adaptiveMargin(variance, opt) {
    var m = opt.marginMin + opt.marginGain * Math.sqrt(Math.max(0, variance));
    if (!isFiniteNumber(m)) m = opt.marginMin;
    return clamp(m, opt.marginMin, opt.marginMax);
  }

  /**
   * 对系数对做符号调制（核心嵌入操作）。
   *   mid = (a+b)/2 保持不变 → 不改变该频率对的平均能量，视觉扰动最小
   *   bit=1 → a = mid + margin/2, b = mid − margin/2  （a−b = margin）
   *   bit=0 → a = mid − margin/2, b = mid + margin/2  （b−a = margin）
   * 若原差值已满足目标符号且 |a−b| ≥ margin，则原样保留（扰动更小）。
   */
  function modulatePair(coeffs, ia, ib, bit, margin) {
    var a = coeffs[ia];
    var b = coeffs[ib];
    var diff = a - b;
    var mid = (a + b) / 2;
    var half = margin / 2;
    if (bit === 1) {
      if (diff >= margin) return;      // 已经是"a 明显大于 b"，不动
      coeffs[ia] = mid + half;
      coeffs[ib] = mid - half;
    } else {
      if (-diff >= margin) return;     // 已经是"b 明显大于 a"，不动
      coeffs[ia] = mid - half;
      coeffs[ib] = mid + half;
    }
  }

  /** 构造 ImageData：优先原生构造器，否则退化到 canvas.createImageData */
  function makeImageData(data, width, height) {
    if (typeof ImageData === 'function') {
      try {
        return new ImageData(data, width, height);
      } catch (e) {
        /* 落到下面的降级分支 */
      }
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('makeImageData: 当前环境既无 ImageData 构造器也无 DOM');
    }
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(width, height);
    img.data.set(data);
    return img;
  }

  // ============================================================
  // 对外命名空间
  // ============================================================
  var DctStego = {};

  /**
   * 8×8 二维 DCT-II 正变换。
   * 2D 分解为两次 1D（行列可分离）：
   *   F = T · f · Tᵀ
   *   第一步按行做 1D：tmp[y][u] = Σ_x T[u][x] · f[y][x]
   *   第二步按列做 1D：F[v][u]  = Σ_y T[v][y] · tmp[y][u]
   * 全程用 double 累加，仅在最后写回 Float32Array。
   *
   * @param {Float32Array|Float64Array|number[]} pixels 64 个亮度值，行优先
   * @returns {Float32Array} 64 个 DCT 系数，行优先（index = v*8+u）
   */
  DctStego.dct8x8 = function (pixels) {
    if (!pixels || typeof pixels.length !== 'number' || pixels.length !== BLOCK_PIXELS) {
      throw new TypeError('dct8x8: 需要传入长度恰好为 64 的亮度数组，当前为 ' +
        (pixels && pixels.length));
    }
    var tmp = new Float64Array(BLOCK_PIXELS); // 行变换中间结果
    var out = new Float32Array(BLOCK_PIXELS);
    var x, y, u, v, s, Tu, Tv;

    // 第一步：逐行 1D DCT
    for (y = 0; y < N; y++) {
      var rowBase = y * N;
      for (u = 0; u < N; u++) {
        Tu = COS[u];
        s = 0;
        for (x = 0; x < N; x++) {
          s += Tu[x] * pixels[rowBase + x];
        }
        tmp[rowBase + u] = s;
      }
    }

    // 第二步：逐列 1D DCT
    for (u = 0; u < N; u++) {
      for (v = 0; v < N; v++) {
        Tv = COS[v];
        s = 0;
        for (y = 0; y < N; y++) {
          s += Tv[y] * tmp[y * N + u];
        }
        out[v * N + u] = s;
      }
    }
    return out;
  };

  /**
   * 8×8 二维 IDCT（DCT-II 的逆变换，等价于 DCT-III）。
   * 因为 T 正交归一（T·Tᵀ = I），逆变换就是把两次乘法转置过来：
   *   f = Tᵀ · F · T
   *   第一步按列：tmp[y][u] = Σ_v T[v][y] · F[v][u]
   *   第二步按行：f[y][x]   = Σ_u T[u][x] · tmp[y][u]
   *
   * @param {Float32Array|Float64Array|number[]} coeffs 64 个 DCT 系数，行优先
   * @returns {Float32Array} 64 个亮度值（未取整，范围一般落在 0~255 附近）
   */
  DctStego.idct8x8 = function (coeffs) {
    if (!coeffs || typeof coeffs.length !== 'number' || coeffs.length !== BLOCK_PIXELS) {
      throw new TypeError('idct8x8: 需要传入长度恰好为 64 的系数数组，当前为 ' +
        (coeffs && coeffs.length));
    }
    var tmp = new Float64Array(BLOCK_PIXELS);
    var out = new Float32Array(BLOCK_PIXELS);
    var x, y, u, v, s, Tu, Tv;

    // 第一步：按列做转置乘法
    for (u = 0; u < N; u++) {
      for (y = 0; y < N; y++) {
        s = 0;
        for (v = 0; v < N; v++) {
          Tv = COS[v];
          s += Tv[y] * coeffs[v * N + u];
        }
        tmp[y * N + u] = s;
      }
    }

    // 第二步：按行做转置乘法
    for (y = 0; y < N; y++) {
      var rowBase = y * N;
      for (x = 0; x < N; x++) {
        s = 0;
        for (u = 0; u < N; u++) {
          Tu = COS[u];
          s += Tu[x] * tmp[rowBase + u];
        }
        out[rowBase + x] = s;
      }
    }
    return out;
  };

  /**
   * 在整块 Tile 的 ImageData 上嵌入比特流，返回**新的** ImageData（不修改入参）。
   *
   * 流程（逐 8×8 块）：
   *   1. 读块内 64 个像素，算亮度 Y = 0.299R+0.587G+0.114B；
   *   2. 对 Y 做 DCT 得到 64 个系数；
   *   3. 用该块的亮度方差算自适应 margin；
   *   4. 对 6 个系数对依次做符号调制（每块 6 比特）；
   *   5. IDCT 回空域，ΔY = Y' − Y，把 ΔY 同时加到 R/G/B；
   *   6. clamp 到 [0,255] 并四舍五入。
   * 比特用尽后剩余块保持原样（不引入无谓扰动）。
   *
   * @param {ImageData} tileImageData 宽高必须是 8 的整数倍
   * @param {Array<boolean|number>} bitArray 待嵌入比特
   * @param {{marginMin?:number, marginGain?:number, marginMax?:number, pairs?:number[][]}} [options]
   * @returns {ImageData} 新的 ImageData
   */
  DctStego.embedBitsInTile = function (tileImageData, bitArray, options) {
    if (!isImageData(tileImageData)) {
      throw new TypeError('embedBitsInTile: 需要传入有效的 ImageData');
    }
    var bits = normalizeBits(bitArray, 'embedBitsInTile');
    var geo = resolveGeometry(tileImageData.width, tileImageData.height, 'embedBitsInTile');
    var opt = resolveOptions(options, 'embedBitsInTile');
    var np = opt.pairs.length;                 // 本次实际使用的系数对数
    var blocksTotal = geo.blocksX * geo.blocksY;
    var capacity = blocksTotal * np;
    if (bits.length > capacity) {
      throw new RangeError('embedBitsInTile: 比特数超出容量，' + geo.w + 'x' + geo.h +
        ' 的 Tile 最多承载 ' + capacity + ' 比特（' + blocksTotal +
        ' 块 × ' + np + '），实际传入 ' + bits.length);
    }

    var w = geo.w, h = geo.h;
    var src = tileImageData.data;
    var need = w * h * 4;
    if (src.length < need) {
      throw new RangeError('embedBitsInTile: ImageData 数据长度不足，需要 ' + need +
        '，实际 ' + src.length);
    }

    // 拷贝一份再改，保证入参不被修改
    var outData = new Uint8ClampedArray(need);
    outData.set(src.subarray(0, need));

    var y = new Float64Array(BLOCK_PIXELS);
    var coeffs, yPrime, r, c, k, d;
    var bitCursor = 0;

    outer:
    for (var by = 0; by < geo.blocksY; by++) {
      for (var bx = 0; bx < geo.blocksX; bx++) {
        if (bitCursor >= bits.length) break outer; // 比特用尽，后续块不动
        var baseX = bx * N, baseY = by * N;

        // 1) 取亮度
        for (r = 0; r < N; r++) {
          for (c = 0; c < N; c++) {
            var p = ((baseY + r) * w + (baseX + c)) * 4;
            y[r * N + c] = 0.299 * outData[p] + 0.587 * outData[p + 1] + 0.114 * outData[p + 2];
          }
        }

        // 2) DCT
        coeffs = DctStego.dct8x8(y);

        // 3) 自适应 margin（按本块的纹理方差）
        var margin = adaptiveMargin(varianceOf(y, BLOCK_PIXELS), opt);

        // 4) 逐对比特调制（对数由 options.pairs 决定：6 对=384bit，4 对=256bit 低频回退）
        for (k = 0; k < np && bitCursor < bits.length; k++, bitCursor++) {
          var pair = opt.pairs[k];
          modulatePair(coeffs, idx(pair[0], pair[1]), idx(pair[2], pair[3]), bits[bitCursor], margin);
        }

        // 5) IDCT 回空域，把 ΔY 加到三个通道
        yPrime = DctStego.idct8x8(coeffs);
        for (r = 0; r < N; r++) {
          for (c = 0; c < N; c++) {
            var q = ((baseY + r) * w + (baseX + c)) * 4;
            d = yPrime[r * N + c] - y[r * N + c];
            // 三通道同加 ΔY：权重和为 1，等价于"只平移亮度"
            outData[q] = clampByte(outData[q] + d);
            outData[q + 1] = clampByte(outData[q + 1] + d);
            outData[q + 2] = clampByte(outData[q + 2] + d);
          }
        }
      }
    }

    return makeImageData(outData, w, h);
  };

  /**
   * 从 Tile 的 ImageData 中提取 bitCount 个比特。
   * 提取完全是嵌入的逆运算：逐块 DCT，只看系数对的大小关系
   *   a > b → true(1)，否则 → false(0)
   * 不需要 margin 参数（margin 只在嵌入时用来拉开距离）。
   *
   * @param {ImageData} tileImageData
   * @param {number} bitCount 期望提取的比特数（0 ~ 容量）
   * @param {{pairs?:number[][]}} [options] 只需与嵌入时一致的 pairs
   * @returns {boolean[]} 长度恰好为 bitCount
   */
  DctStego.extractBitsFromTile = function (tileImageData, bitCount, options) {
    if (!isImageData(tileImageData)) {
      throw new TypeError('extractBitsFromTile: 需要传入有效的 ImageData');
    }
    if (!isFiniteNumber(bitCount) || bitCount < 0 || Math.floor(bitCount) !== bitCount) {
      throw new RangeError('extractBitsFromTile: bitCount 必须是 >= 0 的整数，当前为 ' + bitCount);
    }
    var geo = resolveGeometry(tileImageData.width, tileImageData.height, 'extractBitsFromTile');
    var opt = resolveOptions(options, 'extractBitsFromTile');
    var np = opt.pairs.length;
    var capacity = geo.blocksX * geo.blocksY * np;
    if (bitCount > capacity) {
      throw new RangeError('extractBitsFromTile: 请求的比特数超出容量，最大 ' + capacity +
        '，实际请求 ' + bitCount);
    }
    if (bitCount === 0) return [];

    var w = geo.w;
    var src = tileImageData.data;
    var need = w * geo.h * 4;
    if (src.length < need) {
      throw new RangeError('extractBitsFromTile: ImageData 数据长度不足，需要 ' + need +
        '，实际 ' + src.length);
    }

    var y = new Float64Array(BLOCK_PIXELS);
    var out = new Array(bitCount);
    var cursor = 0;
    var r, c, k;

    outer:
    for (var by = 0; by < geo.blocksY; by++) {
      for (var bx = 0; bx < geo.blocksX; bx++) {
        if (cursor >= bitCount) break outer;
        var baseX = bx * N, baseY = by * N;

        for (r = 0; r < N; r++) {
          for (c = 0; c < N; c++) {
            var p = ((baseY + r) * w + (baseX + c)) * 4;
            y[r * N + c] = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
          }
        }
        var coeffs = DctStego.dct8x8(y);

        for (k = 0; k < np && cursor < bitCount; k++, cursor++) {
          var pair = opt.pairs[k];
          var a = coeffs[idx(pair[0], pair[1])];
          var b = coeffs[idx(pair[2], pair[3])];
          out[cursor] = a > b; // 严格大于：相等时判 0（与嵌入侧"b ≥ a 表示 0"一致）
        }
      }
    }
    return out;
  };

  // ---- 对外常量（便于测试与调参，不属于函数契约的一部分）----
  DctStego.BITS_PER_BLOCK = BITS_PER_BLOCK;
  DctStego.BLOCK_SIZE = N;
  DctStego.DEFAULT_PAIRS = DEFAULT_PAIRS;
  DctStego.LUMA_QUANT_TABLE = LUMA_QUANT_TABLE;
  DctStego.DEFAULT_MARGIN = {
    marginMin: DEFAULT_MARGIN_MIN,
    marginGain: DEFAULT_MARGIN_GAIN,
    marginMax: DEFAULT_MARGIN_MAX
  };

  global.DctStego = DctStego;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
