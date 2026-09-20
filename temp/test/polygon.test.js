/**
 * 多边形掩码分割的测试。
 *
 * 这是「西红柿里不能有篮子」那条需求的落点：矩形切图必然把框里的邻件一起切进来，
 * 只有按部件真实轮廓（polygon）抠图才能得到干净的部件图。
 *
 * 断言都落在像素上——"框里那块邻件的颜色还在不在"是能用数值说清的，
 * 不依赖"看起来干净不干净"这种主观判断。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fillPolygon, cutImageParts } from '../../server/api/cutter.js';

const RED = [220, 40, 40];
const BLUE = [40, 80, 220];

let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'poly-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 造源图：透明底上画实心矩形 */
async function makeSource(path, W, H, blocks) {
  const px = Buffer.alloc(W * H * 4);
  for (const b of blocks) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const i = (y * W + x) * 4;
        px[i] = b.color[0]; px[i + 1] = b.color[1]; px[i + 2] = b.color[2]; px[i + 3] = 255;
      }
    }
  }
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path);
  return path;
}

/** 读切图的像素 */
async function readPixels(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** 数某个颜色的不透明像素（容差比较，bleed 会轻微改色） */
function countColor({ data, width, height }, color, tol = 30) {
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] < 128) continue;
    if (Math.abs(data[i * 4] - color[0]) <= tol &&
        Math.abs(data[i * 4 + 1] - color[1]) <= tol &&
        Math.abs(data[i * 4 + 2] - color[2]) <= tol) n++;
  }
  return n;
}

// --- fillPolygon ---

test('fillPolygon: 正方形四条边之内为 1，之外为 0', () => {
  const poly = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
  const m = fillPolygon(poly, 10, 10);

  assert.equal(m[5 * 10 + 5], 1, '正中在内部');
  assert.equal(m[0], 0, '左上角在外部');
  assert.equal(m[9 * 10 + 9], 0, '右下角在外部');
  assert.equal(m[2 * 10 + 2], 1, '顶点所在行按扫描线算在内部');
});

test('fillPolygon: 顶点顺序反过来（逆时针）结果相同', () => {
  const cw = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
  const ccw = [...cw].reverse();
  const a = fillPolygon(cw, 10, 10);
  const b = fillPolygon(ccw, 10, 10);
  assert.deepEqual(Array.from(a), Array.from(b), '奇偶规则与绕向无关');
});

test('fillPolygon: offX/offY 把源图坐标平移到裁剪窗口', () => {
  // 源图坐标里的方块 10..20，裁剪窗口从 10 开始 → 掩码里应该是 0..10
  const poly = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
  const m = fillPolygon(poly, 10, 10, 10, 10);
  assert.equal(m[5 * 10 + 5], 1, '窗口内的中心点应命中');
  assert.equal(m[0], 1, '窗口左上角就是多边形的左上角');
});

test('fillPolygon: 三角形凹口处的像素不算在内部', () => {
  // 一个 L 形（六边形），缺口在右上
  const poly = [
    { x: 2, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 5 },
    { x: 8, y: 5 }, { x: 8, y: 8 }, { x: 2, y: 8 }
  ];
  const m = fillPolygon(poly, 10, 10);
  assert.equal(m[3 * 10 + 3], 1, '缺口左下方在内部');
  assert.equal(m[3 * 10 + 7], 0, '缺口（右上）在外部');
  assert.equal(m[7 * 10 + 7], 1, '右下角在内部');
});

test('fillPolygon: 少于 3 个顶点返回空掩码，不抛错', () => {
  const m = fillPolygon([{ x: 1, y: 1 }, { x: 5, y: 5 }], 10, 10);
  assert.equal(m.reduce((a, b) => a + b, 0), 0);
});

// --- cutImageParts 的多边形切图 ---

test('cutImageParts: polygon 把框里的邻件扣掉，只留自己的颜色', async () => {
  /*
   * 模拟「西红柿和篮子」：红色方块旁边贴着蓝色方块，两者的 bbox 都被 AI 报成
   * 覆盖整片区域。没有 polygon 时红色切图里会带着蓝色；有 polygon 就该只剩红色。
   */
  const src = await makeSource(join(dir, 'two-parts.png'), 100, 100, [
    { x0: 10, x1: 50, y0: 10, y1: 90, color: RED },
    { x0: 50, x1: 90, y0: 10, y1: 90, color: BLUE }
  ]);

  // 两个部件的框都报成整片——故意的，这正是"框里必然混进邻件"的场景
  const wideBox = { x: 8, y: 8, width: 84, height: 84 };

  const parts = [
    {
      name: 'red', depth: 0, bbox: { ...wideBox }, pivot: { x: 42, y: 42 },
      // 只圈红色那一半
      polygon: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 90 }, { x: 10, y: 90 }]
    },
    {
      name: 'blue', depth: 0, bbox: { ...wideBox }, pivot: { x: 42, y: 42 },
      polygon: [{ x: 50, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 50, y: 90 }]
    }
  ];

  const out = join(dir, 'poly-cut');
  const r = await cutImageParts(src, parts, out, { margin: 0, bleed: 0, snap: true });
  assert.equal(r.length, 2);

  const redCut = await readPixels(r.find((x) => x.name === 'red').path);
  const blueCut = await readPixels(r.find((x) => x.name === 'blue').path);

  assert.ok(countColor(redCut, RED) > 3000, '红色那块必须留下');
  assert.equal(countColor(redCut, BLUE), 0, '红色切图里不能有蓝色（邻件）');
  assert.ok(countColor(blueCut, BLUE) > 3000, '蓝色那块必须留下');
  assert.equal(countColor(blueCut, RED), 0, '蓝色切图里不能有红色（邻件）');
});

test('cutImageParts: 没有 polygon 时保持矩形切图的老行为', async () => {
  const src = await makeSource(join(dir, 'no-poly.png'), 100, 100, [
    { x0: 10, x1: 50, y0: 10, y1: 90, color: RED },
    { x0: 50, x1: 90, y0: 10, y1: 90, color: BLUE }
  ]);

  const parts = [{
    name: 'both', depth: 0,
    bbox: { x: 8, y: 8, width: 84, height: 84 },
    pivot: { x: 42, y: 42 }
    // 没有 polygon
  }];

  const out = join(dir, 'rect-cut');
  const r = await cutImageParts(src, parts, out, { margin: 0, bleed: 0, snap: false });
  const cut = await readPixels(r[0].path);

  // 矩形切图应该把两块都带进来——这是老行为，也是这次改造要治的问题
  assert.ok(countColor(cut, RED) > 3000, '红色在框里');
  assert.ok(countColor(cut, BLUE) > 3000, '蓝色也在框里（矩形切图的老行为）');
});

test('cutImageParts: 窗口撑到多边形范围，被遮挡的下半部分不会被切掉', async () => {
  /*
   * AI 常把 bbox 报成"只圈住可见的那块"：西红柿露出来的上半部分。
   * 但它的 polygon 带着被遮挡的推算下缘。窗口若只按 bbox 开，
   * 下半截轮廓在窗口外，补图连该补哪都看不到。
   */
  const src = await makeSource(join(dir, 'occluded.png'), 100, 100, [
    { x0: 20, x1: 80, y0: 20, y1: 40, color: RED }   // 只有上半部分可见
  ]);

  const parts = [{
    name: 'fruit', depth: 0,
    // AI 只框了可见的上半
    bbox: { x: 20, y: 20, width: 60, height: 20 },
    pivot: { x: 30, y: 10 },
    // 但轮廓推算到了完整形状（下半是被遮挡的）
    polygon: [
      { x: 20, y: 20 }, { x: 80, y: 20 },
      { x: 80, y: 80 }, { x: 20, y: 80 }
    ]
  }];

  const out = join(dir, 'occl-cut');
  const r = await cutImageParts(src, parts, out, { margin: 0, bleed: 0, snap: true });
  const cut = await readPixels(r[0].path);

  assert.equal(cut.height, 60, `窗口应按 polygon 撑到 60 高（实际 ${cut.height}）`);
  // 下半是空的（源图那里本来就没内容），但窗口必须在——补图要往这里填
  assert.equal(cut.data[(50 * cut.width + 50) * 4 + 3], 0, '被遮挡处是透明的，等待补图');
});

test('cutImageParts: 深度擦除只擦遮挡者轮廓内的像素，不擦它框里的空白', async () => {
  /*
   * 「提手内侧多出一个方形缺口」的成因：老代码按遮挡者的**矩形框**擦，
   * 提手两弧之间的空隙也被当成遮挡，把后面的内容误伤了。
   *
   * 构造：一个 U 形遮挡者（两条竖臂 + 底下一条横梁），depth 更大。
   * 它后面的部件在 U 的口子里那块内容不该被擦。
   */
  const src = await makeSource(join(dir, 'u-shape.png'), 100, 100, [
    // 后面：整片绿色内容
    { x0: 20, x1: 80, y0: 20, y1: 80, color: [40, 200, 80] },
    // 前面：U 形（左臂、右臂、底梁），把中间的口子留空
    { x0: 20, x1: 32, y0: 20, y1: 80, color: RED },
    { x0: 68, x1: 80, y0: 20, y1: 80, color: RED },
    { x0: 20, x1: 80, y0: 68, y1: 80, color: RED }
  ]);

  const parts = [
    {
      name: 'back', depth: 0,
      bbox: { x: 18, y: 18, width: 64, height: 64 },
      pivot: { x: 32, y: 32 },
      polygon: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }]
    },
    {
      name: 'front_u', depth: 1,
      bbox: { x: 18, y: 18, width: 64, height: 64 },
      pivot: { x: 32, y: 32 },
      // U 形轮廓：外框顺时针走一圈，在顶部中间留口子
      polygon: [
        { x: 20, y: 20 }, { x: 32, y: 20 }, { x: 32, y: 68 }, { x: 68, y: 68 },
        { x: 68, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }
      ]
    }
  ];

  const out = join(dir, 'u-cut');
  const r = await cutImageParts(src, parts, out, { margin: 0, bleed: 0, snap: false });
  const backCut = await readPixels(r.find((x) => x.name === 'back').path);

  const GREEN = [40, 200, 80];
  // U 的口子正中 (50, 40)：被两条臂夹着，但那里没有遮挡者的像素，必须保留
  const ai = backCut ? null : null;
  const W = backCut.width;
  // 窗口从 18 起，所以源图 (50,40) → 窗口 (32,22)
  const mouth = (22 * W + 32) * 4;
  assert.ok(
    Math.abs(backCut.data[mouth] - GREEN[0]) <= 30 &&
    Math.abs(backCut.data[mouth + 1] - GREEN[1]) <= 30,
    `U 形口子里的内容不该被擦掉（实际 rgb=${backCut.data[mouth]},${backCut.data[mouth + 1]},${backCut.data[mouth + 2]}）`
  );

  // 左臂覆盖的地方 (25, 40) → 窗口 (7, 22) 必须被擦成透明
  const arm = (22 * W + 7) * 4;
  assert.equal(backCut.data[arm + 3], 0, '遮挡者轮廓内的像素要被擦掉');
});

test('cutImageParts: 中空轮廓（提手那种拱形）不会把洞里的内容切进来', async () => {
  /*
   * 这是 12.png 那轮最要命的一个 bug。
   *
   * 提手是两条弧 + 中间一大块空的。AI 画的多边形是"拱形外框"——从左弧底
   * 沿外沿上去、沿右弧下来、再从内侧收回去。多边形填充按奇偶规则把这个
   * 外框整个填满，把两弧之间那块（源图上是水果和篮筐）也算成了提手内部。
   *
   * 后果有两层：
   *   1. 提手切图里混进两弧之间的水果 —— 用户看到的"不干净"
   *   2. 提手当遮挡者去擦别人时，中间空洞也算它的范围，basket_back 被擦空
   *      —— 实测 basket_back 只剩 13% 不透明
   *
   * 修法：轮廓 ∩ 源图不透明像素。轮廓定"哪里可能属于我"，源图定"哪里真有东西"。
   */
  const src = await makeSource(join(dir, 'arch.png'), 100, 100, [
    // 背景内容：整片绿色（相当于篮筐后景 / 水果）
    { x0: 10, x1: 90, y0: 10, y1: 90, color: [40, 200, 80] },
    // 提手：左右两条竖臂，中间是空的
    { x0: 20, x1: 34, y0: 10, y1: 90, color: RED },
    { x0: 66, x1: 80, y0: 10, y1: 90, color: RED }
  ]);

  const parts = [
    {
      name: 'back', depth: 0,
      bbox: { x: 10, y: 10, width: 80, height: 80 }, pivot: { x: 40, y: 40 },
      polygon: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]
    },
    {
      name: 'handle', depth: 1,
      bbox: { x: 20, y: 10, width: 60, height: 80 }, pivot: { x: 30, y: 40 },
      // 拱形：沿左臂外侧上去 → 跨过顶端 → 沿右臂外侧下来 → 从两臂内侧绕回
      // 中间那块空的不在轮廓里，但多边形填充只看外沿，仍会把洞算进内部
      polygon: [
        { x: 20, y: 90 }, { x: 20, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 90 },
        { x: 66, y: 90 }, { x: 66, y: 30 }, { x: 34, y: 30 }, { x: 34, y: 90 }
      ]
    }
  ];

  const out = join(dir, 'arch-cut');
  const r = await cutImageParts(src, parts, out, { margin: 0, bleed: 0, snap: false });

  const handleCut = await readPixels(r.find((x) => x.name === 'handle').path);
  const GREEN = [40, 200, 80];

  /*
   * 提手切图：两条臂要完整，洞里那片绿色要**尽量少**。
   *
   * 断言不是"零绿色"——多边形是直线段，AI 给的拱形轮廓在内沿处跟真实
   * 弧线总有误差，实测会漏进一点点。关键是量级：不修的话洞里 32x60=1920px
   * 会整片混进来，修完应该只剩边缘那一条。
   */
  assert.ok(countColor(handleCut, RED) > 2000, '两条臂要完整切到');
  const leaked = countColor(handleCut, GREEN);
  assert.ok(
    leaked < 1920 * 0.5,
    `两弧之间的绿色（洞里的内容）应大幅减少，实际漏进 ${leaked}px（不修是 ~1920px）`
  );

  // 后景切图：两臂覆盖的地方被擦掉，但洞里的绿色必须留着
  const backCut = await readPixels(r.find((x) => x.name === 'back').path);
  assert.ok(countColor(backCut, GREEN) > 3000, '洞里那片绿色是后景的内容，不能被擦掉');
  assert.ok(
    countColor(backCut, GREEN) < 80 * 80 - 2000,
    '两臂压住的地方要被擦掉，不能整片保留'
  );
});

test('cutImageParts: 擦除掩码只标被擦的像素', async () => {
  const src = await makeSource(join(dir, 'mask.png'), 60, 60, [
    { x0: 10, x1: 50, y0: 10, y1: 50, color: [40, 200, 80] },
    { x0: 10, x1: 50, y0: 10, y1: 28, color: RED }
  ]);

  const parts = [
    {
      name: 'back', depth: 0,
      bbox: { x: 10, y: 10, width: 40, height: 40 }, pivot: { x: 20, y: 20 },
      polygon: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }]
    },
    {
      name: 'front', depth: 1,
      bbox: { x: 10, y: 10, width: 40, height: 18 }, pivot: { x: 20, y: 9 },
      polygon: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 28 }, { x: 10, y: 28 }]
    }
  ];

  const out = join(dir, 'mask-cut');
  await cutImageParts(src, parts, out, { margin: 0, bleed: 0, snap: false });

  const mask = await readPixels(join(out, 'back.erased.png'));
  let marked = 0;
  for (let i = 0; i < mask.width * mask.height; i++) if (mask.data[i * 4 + 3] > 127) marked++;
  // 遮挡区 40x18 = 720px
  assert.ok(marked > 600 && marked <= 720, `掩码应标出遮挡区（实际 ${marked}px）`);
});
