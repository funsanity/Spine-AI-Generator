/**
 * 补图守卫（洞的兜底色）的回归测试。
 *
 * 这里不重写守卫逻辑，直接调 resolveHoleFills —— 之前就是因为只在测试里
 * 复制了一份近似逻辑，线上那份真正的行为（ringN=0 时直接放弃）才没被测到，
 * 结果模型往洞里画的一片白原样进了切图：用户在左肩/裙侧看到的那块白。
 *
 * 几何说明（所有用例共用）：洞是一条瘦高的竖缝，左右两侧各有一条不透明的
 * 内容条，中间隔着 gap 像素的**透明**带。gap≥1 时洞的边界环上一个真实像素
 * 都没有，于是 ringN=0 —— 正是线上 skirt 的情形。gap 决定要往外扩几环才够得着：
 *   gap 3  → 第 4 环命中（RING_MAX=12 以内，够得着）
 *   gap 14 → 第 15 环才有（超出上限，够不着）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHoleFills, ALPHA_CUTOFF, RING_MAX, RING_MIN_N } from '../../server/api/inpaint.js';

const W = 440;
const H = 440;
const DARK = [40, 30, 43];          // 源图这里的真实内容（暗紫）
const WHITE = [255, 254, 254];      // 模型画出来的伪白
const REAL_WHITE = [250, 250, 250]; // 眼白那种本来就白的真实内容

/** 竖缝：洞在正中，内容条在左右两侧 */
const HOLE = { x0: 210, x1: 230, y0: 160, y1: 360 };
const BAND = { y0: 100, y1: 400 };

const idx = (x, y) => y * W + x;
const isNearWhite = (c) =>
  Math.min(...c) >= 225 && Math.max(...c) - Math.min(...c) <= 12;
const inHole = (x, y) => x >= HOLE.x0 && x < HOLE.x1 && y >= HOLE.y0 && y < HOLE.y1;

/**
 * @param {number} gap      洞与内容条之间的透明宽度
 * @param {number[]} [color] 内容条颜色
 * @param {number} [bands]  1=只有左侧内容条（测"只有一个方向有参照"），2=左右都有
 */
function build(gap, color = DARK, bands = 2) {
  const left = { x0: 0, x1: HOLE.x0 - gap };
  const right = { x0: HOLE.x1 + gap, x1: W };
  const opaque = (x, y) => {
    if (y < BAND.y0 || y >= BAND.y1) return false;
    if (bands >= 1 && x >= left.x0 && x < left.x1) return true;
    if (bands >= 2 && x >= right.x0 && x < right.x1) return true;
    return false;
  };

  const base = Buffer.alloc(W * H * 4);
  const filled = Buffer.alloc(W * H * 4);
  const mask = Buffer.alloc(W * H);           // 单通道：255 = 洞
  const exterior = new Uint8Array(W * H);     // 全 0：洞不与图边连通

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (opaque(x, y)) {
        base[i * 4] = color[0]; base[i * 4 + 1] = color[1]; base[i * 4 + 2] = color[2];
        base[i * 4 + 3] = 255;
      }
      if (inHole(x, y)) {
        // 模型在洞里画了一片伪白
        filled[i * 4] = WHITE[0]; filled[i * 4 + 1] = WHITE[1]; filled[i * 4 + 2] = WHITE[2];
        filled[i * 4 + 3] = 255;
        mask[i] = 255;
      }
    }
  }
  return { base, filled, mask, exterior };
}

function run(b) {
  return resolveHoleFills(b.base, b.filled, b.mask, b.exterior, W, H);
}

/** 统计兜底结果：多少洞像素仍近白、多少被改成非白 */
function tally(fb) {
  let whiteLeft = 0, repainted = 0, untouched = 0;
  for (let y = HOLE.y0; y < HOLE.y1; y++) {
    for (let x = HOLE.x0; x < HOLE.x1; x++) {
      const c = fb[idx(x, y)];
      if (!c) { untouched++; whiteLeft++; continue; }
      if (isNearWhite(c)) whiteLeft++;
      else repainted++;
    }
  }
  return { whiteLeft, repainted, untouched };
}

/** 洞边界环上一个真实像素都没有？这是本文件所有用例的前提，先自检 */
function adjacentOpaqueIsZero(gap) {
  let n = 0;
  for (let y = HOLE.y0 - 1; y <= HOLE.y1; y++) {
    for (let x = HOLE.x0 - 1; x <= HOLE.x1; x++) {
      if (inHole(x, y) || x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = idx(x, y);
      if (build(gap).base[i * 4 + 3] >= ALPHA_CUTOFF) n++;
    }
  }
  return n === 0;
}

test('前提自检：洞边界环上没有真实内容（ringN 必然是 0）', () => {
  assert.ok(adjacentOpaqueIsZero(3), 'gap=3 的洞边界必须全是透明');
  assert.ok(adjacentOpaqueIsZero(14), 'gap=14 的洞边界必须全是透明');
});

test('① 洞边界无参照、往外扩几环够得着真实内容 → 用真实内容兜底，白点清零', () => {
  const fb = run(build(3));
  const t = tally(fb);
  const total = (HOLE.x1 - HOLE.x0) * (HOLE.y1 - HOLE.y0);

  assert.equal(t.whiteLeft, 0, '洞里的 4400px 伪白必须一个不剩');
  assert.equal(t.repainted, total);
  assert.equal(t.untouched, 0);

  // 兜底色必须贴近源图内容，不能是随手一个灰
  const c = fb[idx(HOLE.x0 + 5, 260)];
  for (let ch = 0; ch < 3; ch++) {
    assert.ok(Math.abs(c[ch] - DARK[ch]) <= 12,
      `兜底色 rgb(${c.join(',')}) 应贴近真实内容 rgb(${DARK.join(',')})`);
  }
});

test('② 洞口紧邻就有内容（老路径）照旧，不能被新逻辑打乱', () => {
  // gap=0：内容条紧贴洞，ringN 很大，走就地均色
  const fb = run(build(0));
  const c = fb[idx(HOLE.x0 + 5, 260)];
  assert.ok(c, '紧邻有参照时必须兜底');
  for (let ch = 0; ch < 3; ch++) {
    assert.ok(Math.abs(c[ch] - DARK[ch]) <= 6, '就地均色应该就是深色本身');
  }
  assert.equal(tally(fb).whiteLeft, 0);
});

test('③ 四周本来就白（眼白）→ 一个像素都不许改', () => {
  // gap=0 + 内容本身就是近白：白是内容，不是补砸
  const fb = run(build(0, REAL_WHITE));
  let changed = 0;
  for (let i = 0; i < W * H; i++) if (fb[i]) changed++;
  assert.equal(changed, 0, '四周本身是白的，说明白就是内容（眼白），不能下手');
});

test('④ 扩到上限也够不着 → 不猜，原样留着', () => {
  // gap=14：内容条离洞 14px，第 15 环才有，超出 RING_MAX=12
  assert.ok(14 > RING_MAX, '这个用例的前提就是超出扩环上限');
  const fb = run(build(14));
  let changed = 0;
  for (let i = 0; i < W * H; i++) if (fb[i]) changed++;
  assert.equal(changed, 0, '真找不到参照就不动，胡乱铺一个色比留着更糟');
});

test('⑤ 扩环上限确实由 RING_MAX 控制：11 环够得着、14 环够不着', () => {
  // gap=10 → 第 11 环命中（≤12 够得着）
  const near = run(build(10));
  assert.ok(tally(near).repainted > 0, 'gap=10（第 11 环）应在 RING_MAX 内够得着');
  assert.equal(tally(near).whiteLeft, 0);

  // gap=12 → 第 13 环，刚好超出 12
  const far = run(build(12));
  assert.equal(tally(far).repainted, 0, 'gap=12（第 13 环）应超出 RING_MAX，不动');
});

test('⑥ 只有一个方向有参照也能用（不必左右都有）', () => {
  const fb = run(build(3, DARK, 1));
  const t = tally(fb);
  assert.equal(t.whiteLeft, 0, '单侧参照同样该兜底');
  assert.ok(t.repainted > 0);
});

test('⑦ 洞里带着不透明旧图时，扩环不许把洞里的颜色当参照', () => {
  /*
   * 重跑补图时会拿上一次的 _inpainted.png 当底图，那时洞里是有不透明内容的。
   * 如果 ringColor 只按 alpha 取样、忘了排除洞自己，就会把洞里那片白算成
   * "四周的真实内容"，均色一摊还是白的，等于没兜底。这条用例专门卡这个。
   */
  const b = build(3);
  // 往洞里的底图上填不透明的近白（模拟上一次补图留在洞里的白）
  for (let y = HOLE.y0; y < HOLE.y1; y++) {
    for (let x = HOLE.x0; x < HOLE.x1; x++) {
      const i = idx(x, y);
      b.base[i * 4] = WHITE[0]; b.base[i * 4 + 1] = WHITE[1]; b.base[i * 4 + 2] = WHITE[2];
      b.base[i * 4 + 3] = 255;
    }
  }

  const fb = run(b);
  const t = tally(fb);
  assert.equal(t.whiteLeft, 0, '洞里的旧白不能污染参照色，必须仍用洞外的深色兜底');

  const c = fb[idx(HOLE.x0 + 5, 260)];
  assert.ok(c, '必须兜底');
  for (let ch = 0; ch < 3; ch++) {
    assert.ok(Math.abs(c[ch] - DARK[ch]) <= 12,
      `兜底色 rgb(${c.join(',')}) 应来自洞外的深色内容，而不是洞里的旧白`);
  }
});

test('⑧ 常量口径：ALPHA_CUTOFF / RING_MIN_N 不能被人悄悄改小', () => {
  assert.equal(ALPHA_CUTOFF, 8);
  assert.ok(RING_MIN_N >= 4, '参照色至少要几个像素才可信，1~2 个抗锯齿点不能定调');
  assert.ok(RING_MAX >= 8, '上限太小的话大片缺口兜不住（skirt 需要 2 环，这里留足余量）');
});
