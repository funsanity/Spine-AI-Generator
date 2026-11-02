/**
 * 切图写「被挡位置」掩码（.hidden.png），以及框偏诊断的新判据。
 *
 * 补图要让模型把被挡住的部分按部件本来的形状画出来，它得知道两件事：
 * 哪些位置被前面的部件盖着（可以往里画），以及画布要多大（被挡部分可能超出原窗口，
 * 比如 body 在披风底下那截）。所以掩码按「窗口四周外扩 15%」的画布写，
 * 只标被 depth 更大的部件占着的像素——不再和本部件的 polygon 求交，形状交给模型。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cutImageParts, diagnoseAlignment } from '../../server/api/cutter.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'spine-hidden-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const S = 200;
async function scene() {
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const inCape = x >= 110 && x < 145 && y >= 40 && y < 80;
    const inBody = x >= 50 && x < 130 && y >= 50 && y < 150;
    if (inCape) { px[i] = 40; px[i + 1] = 120; px[i + 2] = 90; px[i + 3] = 255; }
    else if (inBody) { px[i] = 220; px[i + 1] = 150; px[i + 2] = 40; px[i + 3] = 255; }
  }
  const p = join(dir, 'src.png');
  await sharp(px, { raw: { width: S, height: S, channels: 4 } }).png().toFile(p);
  return p;
}
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

test('后层部件的被挡掩码按外扩 15% 的画布写，包含遮挡者伸出原窗口的那截', async () => {
  const src = await scene();
  const parts = [
    { name: 'body', depth: 1, bbox: { x: 50, y: 50, width: 80, height: 100 }, polygon: rect(50, 50, 80, 100) },
    { name: 'cape', depth: 2, bbox: { x: 110, y: 40, width: 35, height: 40 }, polygon: rect(110, 40, 35, 40) }
  ];
  const cuts = await cutImageParts(src, parts, join(dir, 'out'), { margin: 0, bleed: 0 });
  const body = cuts.find((c) => c.name === 'body');
  const cape = cuts.find((c) => c.name === 'cape');

  assert.deepEqual(body.hiddenBox, { x: 38, y: 35, width: 104, height: 130 });
  assert.ok(body.hiddenPath, 'body 被披风盖着，必须有被挡掩码');
  assert.equal(cape.hiddenPath, null, '最前面的部件没有被挡的地方');

  const { data, info } = await sharp(body.hiddenPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 104);
  assert.equal(info.height, 130);
  const alphaAt = (sx, sy) => data[((sy - 35) * 104 + (sx - 38)) * 4 + 3];
  assert.equal(alphaAt(120, 60), 255, '原窗口内被披风盖住的位置');
  assert.equal(alphaAt(135, 60), 255, '披风伸出 body 原窗口的那截也要标（不和 body 轮廓求交）');
  assert.equal(alphaAt(90, 100), 0, 'body 自己看得见的地方不是被挡');
  assert.equal(alphaAt(40, 40), 0, '空白处不是被挡');
});

test('诊断：斜长条部件框内大半是空的，但掩码和轮廓吻合就不报框偏', async () => {
  const W = 100, H = 100;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (Math.abs(x - y) < 15) { const i = (y * W + x) * 4; px[i] = 200; px[i + 3] = 255; }
  }
  const p = join(dir, 'diag.png');
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(p);
  const base = { name: 'arm', path: p, bbox: { x: 0, y: 0, width: W, height: H } };

  const [ok] = await diagnoseAlignment([{ ...base, maskPolyIoU: 0.8 }]);
  assert.ok(ok.fillRatio < 0.5);
  assert.deepEqual(ok.flags, []);

  const [bad] = await diagnoseAlignment([{ ...base, maskPolyIoU: 0.3 }]);
  assert.equal(bad.flags.length, 1);
  assert.match(bad.flags[0], /重叠不到一半/);
});

test('SAM 掩码溢出自身多边形 15px 以外的部分不归它（手臂掩码吃进披风）', async () => {
  // 源图：左边 arm 色块，右边 cape 色块，两块相接
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (y < 40 || y >= 160) continue;
    if (x >= 40 && x < 100) { px[i] = 230; px[i + 1] = 200; px[i + 2] = 180; px[i + 3] = 255; }
    else if (x >= 100 && x < 170) { px[i] = 40; px[i + 1] = 90; px[i + 2] = 80; px[i + 3] = 255; }
  }
  const src = join(dir, 'spill.png');
  await sharp(px, { raw: { width: S, height: S, channels: 4 } }).png().toFile(src);
  // arm 的 SAM 掩码一路吃到 x=160（溢出自身多边形 60px），而且 arm 在前（depth 大）
  const armMask = new Uint8Array(S * S);
  for (let y = 40; y < 160; y++) for (let x = 40; x < 160; x++) armMask[y * S + x] = 1;
  const png = await sharp(Buffer.from(armMask.map((v) => v * 255)), { raw: { width: S, height: S, channels: 1 } }).png().toBuffer();
  const parts = [
    { name: 'arm', depth: 3, bbox: { x: 40, y: 40, width: 130, height: 120 }, polygon: rect(40, 40, 60, 120) },
    { name: 'cape', depth: 1, bbox: { x: 100, y: 40, width: 70, height: 120 }, polygon: rect(100, 40, 70, 120) }
  ];
  const cuts = await cutImageParts(src, parts, join(dir, 'spill-out'), {
    margin: 0, bleed: 0, samMasks: new Map([['arm', { png }]])
  });
  const cape = cuts.find((c) => c.name === 'cape');
  const { data, info } = await sharp(cape.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (sx, sy) => data[((sy - cape.bbox.y) * info.width + (sx - cape.bbox.x)) * 4 + 3];
  assert.equal(at(140, 100), 255, '离 arm 多边形 40px 的披风像素归 cape');
  assert.equal(at(108, 100), 0, '15px 以内仍按 SAM 归 arm（多边形本来就粗）');
});

test('SAM 放掉的溢出像素，按框认领时也不能被它的小框领回去', async () => {
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (y < 40 || y >= 160) continue;
    if (x >= 40 && x < 100) { px[i] = 230; px[i + 1] = 200; px[i + 2] = 180; px[i + 3] = 255; }
    else if (x >= 100 && x < 170) { px[i] = 40; px[i + 1] = 90; px[i + 2] = 80; px[i + 3] = 255; }
  }
  const src = join(dir, 'spill2.png');
  await sharp(px, { raw: { width: S, height: S, channels: 4 } }).png().toFile(src);
  const armMask = new Uint8Array(S * S);
  for (let y = 40; y < 160; y++) for (let x = 40; x < 160; x++) armMask[y * S + x] = 1;
  const png = await sharp(Buffer.from(armMask.map((v) => v * 255)), { raw: { width: S, height: S, channels: 1 } }).png().toBuffer();
  // cape 的多边形只盖住它的右半（x>=150），框比 arm 的大：x 100..170 那片落在 arm 小框里、cape 轮廓外
  const parts = [
    { name: 'arm', depth: 3, bbox: { x: 40, y: 40, width: 125, height: 120 }, polygon: rect(40, 40, 60, 120) },
    { name: 'cape', depth: 1, bbox: { x: 30, y: 30, width: 150, height: 140 }, polygon: rect(150, 40, 20, 120) }
  ];
  const cuts = await cutImageParts(src, parts, join(dir, 'spill2-out'), {
    margin: 0, bleed: 0, samMasks: new Map([['arm', { png }]])
  });
  const arm = cuts.find((c) => c.name === 'arm');
  const { data, info } = await sharp(arm.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (sx, sy) => {
    const x = sx - arm.bbox.x, y = sy - arm.bbox.y;
    return x < 0 || y < 0 || x >= info.width || y >= info.height ? 0 : data[(y * info.width + x) * 4 + 3];
  };
  assert.equal(at(140, 100), 0, '离 arm 多边形 40px，不能因为 arm 框小就归 arm');
  assert.equal(at(60, 100), 255);
});

test('切图时把本部件的归属掩码写成 .mask.png（和切图同窗口），补图之后也能看出原来归谁', async () => {
  const src = await scene();
  const parts = [
    { name: 'body', depth: 1, bbox: { x: 50, y: 50, width: 80, height: 100 }, polygon: rect(50, 50, 80, 100) },
    { name: 'cape', depth: 2, bbox: { x: 110, y: 40, width: 35, height: 40 }, polygon: rect(110, 40, 35, 40) }
  ];
  const cuts = await cutImageParts(src, parts, join(dir, 'out-mask'), { margin: 0, bleed: 0 });
  const body = cuts.find((c) => c.name === 'body');

  assert.ok(body.maskPath, '每个部件都要有归属掩码');
  assert.deepEqual(body.maskBox, body.bbox, '掩码窗口要单独记下：补图之后 bbox 会变');
  const { data, info } = await sharp(body.maskPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, body.bbox.width);
  assert.equal(info.height, body.bbox.height);
  const alphaAt = (sx, sy) => data[((sy - body.maskBox.y) * info.width + (sx - body.maskBox.x)) * 4 + 3];
  assert.equal(alphaAt(90, 100), 255, 'body 自己看得见的地方归 body');
  assert.equal(alphaAt(120, 60), 0, '被披风盖住的地方归披风，不归 body');
});
