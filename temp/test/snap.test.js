/**
 * 剪影吸附的测试。
 *
 * 要防的核心缺陷是「AI 的矩形框伸进隔壁部件的地盘」：框多框进来的内容
 * 会跟着这个部件一起动，用户看到的就是缺块、错位。这里的图都是造出来的
 * 确定形状，所以能精确断言"吸附后的框应该是什么"。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapToSilhouette, cutImageParts, diagnoseAlignment } from '../../server/api/cutter.js';

let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snap-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * 造源图：在透明底上画若干实心矩形。
 * @param {string} path
 * @param {number} W
 * @param {number} H
 * @param {Array<{x0,x1,y0,y1,color?}>} blocks
 */
async function makeSource(path, W, H, blocks) {
  const px = Buffer.alloc(W * H * 4);
  for (const b of blocks) {
    const c = b.color ?? [200, 100, 100];
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const i = (y * W + x) * 4;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }
  }
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path);
  return path;
}

/** 读源图的原始像素，喂给 snapToSilhouette */
async function readSource(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

test('snapToSilhouette: 框里两部分时，选中心所在的那块', async () => {
  // 两块分别独立：左上一块、右下一块，中间隔着透明带
  const p = await makeSource(join(dir, 'two.png'), 100, 100, [
    { x0: 2, x1: 26, y0: 2, y1: 46 },      // 左上（框中心落这里）
    { x0: 60, x1: 98, y0: 60, y1: 98 }     // 右下
  ]);
  const src = await readSource(p);

  // 框 0..50，中心 (25,25) 落在左上那块里
  const r = snapToSilhouette(src.data, src.width, src.height, { x: 0, y: 0, width: 50, height: 50 });
  assert.ok(r, '应该吸附成功');
  assert.deepEqual(r.bbox, { x: 2, y: 2, width: 24, height: 44 },
    '应该收紧到框中心所在的那一块');
  assert.equal(r.blobs, 1, '另一块在框外，不该被数进来');
});

test('snapToSilhouette: 框比内容大一圈时，收紧到内容', async () => {
  const p = await makeSource(join(dir, 'loose.png'), 120, 120, [
    { x0: 40, x1: 80, y0: 30, y1: 70 }
  ]);
  const src = await readSource(p);

  const r = snapToSilhouette(src.data, src.width, src.height, { x: 10, y: 5, width: 100, height: 110 });
  assert.ok(r);
  assert.deepEqual(r.bbox, { x: 40, y: 30, width: 40, height: 40 });
});

test('snapToSilhouette: 框贴边不回退——贴边部件的框不能被推出图片', async () => {
  const p = await makeSource(join(dir, 'edge.png'), 60, 60, [
    { x0: 0, x1: 30, y0: 0, y1: 30 }
  ]);
  const src = await readSource(p);

  const r = snapToSilhouette(src.data, src.width, src.height, { x: -10, y: -10, width: 60, height: 60 });
  assert.ok(r);
  assert.equal(r.bbox.x, 0);
  assert.equal(r.bbox.y, 0);
  assert.equal(r.bbox.width, 30);
  assert.equal(r.bbox.height, 30);
});

test('snapToSilhouette: 框里全是透明时返回 null（交给调用方保留原框）', async () => {
  const p = await makeSource(join(dir, 'empty.png'), 50, 50, [
    { x0: 0, x1: 10, y0: 0, y1: 10 }
  ]);
  const src = await readSource(p);

  const r = snapToSilhouette(src.data, src.width, src.height, { x: 20, y: 20, width: 25, height: 25 });
  assert.equal(r, null);
});

test('snapToSilhouette: 内容太小（面积低于阈值）时不吸附', async () => {
  const p = await makeSource(join(dir, 'tiny.png'), 50, 50, [
    { x0: 20, x1: 23, y0: 20, y1: 23 } // 9 像素，低于 SNAP_MIN_AREA
  ]);
  const src = await readSource(p);

  const r = snapToSilhouette(src.data, src.width, src.height, { x: 0, y: 0, width: 50, height: 50 });
  assert.equal(r, null);
});

test('snapToSilhouette: 中心落在透明区时退回面积最大的块', async () => {
  /*
   * 造两块，中间隔着一条透明带，框中心正好落在带上。
   * 这是真实会遇到的：AI 的框偏了，中心踩到部件之间的缝里。
   */
  const p = await makeSource(join(dir, 'holes.png'), 100, 100, [
    { x0: 2, x1: 24, y0: 2, y1: 24 },      // 小块（左上角）
    { x0: 70, x1: 98, y0: 70, y1: 98 }     // 大块（右下角）
  ]);
  const src = await readSource(p);

  // 框 0..60，中心 (30,30) 在透明带上，离两块都远
  const r = snapToSilhouette(src.data, src.width, src.height, { x: 0, y: 0, width: 60, height: 60 });
  assert.ok(r);
  // 两块面积相同（484），取先遇到的那块——关键是必须选中其中一块，不能返回 null
  assert.ok(
    (r.bbox.x === 2 && r.bbox.y === 2) || (r.bbox.x === 14 && r.bbox.y === 14),
    `应选中某一块，实际 ${JSON.stringify(r.bbox)}`
  );
});

test('cutImageParts: 吸附后再外扩，框比原框紧、但比内容大 margin', async () => {
  const src = await makeSource(join(dir, 'cut-src.png'), 100, 100, [
    { x0: 30, x1: 60, y0: 30, y1: 60 }
  ]);
  const out = join(dir, 'cut-out');

  const parts = [{ name: 'body', bbox: { x: 10, y: 10, width: 80, height: 80 }, pivot: { x: 40, y: 40 } }];
  const r = await cutImageParts(src, parts, out, { margin: 4, bleed: 0, snap: true });

  assert.equal(r.length, 1);
  // 内容 30..60，外扩 4 → 26..64，宽 38
  assert.deepEqual(r[0].bbox, { x: 26, y: 26, width: 38, height: 38 });
  assert.equal(r[0].snapped, true);
  assert.deepEqual(r[0].originalBbox, { x: 10, y: 10, width: 80, height: 80 });

  // pivot 要同量补偿，否则骨骼原点会整体偏掉
  assert.equal(r[0].pivot.x, 40 + (30 - 26));
  assert.equal(r[0].pivot.y, 40 + (30 - 26));
});

test('cutImageParts: snap=false 时退回矩形框 + margin', async () => {
  const src = await makeSource(join(dir, 'nosnap-src.png'), 100, 100, [
    { x0: 30, x1: 60, y0: 30, y1: 60 }
  ]);
  const out = join(dir, 'nosnap-out');

  const parts = [{ name: 'body', bbox: { x: 10, y: 10, width: 80, height: 80 }, pivot: { x: 40, y: 40 } }];
  const r = await cutImageParts(src, parts, out, { margin: 4, bleed: 0, snap: false });

  assert.deepEqual(r[0].bbox, { x: 6, y: 6, width: 88, height: 88 }, '不吸附就是原框外扩');
  assert.equal(r[0].snapped, false);
  assert.deepEqual(r[0].originalBbox, { x: 10, y: 10, width: 80, height: 80 });
});

test('cutImageParts: 吸附失败时不吞掉部件，保留原框切出内容', async () => {
  const src = await makeSource(join(dir, 'keep-src.png'), 60, 60, [
    { x0: 5, x1: 15, y0: 5, y1: 15 }
  ]);
  const out = join(dir, 'keep-out');

  // 框完全落在透明区，吸附会返回 null
  const parts = [{ name: 'ghost', bbox: { x: 30, y: 30, width: 20, height: 20 }, pivot: { x: 10, y: 10 } }];
  const r = await cutImageParts(src, parts, out, { margin: 2, bleed: 0, snap: true });

  assert.equal(r.length, 1, '部件不能被丢掉');
  assert.equal(r[0].snapped, false);
  assert.deepEqual(r[0].bbox, { x: 28, y: 28, width: 24, height: 24 });
});

test('diagnoseAlignment: 框里空得多就标出来，并给出吸附挪动量', async () => {
  const src = await makeSource(join(dir, 'diag-src.png'), 100, 100, [
    { x0: 40, x1: 55, y0: 40, y1: 55 }
  ]);
  const out = join(dir, 'diag-out');

  const parts = [{ name: 'arm', bbox: { x: 0, y: 0, width: 100, height: 100 }, pivot: { x: 50, y: 50 } }];
  const cut = await cutImageParts(src, parts, out, { margin: 4, bleed: 0, snap: true });
  const diag = await diagnoseAlignment(cut);

  assert.equal(diag.length, 1);
  assert.equal(diag[0].name, 'arm');
  assert.equal(diag[0].snapped, true);
  // 内容 15x15=225，加上外扩后 23x23=529 的框，不透明占比 225/529 ≈ 0.425
  assert.ok(diag[0].fillRatio < 0.5, `填充率应低于 0.5，实际 ${diag[0].fillRatio}`);
  assert.ok(diag[0].flags.length > 0, '应给出可读的提示');
  // 吸附把框从 100x100 收到 23x23
  assert.ok(diag[0].drift.width < -50, `宽度应大幅收缩，实际 ${diag[0].drift.width}`);
  assert.ok(diag[0].drift.height < -50);
});

test('diagnoseAlignment: 框本来就贴内容时不报警', async () => {
  const src = await makeSource(join(dir, 'tight-src.png'), 100, 100, [
    { x0: 10, x1: 90, y0: 10, y1: 90 }
  ]);
  const out = join(dir, 'tight-out');

  const parts = [{ name: 'body', bbox: { x: 10, y: 10, width: 80, height: 80 }, pivot: { x: 40, y: 40 } }];
  const cut = await cutImageParts(src, parts, out, { margin: 4, bleed: 0, snap: true });
  const diag = await diagnoseAlignment(cut);

  assert.equal(diag[0].flags.length, 0, `贴合内容时不该有告警：${JSON.stringify(diag[0].flags)}`);
  // 内容 10..90 外扩 4 → 6..94，6400/7744
  assert.ok(diag[0].fillRatio > 0.8, `填充率该很高，实际 ${diag[0].fillRatio}`);
});

test('细长部件的框混进邻件时：宽度剖面突变处会切掉那一截', async () => {
  /*
   * 复刻 test_role_arbg 那条右小臂的毛病：手臂是竖着的一条窄带，
   * 框的下端却伸进躯干，把一整块宽得多的内容圈了进来。
   *
   * 实测原图里那条手臂的剖面就是这样的：框内逐行不透明像素数
   * 从 21 一路掉到 0，再往下的一大段全是 39~65（躯干）。
   * 所以判据不是"隔着透明带"，而是"窄带之后突然变宽"。
   */
  const W = 80, H = 200;
  const p = join(dir, 'arm-src.png');
  await makeSource(p, W, H, [
    { x0: 30, x1: 50, y0: 20, y1: 120, color: [80, 80, 90] },  // 手臂：20px 宽的窄带
    { x0: 30, x1: 50, y0: 120, y1: 150, color: [80, 80, 90] },  // 手臂继续（同一块，连通）
    { x0: 10, x1: 75, y0: 125, y1: 165, color: [200, 200, 210] } // 躯干：65px 宽，压住手臂下端
  ]);
  const src = await readSource(p);

  // AI 给的框：x 25..55（够框住手臂），y 15..170（下端伸进躯干）
  const r = snapToSilhouette(src.data, src.width, src.height, { x: 25, y: 15, width: 30, height: 155 });
  assert.ok(r, '应该吸附成功');
  assert.ok(
    r.bbox.height < 155,
    `框的高度该被收窄（躯干那一截要剔掉），实际还是 ${r.bbox.height}`
  );
  assert.ok(
    r.bbox.width < 40,
    `框的宽度该贴着 20px 的手臂，实际 ${r.bbox.width}——躯干被框进来了`
  );
});
