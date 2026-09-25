/**
 * verify-page.node.js —— HTML 页面静态与语法自检（Node，零第三方依赖）
 *
 * 浏览器交互（真实点击上传）无法在无头环境里覆盖，这里检查的是：
 *   1) script 标签引用的本地文件存在、顺序正确（生产页要求 6 个核心库按序引入）
 *   2) 内联脚本能否编译（vm.Script）
 *   3) UI 元素 id 齐全且**唯一**，且脚本里用字符串取过的 id 都真实存在
 *   4) 无外部 URL、无 ES Module
 *   5) 页面调用的 StegoCore / ImageUtils 函数名与形参个数是否与库导出一致（脚本比对）
 *   6) 页面间跳转路径指向真实存在的文件
 *   7) 各页面特有的关键交互与输出是否齐备
 *   8) 【面向大众化】面向用户的三个页面（index / embed / extract）的**可见文本**里
 *      不得出现专业术语（术语黑名单），技术名词只能出现在 tech.html 里
 *   9) 【防 ReferenceError】裸调用审计：页面内联脚本与 7 个库文件里，
 *      "没有前缀的调用"必须能在本文件内找到声明或属已知全局。
 *      这条是浏览器实机 Bug「clamp is not defined」的防复发措施：
 *      stego-core.js 调用了自己从未定义的 clamp，而该分支只有 embed.html 会走到，
 *      于是 Node 测试全绿、页面一点按钮就崩。
 *
 * 覆盖：index.html、embed.html、extract.html、tech.html（面向用户的页面）
 *       dev-test-suite.html（开发者测试页，已从用户页导航中移除）
 *       test-image-utils.html、test-stego-pipeline.html（开发期工具页）
 *       js/*.js（7 个库文件的裸调用审计）
 *
 * 运行： node tests/verify-page.node.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE_SCRIPTS = ['js/image-utils.js', 'js/dct-stego.js', 'js/packet.js', 'js/raptorq.js',
  'js/geo-calibration.js', 'js/stego-core.js'];
// 嵌入页额外引入载体图生成器（放在核心库之后：它只用 ImageData/DOM，不依赖内核）
const EMBED_SCRIPTS = CORE_SCRIPTS.concat(['js/carrier-generator.js']);

// 面向大众用户的页面：可见文本里不得出现这些术语（tech.html 例外，它专门讲原理）
const TERM_BLACKLIST = ['K_effective', 'symbolSize', 'varianceThreshold', 'margin', 'RaptorQ',
  'GF(2^16)', 'DCT', 'CRC', '系数对', '裕量', '扩频', '导频'];

/**
 * 取页面的"可见文本"：去掉注释、<script>、<style>，再把所有标签（含属性）删掉。
 * 这样子剩下的就是用户真正能在页面上读到的文字。
 */
function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

function findTerms(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.indexOf(t.toLowerCase()) !== -1);
}

// ============================================================
// 文风检查（tech.html 专用）：模板短语黑名单 / 每段加粗数 / 每段句数
// ============================================================

/** 写作时最容易带出来的"AI 味"短语，tech.html 里一个都不许出现 */
const BANNED_PHRASES = ['一句话总结', '值得注意的是', '核心在于', '本质上', '换言之',
  '总而言之', '由此可见'];

/** 取出指定标签的块内容（用于按"段"统计） */
function textBlocks(html, tags) {
  const out = [];
  for (const tag of tags) {
    const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
    let m;
    while ((m = re.exec(html)) !== null) out.push({ tag, inner: m[1] });
  }
  return out;
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 一段里加粗了几处（<b> / <strong>） */
function countBold(inner) {
  return (inner.match(/<(?:b|strong)\b/gi) || []).length;
}

/** 一段里有几个中文句末标点（。！？） */
/**
 * 数句子的条数：中文用「。！？」结尾，英文用「. ! ?」+ 空白/行尾结尾
 * （学术页有英文 Abstract，只有中文标点时它会被算成 0 句，属于度量口径问题）。
 */
function countSentences(inner) {
  const text = stripTags(inner);
  const zh = (text.match(/[。！？]/g) || []).length;
  const en = (text.match(/[.!?](?=\s|$)/g) || []).length;
  return zh + en;
}

// ============================================================
// 裸调用审计：找出"调用了一个既没在本文件声明、也不是已知全局"的标识符
// ------------------------------------------------------------
// 起因（真实 Bug）：js/stego-core.js 里写了 clamp(opt.secretJpegQuality, ...)
// 却从未定义 clamp（image-utils.js / dct-stego.js 里的 clamp 都在各自 IIFE 内，
// 外部看不见）。该分支只在"调用方传了 secretJpegQuality"时才执行，
// 而唯一这么传的调用方是 embed.html —— 于是 Node 测试全绿、浏览器一点按钮就
// ReferenceError。这里做一个**零依赖的静态近似检查**：把每个文件里"没有前缀
// 的调用"与"本文件声明的名字 + 已知全局名单"比对，多出来的就是可疑项。
// 它不是完整的词法分析器，只求把这类"漏定义/漏加前缀"的问题挡住。
// ============================================================

/**
 * 把字符串字面量与注释替换成空白（保留换行），避免把 `'rgba(0,0,0,.5)'`、
 * `// foo(` 这类内容误判成函数调用。
 * 说明：这是给静态审计用的**近似**清洗，不追求完整词法分析；
 * 含转义斜杠的正则字面量（如 /\//g）可能让该行后半段被当成注释而漏扫。
 */
function stripLiterals(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (ch === '/' && nx === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  '; i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      out += ' '; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        const c2 = src[i];
        out += c2 === '\n' ? '\n' : ' ';
        i++;
        if (c2 === q) break;
      }
      continue;
    }
    out += ch; i++;
  }
  return out;
}

/** 语言关键字与运算符，出现在 `xxx(` 前面时不是函数调用 */
const NON_CALL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'case', 'function', 'yield', 'await', 'throw',
  'instanceof', 'with', 'try', 'finally', 'break', 'continue', 'var', 'let', 'const', 'class']);

/** 浏览器 / 语言内建 + 本项目挂到全局的命名空间，出现在裸调用里属正常 */
const KNOWN_GLOBALS = new Set([
  // ES 内建
  'Array', 'Boolean', 'Date', 'Error', 'EvalError', 'Float32Array', 'Float64Array', 'Infinity',
  'Int16Array', 'Int32Array', 'Int8Array', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object',
  'Promise', 'RangeError', 'ReferenceError', 'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError',
  'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray',
  'WeakMap', 'WeakSet', 'BigInt', 'ArrayBuffer', 'DataView', 'Proxy', 'Reflect',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
  'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'structuredClone',
  // 浏览器 / Web API
  'window', 'self', 'globalThis', 'document', 'navigator', 'location', 'history', 'screen',
  'console', 'alert', 'confirm', 'prompt', 'ImageData', 'Image', 'Blob', 'File', 'FileReader',
  'URL', 'URLSearchParams', 'FormData', 'fetch', 'atob', 'btoa', 'createImageBitmap',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'performance', 'getComputedStyle', 'matchMedia', 'TextEncoder', 'TextDecoder',
  'CustomEvent', 'Event', 'DOMParser', 'XMLHttpRequest', 'Worker', 'MutationObserver',
  'ResizeObserver', 'IntersectionObserver', 'OffscreenCanvas', 'Path2D', 'crypto',
  // 本项目挂到全局的命名空间（库与测试套件）
  'ImageUtils', 'DctStego', 'Packet', 'RaptorQ', 'GeoCalibration', 'StegoCore', 'TestSuite'
]);

/** 收集一个 JS 片段里"声明过"的名字（函数声明/var·let·const/形参/catch/class/赋值式定义） */
function declaredNames(src) {
  const names = new Set();
  const add = (n) => { if (n && !NON_CALL_KEYWORDS.has(n)) names.add(n); };
  let m;
  const fnRe = /function\s+([A-Za-z_$][\w$]*)?\s*\(/g;
  while ((m = fnRe.exec(src)) !== null) {
    add(m[1]);
    // 形参列表：从 '(' 起做括号配对，取出参数文本
    let i = fnRe.lastIndex, depth = 1, start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    paramNames(src.slice(start, i - 1)).forEach(add);
    fnRe.lastIndex = i;
  }
  for (const mm of src.matchAll(/\b(?:var|let|const)\s+([^;=\n]+)/g)) {
    // 形如 `var a = 1, b = 2;` → 取每个逗号项的第一个标识符
    mm[1].split(',').forEach((part) => {
      const id = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (id) add(id[1]);
    });
  }
  for (const mm of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(mm[1]);
  for (const mm of src.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) add(mm[1]);
  // 单参数箭头函数：`x => ...`
  for (const mm of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(mm[1]);
  // 赋值式定义：`foo = function` / `foo = (...) =>`
  for (const mm of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:function\b|\()/g)) add(mm[1]);
  return names;
}

/** 从一段形参文本里取出参数名（跳过默认值与解构内部的属性名） */
function paramNames(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => {
    const id = p.trim().match(/^([A-Za-z_$][\w$]*)/);
    return id ? id[1] : null;
  }).filter(Boolean);
}

/** 收集"没有前缀的调用"名字（`obj.fn(` / `a[i](` 都不算） */
function bareCallNames(src) {
  const calls = new Set();
  const re = /(^|[^\w$.\]])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[2];
    if (NON_CALL_KEYWORDS.has(name)) continue;
    // 排除对象字面量里的方法简写 `{ foo() {} }`：调用点前面紧挨着 '{' 或 ','
    const before = src.slice(0, m.index + m[1].length).replace(/\s+$/, '');
    const lastCh = before[before.length - 1];
    if (lastCh === '{' || lastCh === ',') continue;
    calls.add(name);
  }
  return calls;
}

/** 审计一个 JS 片段，返回"看起来未定义"的裸调用名 */
function auditBareCalls(src, extraKnown) {
  const clean = stripLiterals(src);
  const declared = declaredNames(clean);
  const known = new Set([...KNOWN_GLOBALS, ...(extraKnown || [])]);
  const bad = [];
  for (const name of bareCallNames(clean)) {
    if (declared.has(name) || known.has(name)) continue;
    bad.push(name);
  }
  return bad.sort();
}

// 载入库，用于"页面调用签名 vs 库导出"的脚本比对
require('./dom-shim.js');
CORE_SCRIPTS.concat(['js/carrier-generator.js', 'js/test-suite.js']).forEach((f) => require(path.join(ROOT, f)));
const StegoCore = global.StegoCore;
const ImageUtils = global.ImageUtils;
const TestSuite = global.TestSuite;
const SIGNATURE_LIBS = { StegoCore: StegoCore, ImageUtils: ImageUtils, TestSuite: TestSuite,
  CarrierGenerator: global.CarrierGenerator };

const results = [];
let failures = 0;

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}\n        ${detail}`);
}

// ============================================================
// 工具：解析某个函数调用实参个数（跳过字符串、按顶层逗号切分）
// ============================================================
function findCallArgs(src, startIdx) {
  // startIdx 指向 '(' 之后的第一个字符
  let depth = 0, i = startIdx, args = 0, hasContent = false;
  let quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; hasContent = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; hasContent = true; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') break; // 调用结束
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) { args++; continue; }
    if (!/\s/.test(ch)) hasContent = true;
  }
  return { argc: hasContent ? args + 1 : 0, end: i };
}

/** 提取页面中所有 `ns.fn(` 调用及其实参个数 */
function extractCalls(html, ns) {
  const re = new RegExp('(?:window\\.)?' + ns + '\\.([A-Za-z0-9_]+)\\s*\\(', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const info = findCallArgs(html, m.index + m[0].length);
    out.push({ fn: m[1], argc: info.argc });
  }
  return out;
}

function signatureReport(html, ns, lib) {
  const calls = extractCalls(html, ns);
  const unknown = [];
  const arityBad = [];
  const seen = new Map();
  for (const c of calls) {
    if (typeof lib[c.fn] !== 'function') { unknown.push(c.fn); continue; }
    const max = lib[c.fn].length;
    // 实参个数下限取 min(1, 形参个数)：无参函数（如 CarrierGenerator.styles()）
    // 本来就不该被要求传参，否则"调用 0 个实参"会被误判为签名不符。
    const min = Math.min(1, max);
    if (c.argc < min || c.argc > max) arityBad.push(`${c.fn}(${c.argc} 个实参, 允许 ${min}~${max})`);
    seen.set(`${c.fn}/${c.argc}`, (seen.get(`${c.fn}/${c.argc}`) || 0) + 1);
  }
  const list = [...seen.entries()].map(([k, v]) => `${k}×${v}`).join(', ');
  return {
    pass: unknown.length === 0 && arityBad.length === 0 && calls.length > 0,
    detail: `调用点 ${calls.length} 个：[${list}]；未导出的函数=[${unknown.join(', ')}]；形参超范围=[${arityBad.join(', ')}]`
  };
}

// ============================================================
// 页面定义
// ============================================================
const PAGES = [
  {
    file: 'index.html',
    // 首页按统一顺序引入 6 个核心库（规范要求），但首页不做隐写调用，故跳过调用签名比对
    scripts: CORE_SCRIPTS,
    useCore: false,
    links: ['index.html', 'embed.html', 'extract.html', 'tech.html'],
    ids: [],
    noTerms: true,
    checks: [
      {
        name: '两个大按钮分别指向 embed.html / extract.html',
        fn: (h) => /href="embed\.html"/.test(h) && /href="extract\.html"/.test(h) &&
          /去嵌入/.test(h) && /去提取/.test(h),
        detail: (h) => `去嵌入=${/去嵌入/.test(h)}；去提取=${/去提取/.test(h)}`
      },
      {
        name: '一句话简介强调"不上传服务器"',
        fn: (h) => /不上传(任何)?服务器/.test(h),
        detail: (h) => `简介=${/不上传(任何)?服务器/.test(h)}`
      },
      {
        name: '三行特性：不上传 / 抗压缩 / 抗损坏',
        fn: (h) => /不上传/.test(h) && /抗压缩/.test(h) && /抗损坏/.test(h),
        detail: (h) => ['不上传', '抗压缩', '抗损坏'].map((k) => `${k}=${h.indexOf(k) !== -1}`).join('；')
      },
      {
        name: '技术细节已迁走：正文不含内核/文件结构等术语（页面上的折叠面板仅限 FAQ）',
        fn: (h) => {
          const text = visibleText(h);
          return /文件结构/.test(text) === false && /纠删码/.test(text) === false &&
            /方差/.test(text) === false && /DCT/.test(text) === false &&
            /id="faq"/.test(h) && /常见问题/.test(text);
        },
        detail: (h) => {
          const text = visibleText(h);
          return `文件结构=${/文件结构/.test(text)}；纠删码=${/纠删码/.test(text)}；` +
            `方差=${/方差/.test(text)}；DCT=${/DCT/.test(text)}；` +
            `FAQ 折叠面板=${/id="faq"/.test(h) && /常见问题/.test(text)}`;
        }
      },
      {
        name: '底部"了解技术原理"链接指向 tech.html',
        fn: (h) => /href="tech\.html"[^>]*>了解技术原理/.test(h),
        detail: (h) => `技术原理链接=${/href="tech\.html"[^>]*>了解技术原理/.test(h)}`
      }
    ]
  },
  {
    file: 'embed.html',
    sig: ['StegoCore', 'ImageUtils', 'CarrierGenerator'],
    scripts: EMBED_SCRIPTS,
    links: ['index.html', 'embed.html', 'extract.html', 'tech.html'],
    ids: ['carrierFile', 'carrierHint', 'carrierThumb', 'carrierMeta',
      'secretFile', 'secretHint', 'secretThumb', 'secretMeta', 'secretNote',
      'readyText', 'embedBtn', 'progressBar', 'statusText',
      'resultSummary', 'shareTip', 'stegoThumb', 'stegoHint', 'downloadStegoBtn',
      'advancedPanel', 'redundancy', 'scaleMode', 'advancedDesc', 'channelPanel',
      'genPanel', 'genStyle', 'genSize', 'genShuffleBtn', 'genUseBtn', 'genHint',
      'genThumb', 'genQuality'],
    noTerms: true,
    checks: [
      {
        name: '上传区文案为自然语言：载体图（用于伪装的图片）/ 秘密图（要隐藏的图片）',
        fn: (h) => /选择载体图（用于伪装的图片）/.test(h) && /选择秘密图（要隐藏的图片）/.test(h) &&
          /id="carrierFile"[^>]*accept="image\/\*"/.test(h) &&
          /id="secretFile"[^>]*accept="image\/\*"/.test(h),
        detail: (h) => `载体图文案=${/选择载体图（用于伪装的图片）/.test(h)}；` +
          `秘密图文案=${/选择秘密图（要隐藏的图片）/.test(h)}；` +
          `两个 accept="image/*"=${(h.match(/accept="image\/\*"/g) || []).length} 处`
      },
      {
        name: '三态状态提示：未上传（灰）/ 容量不足（黄，含"已自动缩至 W×H"）/ 可嵌入（绿）',
        fn: (h) => /上传两张图后可开始/.test(h) && /已自动缩至 /.test(h) &&
          /已就绪，点击下方按钮开始/.test(h) &&
          /\.ready\.warn|ready warn/.test(h) && /\.ready\.ok|ready ok/.test(h),
        detail: (h) => `未上传文案=${/上传两张图后可开始/.test(h)}；` +
          `自动缩小文案=${/已自动缩至 /.test(h)}；可嵌入文案=${/已就绪，点击下方按钮开始/.test(h)}；` +
          `黄/绿样式=${/ready warn/.test(h)}/${/ready ok/.test(h)}`
      },
      {
        name: '大按钮"开始嵌入" + 进度条 + 状态行',
        fn: (h) => /id="embedBtn"[^>]*class="bigbtn"[^>]*>开始嵌入</.test(h) &&
          /id="progressBar"/.test(h) && /id="statusText"/.test(h),
        detail: (h) => `大按钮=${/id="embedBtn"[^>]*class="bigbtn"[^>]*>开始嵌入</.test(h)}；` +
          `进度条/状态行=${/id="progressBar"/.test(h)}/${/id="statusText"/.test(h)}`
      },
      {
        name: '完成后：预览 + 下载按钮 + 分享提示 + 自然语言统计（已嵌入 X KB，用时 Y 秒）',
        fn: (h) => /id="stegoThumb"/.test(h) && /下载隐写图/.test(h) &&
          /把这张图发给对方/.test(h) && /已嵌入 /.test(h) && /秒</.test(h),
        detail: (h) => `预览=${/id="stegoThumb"/.test(h)}；下载=${/下载隐写图/.test(h)}；` +
          `分享提示=${/把这张图发给对方/.test(h)}；自然语言统计=${/已嵌入 /.test(h) && /秒</.test(h)}`
      },
      {
        name: '高级设置默认收起，含抗损坏档位三档 + 抗缩放模式三档（"稳定区间"口径）',
        fn: (h) => /<details id="advancedPanel">/.test(h) && !/<details id="advancedPanel"[^>]*\sopen/.test(h) &&
          /value="standard" selected/.test(h) && /value="balanced"/.test(h) && /value="compact"/.test(h) &&
          /稳定抗 25~35%/.test(h) && /稳定抗 15~25%/.test(h) && /稳定抗 10~15%/.test(h) &&
          /value="auto" selected/.test(h) && /value="on"/.test(h) && /value="off"/.test(h) &&
          /id="advancedDesc"/.test(h),
        detail: (h) => `折叠且默认收起=${/<details id="advancedPanel">/.test(h)}；` +
          `三档"稳定区间"文案=${/稳定抗 25~35%/.test(h) && /稳定抗 15~25%/.test(h) && /稳定抗 10~15%/.test(h)}；` +
          `抗缩放三档=${/value="auto" selected/.test(h) && /value="on"/.test(h) && /value="off"/.test(h)}`
      },
      {
        name: '不再展示统计表格与技术数字（无 statK / statN / Tile 之类）',
        fn: (h) => !/table class="stats"/.test(h) && !/id="statK"/.test(h) && !/id="statN"/.test(h) &&
          !/statSymbol/.test(h) && !/statTextured/.test(h) && !/可用纹理/.test(h) && !/需要 Tile/.test(h),
        detail: (h) => `统计表格=${/table class="stats"/.test(h)}；statK/statN=${/id="statK"/.test(h)}/${/id="statN"/.test(h)}；` +
          `纹理 Tile 文案=${/可用纹理/.test(h)}`
      },
      {
        name: '嵌入调用带 redundancy / lowFrequencyMode / onProgress；下载文件名为 stego.png',
        fn: (h) => /redundancy: currentRedundancy\(\)/.test(h) && /lowFrequencyMode/.test(h) &&
          /onProgress: onProgress/.test(h) && /'stego\.png'/.test(h) && /alert\(err\.message\)/.test(h),
        detail: (h) => `redundancy 传入=${/redundancy: currentRedundancy\(\)/.test(h)}；` +
          `抗缩放模式传入=${/lowFrequencyMode/.test(h)}；进度回调=${/onProgress: onProgress/.test(h)}；` +
          `stego.png=${/'stego\.png'/.test(h)}`
      },
      {
        name: '第 4 步"模拟损坏并测试"：10/25/40/50% 四个按钮 + 内存中涂黑（不动已生成的文件）',
        fn: (h) => /模拟损坏并测试/.test(h) &&
          ['0.1', '0.25', '0.4', '0.5'].every((r) => h.indexOf(`data-ratio="${r}"`) !== -1) &&
          /你保存的文件不会被改动/.test(h) &&
          /function blackenCenter\(/.test(h) && /CONST\.TILE_SIZE/.test(h) &&
          /new ImageData\(new Uint8ClampedArray\(imageData\.data\), W, H\)/.test(h) &&
          /extractSecret\(damaged\.image\)/.test(h),
        detail: (h) => `四个档位=${['0.1', '0.25', '0.4', '0.5'].filter((r) => h.indexOf(`data-ratio="${r}"`) !== -1).length}/4；` +
          `涂黑只改副本=${/new ImageData\(new Uint8ClampedArray\(imageData\.data\), W, H\)/.test(h)}；` +
          `按 64 对齐 Tile=${/CONST\.TILE_SIZE/.test(h)}`
      },
      {
        name: '模拟结果按"模拟损坏 X%：提取成功/失败 + 用时 Y 秒"呈现，且生成隐写图后才可用',
        fn: (h) => /'模拟损坏 ' \+ shown \+ '%（实际遮住 ' \+ Math\.round\(damaged\.area \* 100\) \+ '%）：'/.test(h) &&
          /'提取成功，用时 ' \+ seconds \+ ' 秒。'/.test(h) &&
          /' 个数据块（不够还原），用时 ' \+ seconds \+ ' 秒。'/.test(h) &&
          /setSimButtons\(disabled\)/.test(h) && /setSimButtons\(true\)/.test(h) && /setSimButtons\(false\)/.test(h) &&
          /class="simbtn"[^>]*disabled/.test(h) && /id="simResult"/.test(h) && /id="simThumb"/.test(h),
        detail: (h) => `成功文案=${/提取成功，用时 /.test(h)}；失败文案=${/个数据块（不够还原）/.test(h)}；` +
          `按钮初始 disabled=${/class="simbtn"[^>]*disabled/.test(h)}；测试期间禁用=${/setSimButtons\(true\)/.test(h)}`
      },
      {
        name: '自动生成载体图：折叠面板 + 风格/尺寸选择 + 换一张/用这张 + 进度条 + 预览与质量评估',
        fn: (h) => /<details id="genPanel">/.test(h) && /让工具帮你生成一张/.test(h) &&
          /id="genStyle"/.test(h) && /id="genSize"/.test(h) &&
          /id="genShuffleBtn"[^>]*>🎲 换一张/.test(h) && /id="genUseBtn"[^>]*>✅ 用这张/.test(h) &&
          /id="genThumb"/.test(h) && /id="genQuality"/.test(h) && /id="genProgressBar"/.test(h) &&
          /1024x1024/.test(h) && /2048x2048/.test(h) && /4096x4096/.test(h) &&
          /2048x1152/.test(h) && /3840x2160/.test(h),
        detail: (h) => `折叠面板=${/<details id="genPanel">/.test(h)}；风格/尺寸选择=${/id="genStyle"/.test(h)}/${/id="genSize"/.test(h)}；` +
          `换一张/用这张=${/id="genShuffleBtn"[^>]*>🎲 换一张/.test(h)}/${/id="genUseBtn"[^>]*>✅ 用这张/.test(h)}；` +
          `预览/进度/评估=${/id="genThumb"/.test(h)}/${/id="genProgressBar"/.test(h)}/${/id="genQuality"/.test(h)}；` +
          `五个尺寸档=${['1024x1024', '2048x2048', '4096x4096', '2048x1152', '3840x2160'].filter((v) => h.indexOf(v) !== -1).length}/5`
      },
      {
        name: '生成器引入与调用：carrier-generator.js 在核心库之后加载，分片异步生成并走同一条 embedSecret 流程',
        fn: (h) => /js\/stego-core\.js"><\/script>\s*<script src="js\/carrier-generator\.js"><\/script>/.test(h) &&
          /CarrierGenerator\.generateAsync\(/.test(h) &&
          /onProgress: function \(phase, done, total\)/.test(h) &&
          /state\.carrier = genState\.result\.imageData/.test(h) &&
          /refreshReady\(\)/.test(h) &&
          /analyzeCapacity/.test(h),
        detail: (h) => `脚本顺序=${/js\/stego-core\.js"><\/script>\s*<script src="js\/carrier-generator\.js"><\/script>/.test(h)}；` +
          `调用 generateAsync=${/CarrierGenerator\.generateAsync\(/.test(h)}；` +
          `进度回调=${/onProgress: function \(phase, done, total\)/.test(h)}；` +
          `填入 state.carrier=${/state\.carrier = genState\.result\.imageData/.test(h)}；` +
          `复用容量分析=${/analyzeCapacity/.test(h)}`
      },
      {
        name: '手机优化：灰度模式开关 + 画质/容量三档 + 上传后自动适配提示 + 装不下时的三条建议 + 窄屏默认紧凑档',
        fn: (h) => /id="secretGray"/.test(h) && /id="secretMode"/.test(h) &&
          /高清优先/.test(h) && /均衡（推荐）/.test(h) && /容量优先/.test(h) &&
          /id="fitStatus"/.test(h) &&
          /秘密图偏大，已自动缩至 /.test(h) &&
          /① 换用本页的"自动生成载体图"功能/.test(h) &&
          /② 更换纹理更丰富的载体图/.test(h) &&
          /③ 开启"灰度模式"/.test(h) &&
          /innerWidth\s*\|\|\s*0/.test(h) && /sel\.value === 'standard'/.test(h) && /'compact'/.test(h),
        detail: (h) => `灰度开关=${/id="secretGray"/.test(h)}；三档=${/id="secretMode"/.test(h)}；` +
          `自动适配提示=${/秘密图偏大，已自动缩至 /.test(h)}；` +
          `三条建议=${[/① 换用本页的"自动生成载体图"功能/, /② 更换纹理更丰富的载体图/, /③ 开启"灰度模式"/].filter((re) => re.test(h)).length}/3；` +
          `窄屏默认紧凑=${/innerWidth\s*\|\|\s*0/.test(h) && /'compact'/.test(h)}`
      },
      {
        name: '自适应质量：embedSecret 传入 adaptiveQuality + qualityLadder，且按策略决定是否转灰度',
        fn: (h) => /adaptiveQuality: true/.test(h) && /qualityLadder: pol\.ladder/.test(h) &&
          /secretKeepColor: pol\.keepColor/.test(h) && /toGrayData/.test(h),
        detail: (h) => `adaptiveQuality=${/adaptiveQuality: true/.test(h)}；` +
          `qualityLadder=${/qualityLadder: pol\.ladder/.test(h)}；` +
          `keepColor=${/secretKeepColor: pol\.keepColor/.test(h)}；真实转灰度=${/toGrayData/.test(h)}`
      },
      {
        name: '底部"了解技术原理"链接指向 tech.html',
        fn: (h) => /href="tech\.html"[^>]*>了解技术原理/.test(h),
        detail: (h) => `技术原理链接=${/href="tech\.html"[^>]*>了解技术原理/.test(h)}`
      }
    ]
  },
  {
    file: 'extract.html',
    sig: ['StegoCore', 'ImageUtils'],
    links: ['index.html', 'embed.html', 'extract.html', 'tech.html'],
    ids: ['stegoFile', 'inputHint', 'inputThumb', 'inputMeta', 'inputReady',
      'extractBtn', 'progressBar', 'statusText', 'resultBanner',
      'secretHint', 'secretThumb', 'elapsedText', 'downloadSecretBtn',
      'diagPanel', 'maskHint', 'maskThumb', 'diagTiles', 'diagBlocks', 'diagPath',
      'diagNormal', 'diagPhase', 'diagScale'],
    noTerms: true,
    checks: [
      {
        name: '标题文案：上传一张被隐写的图片，还原其中的秘密图',
        fn: (h) => /上传一张被隐写的图片，还原其中的秘密图/.test(h) &&
          /id="stegoFile"[^>]*accept="image\/\*"/.test(h) && /像素/.test(h),
        detail: (h) => `标题=${/上传一张被隐写的图片，还原其中的秘密图/.test(h)}；` +
          `accept=${/id="stegoFile"[^>]*accept="image\/\*"/.test(h)}；尺寸文案=${/像素/.test(h)}`
      },
      {
        name: '大按钮"开始提取" + 进度条 + 状态行',
        fn: (h) => /id="extractBtn"[^>]*class="bigbtn"[^>]*>开始提取</.test(h) &&
          /id="progressBar"/.test(h) && /id="statusText"/.test(h),
        detail: (h) => `大按钮=${/id="extractBtn"[^>]*class="bigbtn"[^>]*>开始提取</.test(h)}`
      },
      {
        name: '成功/失败两种结果横幅，失败文案为友好提示（平台压缩 / 损坏 / 裁剪 / 不是隐写图）',
        fn: (h) => /banner ok/.test(h) && /banner no/.test(h) &&
          /未能还原秘密图/.test(h) && /可能原因/.test(h) &&
          /平台压缩/.test(h) && /微信\/QQ 的普通发送/.test(h) &&
          /不是一张隐写图/.test(h) && /裁剪/.test(h) && /损坏过多/.test(h),
        detail: (h) => `横幅样式=${/banner ok/.test(h)}/${/banner no/.test(h)}；` +
          `失败文案=${/未能还原秘密图/.test(h) && /可能原因/.test(h)}；` +
          `含平台压缩提示=${/平台压缩/.test(h) && /微信\/QQ 的普通发送/.test(h)}`
      },
      {
        name: '结果显示"用时 YY 秒" + 秘密图预览 + 下载按钮（secret.jpg）',
        fn: (h) => /用时 /.test(h) && /秒/.test(h) && /id="secretThumb"/.test(h) &&
          /下载秘密图/.test(h) && /'secret\.jpg'/.test(h),
        detail: (h) => `用时文案=${/用时 /.test(h) && /秒/.test(h)}；预览=${/id="secretThumb"/.test(h)}；` +
          `secret.jpg=${/'secret\.jpg'/.test(h)}`
      },
      {
        name: '诊断详情为折叠面板（默认收起），含方块校验图 + 图例 + 三项数字',
        fn: (h) => /<details id="diagPanel">/.test(h) && !/<details id="diagPanel"[^>]*\sopen/.test(h) &&
          /id="maskThumb"/.test(h) && /成功读出/.test(h) && /读取失败/.test(h) && /边缘区域/.test(h) &&
          /id="diagTiles"/.test(h) && /id="diagBlocks"/.test(h) && /id="diagPath"/.test(h),
        detail: (h) => `折叠且默认收起=${/<details id="diagPanel">/.test(h)}；` +
          `图例三项=${/成功读出/.test(h) && /读取失败/.test(h) && /边缘区域/.test(h)}；` +
          `诊断三项=${/id="diagTiles"/.test(h) && /id="diagBlocks"/.test(h) && /id="diagPath"/.test(h)}`
      },
      {
        name: '还原方式用自然语言描述（直接读取 / 网格重定位 / 尺寸还原 / 未成功）',
        fn: (h) => /PATH_LABEL/.test(h) && /直接读取/.test(h) && /网格重定位/.test(h) &&
          /尺寸还原/.test(h) && /未成功/.test(h),
        detail: (h) => `路径映射=${/PATH_LABEL/.test(h)}；四种文案=${/直接读取/.test(h) && /网格重定位/.test(h) && /尺寸还原/.test(h) && /未成功/.test(h)}`
      },
      {
        name: '秘密图异步解码预览（decodeSecretImage）+ 不支持解码时的降级提示',
        fn: (h) => /decodeSecretImage/.test(h) && /decodeSupported/.test(h) && /不支持预览/.test(h),
        detail: (h) => `decodeSecretImage=${/decodeSecretImage/.test(h)}；` +
          `decodeSupported=${/decodeSupported/.test(h)}；降级提示=${/不支持预览/.test(h)}`
      },
      {
        name: '进度回调绑定 onProgress，并把校正阶段翻译成中文提示',
        fn: (h) => /onProgress: onProgress/.test(h) && /检查图片/.test(h) && /还原数据/.test(h) &&
          /校正位置/.test(h) && /校正尺寸/.test(h),
        detail: (h) => `onProgress 传入=${/onProgress: onProgress/.test(h)}；` +
          `阶段文案=${/检查图片/.test(h) && /还原数据/.test(h) && /校正位置/.test(h) && /校正尺寸/.test(h)}`
      },
      {
        name: '诊断面板按"每条路径分别报数"：6 对模式 / 4 对低频模式分开显示，不再只报一个 0/N',
        fn: (h) => /id="diagNormal"/.test(h) && /id="diagPhase"/.test(h) && /id="diagScale"/.test(h) &&
          /describeAttempts/.test(h) && /at\.normal6/.test(h) && /at\.normal4/.test(h) &&
          /6 对模式读出 /.test(h) && /4 对低频模式读出 /.test(h) &&
          /常规提取 ' \+ best \+ '\/' \+ need \+ ' 块/.test(h),
        detail: (h) => `三行 id=${/id="diagNormal"/.test(h)}/${/id="diagPhase"/.test(h)}/${/id="diagScale"/.test(h)}；` +
          `读 attempts 两种模式=${/at\.normal6/.test(h) && /at\.normal4/.test(h)}；` +
          `摘要取两模式较大值=${/常规提取 ' \+ best \+ '\/' \+ need \+ ' 块/.test(h)}`
      },
      {
        name: '成功/失败状态行都带真实读数（常规提取 XX/KK 块 + 相位搜索通过率 + 尺寸校准）',
        fn: (h) => /diag\.brief/.test(h) && /setStatus\('完成，用时 ' \+ seconds \+ ' 秒（' \+ diag\.brief/.test(h) &&
          /setStatus\('没能还原出秘密图（' \+ diag\.brief \+ '）/.test(h) &&
          /brief \+= '，相位搜索 ' \+ pctText\(ph\.bestRate\)/.test(h) &&
          /brief \+= '，尺寸校准 ' \+ sc\.detectedSize\.w/.test(h),
        detail: (h) => `成功状态行=${/setStatus\('完成，用时 ' \+ seconds \+ ' 秒（' \+ diag\.brief/.test(h)}；` +
          `失败状态行=${/setStatus\('没能还原出秘密图（' \+ diag\.brief \+ '）/.test(h)}；` +
          `含相位搜索=${/相位搜索/.test(h)}；含尺寸校准=${/尺寸校准/.test(h)}`
      },
      {
        name: '底部"了解技术原理"链接指向 tech.html',
        fn: (h) => /href="tech\.html"[^>]*>了解技术原理/.test(h),
        detail: (h) => `技术原理链接=${/href="tech\.html"[^>]*>了解技术原理/.test(h)}`
      }
    ]
  },
  {
    file: 'tech.html',
    // 纯内容页：不引入任何脚本（连核心库都不需要），因此期望 script 列表为空
    scripts: [],
    useCore: false,
    links: ['index.html', 'embed.html', 'extract.html', 'tech.html'],
    ids: [],
    checks: [
      {
        name: '学术论文体：至少 9 个章节标题（<h2>），且都带锚点 id',
        fn: (h) => (h.match(/<h2[\s>]/g) || []).length >= 9 &&
          (h.match(/<h2 id="s\d+"/g) || []).length === (h.match(/<h2[\s>]/g) || []).length,
        detail: (h) => `h2 数量=${(h.match(/<h2[\s>]/g) || []).length}（要求 >= 9）；` +
          `带 id 的 h2=${(h.match(/<h2 id="s\d+"/g) || []).length}`
      },
      {
        name: '论文元信息齐全：摘要 / Abstract / 关键词 / 参考文献 / 作者与日期',
        fn: (h) => /摘要/.test(h) && /Abstract/.test(h) && /关键词/.test(h) &&
          /参考文献/.test(h) && /TPZF 工具箱项目组/.test(h) && /2026-09/.test(h),
        detail: (h) => `摘要=${/摘要/.test(h)}；Abstract=${/Abstract/.test(h)}；关键词=${/关键词/.test(h)}；` +
          `参考文献=${/参考文献/.test(h)}；作者=${/TPZF 工具箱项目组/.test(h)}；日期=${/2026-09/.test(h)}`
      },
      {
        name: '章节主题覆盖：引言 / 相关工作 / 系统模型 / 方法 / 实验 / 讨论 / 局限与未来工作 / 结论',
        fn: (h) => /引言/.test(h) && /相关工作/.test(h) && /系统模型/.test(h) && /方法/.test(h) &&
          /实验/.test(h) && /讨论/.test(h) && /局限与未来工作/.test(h) && /结论/.test(h),
        detail: (h) => ['引言', '相关工作', '系统模型', '方法', '实验', '讨论', '局限与未来工作', '结论']
          .filter((k) => h.indexOf(k) === -1).length + ' 个主题缺失'
      },
      {
        name: '图表：图 1~图 6 为内联 SVG（每张 ≤ 5KB、含 <title>/<desc>、配 <p class="caption">），表 1~表 8 编号齐全，无外部图片',
        fn: (h) => {
          let figs = 0, tabs = 0;
          for (let i = 1; i <= 6; i++) if (new RegExp(`图\\s?${i}[：:　 ]`).test(h)) figs++;
          for (let i = 1; i <= 8; i++) if (new RegExp(`表\\s?${i}[：:　 ]`).test(h)) tabs++;
          const svgs = h.match(/<svg[\s\S]*?<\/svg>/g) || [];
          // 正式插图：必须有 <title id> 与 <desc id>，且 ≤ 5KB
          const figures = svgs.filter((s) =>
            /<title[^>]*id=/.test(s) && /<desc[^>]*id=/.test(s) && s.length <= 5000);
          // 其余允许存在的是小装饰性图标（例如箭头、圆点），要求足够小
          const deco = svgs.filter((s) => figures.indexOf(s) === -1);
          const svgOk = figures.length >= 6 && deco.every((s) => s.length <= 1000);
          const captions = (h.match(/<p class="caption">/g) || []).length;
          return figs >= 6 && tabs >= 8 && svgOk && captions >= 6 &&
            (h.match(/<pre class="diagram">/g) || []).length === 0 &&
            !/<img\b/i.test(h) && !/background-image/.test(h);
        },
        detail: (h) => {
          const figs = [1, 2, 3, 4, 5, 6].filter((i) => new RegExp(`图\\s?${i}[：:　 ]`).test(h));
          const tabs = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => new RegExp(`表\\s?${i}[：:　 ]`).test(h));
          const svgs = h.match(/<svg[\s\S]*?<\/svg>/g) || [];
          const figures = svgs.filter((s) =>
            /<title[^>]*id=/.test(s) && /<desc[^>]*id=/.test(s) && s.length <= 5000);
          const deco = svgs.filter((s) => figures.indexOf(s) === -1);
          return `图编号=[${figs.join(',')}]；表编号=[${tabs.join(',')}]；` +
            `合规插图=${figures.length} 张（字符数 [${figures.map((s) => s.length).join(', ')}]）；` +
            `装饰性小图标=${deco.length} 张（最大 ${deco.length ? Math.max(...deco.map((s) => s.length)) : 0} 字符）；` +
            `caption=${(h.match(/<p class="caption">/g) || []).length}；` +
            `残留字符图=${(h.match(/<pre class="diagram">/g) || []).length}；<img>=${/<img\b/i.test(h)}`;
        }
      },
      {
        name: '关键原理在正文中给出：量化步长 / 差分调制 / N = 2K / 双导频 / 干扰对消 / 符号与记号表',
        fn: (h) => /量化步长/.test(h) && /差分/.test(h) && /N\s?=\s?2K/.test(h) &&
          /导频/.test(h) && /干扰对消/.test(h) && /符号/.test(h),
        detail: (h) => `量化步长=${/量化步长/.test(h)}；差分=${/差分/.test(h)}；` +
          `N=2K=${/N\s?=\s?2K/.test(h)}；导频=${/导频/.test(h)}；` +
          `干扰对消=${/干扰对消/.test(h)}；符号表=${/符号/.test(h)}`
      },
      {
        name: '含"传输信道要求"内容：信道 / 有损 / 无损 / 微信 / 文件级传输',
        fn: (h) => /信道/.test(h) && /有损/.test(h) && /无损/.test(h) &&
          /微信/.test(h) && /文件级/.test(h),
        detail: (h) => `信道=${/信道/.test(h)}；有损=${/有损/.test(h)}；无损=${/无损/.test(h)}；` +
          `微信=${/微信/.test(h)}；文件级=${/文件级/.test(h)}`
      },
      {
        name: '§7.1 写入 T30 已知限制：513 / 抛物线插值 / ±1 px 精度极限',
        fn: (h) => /T30/.test(h) && /513/.test(h) && /抛物线/.test(h) && /7\.1/.test(h),
        detail: (h) => `T30=${/T30/.test(h)}；513=${/513/.test(h)}；` +
          `抛物线=${/抛物线/.test(h)}；§7.1=${/7\.1/.test(h)}`
      },
      {
        name: '至少 5 篇参考文献，且正文用 [n] 引用（Reed & Solomon / RFC 6330 / ITU-T T.81 等）',
        fn: (h) => (h.match(/\[\d\]/g) || []).length >= 5 &&
          /Reed/.test(h) && /RFC 6330/.test(h) && /T\.81/.test(h) && /Cox/.test(h),
        detail: (h) => `[n] 引用次数=${(h.match(/\[\d\]/g) || []).length}；` +
          `Reed=${/Reed/.test(h)}；RFC 6330=${/RFC 6330/.test(h)}；` +
          `ITU-T T.81=${/T\.81/.test(h)}；Cox=${/Cox/.test(h)}`
      },
      {
        name: '底部含返回首页与开发者测试入口（→ dev-test-suite.html）',
        fn: (h) => /href="index\.html"/.test(h) && /href="dev-test-suite\.html"/.test(h) &&
          /测试/.test(h),
        detail: (h) => `首页链接=${/href="index\.html"/.test(h)}；` +
          `测试页链接=${/href="dev-test-suite\.html"/.test(h)}`
      },
      {
        name: '技术术语集中在本页（与三个面向用户的页面形成对照）',
        fn: (h) => /Reed|纠删码/.test(h) && /导频/.test(h) && /扩频/.test(h) &&
          /GF\(2[\^¹]*16\)/.test(h),
        detail: (h) => `纠删码=${/Reed|纠删码/.test(h)}；导频=${/导频/.test(h)}；` +
          `扩频=${/扩频/.test(h)}；GF(2^16)=${/GF\(2[\^¹]*16\)/.test(h)}`
      },
      {
        name: '学术写法：全文为第三人称，不出现"你 / 你们 / 我们 / 咱们"',
        fn: (h) => {
          const text = visibleText(h);
          return ['你', '你们', '我们', '咱们'].every((w) => text.indexOf(w) === -1);
        },
        detail: (h) => {
          const text = visibleText(h);
          const hits = ['你', '我们', '咱们'].filter((w) => text.indexOf(w) !== -1);
          return `命中=[${hits.join(', ')}]（要求 0）`;
        }
      },
      {
        name: '文风：全文不含模板短语与夸大词（含 非常 / 极其 / 完美的）',
        fn: (h) => {
          const text = visibleText(h);
          const hits = BANNED_PHRASES.concat(['非常', '极其', '完美的']).filter((p) => text.indexOf(p) !== -1);
          const badStart = textBlocks(h, ['p'])
            .filter((b) => /^(首先|其次|最后|再者|然后)/.test(stripTags(b.inner)));
          return hits.length === 0 && badStart.length === 0;
        },
        detail: (h) => {
          const text = visibleText(h);
          const hits = BANNED_PHRASES.concat(['非常', '极其', '完美的']).filter((p) => text.indexOf(p) !== -1);
          const badStart = textBlocks(h, ['p'])
            .map((b) => stripTags(b.inner)).filter((t) => /^(首先|其次|最后|再者|然后)/.test(t));
          return `模板/夸大词命中=[${hits.join(', ')}]（共 ${BANNED_PHRASES.length + 3} 个词，要求 0）；` +
            `排比开头段落=${badStart.length} 个${badStart.length ? '：' + badStart.map((t) => t.slice(0, 12)).join(' / ') : ''}`;
        }
      },
      {
        name: '文风：每个段落/列表项/单元格的加粗不超过 1 处',
        fn: (h) => textBlocks(h, ['p', 'li', 'td', 'th']).every((b) => countBold(b.inner) <= 1),
        detail: (h) => {
          const blocks = textBlocks(h, ['p', 'li', 'td', 'th']);
          const bad = blocks.filter((b) => countBold(b.inner) > 1);
          const max = blocks.reduce((m, b) => Math.max(m, countBold(b.inner)), 0);
          return `检查 ${blocks.length} 个块，最大加粗数=${max}（要求 ≤ 1）；超标=${bad.length} 个` +
            (bad.length ? '：' + bad.map((b) => `[${stripTags(b.inner).slice(0, 16)}…]×${countBold(b.inner)}`).join(' ') : '');
        }
      },
      {
        name: '文风：每个 <p> 段落至少 3 句（禁止短句独立成段）',
        fn: (h) => textBlocks(h, ['p']).every((b) => countSentences(b.inner) >= 3),
        detail: (h) => {
          const ps = textBlocks(h, ['p']);
          const bad = ps.filter((b) => countSentences(b.inner) < 3);
          const min = ps.reduce((m, b) => Math.min(m, countSentences(b.inner)), 99);
          const sum = ps.reduce((s, b) => s + countSentences(b.inner), 0);
          return `检查 ${ps.length} 个 <p>，最少句数=${min}（要求 ≥ 3），平均 ${(sum / ps.length).toFixed(1)} 句；` +
            `不足 3 句的段落=${bad.length} 个` +
            (bad.length ? '：' + bad.map((b) => `[${stripTags(b.inner).slice(0, 16)}…]${countSentences(b.inner)}句`).join(' ') : '');
        }
      }
    ]
  },
  {
    file: 'dev-test-suite.html',
    scripts: CORE_SCRIPTS.concat(['js/test-suite.js']),
    sig: ['TestSuite'],
    links: ['index.html', 'embed.html', 'extract.html', 'tech.html', 'dev-test-suite.html'],
    ids: ['startBtn', 'clearBtn', 'progressBar', 'progressText', 'resultBody',
      'statTotal', 'statPass', 'statFail', 'statTime', 'nsWarning',
      'filterAll', 'filterBaseline', 'filterBlackout', 'filterCrop', 'filterWatermark',
      'filterCapacity', 'filterResync', 'manualPanel'],
    checks: [
      {
        name: '页面顶部有"开发者验证工具，普通用户无需访问"提示',
        fn: (h) => /本页为开发者验证工具，普通用户无需访问/.test(h) && /class="devnote"/.test(h),
        detail: (h) => `提示语=${/本页为开发者验证工具，普通用户无需访问/.test(h)}；` +
          `样式类=${/class="devnote"/.test(h)}`
      },
      {
        name: '已改名为开发者测试页：标题与自引用都指向 dev-test-suite.html',
        fn: (h) => /开发者测试页/.test(h) && /href="dev-test-suite\.html"/.test(h) &&
          !/href="test-suite\.html"/.test(h),
        detail: (h) => `含"开发者测试页"=${/开发者测试页/.test(h)}；` +
          `自引用指向新文件名=${/href="dev-test-suite\.html"/.test(h)}；` +
          `残留旧文件名=${/href="test-suite\.html"/.test(h)}`
      },
      {
        name: 'script 标签在核心库之后引入 test-suite.js（顺序不可换）',
        fn: (h) => /js\/stego-core\.js"><\/script>\s*<script src="js\/test-suite\.js"><\/script>/.test(h),
        detail: (h) => `stego-core → test-suite 相邻且有序=${/js\/stego-core\.js"><\/script>\s*<script src="js\/test-suite\.js"><\/script>/.test(h)}`
      },
      {
        name: '六个命名空间自检 + 缺失时红字提示并禁用开始按钮',
        fn: (h) => /ImageUtils/.test(h) && /DctStego/.test(h) && /Packet/.test(h) &&
          /RaptorQ/.test(h) && /GeoCalibration/.test(h) && /StegoCore/.test(h) && /TestSuite/.test(h) &&
          /nsWarning/.test(h) && /startBtn'\)\.disabled = true/.test(h),
        detail: (h) => `命名空间自检列表齐全=${['ImageUtils', 'DctStego', 'Packet', 'RaptorQ', 'GeoCalibration', 'StegoCore', 'TestSuite'].every((n) => h.indexOf(n) !== -1)}；` +
          `缺失时禁用按钮=${/startBtn'\)\.disabled = true/.test(h)}`
      },
      {
        name: '调 TestSuite.runAll(onProgress, onResult)，逐条回调立即更新表格',
        fn: (h) => /TestSuite\.runAll\(/.test(h) && /function \(cur, total, name\)/.test(h) &&
          /function \(result\)/.test(h) && /renderTable\(\);\s*\/\/ 每个用例完成后立即更新表格/.test(h),
        detail: (h) => `runAll 调用=${/TestSuite\.runAll\(/.test(h)}；进度回调=${/function \(cur, total, name\)/.test(h)}；` +
          `结果回调=${/function \(result\)/.test(h)}；即时渲染=${/renderTable\(\);\s*\/\/ 每个用例完成后立即更新表格/.test(h)}`
      },
      {
        name: '结果表五列齐全（序号 / 测试名 / 结果 / 耗时 / 备注）+ PASS 绿 FAIL 红',
        fn: (h) => /<th>序号<\/th>/.test(h) && /<th>测试名<\/th>/.test(h) && /<th>结果<\/th>/.test(h) &&
          /<th>耗时\(ms\)<\/th>/.test(h) && /<th>备注<\/th>/.test(h) &&
          /badge\.pass/.test(h) && /badge\.fail/.test(h) && /--green/.test(h) && /--red/.test(h),
        detail: (h) => `表头五列=${/序号/.test(h) && /测试名/.test(h) && /结果/.test(h) && /耗时\(ms\)/.test(h) && /备注/.test(h)}；` +
          `PASS/FAIL 徽标样式=${/badge\.pass/.test(h) && /badge\.fail/.test(h)}`
      },
      {
        name: '六个分组筛选按钮 + 全部，data-group 与 TestSuite 分组 id 一致',
        fn: (h) => ['baseline', 'blackout', 'crop', 'watermark', 'capacity', 'resync'].every((g) =>
          new RegExp('data-group="' + g + '"').test(h)) && /data-group="all"/.test(h),
        detail: (h) => `data-group=[${['all', 'baseline', 'blackout', 'crop', 'watermark', 'capacity', 'resync']
          .filter((g) => h.indexOf('data-group="' + g + '"') !== -1).join(', ')}]`
      },
      {
        name: '底部统计：总数 / 通过 / 失败 / 总耗时',
        fn: (h) => /statTotal/.test(h) && /statPass/.test(h) && /statFail/.test(h) && /statTime/.test(h),
        detail: (h) => `四个统计格齐全=${/statTotal/.test(h) && /statPass/.test(h) && /statFail/.test(h) && /statTime/.test(h)}`
      },
      {
        name: '运行期间禁用开始按钮，完成后恢复',
        fn: (h) => /function setRunning\(on\)/.test(h) && /startBtn'\)\.disabled = on/.test(h) &&
          /setRunning\(true\)/.test(h) && /setRunning\(false\)/.test(h),
        detail: (h) => `setRunning 控制禁用=${/function setRunning\(on\)/.test(h) && /startBtn'\)\.disabled = on/.test(h)}；` +
          `开始/结束均调用=${/setRunning\(true\)/.test(h) && /setRunning\(false\)/.test(h)}`
      },
      {
        name: '底部含人工验收清单折叠面板（<details>，覆盖 7 个页面）',
        fn: (h) => /<details id="manualPanel">/.test(h) &&
          /index\.html/.test(h) && /embed\.html/.test(h) && /extract\.html/.test(h) &&
          /dev-test-suite\.html/.test(h) && /test-image-utils\.html/.test(h) && /test-stego-pipeline\.html/.test(h) &&
          /tech\.html/.test(h),
        detail: (h) => `折叠面板=${/<details id="manualPanel">/.test(h)}；` +
          `清单提到 7 个页面=${['index.html', 'embed.html', 'extract.html', 'tech.html', 'dev-test-suite.html', 'test-image-utils.html', 'test-stego-pipeline.html'].filter((f) => h.indexOf(f) !== -1).length}/7`
      }
    ]
  },
  {
    file: 'test-image-utils.html',
    useCore: false,
    scripts: ['js/image-utils.js'],
    ids: ['file', 'threshold', 'thresholdNum', 'preview', 'previewHint', 'canvas',
      'canvasHint', 'exportBtn', 'sTotal', 'sMin', 'sMax', 'sAvg', 'sFiltered'],
    checks: [
      {
        name: '阈值滑块 0~3000 默认 200；实时更新；绿/红框配色',
        fn: (h) => /min="0"[^>]*max="3000"[^>]*value="200"/.test(h) && /DEFAULT_THRESHOLD = 200/.test(h) &&
          /thresholdInput\.addEventListener\('input'/.test(h) && /#00e676/.test(h) && /#ff4d6a/.test(h),
        detail: (h) => `滑块规格=${/min="0"[^>]*max="3000"[^>]*value="200"/.test(h)}；` +
          `input 监听=${/thresholdInput\.addEventListener\('input'/.test(h)}；配色=${/#00e676/.test(h) && /#ff4d6a/.test(h)}`
      }
    ]
  },
  {
    file: 'test-stego-pipeline.html',
    useCore: false,
    scripts: CORE_SCRIPTS,
    ids: ['carrierFile', 'secretFile', 'stegoFile', 'embedBtn', 'extractBtn', 'maskPreview'],
    checks: [
      {
        name: '嵌入/提取双区块与 debugMask 预览齐全',
        fn: (h) => /id="embedSection"/.test(h) && /id="extractSection"/.test(h) && /r\.debugMask/.test(h),
        detail: (h) => `嵌入区=${/id="embedSection"/.test(h)}；提取区=${/id="extractSection"/.test(h)}；` +
          `debugMask=${/r\.debugMask/.test(h)}`
      }
    ]
  }
];

// ============================================================
// 逐页检查
// ============================================================
for (const page of PAGES) {
  const htmlPath = path.join(ROOT, page.file);
  if (!fs.existsSync(htmlPath)) {
    check(`${page.file} 存在`, false, '文件不存在');
    continue;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  console.log(`\n--- ${page.file}（${html.split('\n').length} 行）---`);

  // 1) script 标签：文件存在 + 顺序
  const expected = page.scripts || (page.sig ? CORE_SCRIPTS : []);
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const missingFiles = srcs.filter((s) => !fs.existsSync(path.join(ROOT, s)));
  const orderOk = srcs.length === expected.length && expected.every((s, i) => srcs[i] === s);
  check(`script 标签顺序正确（${expected.length} 个）且文件均存在`, missingFiles.length === 0 && orderOk,
    `实际=[${srcs.join(' → ')}]；期望=[${expected.join(' → ')}]；缺失文件=[${missingFiles.join(', ')}]`);

  // 2) 内联脚本可编译
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let syntaxOk = true, err = '';
  try {
    inline.forEach((code, i) => new vm.Script(code, { filename: `${page.file}#inline-${i}` }));
  } catch (e) {
    syntaxOk = false;
    err = e.message;
  }
  check('内联脚本语法正确（vm.Script 编译通过）', syntaxOk,
    `内联脚本块数=${inline.length}；${syntaxOk ? '编译无错误' : '错误: ' + err}`);

  // 3) id 齐全且唯一
  const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupIds = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  const missingIds = page.ids.filter((id) => allIds.indexOf(id) === -1);
  check(`UI 元素 id 齐全且全局唯一（共 ${allIds.length} 个）`,
    dupIds.length === 0 && missingIds.length === 0,
    `重复 id=[${[...new Set(dupIds)].join(', ')}]；缺失=[${missingIds.join(', ')}]`);

  // 4) 无外部资源、无 ES Module（GitHub 占位符链接除外：发布前由用户替换）
  const ext = (html.match(/https?:\/\/[^"' ]+/g) || [])
    .filter((u) => !/w3\.org/.test(u) && !/^https:\/\/github\.com\/&lt;/.test(u));
  const esm = (inline.join('\n').match(/(^|\n)\s*(import|export)\b/g) || []).length;
  check('无外部 URL、无 ES Module', ext.length === 0 && esm === 0,
    `外部 URL=${JSON.stringify(ext)}；内联 import/export=${esm}`);

  // 4b) 脚本里用字符串取过的 id 必须真实存在（防"改 UI 时漏删/写错 id"导致运行期报错）
  const idRefs = [...new Set([
    ...[...html.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]),
    ...[...html.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1])
  ])];
  const ghostIds = idRefs.filter((id) => allIds.indexOf(id) === -1);
  check(`脚本引用的 id 都存在（共引用 ${idRefs.length} 个）`, ghostIds.length === 0,
    `引用=[${idRefs.join(', ')}]；不存在的=[${ghostIds.join(', ')}]`);

  // 4c) 裸调用审计：内联脚本里不许出现"未定义/未加前缀"的函数调用
  {
    const inlineSrc = inline.join('\n;\n');
    const bad = auditBareCalls(inlineSrc);
    check('内联脚本无未定义的裸函数调用（防 ReferenceError）', bad.length === 0,
      bad.length === 0
        ? `扫描 ${inlineSrc.split('\n').length} 行内联脚本，裸调用全部已定义或属已知全局`
        : `可疑调用=[${bad.join(', ')}]（既未在本页声明，也不在已知全局名单里）`);
  }

  //    除了正文，还把 title / alt / placeholder / aria-label 这类"会露给用户看"的属性值一并算进来
  if (page.noTerms) {
    const attrText = [...html.matchAll(/(?:title|alt|placeholder|aria-label)="([^"]*)"/g)]
      .map((m) => m[1]).join(' ');
    const text = visibleText(html) + ' ' + attrText;
    const hits = findTerms(text, TERM_BLACKLIST);
    check(`可见文本不含专业术语（黑名单 ${TERM_BLACKLIST.length} 个词）`, hits.length === 0,
      hits.length === 0
        ? `可见文本 ${visibleText(html).replace(/\s+/g, ' ').trim().length} 字符 + 提示属性 ${attrText.length} 字符，未命中任何术语`
        : `命中=[${hits.join(', ')}]`);
  }

  // 6) 页面调用的库函数签名与导出是否一致
  if (page.sig) {
    for (const ns of page.sig) {
      const r = signatureReport(html, ns, SIGNATURE_LIBS[ns]);
      check(`${ns} 调用签名与库导出一致（函数名 + 实参个数）`, r.pass, r.detail);
    }
  }

  // 7) 页面间跳转
  if (page.links) {
    const hrefs = [...new Set([...html.matchAll(/href="([^"#]+\.html)"/g)].map((m) => m[1]))];
    const broken = hrefs.filter((h) => !fs.existsSync(path.join(ROOT, h)));
    const navOk = page.links.every((l) => hrefs.indexOf(l) !== -1);
    check('页面跳转路径正确（导航链接齐全且目标文件存在）', broken.length === 0 && navOk,
      `链接=[${hrefs.join(', ')}]；期望含 [${page.links.join(', ')}]；失效链接=[${broken.join(', ')}]`);
  }

  // 8) 页面特有检查
  for (const c of page.checks) {
    let pass = false, detail = '';
    try {
      pass = !!c.fn(html);
      detail = c.detail(html);
    } catch (e) {
      detail = '检查抛错: ' + e.message;
    }
    check(c.name, pass, detail);
  }
}

// ============================================================
// 仓库级检查（开源项目必备文件 + 全项目文案口径）
// ------------------------------------------------------------
// 这些检查不看单个页面，而是看"整个仓库对外发布"需要满足的条件：
//   夸大表述是否清零、必备文件是否齐全、favicon 是否都设了、链接是否都是相对路径。
// ============================================================
{
  const readIf = (rel) => (fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : null);

  // 1) "抗 50%"类夸大表述必须清零（理论边界要用"理论/上限"这类限定词表述）
  {
    const targets = ['js/image-utils.js', 'js/dct-stego.js', 'js/packet.js', 'js/raptorq.js',
      'js/geo-calibration.js', 'js/stego-core.js', 'js/test-suite.js',
      'index.html', 'embed.html', 'extract.html', 'tech.html', '404.html',
      'dev-test-suite.html', 'test-image-utils.html', 'test-stego-pipeline.html'];
    const patterns = [/抗\s?50\s?%/, /能扛住一半/, /扛住一半/, /一半区域被破坏仍/, /抗 50% 损坏/];
    const hits = [];
    for (const rel of targets) {
      const s = readIf(rel);
      if (!s) continue;
      const text = visibleText(s);
      for (const re of patterns) {
        if (re.test(text)) hits.push(`${rel}:${re.source}`);
      }
    }
    check('全项目"抗 50%"类夸大表述已清除（改述为"稳定抗 25~35%"等）', hits.length === 0,
      hits.length === 0 ? `扫描 ${targets.length} 个文件的可见文本，未命中 5 种夸大句式`
        : `命中=[${hits.join(', ')}]`);
  }

  // 2) 三档文案必须给出"稳定"区间，且与内核 REDUNDANCY_LABEL 口径一致
  {
    const embed = readIf('embed.html') || '';
    const hasStable = /稳定抗\s?25~35%/.test(embed) && /稳定抗\s?15~25%/.test(embed) &&
      /稳定抗\s?10~15%/.test(embed);
    const core = readIf('js/stego-core.js') || '';
    const labelOk = /standard: '标准（稳定抗 25~35%/.test(core) &&
      /balanced: '均衡（稳定抗 15~25%/.test(core) &&
      /compact: '紧凑（稳定抗 10~15%/.test(core);
    check('三档抗损坏文案为"稳定区间"口径，且 embed.html 与内核 REDUNDANCY_LABEL 一致',
      hasStable && labelOk,
      `embed 三档=${hasStable}；内核标签=${labelOk}`);
  }

  // 3) 传输方式警告（本工具最关键的注意事项）
  {
    const embed = readIf('embed.html') || '';
    const hasWarn = /必须通过"原图\/文件"方式传输/.test(embed) &&
      /不要用微信\/QQ 的普通发送/.test(embed);
    const hasPanel = /id="channelPanel"/.test(embed) && /推荐传输方式/.test(embed) &&
      /发送原图/.test(embed) && /朋友圈/.test(embed) && /截图后再发/.test(embed) &&
      /图片编辑器/.test(embed);
    const idx = readIf('index.html') || '';
    const idxWarn = /原图\/文件/.test(idx) && /普通发送/.test(idx);
    const ext = readIf('extract.html') || '';
    const extWarn = /原图\/文件/.test(ext) && /平台压缩/.test(ext);
    check('传输方式警告齐全：embed 分享提示 + 推荐传输方式折叠说明 + 首页警告 + 提取页提醒',
      hasWarn && hasPanel && idxWarn && extWarn,
      `embed 分享提示=${hasWarn}；折叠说明与清单=${hasPanel}；首页=${idxWarn}；提取页=${extWarn}`);
  }

  // 4) 首页面向公众化：Hero / 三栏卡片 / 三步 / 警告 / FAQ
  {
    const idx = readIf('index.html') || '';
    const text = visibleText(idx);
    const hero = /<h1[^>]*>图片隐写工具<\/h1>/.test(idx) && /不上传任何服务器/.test(text);
    const cards = (idx.match(/<ul class="features">[\s\S]*?<\/ul>/g) || []).length === 1 &&
      (idx.match(/<li>/g) || []).length >= 3;
    const steps = /<ol class="steps">/.test(idx) && /怎么用/.test(text);
    const warn = /warnbox/.test(idx) && /注意事项/.test(text);
    const faq = /id="faq"/.test(idx) && /常见问题/.test(text) &&
      (idx.match(/<summary>Q：/g) || []).length >= 5;
    const footer = /原本|GitHub/.test(text) && /GPL-3\.0/.test(text);
    check('index.html 面向公众化：Hero + 三栏卡片 + 三步图 + 警告区 + 5 条 FAQ + 页脚（GitHub/协议）',
      hero && cards && steps && warn && faq && footer,
      `Hero=${hero}；三栏卡片=${cards}；三步=${steps}；警告区=${warn}；` +
      `FAQ 条数=${(idx.match(/<summary>Q：/g) || []).length}（≥5）=${faq}；页脚=${footer}`);
  }

  // 5) 开源项目必备文件
  {
    const readme = readIf('README.md');
    const secs = readme ? ['特性', '快速开始', '使用方法', '协议'].filter((k) => readme.indexOf(k) !== -1) : [];
    check('README.md 存在且含"特性 / 快速开始 / 使用方法 / 协议"四个小节',
      !!readme && secs.length === 4,
      readme ? `${readme.length} 字符；命中小节=[${secs.join(', ')}]` : 'README.md 不存在');

    const lic = readIf('LICENSE');
    const gpl = !!lic && /GNU GENERAL PUBLIC LICENSE/.test(lic) && /Version 3, 29 June 2007/.test(lic);
    check('LICENSE 存在且为 GPL-3.0 全文（含 "GNU GENERAL PUBLIC LICENSE" 与 "Version 3, 29 June 2007"）',
      gpl, lic ? `${lic.length} 字符；GPL 头=${/GNU GENERAL PUBLIC LICENSE/.test(lic)}` : 'LICENSE 不存在');

    const p404 = readIf('404.html');
    const ok404 = !!p404 && /页面未找到/.test(p404) && /href="index\.html"/.test(p404) &&
      /href="embed\.html"/.test(p404) && /href="extract\.html"/.test(p404);
    check('404.html 存在，含"页面未找到"与首页/嵌入/提取三个入口', ok404,
      p404 ? `含提示=${/页面未找到/.test(p404)}；三入口=${/href="index\.html"/.test(p404)}/${/href="embed\.html"/.test(p404)}/${/href="extract\.html"/.test(p404)}` : '404.html 不存在');
  }

  // 6) 所有页面的 favicon 都是内联 SVG data URL，且页面间链接都是相对路径
  {
    const pages = ['index.html', 'embed.html', 'extract.html', 'tech.html', '404.html',
      'dev-test-suite.html', 'test-image-utils.html', 'test-stego-pipeline.html'];
    const missingFav = [];
    const extLinks = [];
    for (const rel of pages) {
      const s = readIf(rel);
      if (!s) { missingFav.push(rel + '(缺失)'); continue; }
      if (!/rel="icon"[^>]*href="data:image\/svg\+xml,/.test(s)) missingFav.push(rel);
      // 外部链接：允许 GitHub 占位符（<your-name> 形式），其余一律应为相对路径
      const urls = (s.match(/(?:href|src)="https?:\/\/[^"]+"/g) || [])
        .filter((u) => !/github\.com\/&lt;your-name&gt;/.test(u) && !/w3\.org/.test(u));
      if (urls.length) extLinks.push(`${rel}:[${urls.join(', ')}]`);
    }
    check(`全部 ${pages.length} 个页面都设置了内联 SVG favicon`, missingFav.length === 0,
      missingFav.length === 0 ? `${pages.length} 个页面均含 rel="icon" + data:image/svg+xml`
        : `缺少 favicon=[${missingFav.join(', ')}]`);
    check('页面间链接均为相对路径（无外部 http(s) 链接，GitHub 占位符除外）',
      extLinks.length === 0,
      extLinks.length === 0 ? '未发现外部 http(s) 链接' : `外部链接=[${extLinks.join(' ')}]`);
  }
}

{
  const libs = ['js/image-utils.js', 'js/dct-stego.js', 'js/packet.js', 'js/raptorq.js',
    'js/geo-calibration.js', 'js/stego-core.js', 'js/carrier-generator.js', 'js/test-suite.js'];
  // 允许的跨文件名字：确实由别处挂到全局、且以裸名被调用的（当前为空）
  const CROSS_FILE_ALLOW = new Set();
  const rows = [];
  let bad = 0;
  for (const f of libs) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const found = auditBareCalls(src, CROSS_FILE_ALLOW);
    if (found.length) { bad++; rows.push(`${f}: [${found.join(', ')}]`); }
  }
  check(`库文件（${libs.length} 个）内无未定义的裸函数调用`, bad === 0,
    bad === 0 ? `逐个审计：${libs.map((f) => f.replace('js/', '')).join('、')} 全部通过`
      : `可疑文件 ${bad} 个 → ${rows.join('；')}`);
}

// ============================================================
// 库文件源码约束：无 ESM、无 require、无外部 URL（保证 file:// 可直接打开）
// ============================================================
{
  const libs = ['js/image-utils.js', 'js/dct-stego.js', 'js/packet.js', 'js/raptorq.js',
    'js/geo-calibration.js', 'js/stego-core.js', 'js/carrier-generator.js', 'js/test-suite.js'];
  const rows = [];
  let bad = 0;
  for (const f of libs) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const esm = (code.match(/(^|\n)\s*(import|export)[\s({]/g) || []).length;
    const dyn = (code.match(/\bimport\s*\(/g) || []).length;
    const req = (code.match(/\brequire\s*\(/g) || []).length;
    const urls = (code.match(/https?:\/\//g) || []).length;
    if (esm || dyn || req || urls) {
      bad++;
      rows.push(`${f}: esm=${esm} 动态import=${dyn} require=${req} URL=${urls}`);
    }
  }
  check(`库文件（${libs.length} 个）无 ESM / 无 require / 无外部 URL`, bad === 0,
    bad === 0 ? `${libs.length} 个库文件全部满足零依赖约束` : rows.join('；'));
}

// ============================================================
// 审计器自检：能抓到真问题、且不被字符串/注释误判
// ============================================================
{
  const shouldCatch = auditBareCalls('function f(){ return clamp(x, 0, 1); }');
  const shouldNotCatch = auditBareCalls(
    "var s = 'rgba(0,0,0,.5)'; // clamp(1,2,3)\nvar p = makeIt(1);\nfunction makeIt(v){ return v; }");
  check('裸调用审计器自检：抓得到未定义调用，不误报字符串/注释里的内容',
    shouldCatch.indexOf('clamp') !== -1 && shouldNotCatch.length === 0,
    `未定义调用 → [${shouldCatch.join(', ')}]（期望含 clamp）；字符串+注释样本 → [${shouldNotCatch.join(', ')}]（期望为空）`);
}

// ============================================================
// 跨页面：术语隔离与跳转链路
// ============================================================
{
  const userPages = ['index.html', 'embed.html', 'extract.html'];
  const allHit = {};
  let clean = true;
  for (const f of userPages) {
    const text = visibleText(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const hits = findTerms(text, TERM_BLACKLIST);
    allHit[f] = hits;
    if (hits.length) clean = false;
  }
  check('黑名单汇总：index / embed / extract 三页均无术语（术语只能出现在 tech.html）', clean,
    userPages.map((f) => `${f}=${allHit[f].length ? '[' + allHit[f].join(',') + ']' : '干净'}`).join('；'));

  const techText = visibleText(fs.readFileSync(path.join(ROOT, 'tech.html'), 'utf8'));
  const techHits = findTerms(techText, TERM_BLACKLIST);
  check('tech.html 里确实承载了这些术语（说明技术内容真的迁过去了）', techHits.length >= 6,
    `tech.html 命中术语 ${techHits.length} 个：[${techHits.join(', ')}]`);
}
{
  // 检查器自检：故意造一段"可见文本含术语 + style/script 里也有术语"的假页面，
  // 确认该抓的抓得到、不该抓的（CSS 的 margin、JS 里的变量名）不误报 ——
  // 否则一旦提取逻辑写坏，就会出现"全绿但其实什么都没查"的假象。
  const fake = '<p>已嵌入 ' + 'K_effective' + ' 个数据块</p>' +
    '<style>.a { margin: 0 auto; }</style><script>var CRC = 1;</script>';
  const hits = findTerms(visibleText(fake), TERM_BLACKLIST);
  check('黑名单检查器自检：可见文本里的术语抓得到，style/script 里的不误报',
    hits.indexOf('K_effective') !== -1 && hits.indexOf('margin') === -1 && hits.indexOf('CRC') === -1,
    `命中=[${hits.join(', ')}]（期望只有 K_effective）`);
}
{
  // 跳转链路 index → embed → extract → tech 每一跳都存在
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const chain = [
    ['index.html', 'embed.html'],
    ['index.html', 'extract.html'],
    ['index.html', 'tech.html'],
    ['embed.html', 'extract.html'],
    ['embed.html', 'tech.html'],
    ['extract.html', 'tech.html'],
    ['tech.html', 'index.html'],
    ['tech.html', 'dev-test-suite.html']
  ];
  const bad = chain.filter(([from, to]) =>
    read(from).indexOf(`href="${to}"`) === -1 || !fs.existsSync(path.join(ROOT, to)));
  check('跳转链路完整：index → embed → extract → tech（并含 tech → test-suite）', bad.length === 0,
    bad.length === 0 ? `校验 ${chain.length} 条跳转全部有效`
      : `失效跳转=[${bad.map(([a, b]) => a + '→' + b).join(', ')}]`);
}
{
  // 三个面向用户的页面都必须有"了解技术原理 →"入口
  const missing = ['index.html', 'embed.html', 'extract.html']
    .filter((f) => !/href="tech\.html"[^>]*>了解技术原理/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('三个页面都有"了解技术原理"链接指向 tech.html（AC4）', missing.length === 0,
    missing.length === 0 ? 'index / embed / extract 均含该链接' : `缺失=[${missing.join(', ')}]`);
}
{
  // 测试页已降级为开发者工具：三个面向用户的页面里不许再出现指向它的链接或导航项
  const rows = [];
  let clean = true;
  for (const f of ['index.html', 'embed.html', 'extract.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const linkRefs = (html.match(/href="(?:dev-)?test-suite\.html"/g) || []).length;
    const navRefs = (html.match(/<nav[\s\S]*?<\/nav>/g) || [])
      .join(' ').indexOf('test-suite') !== -1;
    if (linkRefs || navRefs) clean = false;
    rows.push(`${f}: 链接 ${linkRefs} 处、导航出现测试页=${navRefs}`);
  }
  check('index/embed/extract 均不含指向开发者测试页的链接或导航项（AC2）', clean, rows.join('；'));
}

const total = results.length;
const passed = total - failures;
console.log('\n============================================');
console.log(`页面检查：${passed}/${total} 通过，失败 ${failures}`);
console.log('============================================');
process.exit(failures === 0 ? 0 : 1);
