/**
 * packet.js —— 数据包封装与校验（window.Packet）
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致）：
 *   1. 零外部依赖：只用原生 JS；
 *   2. 不使用 ES Module：没有 import / export，普通 script 标签引入，
 *      file:// 双击本地打开即可运行；
 *   3. 挂载到全局命名空间 window.Packet（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法均带原理说明注释。
 *
 * ============================ 包格式 ============================
 *   +---------------------------+------------------+
 *   |  payload (N 字节)          |  CRC32 (4 字节)   |
 *   +---------------------------+------------------+
 *   CRC 以小端序附加在尾部，因此 packet.length === payload.length + 4。
 *   提取端先按长度切出 payload，再重算 CRC 比对，即可在"抗干扰隐写"场景里
 *   快速判定这个 Tile 里的数据是否被破坏 —— 这是后续接入 RaptorQ 前的
 *   第一道防线（只有通过 CRC 的符号才允许交给解码器）。
 *
 * ============================ CRC-32 原理 ============================
 *   采用最常见的反射式实现（与 zip / PNG / zlib 一致）：
 *     - 多项式 0xEDB88320（即标准多项式 0x04C11DB7 的位反转形式）
 *     - 初值 0xFFFFFFFF，输入字节与寄存器低字节异或后查表右移 8 位
 *     - 输出前再与 0xFFFFFFFF 异或（final XOR）
 *   查表法把"每字节 8 次位移+异或"压缩成"每字节 1 次查表+1 次异或"，
 *   256 项的预计算表在构造时一次性算好。
 *
 * 标准测试向量：
 *   crc32("123456789")      === 0xCBF43926
 *   crc32(new Uint8Array(0))=== 0x00000000
 *   crc32([0x00])           === 0xD202EF8D
 */
(function (global) {
  'use strict';

  var POLY_REFLECTED = 0xEDB88320;

  /** 预计算 256 项 CRC 表 */
  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        // 最低位为 1：右移后异或反射多项式；否则只右移
        c = (c & 1) ? (POLY_REFLECTED ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c;
    }
    return table;
  })();

  function isBytes(v) {
    return !!v && typeof v.length === 'number' &&
      (v instanceof Uint8Array || Object.prototype.toString.call(v) === '[object Uint8Array]');
  }

  /**
   * 标准 CRC-32。
   * @param {Uint8Array} bytes
   * @returns {number} 无符号 32 位整数（0 ~ 4294967295）
   */
  function crc32(bytes) {
    if (!isBytes(bytes)) {
      throw new TypeError('crc32: 需要传入 Uint8Array');
    }
    var crc = 0xFFFFFFFF; // 初值全 1
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    // final XOR，并用 >>> 0 转成无符号
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * 打包：payload + 小端 CRC32。
   * 返回**新数组**，不修改入参。
   * @param {Uint8Array} payload
   * @returns {Uint8Array} 长度 = payload.length + 4
   */
  function pack(payload) {
    if (!isBytes(payload)) {
      throw new TypeError('pack: 需要传入 Uint8Array');
    }
    var n = payload.length;
    var out = new Uint8Array(n + 4);
    out.set(payload, 0);
    var crc = crc32(payload);
    // 小端序写入尾部 4 字节
    out[n] = crc & 0xFF;
    out[n + 1] = (crc >>> 8) & 0xFF;
    out[n + 2] = (crc >>> 16) & 0xFF;
    out[n + 3] = (crc >>> 24) & 0xFF;
    return out;
  }

  /**
   * 解包 + 校验。任何异常情况都返回 { valid:false, payload:null }，不抛错。
   *
   * 注意：按契约，长度 < 5 的一律视为无效包 —— 也就是说空 payload 打出来的
   * 4 字节包会被判为无效（这是契约明确要求的行为，见注释下方的长度规则）。
   *
   * @param {Uint8Array} packet
   * @returns {{valid: boolean, payload: Uint8Array|null}} payload 是新数组
   */
  function unpack(packet) {
    if (!isBytes(packet) || packet.length < 5) {
      return { valid: false, payload: null };
    }
    var n = packet.length - 4;
    // slice 返回新数组，调用方改它不会影响原包
    var payload = packet.slice(0, n);
    var crc = (packet[n] | (packet[n + 1] << 8) | (packet[n + 2] << 16) |
      (packet[n + 3] << 24)) >>> 0;
    if (crc32(payload) !== crc) {
      return { valid: false, payload: null };
    }
    return { valid: true, payload: payload };
  }

  global.Packet = {
    crc32: crc32,
    pack: pack,
    unpack: unpack
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
