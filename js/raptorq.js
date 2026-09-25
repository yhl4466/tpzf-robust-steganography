/**
 * raptorq.js —— 抗丢包纠删码内核（window.RaptorQ）
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致）：
 *   1. 零外部依赖：只用原生 JS（无 npm / CDN / WebAssembly）；
 *   2. 不使用 ES Module：没有 import / export，普通 script 标签引入，
 *      file:// 双击本地打开即可运行；
 *   3. 挂载到全局命名空间 window.RaptorQ（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * ================================================================
 * 一、最终采用的方案
 * ================================================================
 *   名称：**系统化 Reed–Solomon 擦除码**（求值型构造）
 *         域：GF(2^16)，本原多项式 x^16 + x^12 + x^3 + x + 1 = 0x1100B
 *         编码点：x_i = i + 1（i = 0 … 65534，即 GF(2^16) 的全部非零元素）
 *         参考：RS 码经典构造（Reed & Solomon 1960）；求值型系统化 RS 与
 *               重心/Lagrange 擦除解码见 RFC 5510 §8、以及任何编码理论教材。
 *
 *   数学结构：把 K 个源分片看成某个次数 < K 的多项式 P 在点 x_0…x_{K-1}
 *   上的取值。第 i 个编码符号就是 P(x_i)：
 *       - i <  K  → P(x_i) = 源分片 i          （完全系统性，零运算）
 *       - i >= K  → P(x_i) = Σ_j L_j(x_i)·分片_j，L_j 是 Lagrange 基
 *   因为 [N,K] RS 码是 MDS 码，**任意 K 个符号都能唯一确定 P**，
 *   所以"发 2K 个、随机收到 K 个"必然可解 —— 这就是本项目的核心约束。
 *
 * ================================================================
 * 二、为什么不用完整 RaptorQ / Raptor / LT（决策依据）
 * ================================================================
 *   项目硬约束是：N = 2K 固定（载体容量上限），提取端只收到 K 个符号，
 *   即**零开销（zero overhead）**译码，且 AC10 还要求"前一半全丢"这种
 *   极端图案、AC11 要求 K=1/2/3 也 100% 成功。在此约束下：
 *   1. 完整 RaptorQ（RFC 6330）的中间符号数 L = K + S + H > K，
 *      收到 K < L 个符号时方程组欠定，**零开销在信息论上就不可解**，
 *      只能提高 N（本项目不允许）。
 *   2. Raptor / LT（RFC 5053、Luby 2002）是喷泉码，靠 Robust Soliton
 *      度分布 + 置信传播（peeling）译码，需要 K + O(√K·ln²(K/δ)) 个符号，
 *      零开销时"可剥离"图几乎必然存在停滞核，成功率随 K 迅速趋近 0。
 *      （tests/verify-raptorq.node.js 里有同参数下的实测对照实验。）
 *   3. 稀疏 LDPC 在恰好码率（丢 50%）处处于阈值上，有限码长必有可观
 *      失败率，同样无法满足 K=2/3 的小尺寸 100% 要求。
 *   结论：在"固定 2K 开销 + 零开销译码"下，唯一稳妥的选择是 MDS 码。
 *   RS 是唯一能在 O(K²) 内实现 MDS 的实用结构（GF(2^16) 提供 65535 个
 *   互异编码点，足够支撑 N = 2K ≤ 8192）。
 *
 * ================================================================
 * 三、相对完整 RaptorQ (RFC 6330) 的简化点
 * ================================================================
 *   1. 无 LDPC/HDPC 预编码、无 inactivation 解码：直接 MDS，零开销必可解，
 *      代价是复杂度从 O(K)/线性时间升到 O(K²)（K ≤ 4096 完全够用）。
 *   2. 编码索引 i 有上限 65534（GF(2^16) 非零元素个数），不是"无上限"；
 *      本项目的嵌入端只用 i < 2K ≤ 8192，余量 8 倍。
 *   3. 码率固定 1/2（N=2K）；若要更多冗余，i 可以继续取到 65534，
 *      但需要更多 Tile 承载（受 N=2K 约束，本项目不使用）。
 *   4. symbolSize 必须是正偶数（内部按 16 位 lane 运算）。典型值
 *      64~1024 都是偶数，见第五节说明。
 *   5. GF(2^16) 运算用 log/exp 查表（2 张表共约 588KB），不是 RaptorQ 的
 *      八元组/GF(256) 运算；符号大小不影响正确性，只影响耗时。
 *
 * ================================================================
 * 四、复杂度与适用 K 范围
 * ================================================================
 *   设 W = symbolSize / 2（16 位 lane 数）。
 *     编码：预计算 O(K²)（每个源点的 M'(x_j)，一次性）；
 *           每个校验符号 O(K) 求系数 + O(K·W) 应用 → 全量 2K 个符号
 *           共约 O(K²·W) 次 GF 乘（系统符号零成本）。
 *     解码：预计算 O(K²)；每个缺失分片 O(K + K·W) →
 *           最坏（缺一半）约 O(K²·W/2) 次 GF 乘。
 *   适用 K：1 ~ 4096（测试覆盖 1/2/3/10/100/200/500/2000/4096）。
 *     建议 K²·W ≤ 1e9，例如 K=4096 配 symbolSize ≤ 128。
 *
 * ================================================================
 * 五、symbolSize 必须为偶数的原因
 * ================================================================
 *   域运算是 16 位的。奇数长度符号的最后 1 字节无法单独作为一个
 *   GF(2^16) 元素参与线性运算（乘法结果会溢出到高 8 位，写回时丢失），
 *   会导致编码/解码不一致。因此这里明确拒绝奇数 symbolSize，
 *   而不是悄悄产生错误结果。典型 symbolSize（64/128/256/512/1024）都是偶数。
 */
(function (global) {
  'use strict';

  // ============================================================
  // GF(2^16) 有限域
  // ============================================================
  var GF_BITS = 16;
  var GF_SIZE = 1 << GF_BITS;      // 65536
  var GF_ORDER = GF_SIZE - 1;      // 65535 个非零元素（乘法群阶）
  var GF_POLY = 0x1100b;           // x^16 + x^12 + x^3 + x + 1
  var MAX_SYMBOL_INDEX = GF_ORDER - 1; // 65534；编码点 x_i = i+1 ∈ [1, 65535]

  // 零元素在"扩展 log 表"里的哨兵下标：让 0 也能走进统一的查表乘法，
  // 避免内层循环里出现分支。见 buildGfTables 与 gfMulTable 的说明。
  var ZERO_LOG = 2 * GF_ORDER;     // 131070
  // EXPZ 前 2*GF_ORDER 项是正常的 exp 表（双倍长度以免取模），
  // 之后 GF_ORDER 项全为 0，专门用于"零元素"这一路查表。
  var EXPZ = new Uint16Array(ZERO_LOG + GF_ORDER); // 196605
  var LOG = new Uint16Array(GF_SIZE);

  (function buildGfTables() {
    var v = 1;
    for (var i = 0; i < GF_ORDER; i++) {
      EXPZ[i] = v;
      LOG[v] = i;
      v <<= 1;
      if (v & GF_SIZE) v ^= GF_POLY; // 超过 16 位则模掉本原多项式
    }
    // 走满 65535 步后必须回到 1，否则说明 2 不是本原元（多项式不可约/非本原），
    // LOG 表会有空洞并导致静默错误 —— 这里直接拒绝加载。
    if (v !== 1) {
      throw new Error('raptorq: GF(2^16) 本原多项式 0x' + GF_POLY.toString(16) + ' 自检失败');
    }
    for (var k = GF_ORDER; k < ZERO_LOG; k++) EXPZ[k] = EXPZ[k - GF_ORDER];
    // [ZERO_LOG, ZERO_LOG + GF_ORDER) 区间保持 0（Uint16Array 初值即 0）
  })();

  function isFiniteInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  /** 普通域乘（带 0 判断，供预计算等非热点路径使用） */
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXPZ[LOG[a] + LOG[b]];
  }

  /** 域逆元 */
  function gfInv(a) {
    if (a === 0) throw new RangeError('gfInv: 0 没有乘法逆元');
    return EXPZ[GF_ORDER - LOG[a]];
  }

  /*
   * 零元素在 log 域的哨兵约定（贯穿本文件所有热点循环）：
   * 把一段字节按小端序拆成 16 位 lane 后，lane 值 0 记成 ZERO_LOG，
   * 于是内层乘法可以写成一句无分支查表：
   *     acc ^= EXPZ[coefLog + laneLog]
   * （coefLog ∈ [0,65534]，laneLog ≤ ZERO_LOG = 131070，和 ≤ 196604 < EXPZ.length）
   */

  // ============================================================
  // 对外命名空间
  // ============================================================
  var RaptorQ = {};

  /**
   * 创建编码器。
   *
   * @param {Uint8Array} srcBytes 原始字节流
   * @param {number} K 原始分片数量（>= 1）
   * @param {number} symbolSize 每片字节数（正偶数），调用方保证
   *        ceil(srcBytes.length / K) <= symbolSize
   * @returns {{K:number, symbolSize:number, generateSymbol:function}}
   */
  RaptorQ.createEncoder = function (srcBytes, K, symbolSize) {
    if (!srcBytes || Object.prototype.toString.call(srcBytes) !== '[object Uint8Array]') {
      throw new TypeError('createEncoder: srcBytes 必须是 Uint8Array');
    }
    if (!isFiniteInt(K) || K < 1) {
      throw new RangeError('createEncoder: K 必须是 >= 1 的整数，当前为 ' + K);
    }
    if (K > 65535) {
      throw new RangeError('createEncoder: K 超出本实现上限 65535');
    }
    if (!isFiniteInt(symbolSize) || symbolSize < 2 || (symbolSize & 1) !== 0) {
      throw new RangeError('createEncoder: symbolSize 必须是 >= 2 的偶数（内部按 16 位 lane 运算），当前为 ' + symbolSize);
    }
    var capacity = K * symbolSize;
    if (srcBytes.length > capacity) {
      throw new RangeError('createEncoder: 源数据 ' + srcBytes.length + ' 字节超过 K*symbolSize = ' + capacity);
    }

    var W = symbolSize >> 1; // 每个符号的 16 位 lane 数

    // ---- 源分片 → lane 对数表：lane-major 存储（lane w 的 K 个分片连续存放），
    //      这样内层循环沿着 K 连续扫描，缓存友好 ----
    var srcLog = new Uint32Array(W * K);
    for (var w2 = 0; w2 < W; w2++) {
      var base = w2 * K;
      for (var j = 0; j < K; j++) {
        var p = j * symbolSize + (w2 << 1);
        var lo = p < srcBytes.length ? srcBytes[p] : 0;
        var hi = (p + 1) < srcBytes.length ? srcBytes[p + 1] : 0;
        var v = lo | (hi << 8);
        srcLog[base + j] = v === 0 ? ZERO_LOG : LOG[v];
      }
    }

    // ---- 预计算每个源点的 sMp[j] = -log(M'(x_j)) mod (2^16-1) ----
    // M'(x_j) = Π_{m≠j} (x_j XOR x_m)  —— 因为域特征为 2，减法就是 XOR
    var pts = new Uint16Array(K);
    for (var t = 0; t < K; t++) pts[t] = t + 1;
    var sMp = new Uint16Array(K);
    for (var j2 = 0; j2 < K; j2++) {
      var xj = pts[j2];
      var prod = 1;
      for (var m = 0; m < K; m++) {
        if (m === j2) continue;
        prod = gfMul(prod, xj ^ pts[m]);
      }
      sMp[j2] = (GF_ORDER - LOG[prod]) % GF_ORDER;
    }

    var cLog = new Uint16Array(K); // 复用缓冲，避免每次 generateSymbol 重新分配

    /**
     * 生成第 i 个编码符号。
     * i < K 时直接返回系统分片；i >= K 时按 Lagrange 基求值。
     */
    function generateSymbol(i) {
      if (!isFiniteInt(i) || i < 0) {
        throw new RangeError('generateSymbol: i 必须是非负整数，当前为 ' + i);
      }
      if (i > MAX_SYMBOL_INDEX) {
        throw new RangeError('generateSymbol: i 超出 GF(2^16) 编码点上限（0~' +
          MAX_SYMBOL_INDEX + '），当前为 ' + i);
      }
      var out = new Uint8Array(symbolSize);

      // 系统符号：分片本身（尾部不足补零）
      if (i < K) {
        var start = i * symbolSize;
        var n = Math.min(symbolSize, srcBytes.length - start);
        if (n > 0) out.set(srcBytes.subarray(start, start + n));
        return out;
      }

      // 校验符号：P(x) = Σ_j L_j(x)·分片_j，L_j(x) = M(x) / ((x XOR x_j)·M'(x_j))
      var x = i + 1;
      var logMx = 0;
      for (var a = 0; a < K; a++) logMx += LOG[x ^ pts[a]];
      logMx %= GF_ORDER; // log M(x) = Σ log(x XOR x_j)，在 65535 阶乘法群里取模
      for (var b = 0; b < K; b++) {
        var c = logMx + sMp[b] - LOG[x ^ pts[b]];
        if (c < 0) c += GF_ORDER;
        else if (c >= GF_ORDER) c -= GF_ORDER;
        cLog[b] = c;
      }

      for (var w3 = 0; w3 < W; w3++) {
        var bb = w3 * K;
        var acc = 0;
        for (var j3 = 0; j3 < K; j3++) {
          acc ^= EXPZ[cLog[j3] + srcLog[bb + j3]]; // 无分支查表乘法 + 累加(XOR)
        }
        out[w3 << 1] = acc & 0xFF;
        out[(w3 << 1) + 1] = acc >>> 8;
      }
      return out;
    }

    return {
      K: K,
      symbolSize: symbolSize,
      generateSymbol: generateSymbol
    };
  };

  /**
   * 创建解码器（增量收符号，最后 decode）。
   *
   * @param {number} K 原始分片数量
   * @param {number} symbolSize 每片字节数（正偶数，须与编码端一致）
   * @returns {{addSymbol:function, receivedCount:function, decode:function}}
   */
  RaptorQ.createDecoder = function (K, symbolSize) {
    if (!isFiniteInt(K) || K < 1) {
      throw new RangeError('createDecoder: K 必须是 >= 1 的整数，当前为 ' + K);
    }
    if (K > 65535) {
      throw new RangeError('createDecoder: K 超出本实现上限 65535');
    }
    if (!isFiniteInt(symbolSize) || symbolSize < 2 || (symbolSize & 1) !== 0) {
      throw new RangeError('createDecoder: symbolSize 必须是 >= 2 的偶数，当前为 ' + symbolSize);
    }

    var W = symbolSize >> 1;
    var store = new Map(); // i -> Uint8Array（副本）
    var order = [];        // 记录接收顺序（便于诊断）

    function addSymbol(i, bytes) {
      if (!isFiniteInt(i) || i < 0 || i > MAX_SYMBOL_INDEX) {
        throw new RangeError('addSymbol: 符号索引 i 非法（应为 0~' + MAX_SYMBOL_INDEX + '），当前为 ' + i);
      }
      if (!bytes || Object.prototype.toString.call(bytes) !== '[object Uint8Array]') {
        throw new TypeError('addSymbol: bytes 必须是 Uint8Array');
      }
      if (bytes.length !== symbolSize) {
        throw new RangeError('addSymbol: bytes 长度必须是 ' + symbolSize + '，当前为 ' + bytes.length);
      }
      if (!store.has(i)) order.push(i);
      store.set(i, bytes.slice()); // 存副本，避免调用方后续修改影响解码
    }

    function receivedCount() {
      return store.size;
    }

    /**
     * 尝试解码。符号不足 K 个返回 null；已解出时返回长度 K*symbolSize 的
     * 字节流（尾部为补零填充，调用方按需截断）。失败后可以继续 addSymbol 再调用。
     */
    function decode() {
      if (store.size < K) return null;

      // 任取 K 个已收符号（MDS 性质：任意 K 个都足以确定 P）
      var idx = order.slice().sort(function (p, q) { return p - q; });
      if (idx.length > K) idx.length = K;
      var R = idx.length;

      // 接收点
      var rpts = new Uint16Array(R);
      var r;
      for (r = 0; r < R; r++) rpts[r] = idx[r] + 1;

      // 接收符号 → lane 对数表（lane-major）
      var yLog = new Uint32Array(W * R);
      for (var w = 0; w < W; w++) {
        var lb = w * R;
        for (r = 0; r < R; r++) {
          var bytes = store.get(idx[r]);
          var p = w << 1;
          var v = bytes[p] | (bytes[p + 1] << 8);
          yLog[lb + r] = v === 0 ? ZERO_LOG : LOG[v];
        }
      }

      // 每个接收点的 sMpr[r] = -log(M'(x_r))
      var sMpr = new Uint16Array(R);
      for (r = 0; r < R; r++) {
        var xr = rpts[r];
        var prod = 1;
        for (var r2 = 0; r2 < R; r2++) {
          if (r2 === r) continue;
          prod = gfMul(prod, xr ^ rpts[r2]);
        }
        sMpr[r] = (GF_ORDER - LOG[prod]) % GF_ORDER;
      }

      var out = new Uint8Array(K * symbolSize);
      var known = new Uint8Array(K);
      for (r = 0; r < R; r++) {
        if (idx[r] < K) {
          known[idx[r]] = 1;
          out.set(store.get(idx[r]), idx[r] * symbolSize); // 系统符号直接可用
        }
      }

      // 缺失的源分片：用接收点上的 Lagrange 插值在 x_j 处求值
      var cLog = new Uint16Array(R);
      for (var j = 0; j < K; j++) {
        if (known[j]) continue;
        var xj = j + 1;
        var logMxj = 0;
        for (r = 0; r < R; r++) logMxj += LOG[xj ^ rpts[r]];
        logMxj %= GF_ORDER;
        for (r = 0; r < R; r++) {
          var cc = logMxj + sMpr[r] - LOG[xj ^ rpts[r]];
          if (cc < 0) cc += GF_ORDER;
          else if (cc >= GF_ORDER) cc -= GF_ORDER;
          cLog[r] = cc;
        }
        var dest = j * symbolSize;
        for (var w2 = 0; w2 < W; w2++) {
          var bb = w2 * R;
          var acc = 0;
          for (r = 0; r < R; r++) {
            acc ^= EXPZ[cLog[r] + yLog[bb + r]];
          }
          out[dest + (w2 << 1)] = acc & 0xFF;
          out[dest + (w2 << 1) + 1] = acc >>> 8;
        }
      }
      return out;
    }

    return {
      addSymbol: addSymbol,
      receivedCount: receivedCount,
      decode: decode
    };
  };

  // ---- 附加常量（便于测试/调参，不属于函数契约的一部分）----
  RaptorQ.GF = {
    bits: GF_BITS,
    poly: GF_POLY,
    size: GF_SIZE,
    order: GF_ORDER,
    maxSymbolIndex: MAX_SYMBOL_INDEX,
    multiply: gfMul,
    inverse: gfInv
  };

  global.RaptorQ = RaptorQ;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
