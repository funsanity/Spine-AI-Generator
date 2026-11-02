/**
 * 切口抗锯齿：前层部件被归属表切开的那条边不能是硬阶梯。
 *
 * 用户报 hair.png 左下鬓角、右下断口「有锯齿」。源图自带的轮廓（对着透明背景）
 * 是画师画的半透明过渡，本来就平滑；锯齿只出现在归属表把一块连续内容切开的地方——
 * 头发压在脸上，那条边是按像素 0/1 判的，alpha 一格之内从 0 跳到 255。
 *
 * 实测 kkk 的 hair.png 切口上还沿着脸带一条肤色：SAM 掩码多吃进 1~2px。
 *
 * 修法两步：
 *   1. 接缝上颜色多半是后层的格子（混合比例 f < 0.5）还给后层；
 *   2. 前层往外羽化一圈：压在后层身上的那格按 f 给 alpha、颜色取自己的。
 * 不往里收：往里收会让前层边缘半透明，背后那层如果没补到，接缝就露缝
 * （idle 那轮裂缝就是这么来的）；往外扩只是盖住后层自己的像素，后层什么都不缺。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { featherFrontEdge, refineSeamOwnership, cutImageParts } from '../../server/api/cutter.js';

const W = 40;
const H = 40;
const HAIR = [20, 70, 80];
const SKIN = [240, 200, 180];
const mix = (f, a, b) => a.map((v, c) => Math.round(f * v + (1 - f) * b[c]));

/**
 * 斜 45° 接缝：x + y < 40 归前层（头发），其余归后层。
 * 源图在 x + y == 40 那一格画了画师的过渡（edgeMix 成头发色）。
 * 右下角留一块透明背景。
 */
function fixture(back = SKIN, edgeMix = 0.3) {
  const src = Buffer.alloc(W * H * 4);
  const buf = Buffer.alloc(W * H * 4);
  const mine = new Uint8Array(W * H);
  const behind = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 34 && y > 34) continue;
      const c = x + y < 40 ? HAIR : x + y === 40 ? mix(edgeMix, HAIR, back) : back;
      src.set([...c, 250], i * 4);
      if (x + y < 40) { mine[i] = 1; buf.set([...c, 250], i * 4); } else behind[i] = 1;
    }
  }
  return { src, buf, mine, behind };
}

test('两侧颜色拆得开：切口外侧那格按画师的混合比例给 alpha，颜色用自己的', () => {
  const { src, buf, mine, behind } = fixture();
  const out = featherFrontEdge(buf, W, H, mine, behind, src);
  let soft = 0;
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (!behind[i]) continue;
      const a = out[i * 4 + 3];
      if (x + y === 40) {
        assert.ok(Math.abs(a - 75) <= 8, `(${x},${y}) 过渡格 alpha=${a}，应接近 0.3×250`);
        assert.deepEqual([...out.subarray(i * 4, i * 4 + 3)], HAIR, `(${x},${y}) 颜色应取前层自己的`);
        soft++;
      } else {
        assert.equal(a, 0, `(${x},${y}) 纯后层颜色，不该叠头发`);
      }
    }
  }
  assert.ok(soft > 20, `切口外侧只羽化了 ${soft} 格`);
});

test('两侧同色系拆不开：退回几何覆盖，阶梯外侧照样有过渡', () => {
  const { src, buf, mine, behind } = fixture([30, 75, 88]);
  const out = featherFrontEdge(buf, W, H, mine, behind, src);
  let soft = 0;
  for (let i = 0; i < W * H; i++) {
    if (!behind[i]) continue;
    const a = out[i * 4 + 3];
    if (a > 0 && a < 250) soft++;
  }
  assert.ok(soft > 20, `只有 ${soft} 格过渡`);
});

test('自己的像素原样不动；透明背景、离切口两格以外都不长', () => {
  const { src, buf, mine, behind } = fixture([30, 75, 88]);
  const out = featherFrontEdge(buf, W, H, mine, behind, src);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mine[i]) assert.deepEqual([...out.subarray(i * 4, i * 4 + 4)], [...buf.subarray(i * 4, i * 4 + 4)]);
      else if (!behind[i] || x + y > 41) assert.equal(out[i * 4 + 3], 0, `(${x},${y}) 不该长出东西`);
    }
  }
});

test('接缝归属修正：前层多吃进来的肤色格还给后层，偏头发色的留下', () => {
  // 源图：x+y<38 头发，x+y==38 是 0.8 成头发，x+y==39 是 0.2 成头发，其余肤色
  const rgba = Buffer.alloc(W * H * 4);
  const ownerOf = new Array(W * H).fill(null);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const s = x + y;
      const c = s < 38 ? HAIR : s === 38 ? mix(0.8, HAIR, SKIN) : s === 39 ? mix(0.2, HAIR, SKIN) : SKIN;
      rgba.set([...c, 255], i * 4);
      // 掩码多吃了一格：x+y<=39 都判给头发
      ownerOf[i] = s <= 39 ? 'hair' : 'face';
    }
  }
  const moved = refineSeamOwnership(ownerOf, rgba, W, H, new Map([['hair', 1], ['face', 0]]));
  assert.ok(moved > 20, `只改判了 ${moved}px`);
  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      const s = x + y;
      if (s === 39) assert.equal(ownerOf[y * W + x], 'face', `(${x},${y}) 八成是肤色，该还给脸`);
      if (s === 38) assert.equal(ownerOf[y * W + x], 'hair', `(${x},${y}) 八成是头发，不该被拿走`);
    }
  }
});

test('切图产物：hair 切口不带肤色、有过渡；face 自己的像素一格不少', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cut-aa-'));
  try {
    const SZ = 100;
    const px = Buffer.alloc(SZ * SZ * 4);
    for (let y = 0; y < SZ; y++) {
      for (let x = 0; x < SZ; x++) {
        const s = x + y;
        const c = s < 89 ? HAIR : s === 89 ? mix(0.6, HAIR, SKIN) : s === 90 ? mix(0.25, HAIR, SKIN) : SKIN;
        px.set([...c, 255], (y * SZ + x) * 4);
      }
    }
    const src = join(dir, 'src.png');
    await sharp(px, { raw: { width: SZ, height: SZ, channels: 4 } }).png().toFile(src);
    // SAM 掩码：hair 多吃进 0.25 那条过渡（x+y<=90），像素级 0/1
    const mask = async (inside) => {
      const m = Buffer.alloc(SZ * SZ);
      for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) m[y * SZ + x] = inside(x, y) ? 255 : 0;
      return { png: await sharp(m, { raw: { width: SZ, height: SZ, channels: 1 } }).png().toBuffer() };
    };
    const samMasks = new Map([
      ['face', await mask((x, y) => x + y > 90)],
      ['hair', await mask((x, y) => x + y <= 90)]
    ]);
    const parts = [
      { name: 'face', depth: 0, bbox: { x: 0, y: 0, width: SZ, height: SZ } },
      { name: 'hair', depth: 1, bbox: { x: 0, y: 0, width: 91, height: 91 } }
    ];
    const cuts = await cutImageParts(src, parts, dir, { margin: 4, bleed: 0, snap: false, samMasks });
    const read = async (n) => {
      const c = cuts.find((k) => k.name === n);
      const r = await sharp(c.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return (x, y) => {
        const lx = x - c.bbox.x, ly = y - c.bbox.y;
        if (lx < 0 || ly < 0 || lx >= r.info.width || ly >= r.info.height) return [0, 0, 0, 0];
        return [...r.data.subarray((ly * r.info.width + lx) * 4, (ly * r.info.width + lx) * 4 + 4)];
      };
    };
    const hair = await read('hair');
    const face = await read('face');
    for (let x = 10; x <= 80; x++) {
      const edge = hair(x, 90 - x);
      assert.ok(edge[3] > 40 && edge[3] < 90, `hair 在过渡格 (${x},${90 - x}) alpha=${edge[3]}，应约 0.25×255`);
      assert.ok(edge[0] < 60, `hair 过渡格颜色 ${edge.slice(0, 3)} 还是肤色`);
      assert.equal(hair(x, 91 - x)[3], 0, `hair 在纯肤色格 (${x},${91 - x}) 不该有东西`);
      assert.equal(face(x, 90 - x)[3], 255, `face 该收回过渡格 (${x},${90 - x})`);
      assert.equal(face(x, 91 - x)[3], 255, `face (${x},${91 - x}) 被削了`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
