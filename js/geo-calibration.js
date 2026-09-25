/**
 * geo-calibration.js —— 几何标尺（window.GeoCalibration）
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致）：
 *   1. 零外部依赖：只用原生 JS + Web API；
 *   2. 不使用 ES Module：没有 import / export，普通 script 标签引入；
 *   3. 挂载到全局命名空间 window.GeoCalibration（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * 依赖：packet.js（CRC32）、raptorq.js（GF(2^16) RS 纠删码）、image-utils.js（缩放）
 *
 * ================================================================
 * 一、为什么需要"标尺"
 * ================================================================
 *   隐写载荷是按 64×64 Tile + 8×8 DCT 块组织的，这套网格锚定在图像左上角。
 *   一旦图像被**缩放**（社交平台很常见），网格间距整体变化，提取端按固定的
 *   64/8 网格去切就完全对不上，载荷必然读不出来。
 *   解决办法：在隐写图里再埋一把"尺子"，让提取端先量出缩放倍率，把图缩放
 *   回原始尺寸再按标准网格提取。
 *
 * ================================================================
 * 二、最终方案：A（正弦模板标尺）+ 扩频载荷
 * ================================================================
 *   方案 A（选中）：在亮度 Y 上叠加
 *     · 双导频：sin(2π(x+y)/32) + sin(2π(x+y)/16)（周期 32/16 像素，2:1 频率对），
 *       每根振幅 1.2（合计 PSNR ≈ 44.5 dB）
 *     · 载荷：与导频同方向的 ±1 扩频码（288 片），振幅 1.0
 *   选 A 而不是 B（标尺带）/ C（低频峰对）的理由：
 *     · B 把信息集中在上下左右 4 像素的窄带里，一旦被裁切/涂抹就彻底失效，
 *       而且窄带里塞 96 bit 需要很强的调制，PSNR 很难达标；
 *     · C 需要较高频率的峰对，JPEG 量化会先把它们抹掉；
 *     · A 把信息铺满整幅图，能量低、分布广，天然抗裁切（少了 1/N 的像素
 *       只是让相关峰值下降一点），也能扛 JPEG 量化（相关增益 ≈ √N）。
 *
 *   为什么导频用 32/16 而不是需求里建议的 64：实测在平滑照片内容上，周期 64
 *   这个频段的"图像自身能量"与导频相当（峰背比 z 只有 0.89），而周期 32 的
 *   峰背比是 4.2、周期 16 是 7.4。换成 32/16 后导频落在自然图像能量更低的
 *   频段，检测稳定；代价是可测缩放范围变成约 [0.4, 3.0]，仍覆盖 0.5×~1.25×。
 *
 *   为什么"缩放不变"：所有分量都以"每像素周期"为单位定义，缩放 s 倍后
 *   周期变成 32s，提取端只需找出真实周期 P，即可得到 s = P/32，
 *   再由当前尺寸反推原始尺寸：W0 = round(W1 / s) = round(W1 · 32 / P)。
 *   也就是说**尺寸信息本身就是尺度不变的**（不需要知道 s 的绝对值）。
 *
 * ================================================================
 * 二之二、对外 API 一览
 * ================================================================
 *   embedScale(imageData, width, height)   → 叠加标尺，返回**新的** ImageData
 *   extractScale(imageData)                → 读出原始尺寸 {width,height} 或 null
 *   generateScalePattern(width, height, amplitude)
 *                                          → Float32Array(width*height)：
 *                                            按给定尺寸确定性重建标尺图案（亮度偏移量）
 *   removeScale(imageData, origWidth, origHeight)
 *                                          → **干扰对消**：减去标尺，返回新的 ImageData
 *                                            （残留幅度 α 记在 GeoCalibration.lastAlpha）
 *   psnr(a, b)                             → PSNR(dB)，自测与页面提示用
 *
 * ================================================================
 * 三、载荷编码（12 字节 → 36 字节）
 * ================================================================
 *   明文 12 字节：
 *     [0]     version = 1
 *     [1]     format  = 0
 *     [2..3]  width   uint16 BE
 *     [4..5]  height  uint16 BE
 *     [6..7]  reserved = 0
 *     [8..11] CRC32   覆盖前 8 字节
 *   纠删码：复用 raptorq.js 的系统化 RS（GF(2^16)），K=6 个 2 字节符号、
 *   N=18 → 36 字节（3 倍冗余）→ 288 bit → 288 片 ±1 扩频码。
 *   为什么不用简单三重复：RS 能在部分符号损坏时纠正，比"三取二"更强。
 *
 * ================================================================
 * 四、提取流程
 * ================================================================
 *   1. 预处理：Y 只减去**全局均值**（不能用 3×3 局部均值高通 —— 导频周期
 *      32/16 属于低频，局部高通会把导频本身一起抹掉）；
 *   2. 频率扫描：对候选周期 P 计算复相关 |Σ h(x,y)·e^{-i2π(x+y)/P}|，
 *      取最大峰并用抛物线插值细化 → P*；粗扫（步长 1、可抽样）
 *      + 细扫（步长 0.05）+ 次导频复核（步长 0.005，按 2:1 关系换算成主周期）；
 *      谱表下限取 PERIOD_MIN/2，保证 0.5× 时"次导频 8px"也能参与 2:1 配对；
 *   3. 由 P 得到缩放倍率 s = P / REF_PERIOD → 原始尺寸；导频沿对角线方向，行列都能量到周期；
 *   4. 载荷交叉校验：把图按估计尺寸还原后，按 (x+y) mod 288 分片求均值，
 *      符号给比特 → RS 解码 → CRC 通过则用载荷里的 W/H（更精确）；
 *   5. 两级结果不一致或都失败 → 返回 null。
 */
(function (global) {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  // 参考周期：主导频 32、次导频 16（2:1 频率对）。
  //   为什么不用需求里建议的 1/64：实测在平滑照片内容上，周期 64 这个频段的
  //   "图像自身能量"与导频相当（峰背比 z 只有 0.89），而周期 32 的峰背比是 6.0。
  //   换成 32/16 后导频落在自然图像能量更低的频段，检测稳定；代价是可测缩放
  //   范围变成约 [0.4, 3.0]，仍覆盖 0.5x~1.25x 的全部需求。
  var REF_PERIOD = 32;          // 主导频周期（原始像素）
  var REF_PERIOD2 = 16;         // 次导频（REF_PERIOD 的一半，构成 2:1 频率对）
  var PILOT_AMP = 1.2;          // 每根导频的振幅（两根合计功率 2×A²/2，PSNR ≈ 44.5dB）
  var CHIP_AMP = 1.0;           // 扩频载荷振幅
  var PAYLOAD_BYTES = 12;       // 明文长度
  var RS_SYMBOL_SIZE = 2;       // 2 字节 = 1 个 GF(2^16) 符号
  var RS_K = PAYLOAD_BYTES / RS_SYMBOL_SIZE;  // 6
  var RS_N = 18;                // 3 倍冗余
  var RS_BYTES = RS_N * RS_SYMBOL_SIZE;       // 36
  var CHIP_LEN = RS_BYTES * 8;                // 288
  // 每片扩频码沿对角线占用 CHIP_SPREAD 个像素位置。
  //   标尺估出的缩放在 1.0 附近总有 ~0.2% 误差，512 图上对角坐标最大差 ~2 个位置，
  //   若"一位像素一片"，这点错位就会让整段扩频码失配；把每片拉长到 8 个位置后，
  //   再配合下面的 8 种对齐偏移搜索，就能容忍 ±4 个位置的错位。
  var CHIP_SPREAD = 8;
  // 干扰对消时残留振幅 α 的上限：α=1 表示"标尺被原样重建"，超过 1.5 只可能是
  // 图像内容与导频偶然强相关导致的拟合异常，此时宁可少减也不要过减（过减会引入新失真）。
  var ALPHA_MAX = 1.5;

  /**
   * 对角块 → 扩频片 的映射表（长度 CHIP_LEN×CHIP_SPREAD = 2304，每片刻 8 个块）。
   *   用**伪随机置换**而不是"顺序分配"：顺序分配会让码型出现周期 8 的强谐波，
   *   其 2 次/4 次谐波正好落在导频周期 16/32 上，实测会把标尺检测带偏。
   *   随机置换后码型接近白噪声，不会再污染导频频点。
   */
  var CHIP_BLOCK_MAP = (function () {
    var total = CHIP_LEN * CHIP_SPREAD;
    var map = new Int16Array(total);
    var i, j;
    for (i = 0; i < total; i++) map[i] = i % CHIP_LEN;
    var a = 0x9e3779b9;
    function rnd() {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    }
    for (i = total - 1; i > 0; i--) {
      j = rnd() % (i + 1);
      var tmp = map[i]; map[i] = map[j]; map[j] = tmp;
    }
    return map;
  })();

  var PERIOD_MIN = 10;          // 主周期候选下限（可测缩放上限 ~3.2×）
  var PERIOD_MAX = 160;         // 周期搜索上限（可测缩放下限 ~0.2×）
  // 谱表的下限：比 PERIOD_MIN 还低一半。
  //   原因（0.5× 实测踩到的坑）：缩放 0.5× 后主导频周期 32→16、次导频 16→8，
  //   而次导频 8 低于 PERIOD_MIN，如果谱表也从 10 开始，P=16 的"2:1 配对"
  //   就查不到 P/2=8，只按单频打分（z=2.95）；而"内容谐波" P=31.5 反而能配到
  //   真实的 16（1.27×2.95=3.75）胜出 → 估出 266×266 而不是 256×256。
  //   把谱表下探到 5（配对时仍只在 P≥PERIOD_MIN 里挑主周期）后，
  //   P=16 得分 3.38×4.02=13.6，稳赢，尺寸读回 512。
  var PERIOD_SCAN_MIN = PERIOD_MIN / 2;
  // 粗扫的**周期步长**必须亚像素：导频在周期轴上的相关峰只有约 ±0.2px 宽
  //   （峰宽 ∝ P²/对角线长度，周期 16、1024 图 ≈ 0.25px），1px 的粗扫格会**整格错过**它 ——
  //   实测 0.98× 缩放时整数周期上的 z 依次是 z(15)=3.19、z(16)=0.50、z(31)=4.11，
  //   于是乘积评分把内容峰（61 配 31）排到了真峰前面，尺寸被读成一半。
  //   改成 0.5px 后真峰总能被采到（最坏情况落在两格正中，仍有约 0.6 倍峰高）。
  var COARSE_STEP = 0.5;
  // ---- 标尺置信度判据 ----
  //   判据一：幅度 α —— 把亮度对"该尺寸隐含的两根导频周期"做最小二乘。
  //           有标尺实测 α = 0.78~1.25；无标尺/纯噪声实测 α = -2.5~0.07。
  //   判据二：谱峰尖锐度 z —— 该周期的相关幅值 ÷ 邻域背景。
  //           为什么在 α 之外还要看 z：**α 会误报**。两种实测误报：
  //             · 尺寸差整整 2 倍时，"次导频回归量"正好压在另一根真导频上 ——
  //               0.98× 被误读成 513×513 时 α 仍有 1.012（真值 0.97）；
  //             · 无标尺图的内容在长周期上偶然相干 —— 1024 图缩到 768 后
  //               报出 199×199 时 α 高达 1.248（该处根本没有导频）。
  //           区分靠 z：真导频是窄峰，实测真值 z = 2.25~10.2；
  //           内容谱是宽的，实测误报 z = 1.19~1.34。取门槛 1.8 正好分开。
  //   两个判据各自分级后取**更弱**的一档（见 sizeConfidence），
  //   因此"α 大但 z 不够"只会拿到 low，不会冒充 high。
  var CONF_ALPHA_HIGH = 0.3, CONF_ALPHA_LOW = 0.1;
  var CONF_Z_HIGH = 1.8, CONF_Z_LOW = 1.2;
  var BG_HALF_PERIODS = 12;      // z 的背景窗：±12 像素周期
  /**
   * 对角剖面：把所有像素按 d = x+y 累加成两条长度 W+H−1 的数组
   * （亮度和 S[d]、像素数 C[d]）。
   *
   * 为什么可以这样降维：本标尺的两根导频都沿对角线方向，相位只取决于 d = x+y，
   *   因此 |C(P)| = |Σ_{x,y} h(x,y)·e^{-i2π(x+y)/P}| = |Σ_d S[d]·e^{-i2πd/P}|。
   *   也就是说，一次 O(W·H) 的累加之后，**任何**周期上的相关都只需 O(W+H)：
   *   2649×1582 从"每个候选 4.19M 次查表"降到"每个候选 4230 次"，而且**全采样、
   *   无 stride 抽样**，非整数周期也不会因为抽样产生边带（实测 stride=4 时
   *   周期 15.68 的峰背比 z 会从 10 掉到 2）。
   *   单音的幅度 α 同理：回归量也只取决于 d。
   */
  function diagonalProfile(hp, W, H) {
    var n = W + H - 1;
    var S = new Float64Array(n);
    var C = new Float64Array(n);
    var y, x;
    for (y = 0; y < H; y++) {
      var base = y * W;
      for (x = 0; x < W; x++) {
        S[x + y] += hp[base + x];
        C[x + y] += 1;
      }
    }
    return { sum: S, cnt: C, total: W * H, len: n };
  }

  /** |Σ_d S[d]·e^{-i2πd/P}|（与逐像素相关数学等价，代价 O(W+H)） */
  function profileMagnitude(prof, P) {
    if (!(P > 2)) return 0;
    var inv = TRIG_SIZE / P, re = 0, im = 0;
    var S = prof.sum, n = prof.len;
    for (var d = 0; d < n; d++) {
      var v = S[d];
      if (v === 0) continue;
      var idx = ((d * inv) | 0) & TRIG_MASK;
      re += v * COS_T[idx];
      im -= v * SIN_T[idx];
    }
    return Math.sqrt(re * re + im * im);
  }

  /**
   * 单音的幅度 α（带截距的最小二乘），同样走对角剖面：
   *   α = Σ_d (S[d] − L̄·C[d])·(sin_d − s̄) / Σ_d C[d]·(sin_d − s̄)²
   * 与逐像素版本数学等价；无该音时接近 0。
   */
  function profileAlpha(prof, P) {
    if (!(P > 2) || prof.total <= 0) return 0;
    var inv = (Math.PI * 2) / P;
    var n = prof.len, i, sumL = 0, sumS = 0;
    for (i = 0; i < n; i++) {
      sumL += prof.sum[i];
      sumS += prof.cnt[i] * Math.sin(inv * i);
    }
    var meanL = sumL / prof.total;
    var meanS = sumS / prof.total;
    var sumIS = 0, sumSS = 0;
    for (i = 0; i < n; i++) {
      var sv = Math.sin(inv * i) - meanS;
      sumIS += (prof.sum[i] - meanL * prof.cnt[i]) * sv;
      sumSS += prof.cnt[i] * sv * sv;
    }
    return sumSS > 0 ? sumIS / sumSS : 0;
  }

  // 三角函数查表（避免每像素调用 Math.cos/sin，扫描提速约 5~10 倍）
  var TRIG_BITS = 13;
  var TRIG_SIZE = 1 << TRIG_BITS;       // 8192
  var TRIG_MASK = TRIG_SIZE - 1;
  var COS_T = new Float32Array(TRIG_SIZE);
  var SIN_T = new Float32Array(TRIG_SIZE);
  (function buildTrig() {
    for (var i = 0; i < TRIG_SIZE; i++) {
      var a = (Math.PI * 2) * i / TRIG_SIZE;
      COS_T[i] = Math.cos(a);
      SIN_T[i] = Math.sin(a);
    }
  })();

  // ============================================================
  // 内部工具
  // ============================================================
  function deps() {
    var d = { Packet: global.Packet, RQ: global.RaptorQ, IU: global.ImageUtils };
    var missing = [];
    if (!d.Packet) missing.push('packet.js (window.Packet)');
    if (!d.RQ) missing.push('raptorq.js (window.RaptorQ)');
    if (!d.IU) missing.push('image-utils.js (window.ImageUtils)');
    if (missing.length) throw new Error('GeoCalibration 依赖缺失，请先加载：' + missing.join('、'));
    return d;
  }

  function isImageData(o) {
    return !!o && !!o.data && typeof o.data.length === 'number' &&
      typeof o.width === 'number' && typeof o.height === 'number' &&
      o.width > 0 && o.height > 0;
  }

  function makeImageData(data, w, h) {
    if (typeof ImageData === 'function') {
      try { return new ImageData(data, w, h); } catch (e) { /* 降级 */ }
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('makeImageData: 当前环境既无 ImageData 构造器也无 DOM');
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    img.data.set(data);
    return img;
  }

  function clampByte(v) {
    if (!isFinite(v)) return 0;
    var b = Math.round(v);
    return b < 0 ? 0 : (b > 255 ? 255 : b);
  }

  function isFiniteInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  // ============================================================
  // 载荷编码 / 解码
  // ============================================================

  /** 12 字节明文：[version][format][W][H][reserved×2][CRC32] */
  function buildPayloadBytes(width, height, Packet) {
    var p = new Uint8Array(PAYLOAD_BYTES);
    p[0] = 1;                          // version
    p[1] = 0;                          // format
    p[2] = (width >>> 8) & 0xFF;
    p[3] = width & 0xFF;
    p[4] = (height >>> 8) & 0xFF;
    p[5] = height & 0xFF;
    p[6] = 0;
    p[7] = 0;
    var crc = Packet.crc32(p.subarray(0, 8));
    p[8] = (crc >>> 24) & 0xFF;
    p[9] = (crc >>> 16) & 0xFF;
    p[10] = (crc >>> 8) & 0xFF;
    p[11] = crc & 0xFF;
    return p;
  }

  /** 12 字节 → 36 字节（RS K=6/N=18，2 字节符号） */
  function rsEncodePayload(payload, RQ) {
    var enc = RQ.createEncoder(payload, RS_K, RS_SYMBOL_SIZE);
    var out = new Uint8Array(RS_BYTES);
    for (var i = 0; i < RS_N; i++) {
      out.set(enc.generateSymbol(i), i * RS_SYMBOL_SIZE);
    }
    return out;
  }

  /** 36 字节 → { width, height } | null */
  function rsDecodePayload(bytes36, Packet, RQ) {
    if (!bytes36 || bytes36.length !== RS_BYTES) return null;
    var dec = RQ.createDecoder(RS_K, RS_SYMBOL_SIZE);
    for (var i = 0; i < RS_N; i++) {
      dec.addSymbol(i, bytes36.subarray(i * RS_SYMBOL_SIZE, (i + 1) * RS_SYMBOL_SIZE));
    }
    var decoded = dec.decode();
    if (!decoded || decoded.length < PAYLOAD_BYTES) return null;
    var p = decoded.subarray(0, PAYLOAD_BYTES);
    if (p[0] !== 1) return null;
    var crc = ((p[8] << 24) | (p[9] << 16) | (p[10] << 8) | p[11]) >>> 0;
    if (Packet.crc32(p.subarray(0, 8)) !== crc) return null;
    var w = (p[2] << 8) | p[3];
    var h = (p[4] << 8) | p[5];
    if (w < 1 || h < 1) return null;
    return { width: w, height: h };
  }

  /** 36 字节 → 288 片 ±1 扩频码 */
  function bytesToChips(bytes) {
    var chips = new Int8Array(CHIP_LEN);
    for (var i = 0; i < CHIP_LEN; i++) {
      var byte = bytes[i >> 3];
      chips[i] = ((byte >> (7 - (i & 7))) & 1) ? 1 : -1;
    }
    return chips;
  }

  /** 288 个相关值 → 36 字节（正数记 1） */
  function correlationsToBytes(corr) {
    var out = new Uint8Array(RS_BYTES);
    for (var i = 0; i < CHIP_LEN; i++) {
      if (corr[i] > 0) out[i >> 3] |= (1 << (7 - (i & 7)));
    }
    return out;
  }

  // ============================================================
  // 对外命名空间
  // ============================================================
  var GeoCalibration = {};

  /**
   * 在图像上嵌入几何标尺（导频 + 扩频载荷），返回**新的** ImageData。
   * @param {ImageData} imageData
   * @param {number} width  要记录的原始宽度（省略则用 imageData.width）
   * @param {number} height 要记录的原始高度（省略则用 imageData.height）
   * @returns {ImageData}
   */
  GeoCalibration.embedScale = function (imageData, width, height) {
    var d = deps();
    if (!isImageData(imageData)) {
      throw new TypeError('embedScale: 需要传入有效的 ImageData');
    }
    var w = (width === undefined) ? imageData.width : width;
    var h = (height === undefined) ? imageData.height : height;
    if (!isFiniteInt(w) || !isFiniteInt(h) || w < 1 || h < 1 || w > 65535 || h > 65535) {
      throw new RangeError('embedScale: width/height 必须是 1~65535 的整数，当前 ' + w + 'x' + h);
    }

    var payload = buildPayloadBytes(w, h, d.Packet);
    var chips = bytesToChips(rsEncodePayload(payload, d.RQ));

    var W = imageData.width, H = imageData.height;
    var src = imageData.data;
    var out = new Uint8ClampedArray(src.length);
    var TWO_PI = Math.PI * 2;

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var o = (y * W + x) * 4;
        // 双导频：周期 64 与 32（2:1 频率对），沿对角线方向
        var pilot = PILOT_AMP * (Math.sin(TWO_PI * (x + y) / REF_PERIOD) +
                                 Math.sin(TWO_PI * (x + y) / REF_PERIOD2));
        // 载荷：同一方向铺开的 ±1 扩频码（按伪随机置换表映射到对角块）
        var chipIdx = CHIP_BLOCK_MAP[Math.floor((x + y) / CHIP_SPREAD) % (CHIP_LEN * CHIP_SPREAD)];
        var chip = CHIP_AMP * chips[chipIdx];
        var delta = pilot + chip;
        // ΔY 同时加到 R/G/B（与 DCT 内核一致的亮度处理方式）
        out[o] = clampByte(src[o] + delta);
        out[o + 1] = clampByte(src[o + 1] + delta);
        out[o + 2] = clampByte(src[o + 2] + delta);
        out[o + 3] = src[o + 3];
      }
    }
    return makeImageData(out, W, H);
  };

  /**
   * 从图像中读出原始尺寸。
   * @param {ImageData} imageData
   * @returns {{width:number, height:number, alpha:number, confidence:string, source:string}|null}
   *
   * 返回 { width, height, alpha, confidence, source }：
   *   · alpha      —— 两根导频单音的最小二乘幅度里较小的那个（"有没有尺子"的幅度判据）
   *   · confidence —— 'high' | 'low' | 'none'，由 α 与谱峰尖锐度 z 两组判据取更弱的一档
   *   · source     —— 'payload'（扩频载荷校验通过，尺寸精确）或 'pilot'（导频兜底）
   * 当 confidence === 'none' 时返回 **null**（图上没有可信标尺，不猜尺寸）。
   *
   * 为什么要把置信度返回给调用方：只有 'high' 才允许按这个尺寸重采样整图。
   * 否则一张没有标尺的图也会被读出一个虚假尺寸（实测无标尺图误报 227×227、
   * 纯噪声图误报 2283×2283），照着它重采样会把整幅图带偏。
   */
  GeoCalibration.extractScale = function (imageData) {
    var d = deps();
    if (!isImageData(imageData)) return null;
    var W = imageData.width, H = imageData.height;
    if (W < 32 || H < 32) return null;

    // ---- 1) 预处理：只减去全局均值 ----
    //   注意：不能用 3×3 这类小窗口高通！导频周期属于低频，
    //   "像素 − 局部均值"会把导频本身也一起抹掉。
    //   减全局均值只是为了数值稳定：直流分量对任何非零频率的相关都没有贡献。
    var lum = new Float32Array(W * H);
    var src = imageData.data;
    var i, x, y;
    var meanAll = 0;
    for (i = 0; i < W * H; i++) {
      var o = i * 4;
      lum[i] = 0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2];
      meanAll += lum[i];
    }
    meanAll /= (W * H);
    var hp = lum;
    for (i = 0; i < W * H; i++) hp[i] -= meanAll;

    // ---- 2) 对角剖面 + 粗扫谱表（只用来挑候选周期）----
    //   降维之后每个候选周期只要 O(W+H)，所以"全采样、不抽样"也很快。
    var prof = diagonalProfile(hp, W, H);
    var spectrum = coarseSpectrum(prof);
    if (!spectrum || spectrum.bestIdx < 0) return null;
    var Pc = PERIOD_SCAN_MIN + spectrum.bestIdx * (spectrum.STEP || 1);

    // ---- 3) 倍率二义性复核（把"当前 / 2 倍 / 一半"三个尺寸假设都验一遍）----
    //   为什么要这一手：导频是严格 2:1 的一对，若尺寸估计差了整整 2 倍，这个假设
    //   会让"次导频"正落在另一根真导频上，于是它**也能**凑出两根像样的音。
    //   判据用两个量配合：
    //     · α（单音幅度）当"闸门"：真导频实测 0.78~0.99，而图上的内容即使在某周期
    //       有大能量，正弦回归系数也很小（无标尺图实测 -0.005~0.07）。α 必须 ≥0.3
    //       才承认"这里真有两根音"。
    //     · z（峰背比）当"排序"：载体内容在长周期上能量很大，会把 α 偶然抬高
    //       （实测照片载体上半尺寸假设的 α 到过 0.92），但内容的谱是宽的、
    //       形不成窄峰（z 只有 1.8~2.3），而真导频的 z 是 5~10。
    //   每个假设都**先把周期精修到它自己的局部峰**再算这两个量：α 是对整幅图做
    //   相干累加，周期差 0.1% 就相位失配（实测差 0.5% 时 α 从 0.97 掉到 -0.44）。
    var w0 = Math.max(1, Math.round(W * REF_PERIOD / Pc));
    var cands = [];
    [w0, Math.max(32, Math.round(w0 * 2)), Math.max(32, Math.round(w0 / 2))].forEach(function (cw) {
      if (cw >= 32 && cands.indexOf(cw) === -1) cands.push(cw);
    });
    var bestTone = null;    // α 达标者里 z 最高的
    var bestAny = null;     // α 都不达标时，退而取 α 最大的（用于判定 low/none）
    for (i = 0; i < cands.length; i++) {
      var ph = refinePeriod(prof, REF_PERIOD * W / cands[i], spectrum);
      if (!ph) continue;
      var ah = Math.min(profileAlpha(prof, ph / 2), profileAlpha(prof, ph));
      var zh = Math.min(zFromSpectrum(spectrum, ph / 2), zFromSpectrum(spectrum, ph));
      var row = { cand: cands[i], period: ph, alpha: ah, z: zh };
      if (!bestAny || ah > bestAny.alpha) bestAny = row;
      if (ah >= CONF_ALPHA_HIGH && (!bestTone || zh > bestTone.z)) bestTone = row;
    }
    var pick = bestTone || bestAny;
    if (!pick) return null;
    var period = pick.period;
    var s = period / REF_PERIOD;
    var estW = Math.max(1, Math.round(W / s));
    var estH = Math.max(1, Math.round(H / s));

    // ---- 4) 置信度：按最终尺寸复查两个音的幅度（α 判据），z 只作为诊断信息 ----
    var conf = sizeConfidence(prof, spectrum, W, estW);
    GeoCalibration.lastConfidence = conf;
    GeoCalibration.lastPeriodInfo = {
      coarse: Pc,
      hypothesis: (pick.cand === w0 ? 'same' : (pick.cand > w0 ? 'x2' : 'x0.5')),
      hypothesisAlpha: pick.alpha, hypothesisZ: pick.z,
      primary: period, refined: period,
      zMin: conf.zMin, alpha: conf.alpha, confidence: conf.confidence
    };

    // ---- 6) 载荷交叉校验（自带 CRC，成功则尺寸精确、置信度直接判 high）----
    var payloadSize = null;
    try {
      payloadSize = readPayload(imageData, s, d);
    } catch (e) {
      payloadSize = null;
    }
    var usePayload = !!(payloadSize && payloadSize.width > 0 && payloadSize.height > 0);

    var result = {
      width: usePayload ? payloadSize.width : estW,
      height: usePayload ? payloadSize.height : estH,
      alpha: conf.alpha,
      confidence: usePayload ? 'high' : conf.confidence,
      source: usePayload ? 'payload' : 'pilot',
      z: conf.zMin
    };
    if (result.confidence === 'none') return null;   // 没有可信标尺：不猜尺寸
    return result;
  };

  /**
   * 从粗扫谱表里取周期 P 处的 z：返回**相邻两格中较大的那个**。
   *   为什么不能只取最近一格：真峰的半周期未必落在格点上（0.98× 图上真峰在
   *   15.68，格点 15.5/16.0 的 z 分别是 13.0 与 0.50），四舍五入到 16.0 会把
   *   "有导频"读成"没有导频"。取相邻两格最大值，让 z 判据对 ≤半格的失配免疫。
   */
  function zFromSpectrum(spectrum, P) {
    var step = spectrum.STEP || 1;
    var f = (P - spectrum.P_LO) / step;
    var i0 = Math.floor(f), i1 = Math.ceil(f);
    var best = 0;
    if (i0 >= 0 && i0 < spectrum.z.length) best = Math.max(best, spectrum.z[i0]);
    if (i1 >= 0 && i1 < spectrum.z.length) best = Math.max(best, spectrum.z[i1]);
    return best;
  }

  /**
   * 某个原始尺寸假设的置信度：两个判据各自分级（2=high / 1=low / 0=none），
   * 取**更弱**的一档作为最终 confidence。
   *
   * 为什么必须两个都要：
   *   · 只看 α：无标尺图的内容在长周期上偶然相干时，α 能到 1.248（该处没有导频），
   *     会把"其实没有标尺"判成 high，接着被下游当成真尺寸去重采样（越重采样越糟）。
   *   · 只看 z：载体内容在中低频很强时，正确尺寸的 z 也会被背景压到 2.2，
   *     单看 z 会把真标尺判成 none（丢掉本可校准的图）。
   * 合起来：真值实测（α,z）= (0.97, 2.25) ~ (0.99, 10.2) → high；
   *   无标尺误报 (1.248, 1.33) → α 给 2、z 给 1 → low（下游只在 high 时才重采样）。
   */
  function sizeConfidence(prof, spectrum, W, candW) {
    var s = W / candW;
    var pSec = REF_PERIOD2 * s, pPri = REF_PERIOD * s;
    var aSec = profileAlpha(prof, pSec);
    var aPri = profileAlpha(prof, pPri);
    var alpha = Math.min(aSec, aPri);
    var zSec = zFromSpectrum(spectrum, pSec), zPri = zFromSpectrum(spectrum, pPri);
    var zMin = Math.min(zSec, zPri);
    var lvA = alpha >= CONF_ALPHA_HIGH ? 2 : (alpha >= CONF_ALPHA_LOW ? 1 : 0);
    var lvZ = zMin >= CONF_Z_HIGH ? 2 : (zMin >= CONF_Z_LOW ? 1 : 0);
    var lv = Math.min(lvA, lvZ);
    var confidence = lv === 2 ? 'high' : (lv === 1 ? 'low' : 'none');
    return {
      alpha: alpha, alphaSec: aSec, alphaPri: aPri,
      zSec: zSec, zPri: zPri, zMin: zMin,
      levelAlpha: lvA, levelZ: lvZ,
      confidence: confidence
    };
  }

  /**
   * 两级周期搜索。
   *
   * 关键点：不能直接比 |C(P)| 的大小。自然图像的能量集中在低频，内容在
   * 长周期上的相关幅值往往比导频还大（实测照片上 period=128 处内容达 6.5e5，
   * 而导频只有 1.6e5），直接取最大峰会锁到图像自身的内容上。
   * 因此改用**峰背比**：Z(P) = |C(P)| / B(P)，其中 B(P) 是邻域候选周期上
   * |C| 的滑动平均（即该频点附近的"背景谱"）。导频是极窄的谱线 → Z 很大；
   * 图像内容是宽带 → Z 接近 1。再用 2:1 双导频的乘积 Z(P)·Z(P/2) 定位，
   * 既排除了内容的宽带背景，也排除了"只有单一频率成峰"的情形。
   */
  function coarseSpectrum(prof) {
    var STEP = COARSE_STEP;                        // 亚像素步长（见 COARSE_STEP 的说明）
    var P_LO = PERIOD_SCAN_MIN;                    // 谱表下限（含 P/2 区域）
    var n = Math.round((PERIOD_MAX - P_LO) / STEP) + 1;
    var mags = new Float64Array(n);
    var i, P;
    for (i = 0; i < n; i++) {
      P = P_LO + i * STEP;
      mags[i] = profileMagnitude(prof, P);
    }

    // 背景 = 邻域滑动平均。窗口宽度必须按**周期长度**给定，不能按"候选个数"给定：
    //   固定 ±24 个候选在步长变化后代表不同的周期跨度，z(P) 的相对关系随之改变 ——
    //   实测会把 0.5× 照片载体的真峰（P=16）压下去，锁到内容峰上，读成 107×107。
    //   这里统一为 ±12 像素周期。
    var HALF = Math.max(1, Math.round(BG_HALF_PERIODS / STEP));
    var z = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var lo = Math.max(0, i - HALF), hi = Math.min(n - 1, i + HALF);
      var sum = 0, cnt = 0;
      for (var k = lo; k <= hi; k++) { sum += mags[k]; cnt++; }
      var bg = sum / cnt;
      z[i] = bg > 0 ? mags[i] / bg : 0;
    }
    return coarseScore(z, n, P_LO, STEP);
  }

  /**
   * 用双导频乘积评分在粗扫谱表里挑出最佳候选（只挑主周期 P ≥ PERIOD_MIN）。
   *   配对查表要取**相邻两格的最大 z**：真峰的半周期未必正好落在格点上
   *   （0.98× 图上真峰在 15.68，格点在 15.5 与 16.0，其中 16.0 恰好落在谷底
   *   z=0.50）。只取四舍五入那一格会让真配对被谷底拉低，实测真配对被内容峰反超。
   */
  function coarseScore(z, n, P_LO, STEP) {
    var HALF_OFFSET = P_LO / (2 * STEP);
    var bestIdx = -1, bestScore = -1, i, P;
    for (i = 0; i < n; i++) {
      P = P_LO + i * STEP;
      if (P < PERIOD_MIN) continue;
      var hf = Math.floor(i / 2 - HALF_OFFSET);
      var hc = Math.ceil(i / 2 - HALF_OFFSET);
      var zh = -1;
      if (hf >= 0 && hf < n && hf !== i) zh = Math.max(zh, z[hf]);
      if (hc >= 0 && hc < n && hc !== i) zh = Math.max(zh, z[hc]);
      var score = zh >= 0 ? z[i] * zh : z[i];
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return { z: z, bestIdx: bestIdx, bestScore: bestScore, n: n, P_LO: P_LO, STEP: STEP };
  }

  /**
   * 在给定候选周期附近把峰值位置精修出来。
   *   centerP 由"尺寸假设"反推得到（REF_PERIOD·W/候选宽度），只作为搜索中心；
   *   真正的周期位置由"窗口内挑最尖锐的谱峰 + 抛物线顶点 + 次导频复核"决定。
   *   为什么窗口只要 ±0.8：候选周期来自 1px 粒度的粗扫，误差不超过半个格；
   *   把窗口收窄（原来 ±1.5）既省时间，又不影响精度 —— 位置由抛物线顶点给出。
   */
  function refinePeriod(prof, centerP, spectrum) {
    var FSTEP = 0.05;
    var P, i;
    // 第一步：在窗口内按**谱峰尖锐度 z** 选出"是哪一个峰"，用谱表自己的格点。
    //   自然图像的低频内容在 |C| 上可以比导频还大（这正是全局用 z 而不是 |C|
    //   挑候选的原因）；窗口落在内容密集处时，直接取 |C| 最大会锁到内容上。
    //   z 只用来"选出是哪一个峰"，亚像素位置由下面的抛物线给出。
    var step = spectrum ? (spectrum.STEP || 1) : 1;
    var loI = Math.max(PERIOD_MIN, centerP - 1.5), hiI = Math.min(PERIOD_MAX, centerP + 1.5);
    var pz = centerP, bestZ = -1;
    if (spectrum) {
      var iLo = Math.max(0, Math.ceil((loI - spectrum.P_LO) / step));
      var iHi = Math.min(spectrum.z.length - 1, Math.floor((hiI - spectrum.P_LO) / step));
      for (i = iLo; i <= iHi; i++) {
        if (spectrum.z[i] > bestZ) { bestZ = spectrum.z[i]; pz = spectrum.P_LO + i * step; }
      }
    }
    // 第二步：在选出的峰附近 ±0.5 用 |C| 精确定位，再取抛物线顶点。
    var samples = [];
    for (P = Math.max(PERIOD_MIN, pz - 0.6); P <= Math.min(PERIOD_MAX, pz + 0.6); P += FSTEP) {
      samples.push({ P: P, mag: profileMagnitude(prof, P) });
    }
    if (!samples.length) return centerP;
    var bi = 0;
    for (i = 1; i < samples.length; i++) if (samples[i].mag > samples[bi].mag) bi = i;
    var refined = samples[bi].P;
    if (bi > 0 && bi < samples.length - 1) {
      var m0 = samples[bi - 1].mag, m1 = samples[bi].mag, m2 = samples[bi + 1].mag;
      var den = m0 - 2 * m1 + m2;
      if (den !== 0) {
        var off = 0.5 * (m0 - m2) / den;      // 抛物线顶点相对偏移（单位：步长）
        if (off > -1 && off < 1) refined = samples[bi].P + off * FSTEP;
      }
    }

    // 用**次导频**（周期 REF_PERIOD2·s）再估一次：相关峰在周期轴上的宽度 ∝ P²，
    // 周期 16 的峰比周期 32 的窄 4 倍，估出来的缩放倍率精度也高约 4 倍。
    //   尺寸对缩放极敏感（512 图上 0.2% 的缩放误差就是 1 像素），这一步是达标关键。
    //   搜索窗取 ±0.05：中心已由主导频定到 ±0.1% 以内，窗口再宽只是徒增耗时；
    //   顶点落在窗口边缘时（si 在两端）不采信，避免用"没找到峰"的结果去顶替主导频。
    var secCenter = refined / 2;
    var secStep = 0.005;
    var secSamples = [];
    var q;
    for (q = Math.max(3, secCenter - 0.05); q <= secCenter + 0.05; q += secStep) {
      secSamples.push({ P: q, mag: profileMagnitude(prof, q) });
    }
    if (secSamples.length) {
      var si = 0;
      for (i = 1; i < secSamples.length; i++) {
        if (secSamples[i].mag > secSamples[si].mag) si = i;
      }
      var secP = secSamples[si].P;
      var edge = (si === 0 || si === secSamples.length - 1);
      if (!edge) {
        var n0 = secSamples[si - 1].mag, n1 = secSamples[si].mag, n2 = secSamples[si + 1].mag;
        var denS = n0 - 2 * n1 + n2;
        if (denS !== 0) {
          var offS = 0.5 * (n0 - n2) / denS;
          if (offS > -1 && offS < 1) secP = secSamples[si].P + offS * secStep;
        }
      }
      var sFromSecondary = secP / REF_PERIOD2;        // 缩放倍率
      var primaryEquiv = sFromSecondary * REF_PERIOD;
      // 两次估计相差不大才采信次导频结果（且要求它的峰不在窗口边缘），否则仍用主导频
      if (!edge && Math.abs(primaryEquiv - refined) / refined < 0.03) return primaryEquiv;
    }
    return refined;
  }

  /** 用 canvas 把 ImageData 缩放到指定尺寸 */
  function resizeTo(imageData, w, h) {
    var IU = deps().IU;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('resizeTo: 需要 DOM');
    }
    var src = document.createElement('canvas');
    src.width = imageData.width;
    src.height = imageData.height;
    src.getContext('2d').putImageData(imageData, 0, 0);
    // 借 ImageUtils.resizeImage 做等比缩放，再按目标长边取回
    var longSide = Math.max(w, h);
    var scaled = IU.resizeImage(src, longSide);
    var ctx = scaled.getContext('2d');
    var got = ctx.getImageData(0, 0, scaled.width, scaled.height);
    if (scaled.width === w && scaled.height === h) return got;
    // 尺寸仍不完全一致时，用第二个 canvas 精确拉伸
    var dst = document.createElement('canvas');
    dst.width = w;
    dst.height = h;
    var dctx = dst.getContext('2d');
    dctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in dctx) dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(scaled, 0, 0, w, h);
    return dctx.getImageData(0, 0, w, h);
  }

  /** 在图上读取扩频载荷（直接在原图坐标下按 scale 映射对角块） */
  function readPayload(imageData, scale, d) {
    var W = imageData.width, H = imageData.height;
    var src = imageData.data;
    var lum = new Float32Array(W * H);
    var i, x, y;
    var meanAll = 0;
    for (i = 0; i < W * H; i++) {
      var o = i * 4;
      lum[i] = 0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2];
      meanAll += lum[i];
    }
    meanAll /= (W * H);
    // 注意：这里**不能**做逐像素高通。扩频码是"每片 8 个对角位置恒定"的分段常量，
    // "像素 − 局部均值"会把它整段抹掉（实测只剩 66% 符号一致，无法纠回）。
    // 只需减去全局均值：图像内容在每片上的平均贡献几乎相同，会被差分掉。
    var BLOCKS = CHIP_LEN * CHIP_SPREAD;             // 2304 个对角块
    var blockSum = new Float64Array(BLOCKS);
    var blockCnt = new Int32Array(BLOCKS);
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        var idx = y * W + x;
        var diagPos = (x + y) * scale;               // 映射回原始尺度
        var b = Math.floor(diagPos / CHIP_SPREAD) % BLOCKS;
        blockSum[b] += (lum[idx] - meanAll);
        blockCnt[b]++;
      }
    }
    // 8 种对齐偏移依次尝试：只要载荷 CRC 通过就返回（CRC 32 位，几乎不可能误判）
    for (var off = 0; off < CHIP_SPREAD; off++) {
      var sums = new Float64Array(CHIP_LEN);
      var counts = new Int32Array(CHIP_LEN);
      for (var b2 = 0; b2 < BLOCKS; b2++) {
        var c = CHIP_BLOCK_MAP[(b2 + off) % BLOCKS];
        sums[c] += blockSum[b2];
        counts[c] += blockCnt[b2];
      }
      for (i = 0; i < CHIP_LEN; i++) {
        sums[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
      }
      var got = rsDecodePayload(correlationsToBytes(sums), d.Packet, d.RQ);
      if (got) return got;
    }
    return null;
  }

  /**
   * 生成"给定尺寸下、给定振幅"的标尺图案（导频 + 扩频载荷），
   * 返回 Float32Array(width*height)，元素是各像素的亮度加性偏移量。
   *
   * 参数 amplitude 只缩放**导频**部分（两根 2:1 正弦导频），扩频载荷的振幅
   * 固定为 CHIP_AMP —— 因为接收端要靠导频找几何、靠扩频码读尺寸，
   * 两者强度独立调节才便于调参（amplitude=0 时图案只剩 ±CHIP_AMP 的扩频码）。
   *
   * 为什么可以确定性重建：标尺的导频频率、相位起点（0）、扩频码
   * （由 width/height 决定的 12 字节载荷经 RS 编码得到）全部是确定的，
   * 只要知道原始尺寸就能一模一样地重算出来 —— 这是干扰对消的前提。
   */
  GeoCalibration.generateScalePattern = function (width, height, amplitude) {
    var d = deps();
    if (!isFiniteInt(width) || !isFiniteInt(height) || width < 1 || height < 1 ||
        width > 65535 || height > 65535) {
      throw new RangeError('generateScalePattern: width/height 必须是 1~65535 的整数');
    }
    var amp = (amplitude === undefined || amplitude === null) ? PILOT_AMP : amplitude;
    if (typeof amp !== 'number' || !isFinite(amp)) {
      throw new TypeError('generateScalePattern: amplitude 必须是有限数值');
    }
    var payload = buildPayloadBytes(width, height, d.Packet);
    var chips = bytesToChips(rsEncodePayload(payload, d.RQ));
    var out = new Float32Array(width * height);
    var TWO_PI = Math.PI * 2;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var pilot = amp * (Math.sin(TWO_PI * (x + y) / REF_PERIOD) +
                           Math.sin(TWO_PI * (x + y) / REF_PERIOD2));
        var chipIdx = CHIP_BLOCK_MAP[Math.floor((x + y) / CHIP_SPREAD) % (CHIP_LEN * CHIP_SPREAD)];
        out[y * width + x] = pilot + CHIP_AMP * chips[chipIdx];
      }
    }
    return out;
  };

  /**
   * 干扰对消：已知原始尺寸后，从图像里减去标尺，返回**新的** ImageData。
   *
   * 嵌入时 stego = 原始 + pattern；若图上又经历过缩放，则残留的是
   * α·pattern（α 是重采样带来的衰减系数）。减的时候用**原始** pattern
   * （导频 + 扩频码，含各自的直流分量），因为嵌入时叠加的就是它。
   *
   * 难点在 α 怎么估。踩过两个坑，都实测过：
   *
   * 坑 1 —— 不能直接用 α = Σ(L·p)/Σ(p²)（无截距）。
   *   图案在有限方图上并不零均值：周期 32/16 的正弦沿对角线铺开时各对角线
   *   长度不同，整流后 Σp ≈ -4.2e4（均值 -0.16）。图像直流 128 乘上这个
   *   非零均值得到 Σ(base·p) ≈ -5.4e6，完全压过 Σ(p²) ≈ 6.0e5 → α ≈ -8，
   *   被钳成 0，对消彻底失效。**必须带截距（先各自去均值）**。
   *
   * 坑 2 —— 即使用了截距，也不能拿"整图案"当回归量。
   *   实测在照片类载体上（无标尺、无载荷）整图案回归给出 α=0.45，
   *   也就是图像自身的低频内容在导频周期上与图案伪相关，把 α 抬高 45%，
   *   变成"过减"，反而把失真注进图里。
   *   改用**周期 16 的次导频单音**当回归量后：
   *     照片载体（无标尺）α = -0.002（干净）、纯色底图 α = 0.976（≈1）；
   *   因为次导频谱峰更窄、在方图上的均值泄漏更小，而图像内容在该频点
   *   是宽带背景，不会形成系统性偏置。
   *
   * 残余再做 [0,255] 截断，不修改入参。
   * 估计出的 α 记录在 GeoCalibration.lastAlpha 便于测试与诊断。
   */
  GeoCalibration.removeScale = function (imageData, origWidth, origHeight) {
    if (!isImageData(imageData)) {
      throw new TypeError('removeScale: 需要传入有效的 ImageData');
    }
    var w = (origWidth === undefined) ? imageData.width : origWidth;
    var h = (origHeight === undefined) ? imageData.height : origHeight;
    if (!isFiniteInt(w) || !isFiniteInt(h) || w < 1 || h < 1) {
      throw new RangeError('removeScale: origWidth/origHeight 必须是正整数');
    }
    var pattern = GeoCalibration.generateScalePattern(w, h, PILOT_AMP);

    // 最小二乘估计残留振幅 α（只统计尺寸重叠区域）
    //   回归量 s(x,y) = sin(2π(x+y)/REF_PERIOD2) —— 与 embedScale 里的次导频同频同相
    var cw = Math.min(w, imageData.width), ch = Math.min(h, imageData.height);
    var src = imageData.data;
    var n = cw * ch;
    var inv = (Math.PI * 2) / REF_PERIOD2;
    var sumL = 0, sumS = 0, x2, y2, i2;
    for (y2 = 0; y2 < ch; y2++) {
      for (x2 = 0; x2 < cw; x2++) {
        i2 = (y2 * imageData.width + x2) * 4;
        sumL += 0.299 * src[i2] + 0.587 * src[i2 + 1] + 0.114 * src[i2 + 2];
        sumS += Math.sin(inv * (x2 + y2));
      }
    }
    var meanL = n > 0 ? sumL / n : 0;
    var meanS = n > 0 ? sumS / n : 0;
    var sumIS = 0, sumSS = 0;
    for (y2 = 0; y2 < ch; y2++) {
      for (x2 = 0; x2 < cw; x2++) {
        i2 = (y2 * imageData.width + x2) * 4;
        var lum = 0.299 * src[i2] + 0.587 * src[i2 + 1] + 0.114 * src[i2 + 2];
        var sv = Math.sin(inv * (x2 + y2)) - meanS;
        sumIS += (lum - meanL) * sv;
        sumSS += sv * sv;
      }
    }
    var alpha = sumSS > 0 ? sumIS / sumSS : 0;
    if (!isFinite(alpha) || alpha < 0) alpha = 0;
    if (alpha > ALPHA_MAX) alpha = ALPHA_MAX;   // 上限保护：正常残留 ≤ 1.0，超过说明拟合异常

    var out = new Uint8ClampedArray(src.length);
    out.set(src);
    for (var y = 0; y < ch; y++) {
      for (var x = 0; x < cw; x++) {
        var oo = (y * imageData.width + x) * 4;
        var delta = alpha * pattern[y * w + x];
        out[oo] = clampByte(src[oo] - delta);
        out[oo + 1] = clampByte(src[oo + 1] - delta);
        out[oo + 2] = clampByte(src[oo + 2] - delta);
      }
    }
    GeoCalibration.lastAlpha = alpha;   // 便于测试与诊断
    return makeImageData(out, imageData.width, imageData.height);
  };

  /** 计算 PSNR（dB），用于自测与页面提示 */
  GeoCalibration.psnr = function (a, b) {
    if (!isImageData(a) || !isImageData(b) || a.width !== b.width || a.height !== b.height) {
      throw new TypeError('psnr: 两张图尺寸必须一致');
    }
    var n = a.width * a.height * 3;
    var se = 0;
    for (var i = 0; i < a.width * a.height; i++) {
      var o = i * 4;
      for (var c = 0; c < 3; c++) {
        var d = a.data[o + c] - b.data[o + c];
        se += d * d;
      }
    }
    var mse = se / n;
    if (mse <= 0) return Infinity;
    return 10 * Math.log(255 * 255 / mse) / Math.LN10;
  };

  // ---- 附加常量（便于测试与调参）----
  GeoCalibration.CONST = {
    REF_PERIOD: REF_PERIOD,
    REF_PERIOD2: REF_PERIOD2,
    PILOT_AMP: PILOT_AMP,
    ALPHA_MAX: ALPHA_MAX,
    CHIP_AMP: CHIP_AMP,
    PAYLOAD_BYTES: PAYLOAD_BYTES,
    RS_K: RS_K,
    RS_N: RS_N,
    RS_BYTES: RS_BYTES,
    CHIP_LEN: CHIP_LEN,
    PERIOD_MIN: PERIOD_MIN,
    PERIOD_MAX: PERIOD_MAX
  };

  global.GeoCalibration = GeoCalibration;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
