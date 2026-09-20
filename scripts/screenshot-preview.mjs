/**
 * 从已有产物重建一份"上次的生成结果"，塞进 app 的会话存储，然后截图。
 *
 * 为什么不直接调生成接口：那条路要 AI key、要几分钟、要花钱，
 * 而调试预览和骨骼这套东西不需要 AI——AI 的产物（各部件 PNG + bbox）
 * 已经在 output/<工程>/<输入图名>/images 里躺着了。
 *
 * 这里用项目自己的 generateSkeleton / generateAnimations 把骨架重建出来，
 * 走 app 真实的会话恢复路径（往 IndexedDB 写 result → 刷新 → restoreSession），
 * 所以截的是真实渲染，不是另起一套假的。
 *
 * 用法:
 *   node scripts/screenshot-preview.mjs [工程名]
 *   SOURCE_NAME=角色A node scripts/screenshot-preview.mjs myproj
 *   SOURCE_DIR=roundtrip-out/x/images node scripts/screenshot-preview.mjs myproj
 *   产物落在 output/_screenshots/
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { generateSkeleton, generateAnimations } from '../server/api/generator.js';

const ROOT = resolve(import.meta.dirname, '..');
const PROJECT = process.argv[2] || 'generated';
const OUTPUT_DIR = join(ROOT, 'output', PROJECT);
/** 素材名：多张输入图时用 SOURCE_NAME 指定，默认取工程名 */
const SOURCE_NAME = process.env.SOURCE_NAME || PROJECT;
const SOURCE_DIR = process.env.SOURCE_DIR
  ? resolve(ROOT, process.env.SOURCE_DIR)
  : pickSourceDir();
const IMAGES_DIR = join(SOURCE_DIR, 'images');
const SHOT_DIR = join(ROOT, 'output', '_screenshots');

/** 新结构 output/<工程>/<素材>/images，旧结构 output/<工程>/images，两种都认 */
function pickSourceDir() {
  const nested = join(OUTPUT_DIR, SOURCE_NAME);
  if (existsSync(join(nested, 'images'))) return nested;
  if (existsSync(join(OUTPUT_DIR, 'images'))) return OUTPUT_DIR;
  return nested;
}

/** 浏览器取图的 URL 前缀，和磁盘层级一致 */
const IMAGES_URL = IMAGES_DIR === join(OUTPUT_DIR, 'images')
  ? `/output/${PROJECT}/images`
  : `/output/${PROJECT}/${SOURCE_NAME}/images`;
const PORT = Number(process.env.PORT || 3991);

/** 定位部件要用原图。默认项目自带的角色图，可用 SHOT_SOURCE 覆盖 */
const SOURCE = process.env.SHOT_SOURCE
  ? resolve(ROOT, process.env.SHOT_SOURCE)
  : join(ROOT, 'test_assets', 'test_role_arbg.png');

/**
 * 从切图反推部件定义。
 *
 * 真实的 bbox 来自 AI 分析，磁盘上没存。位置必须用模板匹配找回来
 * （see scripts/locate-parts.mjs）——把 bbox 全写成 {x:0, y:0} 的话，
 * 所有部件会叠在原点，看起来像"重影"，纯属自找麻烦。
 */
async function buildParts() {
  const { locateParts } = await import('./locate-parts.mjs');
  const files = (await readdir(IMAGES_DIR)).filter((f) => f.endsWith('.png'));
  const cuts = files.map((f) => ({ name: f.replace(/\.png$/, ''), path: join(IMAGES_DIR, f) }));

  const located = SOURCE && existsSync(SOURCE) ? await locateParts(SOURCE, cuts) : null;
  if (!located) {
    console.warn(`找不到原图 ${SOURCE || '(未指定)'}，部件位置只能全按原点处理，画面会叠在一起`);
  }

  const parts = [];
  for (const c of cuts) {
    const meta = await sharp(c.path).metadata();
    const loc = located?.get(c.name);
    parts.push({
      name: c.name,
      bbox: loc
        ? { x: loc.x, y: loc.y, width: loc.width, height: loc.height }
        : { x: 0, y: 0, width: meta.width, height: meta.height },
      pivot: { x: meta.width / 2, y: meta.height / 2 },
      type: 'part'
    });
  }
  return parts;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stderr.on('data', (b) => process.env.DEBUG && process.stderr.write(b));
    proc.on('error', reject);
    setTimeout(() => resolve(proc), 2500);
  });
}

async function main() {
  if (!existsSync(IMAGES_DIR)) {
    console.error(`找不到部件目录: ${IMAGES_DIR}`);
    process.exit(2);
  }

  const parts = await buildParts();
  if (!parts.length) {
    console.error(`${IMAGES_DIR} 里没有 PNG`);
    process.exit(2);
  }
  console.log(`从 ${parts.length} 个切图重建骨架: ${parts.map((p) => p.name).join(', ')}`);

  const maxW = Math.max(...parts.map((p) => p.bbox.width));
  const maxH = Math.max(...parts.map((p) => p.bbox.height));
  const imageSize = { width: maxW, height: maxH };

  const skeleton = generateSkeleton({ parts }, '3.8', { imageSize, density: 8 });
  generateAnimations(skeleton);
  console.log(`骨架: ${skeleton.bones.length} 骨骼, ${Object.keys(skeleton.animations ?? {}).length} 动画`);

  const imageUrls = parts.map((p) => [p.name, `${IMAGES_URL}/${p.name}.png`]);

  const server = await startServer(PORT);
  const browser = await chromium.launch();
  await mkdir(SHOT_DIR, { recursive: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.route('**unpkg.com/**', (r) => r.abort());
    await page.route('**fonts.googleapis.com/**', (r) => r.abort());
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('  [浏览器错误]', m.text());
    });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

    await page.evaluate(async (payload) => {
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
        tx.objectStore('session').put(payload, 'result');
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      });
    }, { skeleton, imageUrls, imageSize, cutResults: [] });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#spineCanvas', { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2500);

    // 整页一张，canvas 一张
    const full = join(SHOT_DIR, `${PROJECT}-full.png`);
    await page.screenshot({ path: full, fullPage: false });
    console.log(`整页截图: ${full}`);

    const canvas = join(SHOT_DIR, `${PROJECT}-canvas.png`);
    await page.locator('#spineCanvas').screenshot({ path: canvas });
    console.log(`画布截图: ${canvas}`);

    // 逐帧再来几张，方便看动画过程中有没有黑块冒出来
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(500);
      const p = join(SHOT_DIR, `${PROJECT}-f${i}.png`);
      await page.locator('#spineCanvas').screenshot({ path: p });
      console.log(`  帧 ${i}: ${p}`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
