/**
 * verify-test-suite.structure.node.js —— js/test-suite.js 结构与干跑自测
 * （Node，零第三方依赖）
 *
 * 第一部分（结构）：window.TestSuite 契约、TEST_GROUPS 分组与 36 个用例注册、
 *   每个用例的 name/degrade 是否齐备、runGroup 的分组校验。
 * 第二部分（干跑）：在没有浏览器的 Node 里，用 canvas 垫片 + JPEG 量化替身
 *   把 36 个用例真的跑一遍，校验返回结构 { name, pass, elapsedMs, detail }，
 *   并把结果表打印出来，作为"浏览器实机运行前的预演"。
 *
 * 注意：干跑用的是垫片，不能替代实机验收 ——
 *   · JPEG 用 DCT 量化替身（真实浏览器走 canvas.toBlob，行为更接近真 JPEG）
 *   · 缩放用最近邻（浏览器是双线性/高质量平滑）
 *   · 文字水印用矩形近似（浏览器是真字体光栅化）
 *   但"全局几何改变会破坏 Tile 网格"这类结论与实现无关，干跑结论是可靠的。
 *
 * 运行： node tests/verify-test-suite.structure.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// 依赖按浏览器 script 顺序加载
require('./dom-shim.js');
['image-utils.js', 'dct-stego.js', 'packet.js', 'raptorq.js', 'geo-calibration.js', 'stego-core.js', 'test-suite.js']
  .forEach((f) => require(path.join(ROOT, 'js', f)));

const { simulateJpegRoundTrip } = require('./jpeg-sim.js');
const { encodeJpeg } = require('./jpeg-encode.js');
const TS = global.TestSuite;

// v2 干跑需要两个替身：
//   ① 秘密图编码器（浏览器里是 canvas.toDataURL，Node 里用真 JPEG 编码器）
//   ② 退化用的 JPEG 重编码器（浏览器里是 canvas.toBlob）
global.__STEGO_JPEG_ENCODE__ = function (imageData, quality01, keepColor) {
  return encodeJpeg(imageData, Math.round(quality01 * 100), keepColor);
};

const results = [];
let failures = 0;

function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}\n        ${detail}`);
}

function assertThrows(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

console.log('=== test-suite.js 结构与干跑自测（Node ' + process.version + '）===\n');

// ============================================================
// 1) 命名空间与函数签名
// ============================================================
{
  const contract = { runAll: 2, runGroup: 3 };
  const missing = Object.keys(contract).filter((k) => typeof TS[k] !== 'function');
  const arityBad = Object.keys(contract).filter((k) => typeof TS[k] === 'function' &&
    TS[k].length !== contract[k]).map((k) => `${k}(期望${contract[k]},实际${TS[k].length})`);
  check('S1', 'window.TestSuite 存在，runAll(onProgress,onResult) / runGroup(groupId,onProgress,onResult) 形参一致',
    !!TS && missing.length === 0 && arityBad.length === 0,
    `可用键=[${TS ? Object.keys(TS).join(', ') : '无'}]；缺失=[${missing.join(', ')}]；形参不符=[${arityBad.join(', ')}]`);
}

// ============================================================
// 2) TEST_GROUPS 分组与用例注册
// ============================================================
{
  const groups = TS && TS.TEST_GROUPS;
  const expected = { baseline: 7, blackout: 5, crop: 4, watermark: 4, capacity: 5, resync: 11 };
  const ids = Array.isArray(groups) ? groups.map((g) => g.id) : [];
  const counts = {};
  if (Array.isArray(groups)) groups.forEach((g) => { counts[g.id] = g.tests.length; });
  const countsOk = Object.keys(expected).every((k) => counts[k] === expected[k]);
  check('S2', 'TEST_GROUPS 共 6 组，且 baseline=7 / blackout=5 / crop=4 / watermark=4 / capacity=5 / resync=11',
    Array.isArray(groups) && groups.length === 6 && countsOk,
    `分组=[${ids.join(', ')}]；各组用例数=${JSON.stringify(counts)}；期望=${JSON.stringify(expected)}`);
}
{
  const groups = TS.TEST_GROUPS;
  const all = [];
  groups.forEach((g) => g.tests.forEach((t) => all.push(t)));
  const wantIds = [];
  for (let i = 1; i <= 36; i++) wantIds.push('T' + i);
  const gotIds = all.map((t) => t.id);
  const idsOk = gotIds.length === 36 && wantIds.every((id, i) => gotIds[i] === id);
  const nameBad = all.filter((t) => typeof t.name !== 'string' || t.name.trim() === '')
    .map((t) => t.id || '(无 id)');
  const degradeBad = all.filter((t) => typeof t.degrade !== 'function' && typeof t.custom !== 'function')
    .map((t) => t.id);
  const groupsOk = groups.every((g) => typeof g.name === 'string' && g.name.trim() !== '');
  check('S3', '36 个用例按 T1~T36 顺序注册，每个都有非空 name 且带 degrade 或 custom',
    idsOk && nameBad.length === 0 && degradeBad.length === 0 && groupsOk,
    `用例数=${all.length}；名称为空=[${nameBad.join(', ')}]；` +
    `既无 degrade 也无 custom=[${degradeBad.join(', ')}]；分组名齐全=${groupsOk}`);
}
{
  const badGroup = assertThrows(() => TS.runGroup('nope'));
  check('S4', 'runGroup 对未知分组抛 RangeError（分组校验有效）',
    badGroup instanceof RangeError && /baseline/.test(badGroup.message),
    `runGroup('nope') → ${badGroup && badGroup.constructor.name}："${badGroup && badGroup.message}"`);
}

// ============================================================
// 3) 干跑：真的把 36 个用例跑一遍（垫片 + JPEG 替身）
// ============================================================
global.__TEST_SUITE_JPEG_ROUNDTRIP__ = function (imageData, quality) {
  // 浏览器 canvas.toBlob 的质量刻度是 0~1，而 JPEG 量化模拟器用 1~100，这里要换算
  var q = quality <= 1 ? Math.round(quality * 100) : quality;
  return simulateJpegRoundTrip(imageData, q);
};

const progressLog = [];
const liveResults = [];

TS.runAll(
  (cur, total, name) => { progressLog.push(`${cur}/${total} ${name}`); },
  (r) => { liveResults.push(r); }
).then((all) => {
  console.log('\n--- 干跑结果（Node 垫片 + JPEG 量化替身）---');
  console.log('序号 | 用例 | 结果 | 耗时(ms) | 备注');
  all.forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)} | ${r.id} | ${r.pass ? 'PASS' : 'FAIL'} | ` +
      `${String(r.elapsedMs).padStart(8)} | ${r.detail}`);
  });

  // 结构校验：返回结构必须符合契约
  const shapeBad = all.filter((r) =>
    typeof r.name !== 'string' || r.name === '' ||
    typeof r.pass !== 'boolean' ||
    typeof r.elapsedMs !== 'number' || !isFinite(r.elapsedMs) ||
    typeof r.detail !== 'string' || r.detail === ''
  ).map((r) => r.id || r.name);
  check('S5', 'runAll 返回 36 条结果，每条均为 { name, pass, elapsedMs, detail } 结构',
    all.length === 36 && shapeBad.length === 0,
    `返回 ${all.length} 条；结构不符=[${shapeBad.join(', ')}]；` +
    `示例=${JSON.stringify({ name: all[0].name, pass: all[0].pass, elapsedMs: all[0].elapsedMs, detail: all[0].detail.slice(0, 40) + '…' })}`);

  // 逐条回调 + 进度回调（要求"每个测试完成后立即更新"，这里验证回调确实按序触发）
  const liveOk = liveResults.length === 36 && liveResults.every((r, i) => r.id === all[i].id);
  const progOk = progressLog.length === 36 && /^1\/36 /.test(progressLog[0]) && /^36\/36 /.test(progressLog[35]);
  check('S6', 'onProgress 与 onResult 均逐条触发（36 次，顺序一致）',
    liveOk && progOk,
    `onResult 次数=${liveResults.length}（顺序一致=${liveOk}）；onProgress 次数=${progressLog.length}；` +
    `首条="${progressLog[0]}"；末条="${progressLog[35]}"`);

  // 单独跑一组
  return TS.runGroup('crop').then((cropRes) => {
    check('S7', "runGroup('crop') 只跑 4 个裁切用例",
      cropRes.length === 4 && cropRes.every((r) => r.group === 'crop'),
      `返回 ${cropRes.length} 条：[${cropRes.map((r) => r.id + '=' + (r.pass ? 'PASS' : 'FAIL')).join(', ')}]`);

    // 异常隔离：注入一个必定抛错的用例，验证不中断后续测试
    const group = TS.TEST_GROUPS.find((g) => g.id === 'crop');
    const first = group.tests[0];
    const origDegrade = first.degrade;
    first.degrade = function () { throw new Error('注入的故意异常'); };
    return TS.runGroup('crop').then((errRes) => {
      first.degrade = origDegrade;
      const firstFailed = errRes[0].pass === false && typeof errRes[0].errorMsg === 'string';
      const restRan = errRes.length === 4;
      check('S8', '单个用例抛异常时记为 FAIL 且不中断后续用例（errorMsg 已填充）',
        firstFailed && restRan,
        `首条 pass=${errRes[0].pass}, errorMsg="${errRes[0].errorMsg}"；` +
        `整组仍返回 ${errRes.length} 条；后续用例=${errRes.slice(1).map((r) => r.id + '=' + (r.pass ? 'PASS' : 'FAIL')).join(', ')}`);
      finish(all);
    });
  });
}).catch((err) => {
  check('S5', 'runAll 干跑完成', false, '干跑异常：' + err.message);
  finish([]);
});

function finish(all) {
  // ==== 临时诊断：JPEG 退化下到底发生了什么 ====
  if (process.argv.indexOf('--diag') >= 0) {
    const SC = global.StegoCore;
    const DCT = global.DctStego;
    const IU = global.ImageUtils;
    const { simulateJpegRoundTrip } = require('./jpeg-sim.js');
    const TILE = 64, N = 512;

    function makeCarrier(gray) {
      const img = new global.ImageData(N, N);
      const rng = (function (seed) {
        let a = seed >>> 0;
        return function () {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), 1 | t);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return (t ^ (t >>> 14)) >>> 0;
        };
      })(20240601);
      for (let i = 0; i < N * N; i++) {
        const o = i * 4;
        const v = rng() >>> 24;
        img.data[o] = v;
        img.data[o + 1] = gray ? v : (rng() >>> 24);
        img.data[o + 2] = gray ? v : (rng() >>> 24);
        img.data[o + 3] = 255;
      }
      return img;
    }
    function makeSecret() {
      const s = 16;
      const img = new global.ImageData(s, s);
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        let v = ((((x >> 1) + (y >> 1)) & 1) === 1) ? 235 : 20;
        if (((x + y) & 7) < 2) v = v > 128 ? 70 : 190;
        const o = (y * s + x) * 4;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
      }
      return img;
    }
    function report(tag, carrier, degrade) {
      const stego = SC.embedSecret(carrier, makeSecret()).outputImageData;
      const deg = degrade ? degrade(stego) : stego;
      const res = SC.extractSecret(deg);
      // 逐 Tile 比对比特，算出比特错误率
      const tA = IU.splitIntoTiles(stego, TILE), tB = IU.splitIntoTiles(deg, TILE);
      let bits = 0, bitErr = 0, diffTiles = 0, checked = 0;
      for (let i = 0; i < tA.length && i < tB.length; i++) {
        if (tA[i].width !== TILE || tA[i].height !== TILE) continue;
        if (tB[i].width !== TILE || tB[i].height !== TILE) continue;
        const b1 = DCT.extractBitsFromTile(tA[i].data, 192);
        const b2 = DCT.extractBitsFromTile(tB[i].data, 192);
        let d = 0;
        for (let k = 0; k < 192; k++) if (b1[k] !== b2[k]) d++;
        bits += 192; bitErr += d;
        if (d > 0) diffTiles++;
        checked++;
      }
      console.log(`${tag}: validTiles=${res.validTiles}/${res.totalTiles}, K_eff=${res.K_effective}, ` +
        `success=${res.success}；逐 Tile 比特错误 ${bitErr}/${bits} = ${(bitErr / bits * 100).toFixed(3)}%，` +
        `含错 Tile ${diffTiles}/${checked}`);
    }

    console.log('\n===== 临时诊断：JPEG 与载体色彩 =====');    report('RGB 载体 + 无退化      ', makeCarrier(false), null);
    report('灰度载体 + 无退化      ', makeCarrier(true), null);
    report('RGB 载体 + JPEG q=0.95 ', makeCarrier(false), (s) => simulateJpegRoundTrip(s, 95));
    report('灰度载体 + JPEG q=0.95 ', makeCarrier(true), (s) => simulateJpegRoundTrip(s, 95));
    report('灰度载体 + JPEG q=0.85 ', makeCarrier(true), (s) => simulateJpegRoundTrip(s, 85));
    report('灰度载体 + JPEG q=0.75 ', makeCarrier(true), (s) => simulateJpegRoundTrip(s, 75));

    // ---- 诊断 2：缩放退化是否"信息可恢复"（用面积平均降采样 + 双线性升采样还原几何）----
    function boxDown(img, w2, h2) {
      const out = new global.ImageData(w2, h2);
      const sx = img.width / w2, sy = img.height / h2;
      for (let y = 0; y < h2; y++) {
        for (let x = 0; x < w2; x++) {
          const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.ceil((x + 1) * sx));
          const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.ceil((y + 1) * sy));
          let r = 0, g = 0, b = 0, n = 0;
          for (let yy = y0; yy < y1; yy++) {
            for (let xx = x0; xx < x1; xx++) {
              const o = (yy * img.width + xx) * 4;
              r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
            }
          }
          const o2 = (y * w2 + x) * 4;
          out.data[o2] = Math.round(r / n);
          out.data[o2 + 1] = Math.round(g / n);
          out.data[o2 + 2] = Math.round(b / n);
          out.data[o2 + 3] = 255;
        }
      }
      return out;
    }
    function bilinearUp(img, w2, h2) {
      const out = new global.ImageData(w2, h2);
      for (let y = 0; y < h2; y++) {
        for (let x = 0; x < w2; x++) {
          const fx = (x + 0.5) * img.width / w2 - 0.5;
          const fy = (y + 0.5) * img.height / h2 - 0.5;
          const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy));
          const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
          const dx = Math.min(1, Math.max(0, fx - x0)), dy = Math.min(1, Math.max(0, fy - y0));
          const o2 = (y * w2 + x) * 4;
          for (let c = 0; c < 3; c++) {
            const p00 = img.data[(y0 * img.width + x0) * 4 + c];
            const p10 = img.data[(y0 * img.width + x1) * 4 + c];
            const p01 = img.data[(y1 * img.width + x0) * 4 + c];
            const p11 = img.data[(y1 * img.width + x1) * 4 + c];
            const top = p00 + (p10 - p00) * dx, bot = p01 + (p11 - p01) * dx;
            out.data[o2 + c] = Math.round(top + (bot - top) * dy);
          }
          out.data[o2 + 3] = 255;
        }
      }
      return out;
    }
    console.log('\n===== 临时诊断：缩放后按原尺寸升采样还原几何，能否解出 =====');
    report('0.75 缩放到 384 后升回 512', makeCarrier(false), (s) => bilinearUp(boxDown(s, 384, 384), 512, 512));
    report('0.50 缩放到 256 后升回 512', makeCarrier(false), (s) => bilinearUp(boxDown(s, 256, 256), 512, 512));
    report('JPEG q=0.85 + 0.75 缩放后升回', makeCarrier(false),
      (s) => bilinearUp(boxDown(simulateJpegRoundTrip(s, 85), 384, 384), 512, 512));
  }

  const passed = all.filter((r) => r.pass).length;
  const failed = all.length - passed;
  console.log('\n--- 干跑统计 ---');
  console.log(`共 ${all.length} 条：PASS ${passed}，FAIL ${failed}，总耗时 ` +
    `${all.reduce((s, r) => s + r.elapsedMs, 0).toFixed(1)} ms`);
  const byGroup = {};
  all.forEach((r) => {
    byGroup[r.group] = byGroup[r.group] || { pass: 0, total: 0 };
    byGroup[r.group].total++;
    if (r.pass) byGroup[r.group].pass++;
  });
  console.log('分组：' + Object.keys(byGroup)
    .map((g) => `${g}=${byGroup[g].pass}/${byGroup[g].total}`).join('  '));

  // 干跑结果只作为预演证据，不作为 Node 侧的硬性断言（实机验收才是判定标准）
  console.log('\n注：以上为 Node 垫片下的预演结果，最终结论以浏览器内 dev-test-suite.html 实机运行为准。');

  const total = results.length;
  const ok = total - failures;
  console.log('\n============================================');
  console.log(`结构与流程检查：${ok}/${total} 通过，失败 ${failures}`);
  console.log('============================================');
  process.exit(failures === 0 ? 0 : 1);
}
