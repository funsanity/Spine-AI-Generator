/**
 * 去背景的测试。
 *
 * 这一块的核心风险不是"清得干不干净"，而是**误删**：
 * 白底图上角色自己的眼白、高光、白衣服和背景同色，
 * 用色键（全图等于背景色的都清）会连人一起镂空。
 * 所以测试的重头在"内部白必须留下"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectBackground, removeBackgroundPixels, recoverEdgeAlpha, removeBackground
} from '../../server/api/background.js';

/**
 * 造一张 **3 通道无 alpha** 的图，和真实失败场景一致。
 *
 * 必须是无 alpha 的：出问题的那张源图是 channels=3 / hasAlpha=false
 * （PNG 里根本没有 alpha 通道），而不是"有 alpha 但全是不透明"。
 * 两者的差别是实打实的——后者会被 removeBackground 判成"已带透明通道"而跳过。
 * 测试要复现的是前者。
 */
function makeRGB(width, height, bg, blocks = []) {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2];
  }
  for (const { x, y, w, h, color } of blocks) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy * width + xx) * 3;
        buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2];
      }
    }
  }
  return buf;
}

/** 去掉 alpha 之后的像素访问。removeBackgroundPixels 的返回值始终是 4 通道 */
const A = (buf, w, x, y) => buf[(y * w + x) * 4 + 3];
const RGB = (buf, w, x, y) => {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2]];
};

test('场景一：白底 + 中间一个方块 —— 背景清掉，方块留住', () => {
  const W = 40, H = 40;
  const img = makeRGB(W, H, [255, 255, 255], [{ x: 10, y: 10, w: 20, h: 20, color: [200, 50, 50] }]);
  const r = removeBackgroundPixels(img, W, H, 3, { tolerance: 18 });

  assert.equal(r.skipped, false);
  assert.deepEqual(r.background, [255, 255, 255]);
  assert.equal(A(r.buffer, W, 0, 0), 0, '角落应该透明');
  assert.equal(A(r.buffer, W, 15, 15), 255, '方块内部应该不透明');
  // 方块 20x20=400，背景 1600-400=1200
  assert.equal(r.cleared, 1200);
});

test('场景二：关键用例 —— 角色内部的白不能被删', () => {
  const W = 40, H = 40;
  // 一个深色方块（角色），里面挖一个纯白方块（眼白）
  const img = makeRGB(W, H, [255, 255, 255], [
    { x: 10, y: 10, w: 20, h: 20, color: [40, 40, 60] },
    { x: 17, y: 17, w: 6, h: 6, color: [255, 255, 255] }
  ]);
  const r = removeBackgroundPixels(img, W, H, 3, { tolerance: 18 });

  // 眼白和背景完全同色，且不接触画布边缘 → 泛洪到不了，必须留成不透明
  assert.equal(A(r.buffer, W, 19, 19), 255, '内部纯白必须留下（这是眼白）');
  assert.deepEqual(RGB(r.buffer, W, 19, 19), [255, 255, 255], '颜色不变');
  // 清掉的只有外侧背景
  assert.equal(r.cleared, 1600 - 400);
});

test('场景三：内部白若与背景连通则一起清掉', () => {
  const W = 40, H = 40;
  // 深色方块右侧开一条缝直通背景，内部的白就"连通"了
  const img = makeRGB(W, H, [255, 255, 255], [
    { x: 10, y: 10, w: 20, h: 20, color: [40, 40, 60] },
    { x: 17, y: 17, w: 6, h: 6, color: [255, 255, 255] }
  ]);
  // 从白洞右缘 (x=23) 一路开到画布边界，把洞和外部背景接通
  for (let x = 23; x < W; x++) {
    const i = (19 * W + x) * 3;
    img[i] = 255; img[i + 1] = 255; img[i + 2] = 255;
  }
  const r = removeBackgroundPixels(img, W, H, 3, { tolerance: 18 });
  assert.equal(A(r.buffer, W, 19, 19), 0, '连通后应该被清掉');
  // 反证：同一张图不开口时，内部白是留住的
  const blocked = makeRGB(W, H, [255, 255, 255], [
    { x: 10, y: 10, w: 20, h: 20, color: [40, 40, 60] },
    { x: 17, y: 17, w: 6, h: 6, color: [255, 255, 255] }
  ]);
  const r2 = removeBackgroundPixels(blocked, W, H, 3, { tolerance: 18 });
  assert.equal(A(r2.buffer, W, 19, 19), 255, '不连通时内部白必须留住');
});

test('detectBackground：四角一致时取该色', () => {
  const W = 20, H = 20;
  const img = makeRGB(W, H, [240, 240, 240]);
  assert.deepEqual(detectBackground(img, W, H, 3), [240, 240, 240]);
});

test('detectBackground：四角各不相同 → null（宁可不做也不瞎做）', () => {
  const W = 20, H = 20;
  const img = makeRGB(W, H, [255, 255, 255]);
  const set = (x, y, c) => { const i = (y * W + x) * 3; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; };
  set(0, 0, [255, 0, 0]);
  set(W - 1, 0, [0, 255, 0]);
  set(0, H - 1, [0, 0, 255]);
  set(W - 1, H - 1, [10, 10, 10]);
  assert.equal(detectBackground(img, W, H, 3), null);
});

test('detectBackground：一个角被角色压住，仍能用另外三角判定', () => {
  const W = 20, H = 20;
  const img = makeRGB(W, H, [255, 255, 255]);
  const set = (x, y, c) => { const i = (y * W + x) * 3; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; };
  set(0, 0, [30, 30, 30]); // 左上被占
  assert.deepEqual(detectBackground(img, W, H, 3), [255, 255, 255]);
});

test('容差：能吃下接近背景色的噪点', () => {
  const W = 20, H = 20;
  const img = makeRGB(W, H, [255, 255, 255]);
  // 撒一片 250 的"灰白"，容差 18 之内
  for (let x = 5; x < 15; x++) {
    const i = (2 * W + x) * 3;
    img[i] = 250; img[i + 1] = 250; img[i + 2] = 250;
  }
  const r = removeBackgroundPixels(img, W, H, 3, { tolerance: 18 });
  assert.equal(A(r.buffer, W, 10, 2), 0, '250 在容差内，应被清掉');

  const r2 = removeBackgroundPixels(img, W, H, 3, { tolerance: 2 });
  assert.equal(A(r2.buffer, W, 10, 2), 255, '容差 2 时 250 不算背景');
});

test('recoverEdgeAlpha：白边像素被还原成半透明', () => {
  const W = 6, H = 3;
  const bg = [255, 255, 255];
  // 造一行： [透明, 半透明(混了白的深色), 本色深色, 本色深色, 透明, 透明]
  const buf = Buffer.alloc(W * H * 4);
  const put = (x, y, r, g, b, a) => { const i = (y * W + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a; };
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) put(x, y, 255, 255, 255, 0);

  // 本色是 (60,30,30)。混 45% 白 → 观察值 ≈ 0.55*60 + 0.45*255 = 147.75
  const mixed = Math.round(0.55 * 60 + 0.45 * 255);
  const mixedG = Math.round(0.55 * 30 + 0.45 * 255);
  for (let y = 0; y < H; y++) {
    put(2, y, mixed, mixedG, mixedG, 255);
    put(3, y, 60, 30, 30, 255);
    put(4, y, 60, 30, 30, 255);
  }

  const r = recoverEdgeAlpha(buf, W, H, 4, bg);
  assert.ok(r.feathered > 0, '应该有像素被还原');

  const i = (1 * W + 2) * 4;
  const a = r.buffer[i + 3];
  assert.ok(a > 100 && a < 200, `alpha 应落在半透明区间，实际 ${a}`);
  // 本色被反解回接近 (60,30,30)
  assert.ok(Math.abs(r.buffer[i] - 60) < 25, `R 应接近 60，实际 ${r.buffer[i]}`);
  assert.ok(Math.abs(r.buffer[i + 1] - 30) < 25, `G 应接近 30，实际 ${r.buffer[i + 1]}`);
});

test('recoverEdgeAlpha：内部像素一个不动', () => {
  const W = 8, H = 8;
  const buf = Buffer.alloc(W * H * 4);
  // 全部不透明 —— 没有任何透明邻居，就不该有像素被改
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = 120; buf[i * 4 + 1] = 60; buf[i * 4 + 2] = 60; buf[i * 4 + 3] = 255;
  }
  const r = recoverEdgeAlpha(buf, W, H, 4, [255, 255, 255]);
  assert.equal(r.feathered, 0);
  for (let i = 0; i < W * H; i++) {
    assert.equal(r.buffer[i * 4 + 3], 255);
    assert.equal(r.buffer[i * 4], 120);
  }
});

test('removeBackground：已带透明的图直接跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-'));
  try {
    const p = join(dir, 'a.png');
    await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0 } } })
      .png().toFile(p);
    const r = await removeBackground(p);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'already-transparent');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('removeBackground：不透明图产出真 PNG，且背景变透明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-'));
  try {
    const p = join(dir, 'b.png');
    const W = 30, H = 30;
    const img = makeRGB(W, H, [255, 255, 255], [{ x: 8, y: 8, w: 14, h: 14, color: [10, 120, 200] }]);
    await sharp(img, { raw: { width: W, height: H, channels: 3 } }).png().toFile(p);

    // 先确认落盘的确实是"无 alpha 通道"的图，否则这个测试就测偏了
    const pre = await sharp(p).metadata();
    assert.equal(pre.channels, 3, '源图应当没有 alpha 通道');
    assert.equal(pre.hasAlpha, false);

    const r = await removeBackground(p);
    assert.equal(r.skipped, false);
    assert.ok(Buffer.isBuffer(r.buffer));
    assert.deepEqual(r.background, [255, 255, 255]);

    const { data, info } = await sharp(r.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[(0 * info.width + 0) * 4 + 3], 0, '角落透明');
    assert.equal(data[(15 * info.width + 15) * 4 + 3], 255, '方块不透明');
    assert.deepEqual([data[(15 * info.width + 15) * 4], data[(15 * info.width + 15) * 4 + 1], data[(15 * info.width + 15) * 4 + 2]], [10, 120, 200]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('大图不爆栈（用显式栈而不是递归）', () => {
  const W = 400, H = 400;
  const img = makeRGB(W, H, [255, 255, 255], [{ x: 150, y: 150, w: 100, h: 100, color: [10, 10, 10] }]);
  const r = removeBackgroundPixels(img, W, H, 3, { tolerance: 18 });
  assert.equal(r.cleared, W * H - 10000);
});

test('四边都能作为种子：背景被角色拦腰切断也能清干净', () => {
  const W = 40, H = 40;
  // 一条横贯整幅的深色条，把画布切成上下两半
  const img = makeRGB(W, H, [255, 255, 255], [{ x: 0, y: 19, w: W, h: 2, color: [20, 20, 20] }]);
  const r = removeBackgroundPixels(img, W, H, 3, { tolerance: 18 });
  assert.equal(A(r.buffer, W, 5, 5), 0, '上半部分背景清掉');
  assert.equal(A(r.buffer, W, 5, 35), 0, '下半部分背景也要清掉（只从四角出发就会漏掉）');
  assert.equal(A(r.buffer, W, 5, 19), 255, '深色条留住');
});
