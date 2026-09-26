/**
 * zip-pack.js —— 把隐写图打包成 ZIP（window.ZipPack）
 * ---------------------------------------------------------------
 * 硬性约束（与项目全局约束一致）：
 *   1. 零外部依赖：只用原生 JS；
 *   2. 不使用 ES Module：普通 script 标签引入，file:// 双击即可运行；
 *   3. 挂到全局命名空间 window.ZipPack（Node 下降级为 globalThis）；
 *   4. 不使用构建工具；
 *   5. 关键算法带原理注释。
 *
 * 为什么需要它：平台"普通发送"会对图片重新编码，把 ±5~30 灰度级的承载信号抹掉
 * （见技术报告 §3.4）。把隐写图**装进 ZIP 当文件发送**，就走的是文件通道而不是
 * 图像通道，平台不会再动它的像素；接收方下载 ZIP 后在提取页直接上传即可。
 *
 * ============================ 为什么只做"存储"模式 ============================
 * ZIP 的 method 有两种常用取值：0 = 存储（原样放进去）、8 = deflate（压缩）。
 * 这里只实现存储模式，理由是：
 *   · 隐写图本身是 PNG，已经是压缩格式，再 deflate 收益通常 < 3%；
 *   · 存储模式不需要任何压缩/解压算法，代码短、出错面小；
 *   · 解包时只需读文件头切出字节，不依赖浏览器的 CompressionStream（老浏览器也能用）；
 *   · 用户看到的 ZIP 体积与图片几乎相同，不会疑惑"为什么压完还是这么大"。
 * 代价：别人用 Windows 右键"压缩文件夹"生成的 ZIP 是 method=8，本模块会**明确报错**
 * 并提示改用本工具打包，而不是悄悄给出错误数据。
 *
 * ============================ ZIP 结构（PKZIP APPNOTE.TXT） ============================
 * 一个 ZIP 文件 = 若干"本地文件头 + 文件数据" + 中央目录 + 中央目录结束记录：
 *
 *   [本地文件头 30 字节][文件名][文件数据]  × N
 *   [中央目录头 46 字节][文件名]            × N
 *   [中央目录结束记录 22 字节]
 *
 * 几个容易写错的地方（本实现都按规范处理）：
 *   · 所有多字节整数**小端**存放；
 *   · 本地文件头与中央目录头里各有一份"文件名长度/扩展字段长度"，两者**不保证相同**
 *     （本实现相同），解析数据起点必须以**本地头**里的长度为准；
 *   · 通用位标志第 11 位（0x0800）置位表示"文件名是 UTF-8"，
 *     否则中文文件名在别的解压软件里会变乱码；
 *   · 时间戳字段是 DOS 格式（日期 + 时间各 2 字节），这里固定成 2026-09-26 12:00:00，
 *     保证同样输入两次打包产出**逐字节相同**的 ZIP（便于校验与复现）。
 */
(function (global) {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  var SIG_LOCAL = 0x04034b50;      // 本地文件头
  var SIG_CENTRAL = 0x02014b50;    // 中央目录头
  var SIG_EOCD = 0x06054b50;       // 中央目录结束记录
  var METHOD_STORE = 0;            // 存储模式
  var FLAG_UTF8 = 0x0800;          // 通用位标志第 11 位：文件名为 UTF-8
  var VERSION_NEEDED = 20;         // 2.0：存储模式 + 文件夹（本实现只用存储）
  var VERSION_MADE_BY = 0x031E;    // 高字节 3 = UNIX，低字节 30 = 3.0（写死即可）

  // 固定时间戳：2026-09-26 12:00:00
  //   DOS 时间：bits 15-11 时、10-5 分、4-0 秒/2；DOS 日期：bits 15-9 年-1980、8-5 月、4-0 日
  var DOS_TIME = (12 << 11) | (0 << 5) | 0;
  var DOS_DATE = ((2026 - 1980) << 9) | (9 << 5) | 26;

  var LOCAL_HEADER_SIZE = 30;
  var CENTRAL_HEADER_SIZE = 46;
  var EOCD_SIZE = 22;

  // ============================================================
  // 小工具
  // ============================================================
  function isBytes(v) {
    return !!v && (v instanceof Uint8Array ||
      Object.prototype.toString.call(v) === '[object Uint8Array]');
  }

  function toBytes(v, what) {
    if (isBytes(v)) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (v && typeof v.length === 'number' && typeof v !== 'string') {
      try { return new Uint8Array(v); } catch (e) { /* 落到下面报错 */ }
    }
    throw new TypeError('ZipPack: ' + what + ' 需要 Uint8Array（收到 ' +
      Object.prototype.toString.call(v) + '）');
  }

  /**
   * CRC-32：直接复用 packet.js 的实现。
   * 为什么不自己写一份：两处 CRC 口径必须完全一致（同表、同初值、同 final XOR），
   * 复制一份实现迟早会漂移；这里只做"依赖是否就位"的检查并给出可操作的报错。
   */
  function crc32(bytes) {
    var P = global.Packet;
    if (!P || typeof P.crc32 !== 'function') {
      throw new Error('ZipPack: 未找到 Packet.crc32 —— 请确认先加载 js/packet.js 再加载 js/zip-pack.js');
    }
    return P.crc32(bytes);
  }

  /** 字符串 → UTF-8 字节（优先 TextEncoder，缺失时用手写实现，保证老环境可用） */
  function utf8Bytes(str) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        // 代理对（emoji 等）——合成一个码点再按 4 字节编码
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
          0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return new Uint8Array(out);
  }

  /** UTF-8 字节 → 字符串（优先 TextDecoder，缺失时手写） */
  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i++];
      if (b < 0x80) { s += String.fromCharCode(b); }
      else if (b < 0xE0) { s += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F)); }
      else if (b < 0xF0) {
        s += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return s;
  }

  /** PNG 编码：浏览器用 canvas，Node 测试用注入的钩子（与 JPEG 钩子同一套路） */
  function encodePng(imageData) {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      var canvas = document.createElement('canvas');
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      var ctx = canvas.getContext('2d');
      ctx.putImageData(imageData, 0, 0);
      if (typeof canvas.toDataURL === 'function') {
        var url = canvas.toDataURL('image/png');
        if (url && url.indexOf('data:image/png') === 0) {
          var b64 = url.slice(url.indexOf(',') + 1);
          if (typeof atob === 'function') {
            var bin = atob(b64);
            var out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
          }
        }
      }
    }
    var hook = global.__STEGO_PNG_ENCODE__;
    if (typeof hook === 'function') {
      var bytes = hook(imageData);
      if (bytes && typeof bytes.length === 'number') {
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      }
      throw new Error('ZipPack: PNG 编码钩子返回值非法');
    }
    throw new Error('ZipPack: 当前环境不支持 PNG 编码（缺少 canvas.toDataURL），' +
      '可通过 window.__STEGO_PNG_ENCODE__ 注入编码器');
  }

  // ============================================================
  // 打包
  // ============================================================
  /**
   * 把若干文件打包成一个 ZIP 字节流（存储模式，不压缩）。
   * @param {Array<{name:string, bytes:Uint8Array}>} files
   * @returns {Uint8Array} 完整 ZIP 文件字节
   */
  function pack(files) {
    if (!files || typeof files.length !== 'number') {
      throw new TypeError('ZipPack.pack: 需要传入文件数组 [{name, bytes}]');
    }
    var list = [];
    var i, total = 0, cdSize = 0;
    for (i = 0; i < files.length; i++) {
      var f = files[i] || {};
      if (typeof f.name !== 'string' || f.name === '') {
        throw new TypeError('ZipPack.pack: 第 ' + (i + 1) + ' 个文件缺少 name');
      }
      var data = toBytes(f.bytes, 'pack 的第 ' + (i + 1) + ' 个文件的 bytes');
      var nameBytes = utf8Bytes(f.name);
      var item = {
        name: f.name, nameBytes: nameBytes, data: data,
        crc: crc32(data), size: data.length
      };
      list.push(item);
      total += LOCAL_HEADER_SIZE + nameBytes.length + data.length;      // 本地头 + 名 + 数据
      cdSize += CENTRAL_HEADER_SIZE + nameBytes.length;                 // 中央目录项
    }
    var cdOffset = total;
    var out = new Uint8Array(total + cdSize + EOCD_SIZE);
    var view = new DataView(out.buffer);
    var pos = 0;

    function w16(v) { view.setUint16(pos, v, true); pos += 2; }
    function w32(v) { view.setUint32(pos, v >>> 0, true); pos += 4; }

    // ---- 本地文件头 + 文件数据 ----
    for (i = 0; i < list.length; i++) {
      var it = list[i];
      it.offset = pos;
      w32(SIG_LOCAL);
      w16(VERSION_NEEDED);
      w16(FLAG_UTF8);              // 文件名是 UTF-8
      w16(METHOD_STORE);
      w16(DOS_TIME);
      w16(DOS_DATE);
      w32(it.crc);
      w32(it.size);                // 压缩后大小 = 原大小（存储模式）
      w32(it.size);                // 原始大小
      w16(it.nameBytes.length);
      w16(0);                      // 扩展字段长度：不用
      out.set(it.nameBytes, pos); pos += it.nameBytes.length;
      out.set(it.data, pos); pos += it.data.length;
    }

    // ---- 中央目录 ----
    var cdStart = pos;
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      w32(SIG_CENTRAL);
      w16(VERSION_MADE_BY);
      w16(VERSION_NEEDED);
      w16(FLAG_UTF8);
      w16(METHOD_STORE);
      w16(DOS_TIME);
      w16(DOS_DATE);
      w32(c.crc);
      w32(c.size);
      w32(c.size);
      w16(c.nameBytes.length);
      w16(0);                      // 扩展字段
      w16(0);                      // 文件注释
      w16(0);                      // 起始磁盘号
      w16(0);                      // 内部属性
      w32(0);                      // 外部属性
      w32(c.offset);               // 本地头偏移
      out.set(c.nameBytes, pos); pos += c.nameBytes.length;
    }

    // ---- 中央目录结束记录 ----
    w32(SIG_EOCD);
    w16(0);                        // 当前磁盘号
    w16(0);                        // 中央目录起始磁盘号
    w16(list.length);              // 本磁盘条目数
    w16(list.length);              // 总条目数
    w32(cdStart === cdOffset ? cdSize : cdSize);
    w32(cdOffset);                 // 中央目录偏移
    w16(0);                        // 注释长度

    return out;
  }

  // ============================================================
  // 解包
  // ============================================================
  /**
   * 从 ZIP 字节流解析出文件列表。
   * @param {Uint8Array} zipBytes
   * @returns {Array<{name:string, bytes:Uint8Array}>}
   */
  function unpack(zipBytes) {
    var b = toBytes(zipBytes, 'unpack');
    if (b.length < EOCD_SIZE) {
      throw new Error('ZipPack.unpack: 数据太短（' + b.length + ' 字节），不可能是 ZIP');
    }
    var view = new DataView(b.buffer, b.byteOffset, b.byteLength);

    // ---- 1) 从尾部往前找中央目录结束记录 ----
    //   注释最长 65535，所以只需回看 22 + 65535 字节
    var minPos = Math.max(0, b.length - EOCD_SIZE - 65535);
    var eocd = -1;
    for (var p = b.length - EOCD_SIZE; p >= minPos; p--) {
      if (view.getUint32(p, true) === SIG_EOCD) { eocd = p; break; }
    }
    if (eocd < 0) {
      throw new Error('ZipPack.unpack: 不是合法的 ZIP —— 未找到中央目录结束记录' +
        '（0x06054b50）。如果这是别人用系统"压缩文件夹"生成的 ZIP，' +
        '它用的是 deflate 压缩，本工具只支持存储模式，请用本工具重新打包。');
    }
    var count = view.getUint16(eocd + 10, true);
    var cdSize = view.getUint32(eocd + 12, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    if (cdOffset + cdSize > b.length) {
      throw new Error('ZipPack.unpack: ZIP 数据被截断 —— 中央目录声明到 ' +
        (cdOffset + cdSize) + ' 字节，实际只有 ' + b.length + ' 字节');
    }

    // ---- 2) 逐个读中央目录项 ----
    var out = [];
    var pos = cdOffset;
    for (var i = 0; i < count; i++) {
      if (pos + CENTRAL_HEADER_SIZE > b.length) {
        throw new Error('ZipPack.unpack: 中央目录第 ' + (i + 1) + ' 项越界（数据已损坏）');
      }
      if (view.getUint32(pos, true) !== SIG_CENTRAL) {
        throw new Error('ZipPack.unpack: 中央目录第 ' + (i + 1) + ' 项签名非法（期望 0x02014b50）');
      }
      var method = view.getUint16(pos + 10, true);
      var crc = view.getUint32(pos + 16, true);
      var compSize = view.getUint32(pos + 20, true);
      var rawSize = view.getUint32(pos + 24, true);
      var nameLen = view.getUint16(pos + 28, true);
      var extraLen = view.getUint16(pos + 30, true);
      var commentLen = view.getUint16(pos + 32, true);
      var localOffset = view.getUint32(pos + 42, true);
      var name = utf8Decode(b.subarray(pos + CENTRAL_HEADER_SIZE, pos + CENTRAL_HEADER_SIZE + nameLen));
      pos += CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;

      if (method !== METHOD_STORE) {
        throw new Error('ZipPack.unpack: 文件"' + name + '"使用了压缩（method=' + method + '），' +
          '本工具只支持存储模式的 ZIP。请用本工具的"下载为 ZIP"重新打包。');
      }
      // ---- 3) 读本地文件头，定位数据起点 ----
      //   注意：数据起点必须用**本地头**里的 名字长度/扩展长度 计算，
      //   中央目录里的同名长度理论上可以不同（某些打包器会写不同的扩展字段）。
      if (localOffset + LOCAL_HEADER_SIZE > b.length) {
        throw new Error('ZipPack.unpack: 文件"' + name + '"的本地文件头偏移越界（ZIP 已损坏）');
      }
      if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
        throw new Error('ZipPack.unpack: 文件"' + name + '"的本地文件头签名非法（期望 0x04034b50）');
      }
      var lNameLen = view.getUint16(localOffset + 26, true);
      var lExtraLen = view.getUint16(localOffset + 28, true);
      var dataStart = localOffset + LOCAL_HEADER_SIZE + lNameLen + lExtraLen;
      var dataEnd = dataStart + (compSize || rawSize);
      if (dataEnd > b.length) {
        throw new Error('ZipPack.unpack: 文件"' + name + '"的数据越界（ZIP 已损坏或截断）');
      }
      var bytes = b.slice(dataStart, dataEnd);
      // ---- 4) CRC 校验：损坏的 ZIP 必须报错，而不是把坏数据当成品交出去 ----
      var actual = crc32(bytes);
      if (actual !== crc) {
        throw new Error('ZipPack.unpack: 文件"' + name + '"的 CRC 校验失败（期望 ' +
          crc.toString(16) + '，实际 ' + actual.toString(16) + '）—— ZIP 内容已损坏');
      }
      out.push({ name: name, bytes: bytes });
    }
    return out;
  }

  /**
   * 便捷方法：把一张隐写图 ImageData 用 PNG 编码后打包成 ZIP。
   * @param {ImageData} imageData
   * @param {string} [fileName] ZIP 内的文件名，默认 stego.png
   * @returns {{zipBytes: Uint8Array, fileName: string}} fileName 是建议的 ZIP 下载名
   */
  function packImage(imageData, fileName) {
    if (!imageData || typeof imageData.width !== 'number' || !imageData.data) {
      throw new TypeError('ZipPack.packImage: 需要传入 ImageData');
    }
    var inner = fileName || 'stego.png';
    var png = encodePng(imageData);
    var zipBytes = pack([{ name: inner, bytes: png }]);
    // ZIP 的下载名：把内层图片名的扩展名换成 .zip
    var base = inner.replace(/\.[A-Za-z0-9]+$/, '');
    return { zipBytes: zipBytes, fileName: (base || 'stego') + '.zip' };
  }

  /**
   * 判断字节流是否是 ZIP（只看开头签名，绝不抛错）。
   * @param {Uint8Array} bytes
   * @returns {boolean}
   */
  function isZip(bytes) {
    try {
      var b = toBytes(bytes, 'isZip');
      if (b.length < 4) return false;
      if (b[0] !== 0x50 || b[1] !== 0x4B) return false;
      // 0x03 0x04 = 本地文件头；0x05 0x06 = 空档案的中央目录结束记录
      return (b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06);
    } catch (e) {
      return false;
    }
  }

  var ZipPack = {
    pack: pack,
    unpack: unpack,
    packImage: packImage,
    isZip: isZip
  };

  // 便于测试与排查的常量
  ZipPack.CONST = {
    SIG_LOCAL: SIG_LOCAL,
    SIG_CENTRAL: SIG_CENTRAL,
    SIG_EOCD: SIG_EOCD,
    METHOD_STORE: METHOD_STORE,
    FLAG_UTF8: FLAG_UTF8,
    DOS_TIME: DOS_TIME,
    DOS_DATE: DOS_DATE,
    LOCAL_HEADER_SIZE: LOCAL_HEADER_SIZE,
    CENTRAL_HEADER_SIZE: CENTRAL_HEADER_SIZE,
    EOCD_SIZE: EOCD_SIZE,
    OVERHEAD_PER_FILE: LOCAL_HEADER_SIZE + CENTRAL_HEADER_SIZE + EOCD_SIZE
  };

  global.ZipPack = ZipPack;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
