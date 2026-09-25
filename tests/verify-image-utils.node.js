/**
 * verify-image-utils.node.js —— 零依赖自测脚本（Node.js 运行）
 *
 * 目的：在没有浏览器的环境下验证 js/image-utils.js 的核心几何 / 数值逻辑。
 * 做法：垫片（shim）位于 tests/dom-shim.js，只实现 canvas / 2D 上下文 / ImageData。
 *       不引入任何 npm 包，符合项目「零外部依赖」约束。
 *
 * 运行： node tests/verify-image-utils.node.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// 1. 最小 DOM / Canvas 垫片
//    已抽到 tests/dom-shim.js，与 dct-stego 测试共用同一份实现
// ============================================================
const { ImageDataShim, CanvasShim } = require('./dom-shim.js');

// ============================================================
// 2. 载入被测库
// ============================================================
const LIB_PATH = path.join(__dirname, '..', 'js', 'image-utils.js');
require(LIB_PATH);
const IU = global.ImageUtils;
if (!IU) {
  console.error('致命错误：window.ImageUtils 未定义');
  process.exit(1);
}

// ============================================================
// 3. 测试工具
// ============================================================
const results = [];
let failures = 0;

function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  if (!pass) failures++;
  const flag = pass ? 'PASS' : 'FAIL';
  console.log(`[${flag}] ${id} ${name}\n        ${detail}`);
}

function assertThrows(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

function makeImageData(w, h, fillFn) {
  const img = new ImageDataShim(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const px = fillFn(x, y);
      img.data[o] = px[0];
      img.data[o + 1] = px[1];
      img.data[o + 2] = px[2];
      img.data[o + 3] = px.length > 3 ? px[3] : 255;
    }
  }
  return img;
}

function fmt(n) {
  return typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(6)) : String(n);
}

console.log('=== image-utils.js 自测（Node ' + process.version + ' + tests/dom-shim.js）===\n');

// ------------------------------------------------------------
// 契约检查：window.ImageUtils 上的函数名与形参个数必须完全一致
// ------------------------------------------------------------
{
  const contract = {
    loadImage: 1,               // (file)
    getImageData: 1,            // (image)
    resizeImage: 2,             // (image, maxLongSide)
    imageDataToFloatArray: 1,   // (imageData)
    floatArrayToImageData: 3,   // (floatArray, width, height)
    splitIntoTiles: 2,          // (imageData, tileSize = 64)
    calculateTileVariance: 1,   // (tile)
    filterTexturedTiles: 2,     // (tiles, threshold)
    canvasToBlob: 3,            // (canvas, type = 'image/png', quality = 0.92)
    downloadBlob: 2             // (blob, filename)
  };
  const keys = Object.keys(IU).sort();
  const want = Object.keys(contract).sort();
  const missing = want.filter((k) => typeof IU[k] !== 'function');
  const extra = keys.filter((k) => want.indexOf(k) === -1);
  const arityBad = want.filter((k) => typeof IU[k] === 'function' && IU[k].length !== contract[k])
    .map((k) => `${k}(期望${contract[k]}个形参,实际${IU[k].length})`);
  check('AC0', 'window.ImageUtils 恰好暴露契约中的 10 个函数，形参个数一致',
    missing.length === 0 && extra.length === 0 && arityBad.length === 0,
    `实际键=[${keys.join(', ')}]；缺失=[${missing.join(', ')}]；多余=[${extra.join(', ')}]；形参不符=[${arityBad.join(', ')}]`);
}

// ------------------------------------------------------------
// 验收 1：纯色 128x128 -> 4 个 64x64 Tile，方差全为 0
// ------------------------------------------------------------
{
  const solid = makeImageData(128, 128, () => [120, 80, 200, 255]);
  const tiles = IU.splitIntoTiles(solid, 64);
  const sizes = tiles.map((t) => `${t.width}x${t.height}`).join(', ');
  const vars = tiles.map((t) => IU.calculateTileVariance(t));
  const sizeOk = tiles.length === 4 && tiles.every((t) => t.width === 64 && t.height === 64);
  const varOk = vars.every((v) => v === 0);
  check('AC1', '纯色 128x128 + tileSize=64 → 4 个 64x64 Tile，方差全 0', sizeOk && varOk,
    `Tile 总数=${tiles.length}；尺寸=[${sizes}]；方差=[${vars.map(fmt).join(', ')}]`);
}

// ------------------------------------------------------------
// 验收 2：左右半边不同灰度 128x128 -> 方差显著大于 0
// ------------------------------------------------------------
{
  const half = makeImageData(128, 128, (x) => (x < 64 ? [50, 50, 50] : [200, 200, 200]));
  // 2a：整图作为一个 Tile（tileSize=128）时方差应为 ((50-125)^2+(200-125)^2)/2 = 5625
  const wholeTiles = IU.splitIntoTiles(half, 128);
  const wholeVar = IU.calculateTileVariance(wholeTiles[0]);
  // 2b：直接拿整幅 ImageData 当成一个 tile 计算
  const directVar = IU.calculateTileVariance({ x: 0, y: 0, width: 128, height: 128, data: half });
  const expect = 5625;
  const ok = wholeTiles.length === 1 && Math.abs(wholeVar - expect) < 1e-3 &&
             Math.abs(directVar - expect) < 1e-3;
  check('AC2', '左右半边灰度 50/200 的 128x128 → 方差 = 5625（>0）', ok,
    `tileSize=128 时 Tile 总数=${wholeTiles.length}；整体方差=${fmt(wholeVar)}（理论值 ${expect}）；` +
    `直接计算=${fmt(directVar)}；tileSize=64 时各 Tile 方差=[${IU.splitIntoTiles(half, 64).map((t) => fmt(IU.calculateTileVariance(t))).join(', ')}]（左右边界恰好对齐，故为 0，符合预期）`);
}

// ------------------------------------------------------------
// 验收 3：100x70 + tileSize=64 -> 4 个 Tile，尺寸依次 64x64,36x64,64x6,36x6
// ------------------------------------------------------------
{
  const img = makeImageData(100, 70, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]);
  const tiles = IU.splitIntoTiles(img, 64);
  const got = tiles.map((t) => `${t.width}x${t.height}`);
  const want = ['64x64', '36x64', '64x6', '36x6'];
  const posOk = tiles[0].x === 0 && tiles[0].y === 0 &&
                tiles[1].x === 64 && tiles[1].y === 0 &&
                tiles[2].x === 0 && tiles[2].y === 64 &&
                tiles[3].x === 64 && tiles[3].y === 64;
  const dataOk = tiles.every((t) => t.data.width === t.width && t.data.height === t.height &&
                                     t.data.data.length === t.width * t.height * 4);
  // 抽查：tile(64,64) 的局部像素应等于原图 (64,64) 处像素
  const t3 = tiles[3];
  const local0 = [t3.data.data[0], t3.data.data[1], t3.data.data[2], t3.data.data[3]];
  const origin = [(64) % 256, (64) % 256, (128) % 256, 255];
  const sampleOk = local0.every((v, i) => v === origin[i]);
  check('AC3', '100x70 + tileSize=64 → 4 个 Tile，尺寸 64x64,36x64,64x6,36x6', 
    tiles.length === 4 && got.join(',') === want.join(',') && posOk && dataOk && sampleOk,
    `Tile 总数=${tiles.length}；实际尺寸=[${got.join(', ')}]；期望=[${want.join(', ')}]；` +
    `坐标=[${tiles.map((t) => `(${t.x},${t.y})`).join(' ')}]；局部 ImageData 尺寸校验=${dataOk}；` +
    `像素原点抽查 tile(64,64)[0]=[${local0.join(',')}] 期望=[${origin.join(',')}]`);
}

// ------------------------------------------------------------
// 验收 4：Float 数组往返误差 <= 1
// ------------------------------------------------------------
{
  const w = 37, h = 23;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
  const src = makeImageData(w, h, () => [rand(), rand(), rand(), rand()]);
  const f = IU.imageDataToFloatArray(src);
  const back = IU.floatArrayToImageData(f, w, h);
  let maxDiff = 0, over1 = 0, sumDiff = 0;
  for (let i = 0; i < src.data.length; i++) {
    const d = Math.abs(src.data[i] - back.data[i]);
    if (d > maxDiff) maxDiff = d;
    if (d > 1) over1++;
    sumDiff += d;
  }
  const inRange = f.every((v) => v >= 0 && v <= 1);
  const sizeOk = f.length === w * h * 4 && back.width === w && back.height === h;
  check('AC4', 'imageDataToFloatArray ↔ floatArrayToImageData 往返误差 <= 1',
    maxDiff <= 1 && over1 === 0 && inRange && sizeOk,
    `尺寸 ${w}x${h}；浮点数组长度=${f.length}（期望 ${w * h * 4}）且全部落在 0~1=${inRange}；` +
    `最大误差=${maxDiff}；平均误差=${fmt(sumDiff / src.data.length)}；误差>1 的通道数=${over1}`);
}

// ------------------------------------------------------------
// 验收 5：源码中不得出现 import / export
// ------------------------------------------------------------
{
  const code = fs.readFileSync(LIB_PATH, 'utf8');
  const esmImport = (code.match(/(^|\n)[ \t]*import[\s(]/g) || []).length;
  const esmExport = (code.match(/(^|\n)[ \t]*export[\s{]/g) || []).length;
  const dynamicImport = (code.match(/\bimport\s*\(/g) || []).length;
  const requireCall = (code.match(/\brequire\s*\(/g) || []).length;
  const scriptTag = (code.match(/<script/gi) || []).length;
  const ok = esmImport === 0 && esmExport === 0 && dynamicImport === 0 &&
             requireCall === 0 && scriptTag === 0;
  check('AC5', '源码无 import/export（非 ES Module，可 file:// 直接运行）', ok,
    `静态 import=${esmImport}；静态 export=${esmExport}；动态 import()=${dynamicImport}；` +
    `require()=${requireCall}；HTML 标签残留=${scriptTag}；文件行数=${code.split('\n').length}`);
}

// ------------------------------------------------------------
// 附加边界用例（超出验收标准，用于确认健壮性）
// ------------------------------------------------------------
console.log('\n--- 附加边界用例 ---');
{
  const e1 = assertThrows(() => IU.splitIntoTiles(null, 64));
  const e2 = assertThrows(() => IU.splitIntoTiles(makeImageData(8, 8, () => [0, 0, 0, 255]), 0));
  const e3 = assertThrows(() => IU.splitIntoTiles(makeImageData(8, 8, () => [0, 0, 0, 255]), NaN));
  check('E1', '非法输入抛明确错误（imageData=null / tileSize=0 / tileSize=NaN）',
    e1 instanceof TypeError && e2 instanceof RangeError && e3 instanceof RangeError,
    `null → ${e1 && e1.constructor.name}: ${e1 && e1.message}；tileSize=0 → ${e2 && e2.constructor.name}；tileSize=NaN → ${e3 && e3.constructor.name}`);
}
{
  // 空图像（0x0）与 tileSize 大于图像尺寸
  const empty = new ImageDataShim(0, 0);
  const t0 = IU.splitIntoTiles(empty, 64);
  const big = IU.splitIntoTiles(makeImageData(100, 70, () => [10, 20, 30, 255]), 4096);
  const zeroTileVar = IU.calculateTileVariance({ width: 0, height: 0, data: new ImageDataShim(0, 0) });
  check('E2', '空图像返回空数组；tileSize > 尺寸时返回 1 个完整 Tile；空 Tile 方差为 0',
    t0.length === 0 && big.length === 1 && big[0].width === 100 && big[0].height === 70 && zeroTileVar === 0,
    `0x0 图 → ${t0.length} 个 Tile；100x70 + tileSize=4096 → ${big.length} 个 Tile（${big[0].width}x${big[0].height}）；空 Tile 方差=${zeroTileVar}`);
}
{
  // filterTexturedTiles 行为 + 方差边界
  const half = makeImageData(128, 128, (x) => (x < 64 ? [50, 50, 50] : [200, 200, 200]));
  const tiles = IU.splitIntoTiles(half, 64); // 4 个纯色 Tile，方差均 0
  const mixed = tiles.concat([{ x: 0, y: 0, width: 128, height: 128, data: half }]);
  const all = IU.filterTexturedTiles(mixed, 0);
  const filtered = IU.filterTexturedTiles(mixed, 200);
  const notArray = IU.filterTexturedTiles(null, 10);
  const badThreshold = IU.filterTexturedTiles(mixed, NaN);
  check('E3', 'filterTexturedTiles：阈值 0 全通过、阈值 200 只留高方差、非数组返回空、NaN 阈值按 0',
    all.length === 5 && filtered.length === 1 && filtered[0].width === 128 &&
    notArray.length === 0 && badThreshold.length === 5,
    `输入 5 个 Tile（4 个方差 0 + 1 个方差 5625）；threshold=0 → ${all.length}；threshold=200 → ${filtered.length}（方差 ${fmt(IU.calculateTileVariance(filtered[0] || { data: { data: [] }, width: 0, height: 0 }))}）；null 输入 → ${notArray.length}；NaN 阈值 → ${badThreshold.length}`);
}
{
  // NaN / 越界浮点防护
  const f = new Float32Array([NaN, Infinity, -Infinity, 0.5, -3, 999, 1 / 3, 1]);
  const img = IU.floatArrayToImageData(f, 2, 1);
  const got = Array.from(img.data);
  const noNaN = got.every((v) => Number.isFinite(v) && v >= 0 && v <= 255);
  const e = assertThrows(() => IU.floatArrayToImageData(new Float32Array(4), 2, 2));
  const e2 = assertThrows(() => IU.floatArrayToImageData(new Float32Array(16), 0, 0));
  // 越界归一化输入：必须被 clamp 到 [0,1] 后再 ×255
  const clampCase = IU.floatArrayToImageData(new Float32Array([0, 1.5, -2, 0.5]), 1, 1);
  const clampGot = Array.from(clampCase.data);
  const clampExpected = [0, 255, 0, 128]; // 1.5→1→255；-2→0→0；0.5→127.5→128
  const clampOk = clampGot.every((v, i) => v === clampExpected[i]);
  check('E4', '浮点 NaN/Infinity/越界被安全处理；越界归一化输入 clamp 到 255 / 0；长度不足与非法尺寸抛错',
    noNaN && clampOk && e instanceof RangeError && e2 instanceof RangeError,
    `[NaN,Inf,-Inf,0.5,-3,999,0.333,1] → [${got.join(', ')}]（全部有限且 0~255=${noNaN}）；` +
    `越界输入 [0,1.5,-2,0.5] → [${clampGot.join(',')}]（期望 [${clampExpected.join(',')}]，${clampOk ? '一致' : '不一致'}）；` +
    `长度不足 → ${e && e.constructor.name}；尺寸 0x0 → ${e2 && e2.constructor.name}`);
}
{
  // 归一化往返：纯黑/纯白
  const black = makeImageData(4, 4, () => [0, 0, 0, 255]);
  const white = makeImageData(4, 4, () => [255, 255, 255, 255]);
  const fb = IU.imageDataToFloatArray(black);
  const fw = IU.imageDataToFloatArray(white);
  const rb = IU.floatArrayToImageData(fb, 4, 4);
  const rw = IU.floatArrayToImageData(fw, 4, 4);
  const okB = Array.from(rb.data).every((v, i) => v === black.data[i]);
  const okW = Array.from(rw.data).every((v, i) => v === white.data[i]);
  check('E5', '归一化语义在纯黑/纯白图上不会退化（往返完全一致）',
    okB && okW && fw[0] === 1 && fb[0] === 0,
    `纯黑 float[0]=${fb[0]} → 往返一致=${okB}；纯白 float[0]=${fw[0]} → 往返一致=${okW}`);
}
{
  // canvasToBlob 参数与错误分支（Node 无 toBlob/toDataURL）
  const p1 = IU.canvasToBlob(new CanvasShim()).then(() => 'resolved', (e) => e.constructor.name);
  const p2 = IU.canvasToBlob(null).then(() => 'resolved', (e) => e.constructor.name);
  const p3 = IU.canvasToBlob({ foo: 1 }).then(() => 'resolved', (e) => e.constructor.name);
  const d1 = assertThrows(() => IU.downloadBlob(null, 'x.png'));
  Promise.all([p1, p2, p3]).then(([r1, r2, r3]) => {
    check('E6', 'canvasToBlob / downloadBlob 对非法输入给出明确拒绝或抛错',
      r1 === 'Error' && r2 === 'TypeError' && r3 === 'TypeError' && d1 instanceof TypeError,
      `无导出能力的 canvas → reject(${r1})；null canvas → reject(${r2})；非 canvas 对象 → reject(${r3})；downloadBlob(null) → ${d1 && d1.constructor.name}`);
    finish();
  });
}

// ============================================================
// 4. 汇总
// ============================================================
function finish() {
  const total = results.length;
  const passed = total - failures;
  console.log('\n============================================');
  console.log(`总计 ${total} 项：通过 ${passed}，失败 ${failures}`);
  console.log('验收标准 AC1~AC5：' + results.filter((r) => r.id.startsWith('AC'))
    .map((r) => `${r.id}=${r.pass ? 'PASS' : 'FAIL'}`).join('  '));
  console.log('============================================');
  process.exit(failures === 0 ? 0 : 1);
}
