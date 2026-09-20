/**
 * 底板的测试。
 *
 * 底板要守的是一条**构造性**的保证：`底板 ∪ 所有部件 ≡ 源图不透明像素`。
 * 这条如果破了，用户看到的就是「图里有一块内容凭空没了」——正是引入
 * 底板要解决的问题（实测那张角色图丢了 30.1%）。
 *
 * 所以这里的断言不看「像不像」，只看这个恒等式，以及两个容易写坏的点：
 *   - 底板不能和部件重叠（同一块像素画两遍，部件一动就穿插）
 *   - 洞的掩码必须只标「源图有内容、被部件拿走了」的地方，
 *     纯背景不算洞（否则补图会去填一片本来就该透明的区域）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { buildBasePlate, basePlatePart, BASE_PLATE_NAME } from '../../server/api/baseplate.js';

const A = 8;

/** 读一张图的 alpha 位图 */
async function alphaOf(p) {
  const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const a = new Uint8Array(info.width * info.height);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] >= A ? 1 : 0;
  return { a, w: info.width, h: info.height };
}

/**
 * 造一张测试源图：两个实心方块 + 一块「谁都不认领」的角。
 * 那块角就是现实里 AI 没枚举到的零碎，底板必须接住它。
 */
async function makeSource(dir) {
  const W = 80, H = 80;
  const px = Buffer.alloc(W * H * 4);
  const put = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  };
  put(5, 5, 30, 40, 220, 60, 60);     // 部件 A
  put(40, 5, 70, 40, 60, 60, 220);    // 部件 B
  put(20, 55, 60, 75, 60, 200, 60);   // 无人认领的一块
  const p = join(dir, 'src.png');
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(p);
  return { path: p, W, H };
}

/** 按 bbox 抠一张切图出来，模拟 cutImageParts 的产物 */
async function makeCut(srcPath, dir, name, bbox) {
  const p = join(dir, `${name}.png`);
  await sharp(srcPath).extract({
    left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height
  }).png().toFile(p);
  return { name, path: p, bbox, size: { width: bbox.width, height: bbox.height } };
}

test('底板接住无人认领的像素，并集等于源图', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'plate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const src = await makeSource(dir);
  const cuts = [
    await makeCut(src.path, dir, 'a', { x: 5, y: 5, width: 25, height: 35 }),
    await makeCut(src.path, dir, 'b', { x: 40, y: 5, width: 30, height: 35 })
  ];

  const plate = await buildBasePlate(src.path, cuts, dir, { bleed: 0 });
  assert.ok(plate, '有一整块内容没人认领，必须造底板');
  assert.equal(plate.name, BASE_PLATE_NAME);
  assert.equal(plate.contour, 'base');

  // 那块绿色 40x20 = 800px 正是无人认领的
  assert.equal(plate.orphanPixels, 800, `应当正好接住那块 800px，实际 ${plate.orphanPixels}`);

  // 核心断言：底板 ∪ 部件 ≡ 源图
  const s = await alphaOf(src.path);
  const union = new Uint8Array(s.w * s.h);
  for (const c of [...cuts, plate]) {
    const m = await alphaOf(c.path);
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (!m.a[y * m.w + x]) continue;
      const cy = c.bbox.y + y, cx = c.bbox.x + x;
      if (cy < 0 || cy >= s.h || cx < 0 || cx >= s.w) continue;
      union[cy * s.w + cx] = 1;
    }
  }
  let missing = 0, stray = 0;
  for (let i = 0; i < union.length; i++) {
    if (s.a[i] && !union[i]) missing++;
    if (!s.a[i] && union[i]) stray++;
  }
  assert.equal(missing, 0, `不能再有无人认领的像素，实际还剩 ${missing}px`);
  assert.equal(stray, 0, `不能凭空多出源图没有的像素，实际多了 ${stray}px`);
});

test('底板和部件不重叠：部件认领过的像素在底板上是透明的', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'plate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const src = await makeSource(dir);
  const cuts = [
    await makeCut(src.path, dir, 'a', { x: 5, y: 5, width: 25, height: 35 }),
    await makeCut(src.path, dir, 'b', { x: 40, y: 5, width: 30, height: 35 })
  ];
  const plate = await buildBasePlate(src.path, cuts, dir, { bleed: 0 });

  const p = await alphaOf(plate.path);
  for (const c of cuts) {
    const m = await alphaOf(c.path);
    let overlap = 0;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (!m.a[y * m.w + x]) continue;
      if (p.a[(c.bbox.y + y) * p.w + (c.bbox.x + x)]) overlap++;
    }
    assert.equal(overlap, 0,
      `${c.name} 和底板重叠了 ${overlap}px——同一块像素画两遍，部件一动就露残影`);
  }
});

test('洞的掩码只标「源图有内容、被部件拿走」的地方，不标纯背景', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'plate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const src = await makeSource(dir);
  // 故意给一个比内容大得多的框：多出来的部分是纯透明背景
  const cuts = [await makeCut(src.path, dir, 'a', { x: 0, y: 0, width: 35, height: 50 })];
  const plate = await buildBasePlate(src.path, cuts, dir, { bleed: 0 });
  assert.ok(plate);

  const maskPath = plate.path.replace(/\.png$/, '.erased.png');
  const { data, info } = await sharp(maskPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const s = await alphaOf(src.path);

  let marked = 0, markedOnBackground = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4] <= 127) continue;
    marked++;
    if (!s.a[i]) markedOnBackground++;
  }
  // 部件 A 是 25x35=875px 的实心块，全被拿走了
  assert.equal(marked, 875, `洞应当正好是部件拿走的那 875px，实际 ${marked}`);
  assert.equal(markedOnBackground, 0,
    '纯背景不该被标成洞——补图会去填一片本来就该透明的区域');
});

test('没有东西丢失时不��底板，不浪费一个槽位和一次补图', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'plate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 整张画布就是一个部件，什么都没漏
  const W = 40, H = 40;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) {
    const i = (y * W + x) * 4;
    px[i] = 200; px[i + 3] = 255;
  }
  const sp = join(dir, 's.png');
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(sp);

  const cut = await makeCut(sp, dir, 'only', { x: 0, y: 0, width: W, height: H });
  const logs = [];
  const plate = await buildBasePlate(sp, [cut], dir, { bleed: 0, onLog: (m) => logs.push(m) });

  assert.equal(plate, null, '没有无人认领的内容时不该造底板');
  assert.match(logs.join('\n'), /不铺底板/, '要说清为什么没铺，否则看不出是没必要还是出错了');
});

test('basePlatePart: 满画布、无父级，排在最前面才会画在最底层', () => {
  const p = basePlatePart(300, 800);
  assert.equal(p.name, BASE_PLATE_NAME);
  assert.equal(p.parent, null, '底板不能挂在任何部件下面，否则跟着那个部件动');
  assert.deepEqual(p.bbox, { x: 0, y: 0, width: 300, height: 800 });
  assert.deepEqual(p.pivot, { x: 150, y: 400 });
});
