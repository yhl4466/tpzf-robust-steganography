/**
 * stego-core.js —— 端到端隐写整合层（window.StegoCore）
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致）：
 *   1. 零外部依赖：只用原生 JS；
 *   2. 不使用 ES Module：没有 import / export，普通 script 标签引入，
 *      file:// 双击本地打开即可运行；
 *   3. 挂载到全局命名空间 window.StegoCore（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * 依赖（必须在本文件之前用 script 标签加载）：
 *   image-utils.js → window.ImageUtils  （分块、方差）
 *   dct-stego.js   → window.DctStego    （单 Tile 192 bit 读写）
 *   packet.js      → window.Packet      （CRC32 校验）
 *   raptorq.js     → window.RaptorQ     （抗丢包纠删码）
 *
 * ================================================================
 * 一、数据流总览（v2：秘密图先 JPEG 压缩再嵌入）
 * ================================================================
 *   载体图 ──splitIntoTiles(64)──► 纹理 Tile 列表（只取 64×64、方差达标）
 *                                        │
 *   秘密图 ──canvas.toDataURL('image/jpeg', q)──► JPEG 字节流
 *          （太大就按 0.85/0.7/0.55/0.4/0.3/0.2 逐级缩小重编码）
 *                                        │
 *           srcBytes = 14 字节头 + JPEG   （L = 14 + jpegLength）
 *                                        │
 *                        K = ceil(L/40)，N = ceil(K × 冗余系数)
 *                                        │
 *                     RaptorQ 编码 i=0..N-1 ──► N 个 40 字节符号
 *                                        │
 *        每个符号 + (seq=i, K) ──Packet.pack──► 48 字节 ──► 384 bit
 *                                        │
 *             DctStego.embedBitsInTile(第 i 个纹理 Tile, 384 bit)
 *                                        │
 *                                   隐写图 ImageData
 *
 *   为什么 v2 的容量能提升一个数量级：v1 把秘密图按 8bit/像素**原样**塞进去，
 *   而 v2 先做 JPEG（质量 0.75）—— 一张照片能压到原尺寸的 5%~15%，
 *   再叠加"每 Tile 384 bit（6 对系数）"与"可选冗余档位"，总容量提升约 50 倍。
 *
 * ================================================================
 * 二、单 Tile payload 格式（两种"系数模式"，见第七节）
 * ================================================================
 *   默认（6 对系数，384 bit/Tile，48 字节 payload）
 *   偏移    长度   含义
 *   0..1     2    seq     uint16 BE —— 编码符号索引 i
 *   2..3     2    K       uint16 BE —— 源分片数（冗余自描述，提取端多数表决）
 *   4..43   40    symbol  40 字节编码符号（symbolSize=40，偶数满足 raptorq 约束）
 *   44..47   4    CRC32   覆盖前 44 字节
 *   —— 直接把 44 字节交给 Packet.pack()，输出恰好 48 字节，CRC 为小端序。
 *
 *   低频回退模式（4 对系数，256 bit/Tile，32 字节 payload）
 *   0..1 seq ｜ 2..3 K ｜ 4..27 symbol（24 字节）｜ 28..31 CRC32
 *   —— 两种模式的 payload 长度、符号长度、每 Tile 比特数都不同，
 *      因此提取端"两种都试"（先 6 对后 4 对），靠 CRC 判断命中。
 *
 * ================================================================
 * 三、秘密载荷头部（srcBytes 的前 14 字节，version = 2）
 * ================================================================
 *   偏移     长度   含义
 *   0        1    version = 2
 *   1        1    format  （0 = JPEG 灰度，1 = JPEG 彩色）
 *   2..3     2    W        uint16 BE（解码后宽度，冗余写入便于快速定位）
 *   4..5     2    H        uint16 BE
 *   6..9     4    length   uint32 BE（JPEG 字节流实际长度）
 *   10..13   4    CRC32    覆盖 [0..9] 共 10 字节
 *   14..            JPEG 字节流
 *
 * ================================================================
 * 四、容错档位（options.redundancy）
 * ================================================================
 *   'standard'（默认）：N = 2K     理论边界 50%，**实测稳定 25~35%**，容量 ×1
 *   'balanced'        ：N = 1.5K   理论边界 33%，**实测稳定 15~25%**，容量 ×1.33
 *   'compact'         ：N = 1.25K  理论边界 20%，**实测稳定 10~15%**，容量 ×1.6
 *   N 一律向上取整。提取端不需要知道档位：K 写在每个 Tile 里，多数表决即可。
 *
 *   为什么必须区分"理论边界"与"实测稳定"：N = 2K 只说明"丢掉任意 ≤ 50% 的
 *   **符号**仍可解码"，而用户在页面上看到的是"遮住多少**面积**"。
 *   两者之间隔着三件事：
 *     ① 承载块的空间分布 —— 棋盘配额只能保证四个半平面各 K 个符号；
 *        一旦遮挡是斜着切、或者恰好压在某几个象限，局部仍会超过 K；
 *     ② 遮挡边缘的承载块会"半坏"——被盖住一部分的 Tile 照样算失败；
 *     ③ 承载块筛选（方差/裕量门槛）本来就集中在纹理区，分布并不均匀。
 *   实测（见 tests/verify-stego-core.node.js 的 AC5/AC6/AC12/AC13 与浏览器用例
 *   T8~T12）：25% 遮挡稳定成功；50% 遮挡只有在"正中间 / 整半平面"这类对齐情况下
 *   才能成功，随机 50% 与 55% 会失败。因此对外一律按"稳定 25~35%"表述。
 *
 * ================================================================
 * 五、关于 JPEG 解码（为什么 extractSecret 是同步的）
 * ================================================================
 *   浏览器的 JPEG 解码 API（createImageBitmap / Image.onload）**都是异步的**，
 *   而 extractSecret 一直是同步契约（页面与测试都同步调用）。
 *   因此 v2 把职责拆开：
 *     · extractSecret 同步返回 secretJpegBytes + 头信息（浏览器/Node 行为一致）；
 *     · StegoCore.decodeSecretImage(jpegBytes) 是异步助手，浏览器里解码成 ImageData；
 *       环境不支持解码（无 createImageBitmap / Image / URL）时 reject 明确错误，
 *       调用方据此降级（例如 Node 测试直接比对 JPEG 字节流）。
 *
 *
 * ================================================================
 * 六、Tile 选取策略（tileStrategy：'spread'（默认）| 'scan'）
 * ================================================================
 *   前提：N = 2K 的**理论**边界是"丢掉任意 ≤ 50% 的符号仍可解码"（RS 需要收到 >= K 个符号）。
 *   就符号层面而言，"任意一半面积被破坏后仍能解码"等价于：
 *       **任意半平面内分布到的符号数必须 <= K**。
 *   又因为左右两半符号数之和恒为 N = 2K，所以"左半 <= K"与"右半 <= K"
 *   同时成立时，两边都只能**恰好等于 K**。也就是说：
 *   在"整半平面被破坏"这种理想化遮挡下，精确对半分是唯一可行解，任何偏斜都会让某一侧失败。
 *
 *   注意这是**符号层**的结论，不等于"面积层"的保证：见文件头第四节列出的三条落差
 *   （分布、边缘半坏、筛选后分布不均），因此对外按"稳定 25~35%"表述。
 *
 *   'spread'（默认）—— 网格分桶 + 每桶等量抽 + 棋盘配额：
 *     1) 把对齐 Tile 网格按左上/右上/左下/右下切成 4 个桶（象限）；
 *     2) 配额取"棋盘式"：TL = BR = a，TR = BL = b，且 a + b = K。
 *        这样 左半 = TL + BL = a + b = K，右半 = TR + BR = b + a = K，
 *        上半、下半同理 —— 四个半平面**恰好**各 K 个符号，零偏斜；
 *     3) 每个桶内部按扫描序做**等距抽样**（index * 桶大小 / 配额），
 *        使符号在桶内也均匀铺开，而不是挤在一角；
 *     4) 若某个桶的纹理 Tile 不够配额，则按可用容量重算 a、b
 *        （仍尽量维持 a + b = K），实在不够才退化为顺序补齐并记录。
 *     复杂度：O(T + N)，T 为纹理 Tile 数；额外空间 O(T + N)。
 *
 *   'scan' —— 旧行为：按 y 外 x 内扫描顺序取前 N 个，左上优先。
 *     优点是选择规则最简单、可预测；缺点是符号在空间上高度聚集
 *     （2048×2048 图上 130 个符号只占最上面 5 行），
 *     左上角一半面积被涂黑就会丢掉一半以上符号而解码失败。
 *     复杂度 O(N)。
 *
 *   两种策略对提取端完全透明：每个 Tile 自带 seq，提取端只认 seq，不关心位置。
 *
 * ================================================================
 * 七、位序约定
 * ================================================================
 *   payload 字节 → 比特采用 **MSB first**（每字节高位在前），嵌入与提取
 *   必须一致；本文件统一用 bytesToBits/bitsToBytes 完成转换。
 *
 * ================================================================
 * 八、两种系数模式（options.lowFrequencyMode）与提取端的"几何恢复四步"
 * ================================================================
 *   系数对的选择直接决定"能扛住什么退化"：
 *     · MODE_6（默认，6 对）：384 bit/Tile，容量大，抗 JPEG 与轻度重采样；
 *     · MODE_4（lowFrequencyMode: true，4 对最低频）：
 *       256 bit/Tile，容量约 2/3，但缩放相当于低通，只有最低频系数能活下来，
 *       所以"0.5×/0.75×/1.25× 缩放后仍能提取"必须靠它。
 *       实测（照片载体）：0.75× 时承载 Tile 的 CRC 存活率 100%、
 *       0.5× 时 80%，而 6 对模式在 0.5× 时为 0%。
 *   提取端不需要知道用的是哪种模式：按 [MODE_6, MODE_4] 顺序各试一次，
 *   谁能让 payload 的 CRC 通过就用谁（结果里的 result.mode 回显）。
 *
 *   提取的四步（recoveryPath 记录走通的是哪一步）：
 *     ① 'normal' —— 网格对齐、无缩放：直接按 (0,0) 相位提取（两种模式都试）；
 *     ② 'phase'  —— 被裁掉非 64 倍数边缘：8px 粒度搜 64 种网格相位（两级探测）；
 *     ③ 'scale'  —— 被缩放过：用几何标尺量出原始尺寸 → 重采样回原尺寸
 *                   →（失败时）调用 GeoCalibration.removeScale 做**干扰对消**
 *                   （减去标尺图案，导频+扩频码一起减）→ 再提取；
 *     ④ 'failed' —— 都失败，返回第一次（常规）提取的 debugMask 供排查。
 */
(function (global) {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  var TILE_SIZE = 64;                        // 固定 Tile 边长
  var SYMBOL_SIZE = 40;                      // 每个编码符号 40 字节
  var PAYLOAD_BYTES = 48;                    // 单 Tile 载荷 48 字节
  var PAYLOAD_BITS = PAYLOAD_BYTES * 8;      // 384 bit
  var PAYLOAD_BODY_BYTES = 44;               // CRC 覆盖的前 44 字节
  var SECRET_HEADER_BYTES = 14;              // 秘密载荷头（v2）
  var SECRET_VERSION = 2;
  var DEFAULT_VARIANCE_THRESHOLD = 60;       // 放宽后可用 Tile 更多（见文件头）
  // ---- 安全块判据（详见 classifyTiles 的说明）----
  // 主判据（默认启用）：块级最小 margin ≥ 12。
  //   实测分界非常干净：margin ≤10 的块在 JPEG q=0.80 下存活率 0%（27 个块全灭），
  //   margin ≥ 12.4 的块同一条件下 100%；q=0.75 下 margin 15.5 仍有 75%。
  var MIN_BLOCK_MARGIN = 12;
  // 次判据（**默认关闭**，0/255 表示不限制）：Tile 平均亮度安全区。
  //   为什么默认不开：亮度本身不伤数据，伤数据的是"亮度极值处块内纹理被 clamp 削平
  //   导致实际 margin 掉到下限"——而这件事已经被上面的块级 margin 判据精确测到了
  //   （实测标称 margin 12.5 的块在亮度 20/200/230 处实际只剩 8.0）。
  //   反过来，硬拦亮度会误杀好块：亮度 227.5、margin 21.3 的亮块在 q=0.75 下仍是 42/42，
  //   亮度 241.5、margin 14.5 的弱纹理亮块是 40/42。需要更保守时可显式传
  //   minTileLum/maxTileLum（例如需求里建议的 40/215）。
  var MIN_TILE_LUM = 0;
  var MAX_TILE_LUM = 255;
  var DEFAULT_SECRET_JPEG_QUALITY = 0.75;    // 秘密图 JPEG 质量（0~1，与 canvas 一致）
  var MAX_DIM = 4096;                        // 秘密图宽高上限
  var DEBUG_ALPHA = Math.round(0.4 * 255);   // 102：debugMask 半透明
  var DEFAULT_TILE_STRATEGY = 'spread';      // 'spread' | 'scan'（见文件头第四节）
  var MIN_SECRET_LONG_SIDE = 64;             // 自动缩放的下限：长边低于此值就放弃

  /** 容错档位：N = ceil(K × 系数) */
  var REDUNDANCY = { standard: 2, balanced: 1.5, compact: 1.25 };
  // 档位标签：对外一律区分"理论边界"与"实测稳定"（详见文件头第四节）
  var REDUNDANCY_LABEL = {
    standard: '标准（稳定抗 25~35%，理论边界 50%）',
    balanced: '均衡（稳定抗 15~25%，容量 +33%）',
    compact: '紧凑（稳定抗 10~15%，容量 +60%）'
  };
  /** 自动缩放候选倍率（长边乘数），按顺序逐个尝试 */
  var AUTO_RESIZE_FACTORS = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];

  // ============================================================
  // 内部工具
  // ============================================================

  /** 惰性解析依赖：加载顺序错时给出明确提示，而不是 undefined 崩溃 */
  function deps() {
    var d = {
      IU: global.ImageUtils,
      DCT: global.DctStego,
      Packet: global.Packet,
      RQ: global.RaptorQ
    };
    var missing = [];
    if (!d.IU) missing.push('image-utils.js (window.ImageUtils)');
    if (!d.DCT) missing.push('dct-stego.js (window.DctStego)');
    if (!d.Packet) missing.push('packet.js (window.Packet)');
    if (!d.RQ) missing.push('raptorq.js (window.RaptorQ)');
    if (missing.length) {
      throw new Error('StegoCore 依赖缺失，请先加载：' + missing.join('、'));
    }
    return d;
  }

  function isImageData(o) {
    return !!o && !!o.data && typeof o.data.length === 'number' &&
      typeof o.width === 'number' && typeof o.height === 'number' &&
      o.width > 0 && o.height > 0;
  }

  function requireImageData(o, name, allowEmpty) {
    if (!o || !o.data || typeof o.data.length !== 'number' ||
        typeof o.width !== 'number' || typeof o.height !== 'number') {
      throw new TypeError(name + ': 需要有效的 ImageData（含 data/width/height）');
    }
    if (!allowEmpty && (o.width <= 0 || o.height <= 0)) {
      throw new Error(name + ': 图像宽高必须大于 0，当前 ' + o.width + 'x' + o.height);
    }
  }

  /** 新建 canvas（浏览器环境） */
  function createCanvas(w, h, fnName) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error((fnName || 'createCanvas') + ': 当前环境不支持 DOM，无法创建 canvas');
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  function get2dContext(canvas, fnName) {
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error((fnName || 'getContext') + ': 无法获取 2D 绘图上下文');
    return ctx;
  }

  /** 新建 ImageData（优先原生构造器，退化到 canvas.createImageData） */
  function makeImageData(data, w, h) {
    if (typeof ImageData === 'function') {
      try {
        return new ImageData(data, w, h);
      } catch (e) { /* 落到降级分支 */ }
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('makeImageData: 当前环境既无 ImageData 构造器也无 DOM');
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (typeof ctx.createImageData === 'function') {
      var img = ctx.createImageData(w, h);
      img.data.set(data);
      return img;
    }
    throw new Error('makeImageData: 无法创建 ImageData');
  }

  function isFiniteNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * 把数值夹到 [lo, hi] 区间内；非有限值（NaN / Infinity）取下界。
   *
   * 【为什么补这个小函数】原先 embedSecret 在"调用方传了 secretJpegQuality"时
   * 会走 `clamp(opt.secretJpegQuality, 0.01, 1)`，但本文件从未定义 clamp ——
   * image-utils.js / dct-stego.js 里各有一个 clamp，可惜都在各自的 IIFE 内部，
   * 外部不可见（本次浏览器实机 ReferenceError 的根因）。
   * 由于该分支藏在 `isFiniteNum(opt.secretJpegQuality) ? ... : 默认值` 的三元里，
   * 只有真正传了这个参数的调用者才会触发：embed.html 传了（点"开始嵌入"即崩），
   * 而所有 Node 测试都没传，于是测试全绿、页面必崩。
   * 这里的实现与上述两个私有 clamp 完全同语义（含"非有限值取下界"的约定），
   * 除新增本函数外不改动任何算法。
   */
  function clamp(v, lo, hi) {
    if (!isFiniteNum(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 字节 → 位（MSB first） */
  function bytesToBits(bytes) {
    var bits = new Uint8Array(bytes.length * 8);
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      var base = i * 8;
      bits[base] = (b >> 7) & 1;
      bits[base + 1] = (b >> 6) & 1;
      bits[base + 2] = (b >> 5) & 1;
      bits[base + 3] = (b >> 4) & 1;
      bits[base + 4] = (b >> 3) & 1;
      bits[base + 5] = (b >> 2) & 1;
      bits[base + 6] = (b >> 1) & 1;
      bits[base + 7] = b & 1;
    }
    return bits;
  }

  /** 位（MSB first）→ 字节 */
  function bitsToBytes(bits) {
    var n = Math.floor(bits.length / 8);
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var base = i * 8;
      out[i] = ((bits[base] & 1) << 7) | ((bits[base + 1] & 1) << 6) |
        ((bits[base + 2] & 1) << 5) | ((bits[base + 3] & 1) << 4) |
        ((bits[base + 4] & 1) << 3) | ((bits[base + 5] & 1) << 2) |
        ((bits[base + 6] & 1) << 1) | (bits[base + 7] & 1);
    }
    return out;
  }

  // 载荷的组装/解析依赖"每 Tile 多少 bit"这一模式参数（见后文 MODE_6 / MODE_4），
  // 因此统一走 buildPayloadFor / parsePayloadFor，两个函数定义在模式常量之后。

  // ------------------------------------------------------------
  // 秘密载荷头（14 字节，version = 2）
  // ------------------------------------------------------------

  /**
   * 组装 srcBytes 头部。
   * [0] version=2 ｜ [1] format ｜ [2..3] W BE ｜ [4..5] H BE
   * [6..9] JPEG 长度 BE ｜ [10..13] CRC32(覆盖 [0..9]，大端存放)
   */
  function buildSecretHeader(format, w, h, jpegLength, Packet) {
    var head = new Uint8Array(SECRET_HEADER_BYTES);
    head[0] = SECRET_VERSION;
    head[1] = format & 0xFF;
    head[2] = (w >>> 8) & 0xFF;
    head[3] = w & 0xFF;
    head[4] = (h >>> 8) & 0xFF;
    head[5] = h & 0xFF;
    head[6] = (jpegLength >>> 24) & 0xFF;
    head[7] = (jpegLength >>> 16) & 0xFF;
    head[8] = (jpegLength >>> 8) & 0xFF;
    head[9] = jpegLength & 0xFF;
    var crc = Packet.crc32(head.subarray(0, 10));
    head[10] = (crc >>> 24) & 0xFF;
    head[11] = (crc >>> 16) & 0xFF;
    head[12] = (crc >>> 8) & 0xFF;
    head[13] = crc & 0xFF;
    return head;
  }

  /** 解析并校验头部；失败返回 null */
  function parseSecretHeader(bytes, Packet) {
    if (!bytes || bytes.length < SECRET_HEADER_BYTES) return null;
    if (bytes[0] !== SECRET_VERSION) return null;
    var format = bytes[1];
    if (format !== 0 && format !== 1) return null;
    var w = (bytes[2] << 8) | bytes[3];
    var h = (bytes[4] << 8) | bytes[5];
    var length = ((bytes[6] << 24) | (bytes[7] << 16) | (bytes[8] << 8) | bytes[9]) >>> 0;
    var crc = ((bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13]) >>> 0;
    if (Packet.crc32(bytes.subarray(0, 10)) !== crc) return null;
    if (w < 1 || w > MAX_DIM || h < 1 || h > MAX_DIM) return null;
    if (length < 1) return null;
    if (SECRET_HEADER_BYTES + length > bytes.length) return null;
    return { format: format, width: w, height: h, length: length };
  }

  // ------------------------------------------------------------
  // JPEG 编解码（秘密图）
  // ------------------------------------------------------------

  /** data:image/jpeg;base64,... → Uint8Array */
  function dataURLToBytes(dataURL) {
    var comma = String(dataURL).indexOf(',');
    if (comma < 0) throw new Error('JPEG 编码失败：dataURL 格式非法');
    var body = String(dataURL).slice(comma + 1);
    if (typeof atob !== 'function') throw new Error('JPEG 编码失败：当前环境缺少 atob');
    var bin = atob(body);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
    return out;
  }

  /** 把 ImageData 画进一个新建 canvas */
  function canvasFromImageData(imageData) {
    var canvas = createCanvas(imageData.width, imageData.height, 'canvasFromImageData');
    get2dContext(canvas, 'canvasFromImageData').putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * 把秘密图编码成 JPEG 字节流（同步）。
   *   浏览器：canvas.toDataURL('image/jpeg', q) —— 这是**同步** API，
   *           能在保持 embedSecret 同步契约的前提下拿到真实 JPEG；
   *   其他环境：使用注入钩子 window.__STEGO_JPEG_ENCODE__(imageData, quality0to1, keepColor)，
   *           供 Node 测试提供真实/替代的 JPEG 编码器。
   */
  function encodeSecretJpeg(imageData, quality, keepColor) {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      var canvas = canvasFromImageData(imageData);
      if (typeof canvas.toDataURL === 'function') {
        var url = canvas.toDataURL('image/jpeg', quality);
        if (url && url.indexOf('data:image/jpeg') === 0) return dataURLToBytes(url);
      }
    }
    var hook = global.__STEGO_JPEG_ENCODE__;
    if (typeof hook === 'function') {
      var bytes = hook(imageData, quality, keepColor);
      if (bytes && typeof bytes.length === 'number') {
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      }
      throw new Error('JPEG 编码钩子返回值非法');
    }
    throw new Error('当前环境不支持 JPEG 编码（缺少 canvas.toDataURL），' +
      '可通过 window.__STEGO_JPEG_ENCODE__ 注入编码器');
  }

  /** 环境是否具备异步 JPEG 解码能力 */
  function canDecodeJpeg() {
    if (typeof createImageBitmap === 'function') return true;
    return typeof Image === 'function' && typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function';
  }

  /** 按长边限制缩放 ImageData（内部经 canvas 缩放） */
  function resizeImageData(imageData, maxLongSide) {
    var IU = deps().IU;
    var canvas = canvasFromImageData(imageData);
    var resized = IU.resizeImage(canvas, maxLongSide);
    return IU.getImageData(resized);
  }

  /** 解析并校验容错档位 */
  function resolveRedundancy(options, fnName) {
    var id = options ? options.redundancy : undefined;
    if (id === undefined || id === null) return 'standard';
    if (!Object.prototype.hasOwnProperty.call(REDUNDANCY, id)) {
      throw new RangeError(fnName + ": redundancy 只能是 'standard' / 'balanced' / 'compact'，当前为 " + id);
    }
    return id;
  }

  /**
   * 解析载荷模式选项。
   *   options.lowFrequencyMode === true  → MODE_4（4 对最低频系数，256 bit/Tile）
   *   其他/缺省                          → MODE_6（6 对系数，384 bit/Tile，默认）
   * 低频模式的代价是容量降到 2/3，换来的是"1/2 缩放后仍可解"——
   * 因为缩放相当于低通滤波，只有最低频的系数对能活下来。
   */
  function resolveMode(options, fnName) {
    var low = options ? options.lowFrequencyMode : undefined;
    if (low !== undefined && low !== null && typeof low !== 'boolean') {
      throw new TypeError(fnName + ': lowFrequencyMode 必须是布尔值，当前为 ' + typeof low);
    }
    return low === true ? MODE_4 : MODE_6;
  }

  /** 把 tile.data（局部 ImageData）写回整图缓冲区的对应位置 */
  function writeTile(target, targetWidth, tile, tileImageData) {
    var tw = tile.width, th = tile.height;
    var src = tileImageData.data;
    for (var r = 0; r < th; r++) {
      var srcRow = r * tw * 4;
      var dstRow = ((tile.y + r) * targetWidth + tile.x) * 4;
      for (var c = 0; c < tw * 4; c++) {
        target[dstRow + c] = src[srcRow + c];
      }
    }
  }

  /**
   * 拆分载体并分类：全部 / 64×64 对齐 / 64×64 且方差达标（保持 scan order）
   *   + 其中"可以放心承载"的安全子集（safe）。
   *
   * ============================ 为什么要再分一层 safe ============================
   * 症状（用户实测 2649×1582、标准档、零遮蔽只读回 434/756 = 57.4%）追到底，
   * 既不是像素被 clamp 吞掉（实测 clamp 只降低幅度、不翻符号：即使每块 3045 次
   * clamp，嵌入后无损提取的比特错误率仍是 0.00%），也不是单纯"图太亮"：
   *
   *   选块用的是 **64×64 Tile 的方差**，而嵌入强度 margin 用的是 **8×8 块的方差**
   *   （dct-stego 的 adaptiveMargin）。一张"头顶大片平滑天空 + 中下部有波纹"的照片里，
   *   天空块虽然块间明暗差很大（Tile 方差轻松过 60），块内却几乎没纹理 →
   *   每个 8×8 块的 margin 只能取到下限 8~10。实测这些块：
   *     · 无损往返：100%（所以单看"自己嵌自己提"完全正常）
   *     · JPEG q=0.90：27%    · JPEG q=0.80：0%    · JPEG q=0.75：0%
   *   而块级 margin ≥ 12.4 的块在 q=0.80 下仍是 100%。这正好解释用户掩码里
   *   "顶部亮天空全红、中下部深色水面绿色密集"——红的是低 margin 的平滑块。
   *
   * 于是判据按"嵌入后实际能站多稳"来定，两条都在**载体上**就能算出来：
   *   ① 块级最小 margin ≥ MIN_BLOCK_MARGIN（主判据，直接决定抗 JPEG 能力）
   *   ② Tile 平均亮度 ∈ [MIN_TILE_LUM, MAX_TILE_LUM]（用户要求的亮度约束；
   *      实测亮度贴近 0/255 时，块内纹理会先被 clamp 削平，标称 margin 12.5 的块
   *      实际只剩 8.0 —— 亮度门槛拦的正是这种"看着有纹理、实际没余量"的块）
   *
   * 注意 safe 只用于**优先选择**，不是硬性剔除：安全块不够时会回落到全部纹理块
   * （见 embedSecret），这样既修好了脆弱块，也不会让本来能嵌的图突然嵌不进去。
   */
  function classifyTiles(carrierImageData, varianceThreshold, marginOptions, lumBounds) {
    var IU = deps().IU;
    var tiles = IU.splitIntoTiles(carrierImageData, TILE_SIZE);
    var aligned = [];
    var textured = [];
    var safe = [];
    var variances = [];
    var darkRejected = 0, brightRejected = 0, lowMarginRejected = 0;
    var minLum = lumBounds ? lumBounds.min : MIN_TILE_LUM;
    var maxLum = lumBounds ? lumBounds.max : MAX_TILE_LUM;
    var minMargin = lumBounds ? lumBounds.minBlockMargin : MIN_BLOCK_MARGIN;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.width !== TILE_SIZE || t.height !== TILE_SIZE) continue; // 丢弃边界 Tile
      aligned.push(t);
      var v = IU.calculateTileVariance(t);
      variances.push(v);
      if (v < varianceThreshold) continue;
      textured.push(t);
      var lum = tileLuminance(t);
      if (lum < minLum) { darkRejected++; continue; }
      if (lum > maxLum) { brightRejected++; continue; }
      if (minBlockMargin(t, marginOptions) < minMargin) { lowMarginRejected++; continue; }
      safe.push(t);
    }
    return {
      all: tiles, aligned: aligned, textured: textured, safe: safe, variances: variances,
      darkRejected: darkRejected, brightRejected: brightRejected,
      lowMarginRejected: lowMarginRejected
    };
  }

  /** Tile 平均亮度 Y = 0.299R + 0.587G + 0.114B */
  function tileLuminance(tile) {
    var d = tile.data.data, n = tile.width * tile.height;
    if (!(n > 0)) return 0;
    var sum = 0;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      sum += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    }
    return sum / n;
  }

  /**
   * Tile 内 8×8 块的**最小** margin（与 dct-stego 的 adaptiveMargin 同一公式）。
   *
   * 为什么取最小而不是平均：一个 Tile 承载 384 个比特，分布在 64 个块上，
   * 只要**任意一个块**的符号被掀翻，整个 Tile 的 CRC 就失败 —— 决定存活的是最弱的那个块。
   * marginOptions 与嵌入时保持一致（用户改 marginMin/marginGain 时判据跟着变）。
   */
  function minBlockMargin(tile, marginOptions) {
    var opt = resolveMarginOptions(marginOptions);
    var d = tile.data.data;
    var w = tile.width, h = tile.height;
    var vals = new Float64Array(64);
    var worst = Infinity;
    for (var by = 0; by + 8 <= h; by += 8) {
      for (var bx = 0; bx + 8 <= w; bx += 8) {
        var sum = 0, r, c;
        for (r = 0; r < 8; r++) {
          for (c = 0; c < 8; c++) {
            var p = ((by + r) * w + (bx + c)) * 4;
            var y = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
            vals[r * 8 + c] = y;
            sum += y;
          }
        }
        var mean = sum / 64;
        var acc = 0;
        for (var i = 0; i < 64; i++) { var dv = vals[i] - mean; acc += dv * dv; }
        var variance = acc / 64;
        var m = opt.marginMin + opt.marginGain * Math.sqrt(Math.max(0, variance));
        if (m > opt.marginMax) m = opt.marginMax;
        if (m < opt.marginMin) m = opt.marginMin;
        if (m < worst) worst = m;
      }
    }
    return isFiniteNum(worst) ? worst : 0;
  }

  /** 与 dct-stego.resolveOptions 的 margin 部分保持一致（缺省 8 / 1.0 / 32） */
  function resolveMarginOptions(marginOptions) {
    var o = marginOptions || {};
    var min = isFiniteNum(o.marginMin) ? o.marginMin : 8;
    var gain = isFiniteNum(o.marginGain) ? o.marginGain : 1.0;
    var max = isFiniteNum(o.marginMax) ? o.marginMax : 32;
    if (max < min) max = min;
    return { marginMin: min, marginGain: gain, marginMax: max };
  }

  /** 解析并校验 tileStrategy 选项 */
  function resolveStrategy(options, fnName) {
    var s = options ? options.tileStrategy : undefined;
    if (s === undefined || s === null) return DEFAULT_TILE_STRATEGY;
    if (s !== 'spread' && s !== 'scan') {
      throw new RangeError(fnName + ": tileStrategy 只能是 'spread' 或 'scan'，当前为 " + s);
    }
    return s;
  }

  /** 层（桶）内等距抽样：取 list 中均匀分布的 q 个元素，保持原有顺序 */
  function pickEvenly(list, q) {
    if (q <= 0) return [];
    if (q >= list.length) return list.slice();
    var out = new Array(q);
    for (var i = 0; i < q; i++) {
      out[i] = list[Math.floor(i * list.length / q)];
    }
    return out;
  }

  /**
   * 网格分桶 + 棋盘配额 + 桶内等距抽样（'spread'）。
   *
   * 棋盘配额：TL = BR = a，TR = BL = b，a + b = K
   *   → 左半 = TL+BL = a+b = K；右半 = TR+BR = b+a = K；
   *     上半 = TL+TR = a+b = K；下半 = BL+BR = b+a = K
   *   四个半平面各恰好 K 个符号 —— 这是 50% 面积破坏下能达到的最优平衡
   *   （总符号数 2K，两侧都必须 >= K，故只能都等于 K）。
   */
  function selectSpreadTiles(textured, N, cols, rows) {
    var K = N >> 1; // N = 2K 恒为偶数
    var buckets = [[], [], [], []]; // 0=左上 1=右上 2=左下 3=右下
    for (var i = 0; i < textured.length; i++) {
      var t = textured[i];
      var col = Math.floor(t.x / TILE_SIZE);
      var row = Math.floor(t.y / TILE_SIZE);
      // 用 row < rows/2 而不是 row*2 < rows：行数为奇数时把多出来的一行给上半，
      // 避免出现"上半 1 行、下半 2 行"这种明显偏斜
      var top = row < rows / 2;
      var left = col < cols / 2;
      buckets[(top ? 0 : 2) + (left ? 0 : 1)].push(t);
    }

    var aMax = Math.min(buckets[0].length, buckets[3].length); // A 组（左上 + 右下）
    var bMax = Math.min(buckets[1].length, buckets[2].length); // B 组（右上 + 左下）
    var a, b;
    if (aMax + bMax >= K) {
      // 容量够：在 a <= aMax 且 b = K - a <= bMax 的前提下，尽量对半分
      a = Math.min(aMax, Math.max(K - bMax, Math.ceil(K / 2)));
      b = K - a;
    } else {
      // 容量不足以维持严格平衡：按可用容量尽力取满（此时可能偏向一侧）
      a = aMax;
      b = bMax;
    }

    var chosen = [];
    chosen = chosen.concat(pickEvenly(buckets[0], a));
    chosen = chosen.concat(pickEvenly(buckets[3], a));
    chosen = chosen.concat(pickEvenly(buckets[1], b));
    chosen = chosen.concat(pickEvenly(buckets[2], b));

    // 兜底：配额受容量限制导致不足 N 个时，按扫描序补齐（保持确定性）
    if (chosen.length < N) {
      var picked = new Set(chosen);
      for (var k = 0; k < textured.length && chosen.length < N; k++) {
        if (!picked.has(textured[k])) {
          picked.add(textured[k]);
          chosen.push(textured[k]);
        }
      }
    }
    return chosen;
  }

  /** 按策略选出实际承载符号的 N 个 Tile */
  function selectTiles(textured, N, strategy, cols, rows) {
    if (strategy === 'scan') {
      return textured.length > N ? textured.slice(0, N) : textured.slice();
    }
    return selectSpreadTiles(textured, N, cols, rows);
  }

  // ============================================================
  // 对外命名空间
  // ============================================================
  var StegoCore = {};

  /**
   * 灰度转换：Y = 0.299R + 0.587G + 0.114B，RGB 同置为 Y，A 保持不变。
   * 返回新 ImageData，不修改入参。
   */
  StegoCore.toGrayscale = function (imageData) {
    requireImageData(imageData, 'toGrayscale');
    var w = imageData.width, h = imageData.height;
    var src = imageData.data;
    var out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      var o = i * 4;
      var y = Math.round(0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]);
      if (y < 0) y = 0;
      if (y > 255) y = 255;
      out[o] = y;
      out[o + 1] = y;
      out[o + 2] = y;
      out[o + 3] = src[o + 3];
    }
    return makeImageData(out, w, h);
  };

  /**
   * 容量分析（v2）。
   * @param {ImageData} carrierImageData
   * @param {number} secretJpegBytesLength 秘密图 **JPEG 编码后的字节数**
   *        （v1 传的是像素数；v2 传 JPEG 字节数，页面会先编码一次拿到真实长度）
   * @param {{varianceThreshold?:number, redundancy?:string, tileStrategy?:string}} [options]
   */
  StegoCore.analyzeCapacity = function (carrierImageData, secretJpegBytesLength, options) {
    requireImageData(carrierImageData, 'analyzeCapacity');
    var opt = options || {};
    var threshold = isFiniteNum(opt.varianceThreshold) ?
      opt.varianceThreshold : DEFAULT_VARIANCE_THRESHOLD;
    var strategy = resolveStrategy(opt, 'analyzeCapacity');
    var redundancy = resolveRedundancy(opt, 'analyzeCapacity');
    var mode = resolveMode(opt, 'analyzeCapacity');
    var factor = REDUNDANCY[redundancy];

    var cls = classifyTiles(carrierImageData, threshold, opt.marginOptions, resolveLumBounds(opt));
    var textured = cls.textured.length;
    var safe = cls.safe.length;

    var secretLen = isFiniteNum(secretJpegBytesLength) && secretJpegBytesLength > 0 ?
      Math.floor(secretJpegBytesLength) : 0;
    var L = SECRET_HEADER_BYTES + secretLen;
    var K = Math.ceil(L / mode.symbolSize);
    var N = Math.ceil(K * factor);

    // 该载体最多能装多少秘密图 JPEG 字节：K_max = floor(Tile数 / 冗余系数)
    //   两个数字都给：texturedTiles 是"能选"，safeTiles 是"选了能扛住 JPEG"。
    var Kmax = Math.floor(textured / factor);
    var maxSrcBytes = Kmax * mode.symbolSize;
    var maxSecretBytes = Math.max(0, maxSrcBytes - SECRET_HEADER_BYTES);
    var safeKmax = Math.floor(safe / factor);
    var maxSafeSecretBytes = Math.max(0, safeKmax * mode.symbolSize - SECRET_HEADER_BYTES);

    return {
      totalTiles: cls.all.length,
      alignedTiles: cls.aligned.length,
      texturedTiles: textured,
      safeTiles: safe,
      // 因过于"没有纹理余量"而被安全筛选剔掉的三类 Tile（用户能据此看出损失在哪）
      darkRejected: cls.darkRejected,
      brightRejected: cls.brightRejected,
      lowMarginRejected: cls.lowMarginRejected,
      minTileLum: resolveLumBounds(opt).min,
      maxTileLum: resolveLumBounds(opt).max,
      minBlockMargin: resolveLumBounds(opt).minBlockMargin,
      K: K,
      N: N,
      symbolSize: mode.symbolSize,
      mode: mode.id,
      lowFrequencyMode: mode === MODE_4,
      fits: textured >= N,                 // 保持旧口径：纹理块够就能嵌（安全块不够会回落）
      fitsSafe: safe >= N,
      maxSecretBytes: maxSecretBytes,       // 单位：JPEG 字节（按纹理块算）
      maxSafeSecretBytes: maxSafeSecretBytes,
      redundancy: redundancy,
      redundancyFactor: factor,
      tileStrategy: strategy
    };
  };

  /** 解析安全块判据的三个阈值（全部可被 options 覆盖，便于调参与测试对照） */
  function resolveLumBounds(opt) {
    var o = opt || {};
    return {
      min: isFiniteNum(o.minTileLum) ? o.minTileLum : MIN_TILE_LUM,
      max: isFiniteNum(o.maxTileLum) ? o.maxTileLum : MAX_TILE_LUM,
      minBlockMargin: isFiniteNum(o.minBlockMargin) ? o.minBlockMargin : MIN_BLOCK_MARGIN
    };
  }

  /**
   * 嵌入秘密图（v2）。
   * @param {ImageData} carrierImageData 载体
   * @param {ImageData} secretImageData  秘密图（会被编成 JPEG）
   * @param {{varianceThreshold?:number, marginOptions?:object, onProgress?:function,
   *          redundancy?:string, secretJpegQuality?:number, secretKeepColor?:boolean}} [options]
   * @returns {{outputImageData: ImageData, stats: object}}
   */
  StegoCore.embedSecret = function (carrierImageData, secretImageData, options) {
    var d = deps();
    requireImageData(carrierImageData, 'embedSecret(carrierImageData)');
    // 秘密图先做尺寸校验（0×0 时不要往下走 —— 浏览器里 new ImageData(0,0) 会抛）
    requireImageData(secretImageData, 'embedSecret(secretImageData)', true);
    var origW = secretImageData.width, origH = secretImageData.height;
    if (origW <= 0 || origH <= 0) {
      throw new Error('秘密图为空：宽高必须大于 0，当前 ' + origW + 'x' + origH);
    }
    if (origW > MAX_DIM || origH > MAX_DIM) {
      throw new Error('秘密图尺寸超限：宽高必须在 1~' + MAX_DIM + ' 之间，当前 ' + origW + 'x' + origH);
    }

    var opt = options || {};
    var threshold = isFiniteNum(opt.varianceThreshold) ?
      opt.varianceThreshold : DEFAULT_VARIANCE_THRESHOLD;
    var marginOptions = opt.marginOptions || {};
    var onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : null;
    var strategy = resolveStrategy(opt, 'embedSecret');
    var redundancy = resolveRedundancy(opt, 'embedSecret');
    var mode = resolveMode(opt, 'embedSecret');
    var factor = REDUNDANCY[redundancy];
    var jpegQuality = isFiniteNum(opt.secretJpegQuality) ?
      clamp(opt.secretJpegQuality, 0.01, 1) : DEFAULT_SECRET_JPEG_QUALITY;
    var keepColor = opt.secretKeepColor === undefined ? true : !!opt.secretKeepColor;
    var format = keepColor ? 1 : 0;

    // ---- 1) 载体分块：先摸清可用纹理 Tile 数与"安全块"数，供自动缩放判断 ----
    var bounds = resolveLumBounds(opt);
    var cls = classifyTiles(carrierImageData, threshold, marginOptions, bounds);
    var texturedTiles = cls.textured.length;
    var safeTiles = cls.safe.length;
    if (texturedTiles < 1) {
      throw new Error('载体太小，无法嵌入：该图没有任何 64×64 且方差达标的纹理 Tile。');
    }

    // ---- 2) 秘密图 → JPEG；太大就按倍率逐级缩小重编码 ----
    //
    // 容量按**安全块**算：安全块不够时先把秘密图缩小，而不是硬塞进脆弱块 ——
    //   用户那张"头顶平滑亮天空"的图正是死在这里（脆弱块占了大半，零遮蔽只读回 57%）。
    //   只有当秘密图缩到最小仍装不进安全块时，才回落到全部纹理块（保持旧行为），
    //   并在 stats.riskyTilesUsed 里如实标注"这次用了脆弱块"。
    function planAttempts(limit) {
      var found = null;
      var tried = [];
      for (var f = 0; f < AUTO_RESIZE_FACTORS.length; f++) {
        var scale = AUTO_RESIZE_FACTORS[f];
        var longSide = Math.round(Math.max(origW, origH) * scale);
        if (scale < 1 && longSide < MIN_SECRET_LONG_SIDE) break; // 缩到长边 < 64 仍不行，放弃
        var candidate = (scale === 1) ? secretImageData : resizeImageData(secretImageData, longSide);
        var jpegBytes = encodeSecretJpeg(candidate, jpegQuality, keepColor);
        var L = SECRET_HEADER_BYTES + jpegBytes.length;
        var Kt = Math.ceil(L / mode.symbolSize);
        var Nt = Math.ceil(Kt * factor);
        tried.push({ scale: scale, w: candidate.width, h: candidate.height, bytes: jpegBytes.length, K: Kt, N: Nt });
        if (!found && Nt <= limit) {
          found = {
            scale: scale, image: candidate, jpeg: jpegBytes,
            L: L, K: Kt, N: Nt, width: candidate.width, height: candidate.height
          };
        }
      }
      return { attempt: found, tried: tried };
    }

    var planned = planAttempts(safeTiles);
    var attempt = planned.attempt;
    var triedFactors = planned.tried;
    var riskyTilesUsed = false;
    if (!attempt && texturedTiles > safeTiles) {
      // 安全块装不下：回落到全部纹理块（旧行为），并记下"用了脆弱块"
      var fallback = planAttempts(texturedTiles);
      attempt = fallback.attempt;
      triedFactors = fallback.tried;
      riskyTilesUsed = !!attempt;
    }

    if (!attempt) {
      var last = triedFactors.length ? triedFactors[triedFactors.length - 1] : null;
      throw new Error('载体太小，无法嵌入：可用纹理 Tile 只有 ' + texturedTiles + ' 个' +
        '（其中安全块 ' + safeTiles + ' 个），' +
        (last ? '秘密图缩到 ' + last.w + '×' + last.h + '（JPEG ' + last.bytes + ' 字节）仍需要 ' +
          last.N + ' 个 Tile。' : '秘密图已缩到长边 ' + MIN_SECRET_LONG_SIDE + ' 像素仍放不下。') +
        ' 请换更大的载体图，或把冗余档位调成 balanced / compact。');
    }

    var K = attempt.K;
    var N = attempt.N;
    var jpeg = attempt.jpeg;
    var L2 = attempt.L;

    // ---- 3) 组装 srcBytes（14 字节头 + JPEG）----
    var src = new Uint8Array(L2);
    src.set(buildSecretHeader(format, attempt.width, attempt.height, jpeg.length, d.Packet), 0);
    src.set(jpeg, SECRET_HEADER_BYTES);

    // ---- 4) RaptorQ 编码 ----
    var enc = d.RQ.createEncoder(src, K, mode.symbolSize);
    var symbols = new Array(N);
    for (var i = 0; i < N; i++) {
      symbols[i] = enc.generateSymbol(i);
      if (onProgress) onProgress('encode', i + 1, N);
    }

    // ---- 5) 拷贝载体并逐 Tile 嵌入 ----
    //   选块优先只用安全块；只有当"秘密图缩到最小仍装不下安全块"时才回落到全部纹理块
    //   （riskyTilesUsed=true），此时用的块里会混有脆弱块，stats 里如实标注。
    var cw = carrierImageData.width, ch = carrierImageData.height;
    var cols = Math.floor(cw / TILE_SIZE);
    var rows = Math.floor(ch / TILE_SIZE);
    var pool = (!riskyTilesUsed && cls.safe.length >= N) ? cls.safe : cls.textured;
    var usedTiles = selectTiles(pool, N, strategy, cols, rows);
    if (usedTiles.length < N) {
      // 兜底：安全块被 spread 分桶后不足 N 个时，用纹理块补齐（保持确定性扫描序）
      var picked = {};
      for (i = 0; i < usedTiles.length; i++) picked[usedTiles[i].x + ',' + usedTiles[i].y] = true;
      for (i = 0; i < cls.textured.length && usedTiles.length < N; i++) {
        var cand = cls.textured[i];
        if (!picked[cand.x + ',' + cand.y]) { picked[cand.x + ',' + cand.y] = true; usedTiles.push(cand); }
      }
    }
    var outData = new Uint8ClampedArray(carrierImageData.data.length);
    outData.set(carrierImageData.data);

    for (i = 0; i < N; i++) {
      var tile = usedTiles[i];
      var payload = buildPayloadFor(mode, i, K, symbols[i], d.Packet);
      var bits = bytesToBits(payload);
      // DctStego 返回新的 ImageData，不改入参；低频模式用 4 对最低频系数
      var embedded = d.DCT.embedBitsInTile(tile.data, bits, withPairs(marginOptions, mode));
      writeTile(outData, cw, tile, embedded);
      if (onProgress) onProgress('embed', i + 1, N);
    }

    // ---- 6) 叠加几何标尺（抗缩放的关键：让提取端能量出缩放倍率）----
    var outImage = makeImageData(outData, cw, ch);
    var hasScale = false;
    var GC = global.GeoCalibration;
    if (GC && typeof GC.embedScale === 'function' && opt.embedScale !== false) {
      outImage = GC.embedScale(outImage, cw, ch);
      hasScale = true;
    }

    return {
      outputImageData: outImage,
      stats: {
        K: K,
        N: N,
        symbolSize: mode.symbolSize,
        payloadBytes: mode.payloadBytes,
        bitsPerTile: mode.bitsPerTile,
        mode: mode.id,
        lowFrequencyMode: mode === MODE_4,
        texturedTiles: texturedTiles,
        safeTiles: safeTiles,
        darkRejected: cls.darkRejected,
        brightRejected: cls.brightRejected,
        lowMarginRejected: cls.lowMarginRejected,
        usedSafeTiles: (pool === cls.safe),
        riskyTilesUsed: riskyTilesUsed,
        usedTiles: N,
        tileStrategy: strategy,
        redundancy: redundancy,
        redundancyFactor: factor,
        secretBytes: attempt.width * attempt.height,
        secretOriginalSize: { W: origW, H: origH },
        secretFinalSize: { W: attempt.width, H: attempt.height },
        secretAutoResized: (attempt.width !== origW || attempt.height !== origH),
        secretJpegBytes: jpeg.length,
        secretJpegQuality: jpegQuality,
        secretKeepColor: keepColor,
        secretFormat: format,
        hasScale: hasScale,
        // 供没有 JPEG 解码器的环境做"逐字节等价"判定（CRC32 相同即字节流一致）
        secretJpegCrc32: d.Packet.crc32(jpeg)
      }
    };
  };

  /** 4 对低频回退模式使用的系数对（量化表值最小、频率最低，抗缩放） */
  var DEFAULT_LOW_FREQ_PAIRS = [
    [2, 0, 0, 2],
    [2, 1, 1, 2],
    [3, 0, 0, 3],
    [3, 1, 1, 3]
  ];

  // ------------------------------------------------------------
  // 两种载荷模式（系数对数不同 → 每 Tile 比特数与符号尺寸都不同）
  // ------------------------------------------------------------
  /** 6 对模式（默认）：384 bit/Tile，符号 40 字节，payload 48 字节 */
  var MODE_6 = {
    id: 'mode6', pairs: null,
    bitsPerTile: PAYLOAD_BITS, symbolSize: SYMBOL_SIZE,
    payloadBytes: PAYLOAD_BYTES, bodyBytes: PAYLOAD_BODY_BYTES
  };
  /** 4 对低频回退模式：256 bit/Tile，符号 24 字节，payload 32 字节（抗缩放） */
  var MODE_4 = {
    id: 'mode4', pairs: DEFAULT_LOW_FREQ_PAIRS,
    bitsPerTile: 64 * 4, symbolSize: 24,
    payloadBytes: 32, bodyBytes: 28
  };

  /** 按模式组装 payload（复用 packet.js 的 CRC） */
  function buildPayloadFor(mode, seq, K, symbol, Packet) {
    var body = new Uint8Array(mode.bodyBytes);
    body[0] = (seq >>> 8) & 0xFF;
    body[1] = seq & 0xFF;
    body[2] = (K >>> 8) & 0xFF;
    body[3] = K & 0xFF;
    body.set(symbol, 4);
    return Packet.pack(body);          // 小端 CRC 在尾部
  }

  /** 按模式解析 payload；CRC 失败返回 null */
  function parsePayloadFor(mode, bytes, Packet) {
    if (!bytes || bytes.length !== mode.payloadBytes) return null;
    var r = Packet.unpack(bytes);
    if (!r.valid || !r.payload || r.payload.length !== mode.bodyBytes) return null;
    var p = r.payload;
    return {
      seq: ((p[0] << 8) | p[1]) & 0xFFFF,
      K: ((p[2] << 8) | p[3]) & 0xFFFF,
      symbol: p.slice(4, mode.bodyBytes)
    };
  }

  // ------------------------------------------------------------
  // 网格相位搜索（任务 B，内部实现，不对外暴露）
  // ------------------------------------------------------------
  var PHASE_STEP = 8;            // 相位粒度（8×8 DCT 块决定最小粒度是 8px）
  var PHASE_PROBE_TILES = 16;    // 精探时每个相位的 Tile 数
  // 粗探块数从 2 提到 8：这是"裁切恢复靠运气"的根因。
  //   旧实现每个相位只粗探 2 个块，而采样点是确定性等距的（t=0 与 t=总数/2），
  //   于是**不同裁切量会采到同一批原图块**（实测裁 8/16/24/32/40/48/56px 时，
  //   采样点恒为原图 (64,64) 与 (64,512)）。这两个块恰好不承载数据时，真相位
  //   在粗探阶段恒为 0/2 → 永远进不了精探 → 7 种裁切偏移全部失败（实测 7/7）。
  //   提到 8 块后，真相位的通过率恢复到 ~37%（3/8），远高于 10% 的接受阈值。
  var PHASE_COARSE_TILES = 8;
  var PHASE_REFINE_MAX = 8;      // 最多对 8 个"粗探有命中"的相位做精探

  /** 从任意 (x,y) 处取出一个 64×64 Tile 的局部 ImageData（越界返回 null） */
  function readTileAt(img, x, y) {
    if (x < 0 || y < 0 || x + TILE_SIZE > img.width || y + TILE_SIZE > img.height) return null;
    var out = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    var rowBytes = TILE_SIZE * 4;
    for (var r = 0; r < TILE_SIZE; r++) {
      var srcRow = ((y + r) * img.width + x) * 4;
      for (var c = 0; c < rowBytes; c++) out[r * rowBytes + c] = img.data[srcRow + c];
    }
    return makeImageData(out, TILE_SIZE, TILE_SIZE);
  }

  /**
   * 在给定相位下，均匀采样若干 Tile 做 CRC 探测，返回 { valid, total }。
   * modes 传入候选载荷模式数组（默认 [MODE_6]，尺度恢复后加 [MODE_4, MODE_6]），
   * 同一 Tile 只要在**任一**模式下 CRC 通过就算有效 —— 提取端不知道嵌入端用了哪种模式。
   * @param {number} want 探测的 Tile 数（粗探用少量，精探用 PHASE_PROBE_TILES）
   */
  function probeGridPhase(img, dx, dy, modes, marginOptions, d, want) {
    var cols = Math.floor((img.width - dx) / TILE_SIZE);
    var rows = Math.floor((img.height - dy) / TILE_SIZE);
    var total = cols * rows;
    if (cols <= 0 || rows <= 0) return { valid: 0, total: 0 };
    var probe = Math.min(want || PHASE_PROBE_TILES, total);
    var valid = 0;
    for (var i = 0; i < probe; i++) {
      // 采样点取每段的**中点**：floor((i+0.5)·总数/探针数)。
      //   旧写法 floor(i·总数/探针数) 会让"第一块"永远是裁剪后网格的左上角，
      //   而它对应的原图块与裁切量无关（总是原图第一个完整块），于是不同裁切量
      //   反复采到同一批块；取中点让采样点均匀铺开，减小"两三个块恰好都不承载"
      //   导致整轮相位搜索落空的概率。
      var t = Math.min(total - 1, Math.floor((i + 0.5) * total / probe));
      var x = dx + (t % cols) * TILE_SIZE;
      var y = dy + Math.floor(t / cols) * TILE_SIZE;
      var tileData = readTileAt(img, x, y);
      if (!tileData) continue;
      for (var m = 0; m < modes.length; m++) {
        if (tileMatchesMode(tileData, modes[m], marginOptions, d)) { valid++; break; }
      }
    }
    return { valid: valid, total: probe };
  }

  /** 单个 Tile 在某个模式下是否 CRC 通过 */
  function tileMatchesMode(tileData, mode, marginOptions, d) {
    var mo = withPairs(marginOptions, mode);
    var bits = d.DCT.extractBitsFromTile(tileData, mode.bitsPerTile, mo);
    return !!parsePayloadFor(mode, bitsToBytes(bits), d.Packet);
  }

  /** 复制一份 marginOptions 并叠加模式要求的系数对（不污染调用方对象） */
  function withPairs(marginOptions, mode) {
    var mo = {};
    if (marginOptions) {
      for (var key in marginOptions) {
        if (Object.prototype.hasOwnProperty.call(marginOptions, key)) mo[key] = marginOptions[key];
      }
    }
    if (mode && mode.pairs) mo.pairs = mode.pairs;
    return mo;
  }

  /**
   * 8px 粒度搜索 64 种网格相位，返回通过率最高的相位。
   * 只在常规提取失败后触发，成功路径零开销。
   *
   * 两级结构（为了"未隐写图不要卡住"的耗时要求）：
   *   ① 粗探：每个相位均匀采 PHASE_COARSE_TILES（8）个 Tile，取每段中点。
   *      共 63×8 次单块提取（两种载荷模式都试），512² 实测整轮 ~0.4 s；
   *   ② 精探：只对粗探有命中的相位（最多 PHASE_REFINE_MAX=8 个）用
   *      PHASE_PROBE_TILES（16）个 Tile 复测，取通过率最高者。
   *   未隐写图在①里全部 0 命中 → 直接返回，跳过②；真隐写图在①里的命中率
   *   实测约 37%（3/8），远高于 10% 的接受阈值。
   */
  function searchGridPhase(img, modes, marginOptions, onProgress, d) {
    var phases = [];
    for (var dy = 0; dy < TILE_SIZE; dy += PHASE_STEP) {
      for (var dx = 0; dx < TILE_SIZE; dx += PHASE_STEP) {
        if (dx === 0 && dy === 0) continue;          // (0,0) 已在常规提取里试过
        phases.push({ dx: dx, dy: dy });
      }
    }
    var tested = 0, i;
    var coarse = [];
    for (i = 0; i < phases.length; i++) {
      var r = probeGridPhase(img, phases[i].dx, phases[i].dy, modes, marginOptions, d,
        PHASE_COARSE_TILES);
      coarse.push({ dx: phases[i].dx, dy: phases[i].dy, valid: r.valid, total: r.total });
      tested++;
      if (onProgress) onProgress('标定中', tested, phases.length);
    }
    coarse.sort(function (a, b) { return b.valid - a.valid; });

    var best = { dx: 0, dy: 0, valid: 0, total: PHASE_PROBE_TILES };
    var limit = Math.min(PHASE_REFINE_MAX, coarse.length);
    for (i = 0; i < limit; i++) {
      if (coarse[i].valid <= 0) break;               // 粗探零命中 → 后面的更差
      var rr = probeGridPhase(img, coarse[i].dx, coarse[i].dy, modes, marginOptions, d,
        PHASE_PROBE_TILES);
      if (rr.valid > best.valid) best = { dx: coarse[i].dx, dy: coarse[i].dy, valid: rr.valid, total: rr.total };
      tested++;
      if (onProgress) onProgress('标定中', tested, phases.length + limit);
      if (best.valid === best.total) break;          // 已满分，不必再看
    }
    best.tested = tested;
    best.coarseHits = coarse.length ? coarse[0].valid : 0;
    return best;
  }

  /** 按目标尺寸重采样（用 canvas 高质量缩放） */
  function resizeToSize(imageData, w, h) {
    var canvas = canvasFromImageData(imageData);
    var dst = createCanvas(w, h, 'resizeToSize');
    var ctx = get2dContext(dst, 'resizeToSize');
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** 把偏移网格的结果拼回原尺寸的 debugMask（网格外区域判灰） */
  function adaptMask(subMask, dx, dy, w, h) {
    var data = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      var o = i * 4;
      data[o] = 128; data[o + 1] = 128; data[o + 2] = 128; data[o + 3] = DEBUG_ALPHA;
    }
    for (var y = 0; y < subMask.height; y++) {
      var ty = y + dy;
      if (ty < 0 || ty >= h) continue;
      for (var x = 0; x < subMask.width; x++) {
        var tx = x + dx;
        if (tx < 0 || tx >= w) continue;
        var s = (y * subMask.width + x) * 4;
        var dd = (ty * w + tx) * 4;
        data[dd] = subMask.data[s];
        data[dd + 1] = subMask.data[s + 1];
        data[dd + 2] = subMask.data[s + 2];
        data[dd + 3] = subMask.data[s + 3];
      }
    }
    return makeImageData(data, w, h);
  }

  /**
   * 提取秘密图。
   *
   * 四种恢复路径（recoveryPath）：
   *   'normal' —— 网格对齐、无缩放：直接按 (0,0) 相位提取；
   *   'phase'  —— 被裁掉非 64 倍数边缘：8px 粒度搜索 64 种网格相位；
   *   'scale'  —— 被缩放过：用几何标尺量出原始尺寸 → 重采样回原尺寸
   *               → **干扰对消**（减去标尺图案）→ 提取；
   *   'failed' —— 均失败。
   *
   * 每种路径都按 [MODE_6, MODE_4] 顺序尝试两种载荷模式：
   * 嵌入端用哪种模式提取端并不知道，而两种模式的"每 Tile 比特数 / 符号尺寸 /
   * payload 长度"都不同，所以只能穷举 —— 好在只有两种，代价可接受。
   *
   * @param {ImageData} carrierImageData 隐写图
   * @param {{marginOptions?:object, onProgress?:function}} [options]
   * @returns {{success:boolean, mode:string|null, secretJpegBytes:Uint8Array|null,
   *            secretWidth:number, secretHeight:number, validTiles:number,
   *            totalTiles:number, K_effective:number, debugMask:ImageData,
   *            recoveryPath:string, decodeSupported:boolean, attempts:object}}
   *
   * 关于 attempts：把每条路径的中间结果都带出来（两种模式在常规路径下各自读出
   * 多少有效块、相位搜索选中的相位与通过率、标尺读到的尺寸与置信度）。
   * 失败时尤其重要：旧实现返回的是"最后尝试的那个模式"（MODE_4）的结果，
   * 而 6 对嵌入的图用 MODE_4 读永远是 0 个有效块 —— 界面上于是恒显示"0/N 全红"，
   * 与损坏程度无关，严重误导使用者。
   */
  StegoCore.extractSecret = function (carrierImageData, options) {
    var d = deps();
    requireImageData(carrierImageData, 'extractSecret(carrierImageData)');
    var opt = options || {};
    var marginOptions = opt.marginOptions || {};
    var onProgress = typeof opt.onProgress === 'function' ? opt.onProgress : null;
    var attempts = {
      normal6: { tried: false, validTiles: 0, K_effective: 0 },
      normal4: { tried: false, validTiles: 0, K_effective: 0 },
      phase: { tried: false, bestPhase: null, bestRate: 0, validTiles: 0 },
      scale: { tried: false, detectedSize: null, alpha: 0, z: 0, confidence: 'none', used: false }
    };

    // ---- 1) 常规提取：两种模式**各自**跑一次，分别记录有效块数 ----
    var r6 = extractAtPhase(carrierImageData, 0, 0, MODE_6, marginOptions, onProgress, d);
    attempts.normal6 = { tried: true, validTiles: r6.validTiles, K_effective: r6.K_effective };
    if (r6.success) {
      r6.recoveryPath = 'normal';
      r6.attempts = attempts;
      return r6;
    }
    var r4 = extractAtPhase(carrierImageData, 0, 0, MODE_4, marginOptions, onProgress, d);
    attempts.normal4 = { tried: true, validTiles: r4.validTiles, K_effective: r4.K_effective };
    if (r4.success) {
      r4.recoveryPath = 'normal';
      r4.attempts = attempts;
      return r4;
    }
    // 都失败：主结果取**有效块更多**的那个模式（而不是"最后尝试的那个"），
    // 这样界面上的 validTiles/debugMask 才反映真实的损坏程度。
    var first = (r4.validTiles > r6.validTiles) ? r4 : r6;

    // ---- 2) 网格相位搜索（抗"非 64 倍数"裁切）----
    var phase = searchGridPhase(carrierImageData, [MODE_6, MODE_4], marginOptions, onProgress, d);
    var passRate = phase.total > 0 ? phase.valid / phase.total : 0;
    attempts.phase = {
      tried: true,
      bestPhase: (phase.dx !== 0 || phase.dy !== 0) ? [phase.dx, phase.dy] : null,
      bestRate: passRate,
      validTiles: 0
    };
    if ((phase.dx !== 0 || phase.dy !== 0) && passRate >= 0.1) {
      var second = tryModesAtPhase(carrierImageData, phase.dx, phase.dy, [MODE_6, MODE_4],
        marginOptions, onProgress, d);
      attempts.phase.validTiles = second.validTiles;
      if (second.success) {
        second.recoveryPath = 'phase';
        second.phaseOffset = { dx: phase.dx, dy: phase.dy };
        second.debugMask = adaptMask(second.debugMask, phase.dx, phase.dy,
          carrierImageData.width, carrierImageData.height);
        second.attempts = attempts;
        return second;
      }
    }

    // ---- 3) 尺度标尺 + 干扰对消（抗缩放）----
    //   只有 extractScale 给出 confidence === 'high' 才允许重采样整图：
    //   没有标尺的图也会被读出一个虚假尺寸（实测无标尺图误报 227×227、
    //   纯噪声图误报 2283×2283），照着它重采样只会把整幅图带偏、白花十几秒。
    var GC = global.GeoCalibration;
    if (GC && typeof GC.extractScale === 'function') {
      if (onProgress) onProgress('重同步', 0, 1);
      var size = null;
      try { size = GC.extractScale(carrierImageData); } catch (e) { size = null; }
      attempts.scale = {
        tried: true,
        detectedSize: size ? { w: size.width, h: size.height } : null,
        alpha: size && typeof size.alpha === 'number' ? size.alpha : 0,
        // z（谱峰尖锐度）只作诊断信息带出来：界面不展示，但出问题时能看出
        // "α 大而 z 小"这类内容误报（实测无标尺图 α=1.25 / z=1.33）。
        z: size && typeof size.z === 'number' ? size.z : 0,
        confidence: size && size.confidence ? size.confidence : 'none',
        used: false
      };
      var confident = !!(size && size.confidence === 'high' &&
        size.width > 0 && size.height > 0 &&
        (size.width !== carrierImageData.width || size.height !== carrierImageData.height));
      if (confident) {
        if (onProgress) onProgress('重同步', 1, 1);
        var restored = resizeToSize(carrierImageData, size.width, size.height);

        // 3a) 先按恢复后的尺寸直接提取（标尺能量只占 ~1.2/255，多数情况无碍）
        var third = tryModesAtPhase(restored, 0, 0, [MODE_4, MODE_6], marginOptions, null, d);

        // 3b) 失败则做干扰对消：把标尺图案按最小二乘拟合的幅度从图里减掉。
        //     重采样会让标尺相位/幅度发生轻微变化，用残差幅度 α 自适应即可。
        if (!third.success && GC && typeof GC.removeScale === 'function') {
          var cancelled = null;
          try {
            cancelled = GC.removeScale(restored, size.width, size.height);
          } catch (e2) { cancelled = null; }
          if (cancelled) {
            var fourth = tryModesAtPhase(cancelled, 0, 0, [MODE_4, MODE_6], marginOptions, null, d);
            if (fourth.success) {
              fourth.recoveryPath = 'scale';
              fourth.restoredSize = { width: size.width, height: size.height };
              fourth.scaleCancelled = true;
              fourth.scaleAlpha = GC.lastAlpha;
              attempts.scale.used = true;
              attempts.scale.cancelled = true;
              fourth.attempts = attempts;
              return fourth;
            }
            // 对消没救回来就退回"未对消"的结果做调试输出（对消后的 mask 也可参考）
            third.debugMask = fourth.debugMask;
          }
        }

        if (third.success) {
          third.recoveryPath = 'scale';
          third.restoredSize = { width: size.width, height: size.height };
          attempts.scale.used = true;
          third.attempts = attempts;
          return third;
        }
      }
    }

    // ---- 4) 失败 ----
    first.recoveryPath = 'failed';
    first.attempts = attempts;
    return first;
  };

  /** 在某个网格相位上依次尝试多种载荷模式，返回第一个成功的结果（都失败则返回最后一次） */
  function tryModesAtPhase(carrierImageData, dx, dy, modes, marginOptions, onProgress, d) {
    var last = null;
    for (var i = 0; i < modes.length; i++) {
      var r = extractAtPhase(carrierImageData, dx, dy, modes[i], marginOptions, onProgress, d);
      if (r.success) return r;
      last = r;
    }
    return last || emptyResult(carrierImageData.width, carrierImageData.height, d);
  }

  /** 在指定网格相位上做一次完整提取（dx/dy 为网格原点偏移） */
  function extractAtPhase(carrierImageData, dx, dy, mode, marginOptions, onProgress, d) {
    var img = carrierImageData;
    if (dx !== 0 || dy !== 0) {
      // 按相位裁剪出一个子图，使网格原点落在 (0,0)
      var sw = img.width - dx, sh = img.height - dy;
      if (sw < TILE_SIZE || sh < TILE_SIZE) {
        return emptyResult(img.width, img.height, d);
      }
      var sub = new Uint8ClampedArray(sw * sh * 4);
      for (var y = 0; y < sh; y++) {
        var srcRow = ((y + dy) * img.width + dx) * 4;
        var dstRow = y * sw * 4;
        for (var c = 0; c < sw * 4; c++) sub[dstRow + c] = img.data[srcRow + c];
      }
      img = makeImageData(sub, sw, sh);
    }
    return extractCore(img, mode, withPairs(marginOptions, mode), onProgress, d);
  }

  function emptyResult(w, h, d) {
    var data = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < w * h; i++) {
      var o = i * 4;
      data[o] = 128; data[o + 1] = 128; data[o + 2] = 128; data[o + 3] = DEBUG_ALPHA;
    }
    return {
      success: false, mode: null, secretImageData: null, secretJpegBytes: null, secretJpegLength: 0,
      secretFormat: 0, decodeSupported: canDecodeJpeg(), secretWidth: 0, secretHeight: 0,
      validTiles: 0, totalTiles: 0, K_effective: 0,
      debugMask: makeImageData(data, w, h)
    };
  }

  /** 常规提取内核：在给定图像上按 (0,0) 网格提取指定模式 */
  function extractCore(carrierImageData, mode, marginOptions, onProgress, d) {
    var cw = carrierImageData.width, ch = carrierImageData.height;
    var tiles = d.IU.splitIntoTiles(carrierImageData, TILE_SIZE);

    var totalTiles = 0;          // 64×64 对齐 Tile 数
    var validTiles = 0;          // CRC 通过的 Tile 数（含重复 seq）
    var symbols = new Map();     // seq -> symbol（同 seq 只保留首个）
    var kCount = new Map();      // K -> 出现次数（多数表决用）
    var tileOk = [];             // 每个 Tile 是否 CRC 通过（用于 debugMask）

    for (var t = 0; t < tiles.length; t++) {
      var tile = tiles[t];
      if (tile.width !== TILE_SIZE || tile.height !== TILE_SIZE) {
        tileOk.push(-1);         // -1 = 边界区域（灰）
        continue;
      }
      totalTiles++;
      var bits = d.DCT.extractBitsFromTile(tile.data, mode.bitsPerTile, marginOptions);
      var parsed = parsePayloadFor(mode, bitsToBytes(bits), d.Packet);
      if (!parsed) {
        tileOk.push(0);          // 0 = CRC 失败（红）
      } else {
        tileOk.push(1);          // 1 = CRC 通过（绿）
        validTiles++;
        if (!symbols.has(parsed.seq)) symbols.set(parsed.seq, parsed.symbol);
        kCount.set(parsed.K, (kCount.get(parsed.K) || 0) + 1);
      }
      if (onProgress) onProgress('extract', t + 1, tiles.length);
    }

    // ---- K 多数表决 ----
    var KEffective = 0, bestVotes = 0;
    kCount.forEach(function (votes, k) {
      if (votes > bestVotes || (votes === bestVotes && k > KEffective)) {
        bestVotes = votes;
        KEffective = k;
      }
    });

    // ---- 构造 debugMask（与输入同尺寸）----
    var maskData = new Uint8ClampedArray(cw * ch * 4);
    for (t = 0; t < tiles.length; t++) {
      var tl = tiles[t];
      var st = tileOk[t];
      var color = st === 1 ? [0, 255, 0] : (st === 0 ? [255, 0, 0] : [128, 128, 128]);
      for (var y = tl.y; y < tl.y + tl.height; y++) {
        for (var x = tl.x; x < tl.x + tl.width; x++) {
          var o = (y * cw + x) * 4;
          maskData[o] = color[0];
          maskData[o + 1] = color[1];
          maskData[o + 2] = color[2];
          maskData[o + 3] = DEBUG_ALPHA;
        }
      }
    }
    var debugMask = makeImageData(maskData, cw, ch);

    var result = {
      success: false,
      mode: mode.id,
      // v2：JPEG 解码是异步 API，为了保持 extractSecret 的同步契约，
      // 这里只返回 JPEG 字节流；需要像素时调用 StegoCore.decodeSecretImage()
      secretImageData: null,
      secretJpegBytes: null,
      secretJpegLength: 0,
      secretFormat: 0,
      decodeSupported: canDecodeJpeg(),
      secretWidth: 0,
      secretHeight: 0,
      validTiles: validTiles,
      totalTiles: totalTiles,
      K_effective: KEffective,
      debugMask: debugMask
    };

    // ---- 表决票数不足 / 符号不足：直接失败，不抛错 ----
    if (bestVotes < 2) return result;
    if (validTiles < KEffective) return result;

    // ---- RaptorQ 解码 ----
    var dec = d.RQ.createDecoder(KEffective, mode.symbolSize);
    symbols.forEach(function (sym, seq) {
      dec.addSymbol(seq, sym);
    });
    if (dec.receivedCount() < KEffective) return result;
    if (onProgress) onProgress('decode', 0, 1);

    var decoded = dec.decode();
    if (onProgress) onProgress('decode', 1, 1);
    if (!decoded || decoded.length < SECRET_HEADER_BYTES) return result;

    // ---- 头部校验（version=2 / format / W / H / length / 头部 CRC）----
    var head = parseSecretHeader(decoded, d.Packet);
    if (!head) return result;

    var jpegBytes = decoded.slice(SECRET_HEADER_BYTES, SECRET_HEADER_BYTES + head.length);
    result.success = true;
    result.secretJpegBytes = jpegBytes;
    result.secretJpegLength = jpegBytes.length;
    result.secretFormat = head.format;
    result.secretWidth = head.width;
    result.secretHeight = head.height;
    return result;
  }

  /**
   * JPEG 字节流结构自检：SOI(FF D8) 开头、长度足够、且能找到 SOF 段里的宽高。
   *
   * 为什么要在解码前先做这一步：**浏览器抛出的错误信息对用户毫无意义**。
   *   实测过的现场是 `Failed to execute 'getImageData' ... The source width is 0`——
   *   它来自"解码出来的位图宽高为 0"，而不是"数据坏了"；先自己校验一遍，
   *   就能把"字节流不合法"和"解码器给不出尺寸"分开报，界面才能给出可操作的提示。
   *
   * @returns {{ok:boolean, reason?:string, width?:number, height?:number}}
   */
  function inspectJpegStream(bytes) {
    if (!bytes || typeof bytes.length !== 'number' || bytes.length < 4) {
      return { ok: false, reason: '字节流为空或长度不足 4 字节' };
    }
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
      return { ok: false, reason: '前两字节不是 FF D8（JPEG SOI 标记）' };
    }
    // 顺序扫描段：找 SOF0~SOF15（C0~CF，排除 C4=DHT、C8=JPG、CC=DAC），读宽高
    var i = 2, n = bytes.length;
    while (i + 3 < n) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      var marker = bytes[i + 1];
      if (marker === 0xFF) { i++; continue; }        // 填充字节
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
      var len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) break;
      var isSOF = marker >= 0xC0 && marker <= 0xCF &&
        marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSOF && i + 9 < n) {
        var h = (bytes[i + 5] << 8) | bytes[i + 6];
        var w = (bytes[i + 7] << 8) | bytes[i + 8];
        if (w > 0 && h > 0) return { ok: true, width: w, height: h };
        return { ok: false, reason: 'SOF 段里的宽高为 0（' + w + '×' + h + '）' };
      }
      if (marker === 0xDA) break;                    // 进入扫描数据，SOF 应已出现过
      i += 2 + len;
    }
    return { ok: false, reason: '未找到 SOF 段（宽高信息）' };
  }

  /**
   * 把提取出来的 JPEG 字节流解码成 ImageData（异步）。
   *
   * 解码器按顺序尝试：createImageBitmap → Image + objectURL。
   * 关键点是**每个解码器都必须自己校验"解出来的宽高 > 0"**：
   *   旧实现直接把 `bmp.width / img.naturalWidth` 交给 getImageData，
   *   一旦解码器给出 0 尺寸（某些浏览器/某些 Blob 组合会这样），
   *   用户看到的是一句 `The source width is 0` 的 DOMException，
   *   而真正的原因（这个解码器不可用）被掩盖了，也不会去试下一个解码器。
   *
   * @param {Uint8Array|Blob} jpegBytesOrBlob
   * @returns {Promise<ImageData>}
   */
  StegoCore.decodeSecretImage = function (jpegBytesOrBlob) {
    var isBlob = typeof Blob === 'function' && jpegBytesOrBlob instanceof Blob;
    var bytes = isBlob ? null : jpegBytesOrBlob;
    if (bytes) {
      var inspect = inspectJpegStream(bytes);
      if (!inspect.ok) {
        return Promise.reject(new Error(
          'decodeSecretImage: 不是合法的 JPEG 字节流（' + inspect.reason + '），' +
          '文件可能已损坏；可直接保存为 .jpg 后用系统看图工具确认'));
      }
    }
    var blob = jpegBytesOrBlob;
    if (bytes && typeof bytes.length === 'number' && typeof Blob === 'function') {
      blob = new Blob([bytes], { type: 'image/jpeg' });
    }
    if (!blob) return Promise.reject(new Error('decodeSecretImage: 需要 JPEG 字节流或 Blob'));

    // ---- 解码器 1：createImageBitmap ----
    function viaBitmap() {
      if (typeof createImageBitmap !== 'function') {
        return Promise.reject(new Error('当前环境没有 createImageBitmap'));
      }
      return createImageBitmap(blob).then(function (bmp) {
        var w = bmp && bmp.width, h = bmp && bmp.height;
        if (!(w > 0 && h > 0)) {
          if (bmp && typeof bmp.close === 'function') bmp.close();
          throw new Error('createImageBitmap 解出的尺寸为 ' + w + '×' + h);
        }
        var canvas = createCanvas(w, h, 'decodeSecretImage');
        var ctx = get2dContext(canvas, 'decodeSecretImage');
        ctx.drawImage(bmp, 0, 0);
        var out = ctx.getImageData(0, 0, w, h);
        if (typeof bmp.close === 'function') bmp.close();
        return out;
      });
    }

    // ---- 解码器 2：Image + objectURL ----
    function viaImage() {
      if (typeof Image !== 'function' || typeof URL === 'undefined' ||
          typeof URL.createObjectURL !== 'function') {
        return Promise.reject(new Error('当前环境没有 Image / URL.createObjectURL'));
      }
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        var done = false;
        function finish(fn, arg) {
          if (done) return;
          done = true;
          try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
          fn(arg);
        }
        img.onload = function () {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!(w > 0 && h > 0)) {
            finish(reject, new Error('Image 解出的尺寸为 ' + w + '×' + h));
            return;
          }
          try {
            var canvas = createCanvas(w, h, 'decodeSecretImage');
            var ctx = get2dContext(canvas, 'decodeSecretImage');
            ctx.drawImage(img, 0, 0);
            finish(resolve, ctx.getImageData(0, 0, w, h));
          } catch (e) {
            finish(reject, e);
          }
        };
        img.onerror = function () { finish(reject, new Error('JPEG 解码失败（Image.onerror）')); };
        img.src = url;
      });
    }

    var decoders = [viaBitmap, viaImage];
    var reasons = [];
    function attempt(idx) {
      if (idx >= decoders.length) {
        return Promise.reject(new Error(
          'decodeSecretImage: JPEG 解码失败（' + reasons.join('；') + '）——' +
          '数据本身已还原，可直接下载保存为 .jpg'));
      }
      return decoders[idx]().catch(function (e) {
        reasons.push((e && e.message ? e.message : String(e)));
        return attempt(idx + 1);
      });
    }
    return attempt(0);
  };

  // ---- 附加常量（便于测试与调参，不属于函数契约的一部分）----
  StegoCore.CONST = {
    TILE_SIZE: TILE_SIZE,
    SYMBOL_SIZE: SYMBOL_SIZE,
    PAYLOAD_BYTES: PAYLOAD_BYTES,
    PAYLOAD_BITS: PAYLOAD_BITS,
    SECRET_HEADER_BYTES: SECRET_HEADER_BYTES,
    SECRET_VERSION: SECRET_VERSION,
    DEFAULT_VARIANCE_THRESHOLD: DEFAULT_VARIANCE_THRESHOLD,
    // 安全块判据（块级 margin 为主判据，亮度为次判据）
    MIN_BLOCK_MARGIN: MIN_BLOCK_MARGIN,
    MIN_TILE_LUM: MIN_TILE_LUM,
    MAX_TILE_LUM: MAX_TILE_LUM,
    DEFAULT_SECRET_JPEG_QUALITY: DEFAULT_SECRET_JPEG_QUALITY,
    REDUNDANCY: REDUNDANCY,
    REDUNDANCY_LABEL: REDUNDANCY_LABEL,
    AUTO_RESIZE_FACTORS: AUTO_RESIZE_FACTORS,
    MIN_SECRET_LONG_SIDE: MIN_SECRET_LONG_SIDE,
    MAX_DIM: MAX_DIM,
    DEBUG_ALPHA: DEBUG_ALPHA,
    // 两种载荷模式（低频回退模式的容量/符号尺寸都不同，供页面与测试自省）
    MODE_6: MODE_6,
    MODE_4: MODE_4,
    DEFAULT_LOW_FREQ_PAIRS: DEFAULT_LOW_FREQ_PAIRS
  };

  global.StegoCore = StegoCore;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
