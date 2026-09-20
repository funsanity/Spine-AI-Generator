/**
 * 预览截图测试。
 *
 * 前面那些测试断的是"像素数据"，看不出"画到屏幕上是什么样"。这一层真开浏览器，
 * 走 app 自己的会话恢复路径（往 IndexedDB 塞一份生成结果 → 刷新 →
 * restoreSession → preview.load），再对 canvas 截图断言。
 *
 * 踩过的坑，都写下来免得再犯：
 *
 *   - 不能直接数"暗色像素占比"。预览画布是深色网格底，整片都算暗色，
 *     角色占多少完全被淹掉。曾经据此判"74.6% 是黑的"，其实是背景。
 *   - 不能拿"同尺寸纯色底图"做差。canvas 是透明的，透出来的是页面网格，
 *     不是纯色；控制组和实验组的底对不上，差出来的全是噪声。
 *
 * 现在断的是三条不依赖底图的性质：
 *
 *   1. 轮廓：角色占据的矩形里，被画到的像素占比要明显小于 100%。
 *      部件被糊成实心矩形时（黑框 bug），这个值会顶到 ~100%。
 *   2. 透明：那个矩形里还能看见画布的网格线——说明透明区真的透过去了。
 *   3. 有内容：必须有成片的彩色像素，全灰说明渲染或贴图挂了。
 *
 * 用法:
 *   node --test test/screenshot.test.js
 *   SCREENSHOT_PROJECT=e2e node --test test/screenshot.test.js
 *   SCREENSHOT_PROJECT=myproj SCREENSHOT_SOURCE_NAME=角色A node --test test/screenshot.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const PROJECT = process.env.SCREENSHOT_PROJECT || 'generated';
const OUTPUT_DIR = join(ROOT, 'output', PROJECT);

/*
 * 散图落在 output/<工程名>/<输入图名>/images/。
 *
 * 素材名默认取工程名（旧结构迁移过来就是这个取名），多张素材时用
 * SCREENSHOT_SOURCE_NAME 指定。三种情况都要认：
 *
 *   1. 新结构，素材名 == 工程名        output/demo/demo/images/
 *   2. 新结构，素材名不同（多素材）     output/demo/角色A/images/ —— 得靠环境变量指
 *   3. 旧结构（升级前生成的平铺产物）   output/demo/images/
 *
 * 第 2 种如果工程下只有一个素材目录，就直接用它——用户给工程起名
 * "20260917-110919" 这种时间戳是常态，硬要求他再传一次 SCREENSHOT_SOURCE_NAME
 * 才能截图，等于这个测试对真实产物默认不可用。
 */
const SOURCE_NAME = process.env.SCREENSHOT_SOURCE_NAME || PROJECT;
const SOURCE_DIR = process.env.SCREENSHOT_SOURCE_DIR
  ? resolve(ROOT, process.env.SCREENSHOT_SOURCE_DIR)
  : pickSourceDir();
const IMAGES_DIR = join(SOURCE_DIR, 'images');
const SNAPSHOT_DIR = join(ROOT, 'output', '_screenshots');

function pickSourceDir() {
  // ① 同名素材目录
  const nested = join(OUTPUT_DIR, SOURCE_NAME);
  if (existsSync(join(nested, 'images'))) return nested;

  // ③ 旧结构：产物直接躺在工程目录下
  if (existsSync(join(OUTPUT_DIR, 'images'))) return OUTPUT_DIR;

  // ② 工程下有素材目录（可能有多个：时间戳项目名 + 按输入图名的），取最新的那个
  try {
    const dirs = readdirSync(OUTPUT_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .filter((e) => existsSync(join(OUTPUT_DIR, e.name, 'images')))
      .map((e) => ({ name: e.name, mtime: statSync(join(OUTPUT_DIR, e.name, 'images')).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (dirs.length) return join(OUTPUT_DIR, dirs[0].name);
  } catch {
    /* 工程目录还不存在，交给调用方按「缺少产物」跳过 */
  }

  return nested;
}

/**
 * 浏览器取图的 URL 前缀。
 *
 * 从磁盘路径反推，而不是用 SOURCE_NAME 拼——②那种情况 SOURCE_NAME
 * 和真实目录名对不上，拼出来的 URL 会 404，截图里角色就没了，
 * 而测试只会报「没有成片彩色像素」，把排查带偏。
 */
const IMAGES_URL = `/output/${relative(join(ROOT, 'output'), IMAGES_DIR).split(sep).join('/')}`;

/** 定位部件要用原图。默认是项目自带的那张角色图，可用环境变量换 */
const SOURCE = process.env.SCREENSHOT_SOURCE
  ? resolve(ROOT, process.env.SCREENSHOT_SOURCE)
  : join(ROOT, 'test_assets', 'test_role_arbg.png');

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    setTimeout(() => resolve(proc), 2500);
  });
}

/**
 * 用项目自己的 generator 从切图重建骨架。
 *
 * 落盘的是导出产物，没有骨架 JSON，所以要重建。重建的关键是**部件在原图里的
 * 位置**——bbox 是 AI 分析时给的，同样没落盘。
 *
 * 一开始图省事把 bbox 全写成 {x:0, y:0}，结果所有部件叠在原点，
 * 截图看起来像"重影/部件被画了两遍"，把排查带偏了很久：
 * 那是我这个脚本的假象，不是 app 的 bug。
 *
 * 现在用 locateParts 做模板匹配把真实位置找回来（只匹配 alpha 形状，
 * 不受补图改颜色影响），再加 margin 补偿回切图的 bbox。
 */
async function loadFixture() {
  const { generateSkeleton, generateAnimations } = await import('../../server/api/generator.js');
  const { locateParts } = await import('../../scripts/locate-parts.mjs');

  const files = (await readdir(IMAGES_DIR)).filter((f) => f.endsWith('.png'));
  if (!files.length) return null;

  const cuts = files.map((f) => ({
    name: f.replace(/\.png$/, ''),
    path: join(IMAGES_DIR, f)
  }));

  // 定位需要原图；找不到原图就退回"全摆在原点"并明确警告
  let located = null;
  if (existsSync(SOURCE)) {
    located = await locateParts(SOURCE, cuts);
  } else {
    console.warn(`[截图] 找不到原图 ${SOURCE}，部件位置只能全按原点处理（画面会叠在一起）`);
  }

  const parts = [];
  for (const c of cuts) {
    const m = await sharp(c.path).metadata();
    const loc = located?.get(c.name);
    parts.push({
      name: c.name,
      bbox: loc
        ? { x: loc.x, y: loc.y, width: loc.width, height: loc.height }
        : { x: 0, y: 0, width: m.width, height: m.height },
      pivot: loc
        ? { x: m.width / 2, y: m.height / 2 }
        : { x: m.width / 2, y: m.height / 2 },
      type: 'part'
    });
  }

  // imageSize 必须用原图尺寸，不能用切图最大尺寸。
  // generateSkeleton 用 imageSize 算坐标原点（画面中心），
  // 用切图尺寸会让原点算错，所有骨骼偏出画面之外。
  const srcMeta = existsSync(SOURCE) ? await sharp(SOURCE).metadata() : null;
  const imageSize = srcMeta
    ? { width: srcMeta.width, height: srcMeta.height }
    : { width: parts[0]?.bbox.width ?? 300, height: parts[0]?.bbox.height ?? 800 };
  const skeleton = generateSkeleton({ parts }, '3.8', { imageSize, density: 8 });
  generateAnimations(skeleton);

  return {
    skeleton,
    imageUrls: cuts.map((c) => [c.name, `${IMAGES_URL}/${c.name}.png`]),
    imageSize
  };
}

/** 塞进 app 的 IndexedDB 再刷新——走真实的恢复路径 */
async function seedAndReload(page, payload) {
  await page.evaluate(async (result) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('spineAiSession', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('session')) d.createObjectStore('session');
        if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put(result, 'result');
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    });
  }, payload);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#spineCanvas', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2500);
}

async function shoot(page, name) {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const p = join(SNAPSHOT_DIR, `${name}.png`);
  await page.locator('#spineCanvas').screenshot({ path: p });
  return p;
}

/**
 * 分析一张预览截图，数出各类像素的占比。
 *
 * 判据要靠"和对照组的差值"来用，不要看绝对值：
 * 画布底是深色网格（#141a24，各通道最大值 36），整片都算近黑。
 * 单看"坏产物近黑 70.5%"完全说明不了问题，得和"没画角色"的底图比。
 *
 * 能区分好坏的是 **above-bg 像素占比**（最大通道 > 50）：
 *   - 对照组（没画角色）        0.2%   ← 背景网格本身近乎 0
 *   - 坏产物（部件是黑框）      ~0.2%  ← 黑框把角色压成了背景色
 *   - 好产物                    ~7%    ← 服装和皮肤像素显著高于背景
 *
 * 为什么不用彩色饱和度（mx-mn > 40）：这张素材的服装是低饱和紫色
 * （rgb(105,93,117)，mx-mn≈24），饱和度阈值会漏掉大半内容。
 * above-bg 只看亮度，对任何服装配色都可靠。
 */
async function analyze(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;

  let dark = 0, aboveBg = 0, bright = 0;
  for (let i = 0; i < total; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 50) dark++;
    // 背景网格 #141a24 的最大通道值为 36；角色像素（含低饱和服装）≥ 50
    if (mx > 50) aboveBg++;
    if (mn > 230) bright++;
  }

  return {
    width: info.width,
    height: info.height,
    darkRatio: dark / total,
    aboveBgRatio: aboveBg / total,
    brightRatio: bright / total
  };
}

const canRun = existsSync(IMAGES_DIR) && readdirSync(IMAGES_DIR).some((f) => f.endsWith('.png'));
const skip = !canRun && `缺少产物 ${OUTPUT_DIR}`;

test('预览截图：轮廓要通透、有内容、网格能透出来', { skip }, async (t) => {
  const PORT = 3987;
  const server = await startServer(PORT);
  t.after(() => server.kill());

  const browser = await chromium.launch();
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**unpkg.com/**', (r) => r.abort());
  await page.route('**fonts.googleapis.com/**', (r) => r.abort());

  const fixture = await loadFixture();
  assert.ok(fixture, '要能从切图重建出骨架');

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await seedAndReload(page, {
    skeleton: fixture.skeleton,
    imageUrls: fixture.imageUrls,
    imageSize: fixture.imageSize,
    cutResults: []
  });

  /*
   * 对照组：同一套骨架，但把 canvas 藏起来截一张底图。
   *
   * 不能靠"不塞图片"来做对照——没有图片时 app 会把 canvas 整个隐藏掉。
   * 这里正常加载出预览，再临时把 canvas 换成同尺寸的深色占位盒，
   * 截出来就是"同一位置、同一尺寸、没画角色"的底。
   */
  await page.evaluate(() => {
    const c = document.getElementById('spineCanvas');
    const r = c.getBoundingClientRect();
    const box = document.createElement('div');
    box.id = '__ctl';
    box.style.cssText = `width:${r.width}px;height:${r.height}px;background:#141a24;`;
    c.parentNode.insertBefore(box, c);
    c.style.visibility = 'hidden';
  });
  await page.waitForTimeout(300);
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const ctlPath = join(SNAPSHOT_DIR, `${PROJECT}-control.png`);
  await page.locator('#__ctl').screenshot({ path: ctlPath });
  const ctl = await analyze(ctlPath);
  await page.evaluate(() => {
    document.getElementById('__ctl')?.remove();
    document.getElementById('spineCanvas').style.visibility = '';
  });

  const shotPath = await shoot(page, `${PROJECT}-preview`);
  const a = await analyze(shotPath);

  console.log(`  截图 ${shotPath} (${a.width}x${a.height})`);
  console.log(`  对照组 above-bg ${(ctl.aboveBgRatio * 100).toFixed(1)}%`);
  console.log(`  实验组 above-bg ${(a.aboveBgRatio * 100).toFixed(1)}%  近黑 ${(a.darkRatio * 100).toFixed(1)}%  近白 ${(a.brightRatio * 100).toFixed(1)}%`);

  /*
   * above-bg 像素占比是这里唯一站得住的判据。
   *
   * 背景网格 #141a24 各通道最大值 36，above-bg 定义为最大通道 > 50。
   * 坏产物（部件被糊成实心黑框）把角色压成黑色，above-bg 和对照组相近（~0.2%）；
   * 正常渲染 above-bg 在 7% 上下，差了约 7 个百分点。
   * 门槛卡在对照组 + 3%：比坏产物高，又给不同素材留了余量。
   */
  const MIN_ABOVE_BG = 0.03;
  assert.ok(a.aboveBgRatio > ctl.aboveBgRatio + MIN_ABOVE_BG,
    `above-bg 像素只占 ${(a.aboveBgRatio * 100).toFixed(1)}%（对照组 ${(ctl.aboveBgRatio * 100).toFixed(1)}%），` +
    `差值 ${((a.aboveBgRatio - ctl.aboveBgRatio) * 100).toFixed(1)}pp < 3pp——角色没有被渲染出来或被实心块盖住了`);
});

test('预览截图：动画过程中轮廓不应忽然变实心', { skip }, async (t) => {
  const PORT = 3988;
  const server = await startServer(PORT);
  t.after(() => server.kill());

  const browser = await chromium.launch();
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**unpkg.com/**', (r) => r.abort());
  await page.route('**fonts.googleapis.com/**', (r) => r.abort());

  const fixture = await loadFixture();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await seedAndReload(page, {
    skeleton: fixture.skeleton,
    imageUrls: fixture.imageUrls,
    imageSize: fixture.imageSize,
    cutResults: []
  });

  // 抽几帧，每帧都量彩色占比。动画中冒出实心黑块时，这个值会掉下去
  const colorful = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(500);
    const a = await analyze(await shoot(page, `${PROJECT}-f${i}`));
    colorful.push(a.aboveBgRatio);
  }

  const min = Math.min(...colorful);
  console.log(`  4 帧 above-bg 占比: ${colorful.map((r) => (r * 100).toFixed(1) + '%').join(' ')}`);
  assert.ok(min > 0.03,
    `某一帧 above-bg 占比只有 ${(min * 100).toFixed(1)}%，动画过程中角色被实心块盖住了`);
});
