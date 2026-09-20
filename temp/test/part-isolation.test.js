/**
 * 部件隔离的回归测试：一块源图内容只能出现在一张切图里。
 *
 * 用户报的最严重的问题是「一个部位在很多张图上都会出现，头部在多个部件都有，
 * 组成 spine 动画的时候看到头部在断裂滑动」。成因不是擦除漏了，而是擦除被
 * 「本部件的 SAM 掩码认领的像素不让位」这条豁免放过了：SAM 给每个部件独立
 * 预测，body 的框圈住整个躯干，掩码很容易把连在一起的头颈一起认领进来，
 * 豁免一生效，头的像素就在 body 上留了一份，head 自己也有一份。
 *
 * 实测（scripts/dup-check.mjs，改之前）：test_role_arbg 覆盖的 111134 个源像素里
 * 有 58.3% 被多个部件同时画，body 自己 93.9% 的像素和别人重复。
 *
 * 这里用合成掩码复现同一个形状，不依赖 MobileSAM 环境，所以能进常规 CI。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { cutImageParts } from '../../server/api/cutter.js';

const W = 80, H = 120;

/** 整张不透明的源图：这样"哪里有内容"完全由掩码决定，断言才好读 */
async function makeSource(dir) {
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = 200; buf[i * 4 + 1] = 120; buf[i * 4 + 2] = 90; buf[i * 4 + 3] = 255;
  }
  const p = join(dir, 'src.png');
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(p);
  return p;
}

/** 把一个矩形区域做成 SAM 掩码 PNG（白 = 属于这个部件） */
async function maskOf({ x, y, width, height }) {
  const buf = Buffer.alloc(W * H);
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      buf[py * W + px] = 255;
    }
  }
  return sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spine-iso-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 把每张切图映射回源图坐标，统计每个源像素被哪些部件画了。
 *
 * 这就是用户看到的那个现象的量化方式：同一个源像素出现在两张切图里，
 * 就是同一块内容进了两个骨头，动起来必然各走各的。
 */
async function ownersOf(cuts) {
  const owners = new Map();
  for (const cut of cuts) {
    const { data, info } = await sharp(cut.path).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    for (let py = 0; py < info.height; py++) {
      for (let px = 0; px < info.width; px++) {
        if (data[(py * info.width + px) * 4 + 3] < 8) continue;
        const sx = cut.bbox.x + px, sy = cut.bbox.y + py;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const k = sy * W + sx;
        if (!owners.has(k)) owners.set(k, []);
        owners.get(k).push(cut.name);
      }
    }
  }
  return owners;
}

/*
 * 复现用户那张图的形状：body 的掩码把头颈一起认领了。
 *
 *   head  depth=1  y 10..50     ← 靠前，头该归它
 *   body  depth=0  y 30..110    ← 靠后，掩码却从 y=30 就开始（和头重叠 20 行）
 *
 * 重叠区 y 30..50 是矛盾点：两张掩码都认领，depth 判给 head。
 */
const OVERLAP_PARTS = [
  { name: 'body', depth: 0, bbox: { x: 20, y: 30, width: 40, height: 80 } },
  { name: 'head', depth: 1, bbox: { x: 20, y: 10, width: 40, height: 40 } }
];

async function cutOverlap(dir, { bleed = 0, margin = 0 } = {}) {
  const src = await makeSource(dir);
  const samMasks = new Map([
    // body 的掩码越界到头上：这正是 SAM 从整躯干框出发时的实际行为
    ['body', { png: await maskOf({ x: 20, y: 30, width: 40, height: 80 }) }],
    ['head', { png: await maskOf({ x: 20, y: 10, width: 40, height: 40 }) }]
  ]);
  const out = join(dir, 'cuts');
  const cuts = await cutImageParts(src, OVERLAP_PARTS, out, {
    margin, bleed, snap: false, samMasks
  });
  return { cuts, out };
}

test('掩码重叠时，一块内容只进一张切图（头部不再出现在多个部件上）', async () => {
  await withTmp(async (dir) => {
    const { cuts } = await cutOverlap(dir);
    const owners = await ownersOf(cuts);

    const dup = [...owners.values()].filter((l) => l.length > 1);
    assert.equal(dup.length, 0,
      `有 ${dup.length} 个源像素被多个部件同时画，例如 ${JSON.stringify(dup[0])}`);
  });
});

test('重叠区判给 depth 更大的那一层（靠前的可见层）', async () => {
  await withTmp(async (dir) => {
    const { cuts } = await cutOverlap(dir);
    const owners = await ownersOf(cuts);

    // y 30..50 是两张掩码都认领的那 20 行，depth 大的 head 该拿走
    let headWon = 0, bodyKept = 0;
    for (let y = 30; y < 50; y++) {
      for (let x = 20; x < 60; x++) {
        const list = owners.get(y * W + x) ?? [];
        if (list.includes('head')) headWon++;
        if (list.includes('body')) bodyKept++;
      }
    }

    assert.ok(headWon > 0, '重叠区应该归 head');
    assert.equal(bodyKept, 0, `body 不该在重叠区留下内容，实际留了 ${bodyKept}px`);
  });
});

test('让位的像素写进 .erased 掩码，补图才知道该填这里', async () => {
  await withTmp(async (dir) => {
    const { out } = await cutOverlap(dir);

    /*
     * 不写这张掩码的后果不是"少补一点"，而是整片丢掉：补图靠「透明区连不连到
     * 图边」区分 padding 和洞，让位让出来的那片按定义连到图边，会被当成
     * 部件外的留白保持透明。预览里上半身就是个黑洞。
     */
    const { data, info } = await sharp(join(out, 'body.erased.png'))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    let marked = 0;
    // alpha 是掩码语义；RGB 装真值色
    for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] > 127) marked++;

    assert.ok(marked > 0, 'body 让位给 head 的那片必须标进 erased 掩码');
  });
});

test('独占的内容一个像素都不该被擦掉（防擦空回归）', async () => {
  await withTmp(async (dir) => {
    const { cuts } = await cutOverlap(dir);
    const owners = await ownersOf(cuts);

    /*
     * 唯一归属只拿走"判给别人的那一半"，不能顺手把独占区也擦了。
     *
     * 这条是钉死一个真实回归：早先直接拿遮挡者掩码当擦除依据时，
     * left_arm 只剩 4.3% 不透明、body 剩 16.8%，预览里几乎是空图。
     */
    const count = (name, y0, y1) => {
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 20; x < 60; x++) {
          if ((owners.get(y * W + x) ?? []).includes(name)) n++;
        }
      }
      return n;
    };

    // head 独占 y 10..30（body 掩码还没开始），body 独占 y 50..110
    assert.equal(count('head', 10, 30), 20 * 40, 'head 的独占区应完整保留');
    assert.equal(count('body', 50, 110), 60 * 40, 'body 的独占区应完整保留');
  });
});

test('没有 SAM 掩码时行为不变（polygon/矩形路径不受唯一归属影响）', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(dir);
    const out = join(dir, 'cuts');

    // 不传 samMasks：走的是原来的按遮挡者轮廓擦除，唯一归属表根本不建
    const cuts = await cutImageParts(src, OVERLAP_PARTS, out, {
      margin: 0, bleed: 0, snap: false
    });

    assert.equal(cuts.length, 2);
    // 这条路径下 body 仍会被 head 的矩形擦一块，但不该整张空掉
    const { data, info } = await sharp(cuts.find((c) => c.name === 'body').path)
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] >= 8) opaque++;
    assert.ok(opaque > 0, 'body 不该被擦空');
  });
});


/* ---------- 掩码漏掉的内容要按框认领回来 ---------- */

/*
 * 这一组钉的是用户报的"头部在断裂滑动"。
 *
 * 成因：MobileSAM 是纯框提示，取 score 最高的那张掩码。喂进去一个"头"的框，
 * 它给回来的往往是**头发**——实测 test_role_arbg 的 head 掩码只盖住框内
 * 32.5% 的不透明像素，脸、下巴、耳朵、眼镜全在掩码外。
 * 于是那些像素既不在 head 切图里，也不在别的部件切图里，
 * 头一转，脸留在原地不跟着动。
 *
 * 修法是：框既是 SAM 的提示，也算一次声明——框里没被任何掩码认领的内容，
 * 归**面积最小的那个框**（声明更具体）。而 SAM 裁图那一步必须放行这种像素，
 * 否则刚认回来又被当"掩码外"删掉。
 */
const LAZY_PARTS = [
  // head 的框把整张脸都圈住了，但下面给的掩码只覆盖头上半截（模拟只认了头发）
  { name: 'head', depth: 1, bbox: { x: 10, y: 10, width: 60, height: 60 } },
  // torso 的框压在脸的下半部分——比 head 的框大，所以争不过它
  { name: 'torso', depth: 0, bbox: { x: 0, y: 40, width: 80, height: 70 } }
];

async function cutLazyMask(dir) {
  const src = await makeSource(dir);
  const samMasks = new Map([
    // head：只有上半截（y 10..30）——正是"只认了头发"的形状
    ['head', { png: await maskOf({ x: 10, y: 10, width: 60, height: 20 }) }],
    // torso：下半部分（y 40..110）
    ['torso', { png: await maskOf({ x: 0, y: 40, width: 80, height: 70 }) }]
  ]);
  const out = join(dir, 'cuts');
  const cuts = await cutImageParts(src, LAZY_PARTS, out, {
    margin: 0, bleed: 0, snap: false, samMasks
  });
  return { cuts, out };
}

test('掩码漏掉的脸部内容按框认领回来，不会谁都不画', async () => {
  await withTmp(async (dir) => {
    const { cuts } = await cutLazyMask(dir);
    const owners = await ownersOf(cuts);

    // head 框里 y 30..40 那段：head 掩码没盖、torso 掩码也没盖，
    // 但它在 head 的框内 → 必须归 head
    let covered = 0, missing = 0;
    for (let y = 30; y < 40; y++) {
      for (let x = 10; x < 70; x++) {
        const list = owners.get(y * W + x) ?? [];
        if (list.length) covered++; else missing++;
      }
    }
    assert.equal(missing, 0,
      `head 框内还有 ${missing}px 谁都没画——这些像素在动画里就是"脸不跟着头转"`);
    assert.equal(covered, 10 * 60);
  });
});

test('按框认领的内容仍然只归一个部件（不产生新的重复）', async () => {
  await withTmp(async (dir) => {
    const { cuts } = await cutLazyMask(dir);
    const owners = await ownersOf(cuts);

    const dup = [...owners.values()].filter((l) => l.length > 1);
    assert.equal(dup.length, 0,
      `按框补齐造出了重复：${JSON.stringify(dup[0])}`);
  });
});

test('两个框都圈住时归面积小的那个（声明更具体）', async () => {
  await withTmp(async (dir) => {
    const { cuts } = await cutLazyMask(dir);
    const owners = await ownersOf(cuts);

    // y 30..40 是 head(60x60=3600) 和 torso(80x70=5600) 都圈住、但两个掩码
    // 都没盖住的区域 —— 该给框更小的 head
    let headWon = 0, torsoWon = 0;
    for (let y = 30; y < 40; y++) {
      for (let x = 10; x < 70; x++) {
        const list = owners.get(y * W + x) ?? [];
        if (list.includes('head')) headWon++;
        if (list.includes('torso')) torsoWon++;
      }
    }
    assert.equal(headWon, 600, 'head 框更小，该它拿');
    assert.equal(torsoWon, 0);
  });
});

/*
 * 擦除区要分两种，它们的 alpha 处置相反。
 *
 * 用户报的"动画里断裂滑动"在数据上有两个来源，一个是归属判决（上面几条），
 * 另一个是**补图把被盖住的那片又画了一遍**：
 *
 *   1. 部件自己身上的洞（接缝、被邻件挡掉的一小块）——有真值可参考，
 *      补图该把它填实。补图靠「透明区连不到图边」识别它们（inpaint.js
 *      的 markExteriorGap），填完 alpha = 255。
 *
 *   2. 被前方部件**整个盖住**的那片——补图看不到下面是什么，只有猜。
 *      实测它照着画面里还看得见的东西推：围裙压在裙子上，裙子那片擦除区
 *      补出来全是围裙的紫灰（平均比源图暗 27 个色阶，只有 4.3% 的像素和
 *      源图接近）。那块 alpha 是 0、静态预览看不见，但两片按不同骨头转起来
 *      就是一层重影。实测 skirt∩apron 重叠 69669px、98% 落在这里。
 *
 * 所以 cutter 要单独写一张 <部件名>.front.png 标出第 2 种，让补图把它的
 * alpha 一律压成 0（内容照补，反正盖着看不见）。
 */
/*
 * 被前方盖住的那片，要分两种：源图那里本来就是空的（没有真值）
 * 和源图那里有内容（有真值）。两者的 alpha 处置相反。
 *
 *   ① 空的那种 = 围裙盖裙子。裙子画到围裙边缘就断了，源图那块是透明的；
 *      补图看不到下面是什么，只能照着画面里还看得见的东西推——它就照着
 *      围裙画了一遍（实测平均比源图暗 27 个色阶，只有 4.3% 的像素和源图
 *      接近）。那片 alpha 是 0、静态预览看不见，两片按不同骨头转起来
 *      就是一层重影。→ 写 .front.png，让补图把 alpha 压成 0。
 *
 *   ② 有内容的那种 = 眼镜盖脸。脸一直在，只是被挡着，遮挡移开就该看见。
 *      判成①会把脸整个压透明，切出来的 head 是一张没有脸的头。
 *
 * 判据用"这片里源图 alpha 为空的像素占比"，门槛 0.5（实测两类分别在
 * 0% 和接近 100%，离得很开）。
 */

/** 造一张源图：指定的 y 区间是空的，其余不透明 */
async function makeHoleySource(dir, blankRows) {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      buf[i] = 200; buf[i + 1] = 120; buf[i + 2] = 90;
      buf[i + 3] = blankRows(y) ? 0 : 255;
    }
  }
  const p = join(dir, 'src-holey.png');
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(p);
  return p;
}

/*
 * 这一组用例复现的是"围裙压裙子"的真实形状：
 *
 *   裙子（under）按自己的框一路画下去，可 y 30 以下是**源图为空的**——
 *   那截被围裙挡住了，画的时候就断了。
 *   围裙（over）盖在 y 30..50 这一段（源图正是空的那一段）。
 *
 * 补图看不到下面是什么，也没有源图可参考，只能照着画面里还看得见的东西推
 * ——它就会把围裙画一遍，那就是重影。
 *
 *   under  depth=0  x 20..60, y 0..50    （根框）
 *   over   depth=1  x 20..60, y 30..50   （盖住 under 的下缘，那里源图是空的）
 *   源图          y 0..30 有内容，30 以下全空
 */
async function cutLayered(dir, blankRows, outName) {
  const src = await makeHoleySource(dir, blankRows);
  const samMasks = new Map([
    ['under', { png: await maskOf({ x: 20, y: 0, width: 40, height: 50 }) }],
    ['over', { png: await maskOf({ x: 20, y: 30, width: 40, height: 20 }) }]
  ]);
  const out = join(dir, outName);
  const cut = await cutImageParts(src, [
    { name: 'under', depth: 0, bbox: { x: 20, y: 0, width: 40, height: 50 } },
    { name: 'over', depth: 1, bbox: { x: 20, y: 30, width: 40, height: 20 } }
  ], out, { margin: 0, bleed: 0, snap: false, samMasks });
  return { out, cut };
}

test('被前方部件盖住的那片 → 写 .front.png（标出"模型看不到下面"的位置）', async () => {
  await withTmp(async (dir) => {
    // y 30 以下源图是空的：裙子在围裙边缘就断了
    const { out, cut } = await cutLayered(dir, (y) => y >= 30, 'front-yes');

    const { data, info } = await sharp(join(out, 'under.front.png')).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });

    /*
     * 窗口比 under 的框（x20..60）宽：源图 x0..19 和 x61..79 是不透明内容、
     * 又没有落进任何框，连通性认领把它们判给了 under，窗口跟着撑过去
     * （见 cutter.js 的「窗口撑到归属范围」）。
     *
     * 断言要跟着按**源图坐标**来算，不能再假设窗口从 x20 起——那样
     * 一旦窗口撑开，px 就对不上源图的 x，前半段会数成"窗外多标的"。
     */
    const wx0 = Math.round(cut.find((c) => c.name === 'under').bbox.x);
    assert.equal(info.height, 50);
    assert.ok(info.width > 40,
      `窗口该被撑到认领范围（原始框只有 40 宽），实际 ${info.width}`);

    // over 盖住 y 30..50，那 20 行源图都是空的 => 整块该判 front
    let marked = 0, outside = 0;
    for (let py = 0; py < info.height; py++) {
      for (let px = 0; px < info.width; px++) {
        if (data[(py * info.width + px) * 4] <= 127) continue;
        // 被盖的那段是 x20..60（源图坐标）→ 换算回源图再判
        const srcX = wx0 + px;
        if (py >= 30 && srcX >= 20 && srcX < 60) marked++; else outside++;
      }
    }
    assert.equal(marked, 40 * 20, `被盖住的 40x20 块该判 front，实际 ${marked}px`);
    assert.equal(outside, 0, `只该标被盖住的那段，多标了 ${outside}px`);
  });
});

test('被盖住的那片源图有内容 → 真值写进 .erased.png（脸一直在，不能被压成透明）', async () => {
  await withTmp(async (dir) => {
    // 全图都有内容：脸一直在，只是被眼镜挡着
    const { out, cut } = await cutLayered(dir, () => false, 'truth-in-mask');

    /*
     * 这片的处置有两层，缺一不可：
     *
     *   ① 形状上该让位 —— 它被 over 盖着，写进 .erased.png 让补图知道要填。
     *   ② 颜色上不能靠模型 —— 模型看不到下面是什么，会照着 over 画。
     *      cutter 顺手把源图在那里的原样 RGB 写进 .erased.png 的像素，
     *      补图选完轮次后贴回来（见 inpaint.js）。
     *
     * 曾经这里判的是"源图有内容就不写 .front.png"，靠保留 alpha 不压来保住脸。
     * 那条路在实测上翻车了：.front.png 压根不落盘 → 补图照常把这片补成
     * 遮挡者的复制品（实测 role7 75.1%、12 62.2% 的"重复"就是这么来的）。
     * 现在改成"让位 + 贴真值"，脸还在，接缝也不会错色。
     */
    const { data, info } = await sharp(join(out, 'under.erased.png')).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });

    const wx0 = Math.round(cut.find((c) => c.name === 'under').bbox.x);
    const wy0 = Math.round(cut.find((c) => c.name === 'under').bbox.y);
    let em = 0, withTruth = 0;
    // 窗口可能被认领撑开过，按源图坐标换算回窗口坐标再遍历
    for (let sy = 30; sy < 50; sy++) {
      for (let sx = 20; sx < 60; sx++) {
        const py = sy - wy0, px = sx - wx0;
        if (py < 0 || px < 0 || py >= info.height || px >= info.width) continue;
        const i = py * info.width + px;
        if (data[i * 4 + 3] <= 127) continue;      // 不在擦除掩码里
        em++;
        // 源图那块有内容 => 掩码像素里必须存着真值（非全零）
        if (data[i * 4] || data[i * 4 + 1] || data[i * 4 + 2]) withTruth++;
      }
    }
    assert.equal(em, 40 * 20, `擦除掩码要标出这 40x20 块，补图才知道该填这里，实际 ${em}px`);
    assert.equal(withTruth, 40 * 20,
      `这 40x20 块源图有内容，真值必须写进掩码（补图据此贴回，不让模型编），实际只有 ${withTruth}px`);
  });
});

test('没被任何前方部件盖住时，不写 .front.png', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(dir);
    const samMasks = new Map([
      ['a', { png: await maskOf({ x: 0, y: 0, width: 80, height: 60 }) }],
      ['b', { png: await maskOf({ x: 0, y: 60, width: 80, height: 60 }) }]
    ]);
    const out = join(dir, 'cuts2');
    await cutImageParts(src, [
      { name: 'a', depth: 0, bbox: { x: 0, y: 0, width: 80, height: 60 } },
      { name: 'b', depth: 1, bbox: { x: 0, y: 60, width: 80, height: 60 } }
    ], out, { margin: 0, bleed: 0, snap: false, samMasks });

    // 两块不重叠，谁都没被盖住
    for (const n of ['a', 'b']) {
      assert.ok(!existsSync(join(out, `${n}.front.png`)),
        `${n} 没被盖住就不该有 front 掩码`);
    }
  });
});

/*
 * 遮挡者的 SAM 掩码会外溢，不能直接当"它盖住了这里"。
 *
 * 用户那张图上的实例：眼镜的框（67,112 135x111）里，SAM 回来的掩码覆盖
 * 10039px，而眼镜本身只有 9889px 的内容——多出来的那片是整张脸。
 * 眼镜 depth=3 比 head 的 depth=1 深，于是 head 的脸（脸中心是皮肤色
 * rgb(249,190,163)）被当成"被眼镜盖住"整片擦掉，补图又把它的 alpha 压成 0，
 * 切出来的 head 是一张没有脸的头。
 *
 * 这里用合成掩码复现同一个形状：靠前的部件掩码盖过头，但它自己没有内容。
 */
test('遮挡者掩码外溢时，不能把被盖部件的内容一起擦掉', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(dir);

    /*
     * 形状照着眼镜那个实例摆：
     *
     *   head   depth=0  框 x 0..80,  y 10..70   ← 脸，整块都是内容
     *   specs  depth=1  框 x 48..80, y 10..70   ← 眼镜，只压在脸的右半边
     *
     * 但 specs 的 SAM 掩码**外溢到整个框之外**，把 x 0..48（左半张脸、
     * 眼镜根本不在那儿）也盖住了。原代码直接用这张掩码判遮挡，于是
     * specs 把左半张脸也擦掉、补图再压成透明，head 就少了半张脸。
     */
    const PARTS = [
      { name: 'head', depth: 0, bbox: { x: 0, y: 10, width: 80, height: 60 } },
      { name: 'specs', depth: 1, bbox: { x: 48, y: 10, width: 32, height: 60 } }
    ];
    const headMask = await maskOf({ x: 0, y: 10, width: 80, height: 60 });
    // specs 的掩码盖住左半张脸——外溢，那里根本没有眼镜
    const specMask = await maskOf({ x: 0, y: 10, width: 80, height: 60 });
    const samMasks = new Map([
      ['head', { png: headMask }],
      ['specs', { png: specMask }]
    ]);
    const out = join(dir, 'cuts3');
    const cuts = await cutImageParts(src, PARTS, out, {
      margin: 0, bleed: 0, snap: false, samMasks
    });

    const owners = await ownersOf(cuts);

    // x 0..48 那半张脸：specs 的框没盖到，掩码却盖到了 => 该留给 head
    let leftPx = 0;
    for (let y = 10; y < 70; y++) {
      for (let x = 0; x < 48; x++) {
        if ((owners.get(y * W + x) ?? []).includes('head')) leftPx++;
      }
    }
    assert.equal(leftPx, 48 * 60,
      `左半张脸（x 0..48，眼镜框根本不在那儿）被 specs 外溢的掩码吃掉了，只剩 ${leftPx}px`);

    // x 48..80 那半张：specs 真的压在这儿，按 depth 该让给它
    let rightHead = 0;
    for (let y = 10; y < 70; y++) {
      for (let x = 48; x < 80; x++) {
        if ((owners.get(y * W + x) ?? []).includes('head')) rightHead++;
      }
    }
    assert.equal(rightHead, 0,
      `x 48..80 是 specs 真正遮住的地方，head 不该留着，实际留了 ${rightHead}px`);
  });
});

/**
 * 窗口要按归属表撑开：认领到框外的内容，得让窗口装得下才画得出来。
 *
 * 这一条补的是一个**只对了归属、画不出来的**中间状态：连通性认领把框外的
 * 内容判给了某部件（归属表对了、日志也打了"认领 N px"），但切图窗口
 * 仍是「AI 的框 ± margin」，那片像素在窗口外，一个都画不出来。
 *
 * 实测 test_role_arbg：认领 12619px 之后，切图仍漏掉源图内容的 6.76%
 * （集中在左袖外沿、发髻边、裙摆两侧——全是长条部件的外轮廓）。
 * 把窗口撑开之后是 0.00%。
 *
 * 判据用 checkMissingContent 而不是 checkCoverage：后者要把切图贴回源图
 * 坐标才能分类，位置一取错就整张图错位（这正是当时误报 9.78% 的原因）。
 * 这里只问"这块内容有没有人画"。
 */
test('内容落在所有框之外时，认领之后窗口要跟着撑开（否则认了也画不出）', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(dir);
    /*
     * 复现实测里那个形状：部件自己的框只圈住中间一段，上下两端的内容
     * 落在所有框之外。旧行为下这两端谁都画不出来。
     *
     *   part  框 y 40..80（中间那段）
     *   源图  y 0..120 全不透明
     *   => y 0..40 和 y 80..120 都是"框外无主内容"，认领给 part，
     *      但窗口不撑开的话画不出来
     */
    const samMasks = new Map([
      ['part', { png: await maskOf({ x: 0, y: 40, width: 80, height: 40 }) }]
    ]);
    const out = join(dir, 'grow');
    const cut = await cutImageParts(src, [
      { name: 'part', depth: 0, bbox: { x: 0, y: 40, width: 80, height: 40 } }
    ], out, { margin: 0, bleed: 0, snap: false, samMasks,
      growCap: Number(process.env.TEST_GROW_CAP ?? 120) });

    const { data, info } = await sharp(cut[0].path).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(cut[0].bbox.y, 0, '窗口上边该撑到认领范围的最上沿');
    assert.equal(cut[0].bbox.height, H, '窗口该覆盖整片被认领的内容');

    // 逐像素：源图不透明的地方，切图里必须有不透明像素
    let missing = 0;
    const y0 = cut[0].bbox.y, x0 = cut[0].bbox.x;
    for (let sy = 0; sy < H; sy++) {
      for (let sx = 0; sx < W; sx++) {
        const py = sy - y0, px = sx - x0;
        if (py < 0 || px < 0 || py >= info.height || px >= info.width) { missing++; continue; }
        if (data[(py * info.width + px) * 4 + 3] < 8) missing++;
      }
    }
    assert.equal(missing, 0, `源图有内容、切图里却没有的像素：${missing}（窗口没撑开？）`);
  });
});

/**
 * 撑开有上限：认领是基于连通性的推断，偶尔会顺着邻件传染出去。
 * 没有上限的话一次误判就能把窗口撑到整张图。
 */
test('窗口撑开有单边上限，不会被误认的像素拉爆', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(dir);
    // 掩码只盖中间一条，但源图整张不透明 => 上下两片都会被认领给 part。
    // 用 growCap 限制后，窗口不该吃到整张图的高度。
    const samMasks = new Map([
      ['part', { png: await maskOf({ x: 0, y: 60, width: 80, height: 4 }) }]
    ]);
    const out = join(dir, 'cap');
    const cut = await cutImageParts(src, [
      { name: 'part', depth: 0, bbox: { x: 0, y: 60, width: 80, height: 4 } }
    ], out, { margin: 0, bleed: 0, snap: false, samMasks, growCap: 10 });

    assert.ok(cut[0].bbox.height <= 4 + 20,
      `growCap=10 时窗口高不该超过 24，实际 ${cut[0].bbox.height}`);
  });
});

/**
 * 没有 SAM 掩码的部件（掩码被判太差、没进归属表）走 polygon 分支时，
 * 轮廓外属于它的内容不能被当成"邻件"删掉。
 *
 * 实测 role2：`left_arm` 的掩码几乎为空（占框内 8.9%）被丢掉，
 * 归属表里就没有 left_arm 这个条目，于是 `ownerOf[...] === 'left_arm'`
 * 永远为假，它整条袖子在轮廓外的那 1577px 被删得一个不剩——内容漏失 1.12%，
 * 主块 1343px 落在 x232..290 y587..740，正是袖子下段。
 *
 * 兜底规则保守：只认领**别的框都没圈住**的像素。没有掩码就没有证据说
 * 这块是我的，只能靠"没有别人声索"来判。
 */
test('没有掩码的部件走 polygon 时，轮廓外没人声索的内容不能删', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(dir);
    /*
     * 复现形状：一个部件有掩码（进归属表），另一个没有（走 polygon）。
     * 没有掩码那个的多边形只盖住左半，右半是它自己的内容、又不在
     * 有掩码那个的框内 —— 旧行为下右半被删掉，没人画。
     *
     *   poly   轮廓 x0..40（左半），框 x0..80
     *   other  掩码 + 框 x0..40（左半）
     *   => x40..80 不在 other 的框内，该留给 poly
     */
    const square = [
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: H }, { x: 0, y: H }
    ];
    const samMasks = new Map([
      ['other', { png: await maskOf({ x: 0, y: 0, width: 40, height: H }) }]
    ]);
    const out = join(dir, 'poly-fallback');
    const cut = await cutImageParts(src, [
      { name: 'poly', depth: 0, bbox: { x: 0, y: 0, width: W, height: H }, polygon: square },
      { name: 'other', depth: 1, bbox: { x: 0, y: 0, width: 40, height: H } }
    ], out, { margin: 0, bleed: 0, snap: false, samMasks });

    // poly 的切图里，x40..80 那片不能被删空（源图那儿有内容）
    const { data, info } = await sharp(join(out, 'poly.png')).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    let keptRight = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 40; x < Math.min(80, info.width); x++) {
        if (data[(y * info.width + x) * 4 + 3] >= 8) keptRight++;
      }
    }
    assert.ok(keptRight > 0,
      '轮廓外、又没别人声索的内容该保留，实际被整片删掉了');
    void cut;
  });
});
