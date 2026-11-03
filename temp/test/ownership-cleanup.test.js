/**
 * 归属表清理：孤岛和线头改判给真正的主人。
 *
 * 实测 kkk 基线：cape 被切成主体 + 9 块碎片（1337px），body 里夹着披风的深绿碎片，
 * 各部件合计 185 个 1px 线头——用户截图里那些「边边角角」。
 * 它们都是 SAM 掩码、多边形、框认领、连通认领四遍叠出来的边角料。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupOwnership } from '../../server/api/ownership-cleanup.js';

const W = 40, H = 40;
/** 造一张归属表：fill(x,y) 返回该像素的主人 */
function table(fill) {
  const t = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[y * W + x] = fill(x, y);
  return t;
}
const count = (t, name) => t.filter((v) => v === name).length;

test('小孤岛判给接触最多的邻居', () => {
  // A 占左半，B 占右半；A 在 B 区里还有一块 3x3 孤岛
  const t = table((x, y) => {
    if (x >= 30 && x < 33 && y >= 10 && y < 13) return 'A';
    return x < 20 ? 'A' : 'B';
  });
  const r = cleanupOwnership(t, W, H);
  assert.equal(r.islandPx, 9);
  assert.equal(t[11 * W + 31], 'B');
  assert.equal(count(t, 'A'), 20 * 40);
});

test('大块不算孤岛：被隔开的两段都保留', () => {
  // A 两块：20x20 和 10x10（面积 25%，超过 15%），中间隔着 B
  const t = table((x, y) => {
    if (x < 20 && y < 20) return 'A';
    if (x >= 28 && x < 38 && y >= 28 && y < 38) return 'A';
    return 'B';
  });
  const r = cleanupOwnership(t, W, H);
  assert.equal(r.islandPx, 0);
  assert.equal(count(t, 'A'), 400 + 100);
});

test('只挨着空白的孤岛留给原部件（源图里本来就是分开的一小块）', () => {
  const t = table((x, y) => {
    if (x < 20 && y < 20) return 'A';
    if (x >= 30 && x < 32 && y >= 30 && y < 32) return 'A';
    return null;
  });
  const r = cleanupOwnership(t, W, H);
  assert.equal(r.islandPx, 0);
  assert.equal(t[30 * W + 30], 'A');
});

test('伸进空白里的 1px 线留着（轮廓描边、发丝）', () => {
  const t = table((x, y) => {
    if (y === 10 && x >= 20 && x < 24) return 'A';
    return x < 20 ? 'A' : null;
  });
  const r = cleanupOwnership(t, W, H);
  assert.equal(r.hairPx, 0);
  assert.equal(t[10 * W + 23], 'A');
});

test('1px 线头判给周围多数', () => {
  // A 占 x<20；在 y=10 这一行伸出一条 1px 宽、4px 长的线进 B 区
  const t = table((x, y) => {
    if (y === 10 && x >= 20 && x < 24) return 'A';
    return x < 20 ? 'A' : 'B';
  });
  const r = cleanupOwnership(t, W, H);
  assert.equal(r.hairPx, 4);
  for (let x = 20; x < 24; x++) assert.equal(t[10 * W + x], 'B');
});

test('2px 宽的发丝保留', () => {
  // A 占 x<20；伸出一条 2px 宽、15px 长的条
  const t = table((x, y) => {
    if ((y === 10 || y === 11) && x >= 20 && x < 35) return 'A';
    return x < 20 ? 'A' : 'B';
  });
  const r = cleanupOwnership(t, W, H);
  assert.equal(r.hairPx, 0);
  assert.equal(t[10 * W + 34], 'A');
});

test('处理后每个像素仍只有一个归属', () => {
  const t = table((x, y) => ((x * 7 + y * 13) % 5 === 0 ? 'A' : x < 20 ? 'B' : null));
  cleanupOwnership(t, W, H);
  assert.equal(t.length, W * H);
  assert.ok(t.every((v) => v === null || typeof v === 'string'));
});

/** 造 RGBA：color(x,y) 返回 [r,g,b] */
function rgba(color) {
  const b = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, bl] = color(x, y), i = (y * W + x) * 4;
    b[i] = r; b[i + 1] = g; b[i + 2] = bl; b[i + 3] = 255;
  }
  return b;
}

test('颜色像原部件的大孤岛留着（被隔开的披风领子不该判给身体）', () => {
  // A=墨绿占左半，B=黄占右半；A 在 B 区里有一块 8x8 墨绿孤岛（64px，不到主体 15%）
  const inIsland = (x, y) => x >= 28 && x < 36 && y >= 10 && y < 18;
  const t = table((x, y) => (inIsland(x, y) ? 'A' : x < 20 ? 'A' : 'B'));
  const img = rgba((x, y) => (inIsland(x, y) || x < 20 ? [50, 90, 80] : [220, 160, 40]));
  const r = cleanupOwnership(t, W, H, { rgba: img });
  assert.equal(r.islandPx, 0);
  assert.equal(t[12 * W + 30], 'A');
});

test('颜色像邻居的大孤岛判给邻居', () => {
  const inIsland = (x, y) => x >= 28 && x < 36 && y >= 10 && y < 18;
  const t = table((x, y) => (inIsland(x, y) ? 'A' : x < 20 ? 'A' : 'B'));
  const img = rgba((x, y) => (x < 20 ? [50, 90, 80] : [220, 160, 40]));
  const r = cleanupOwnership(t, W, H, { rgba: img });
  assert.equal(r.islandPx, 64);
  assert.equal(t[12 * W + 30], 'B');
});

test('整个部件都是 1px 线条（细框眼镜）时不当线头，否则这个部件被清空', () => {
  // face 铺满，glasses 是压在上面的 1px 方框
  const t = table((x, y) => {
    const onFrame = (x >= 10 && x <= 29 && (y === 15 || y === 24)) || ((x === 10 || x === 29) && y >= 15 && y <= 24);
    return onFrame ? 'glasses' : 'face';
  });
  const before = count(t, 'glasses');
  // 和生产一样带上源图颜色：闭合的框把镜片里的脸隔成孤岛，靠颜色判断它还是脸
  const rgba = Buffer.alloc(W * H * 4);
  t.forEach((o, i) => rgba.set(o === 'glasses' ? [20, 20, 20, 255] : [240, 190, 160, 255], i * 4));
  cleanupOwnership(t, W, H, { rgba });
  assert.equal(count(t, 'glasses'), before, '眼镜框被判给了脸，或镜片里的脸被判给了眼镜');
});

/*
 * 2026-11-02 用户截图：upper_arm_right 右上角两条橙色细线——是上衣短袖的下摆边，
 * 切口偏了几个像素，2-4px 宽的一条留在了白袖子上。连着手臂主体，不是孤岛；
 * 比 1px 宽，不是线头。两条规则都抓不到。
 */
// 场景用大一点的画布：黄边在手臂上的占比要像实测那样只有几个百分点
const AW = 80, AH = 70;
function armScene(stripColor) {
  const WHITE = [230, 222, 205], YELLOW = [225, 160, 50];
  // 上衣（黄）占上方 y<10 和右侧 x>=60；袖子（白）x 5..44, y 10..69
  // 两种黄边：袖子上沿 2px 的带子（y 10..11, x 10..29），和从袖子右边伸进上衣的 3px 细条（y 15..17, x 45..59）
  const t = [];
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    t.push(y < 10 || x >= 60 ? 'body'
      : x >= 5 && x < 45 && y >= 10 ? 'arm'
        : x >= 45 && x < 60 && y >= 15 && y < 18 ? 'arm' : null);
  }
  const rgba = Buffer.alloc(AW * AH * 4);
  t.forEach((o, i) => {
    const x = i % AW, y = (i / AW) | 0;
    const foreign = o === 'arm' && ((y < 12 && x >= 10 && x < 30) || x >= 45);
    const c = o === 'body' ? YELLOW : o === 'arm' ? (foreign ? stripColor(YELLOW, WHITE) : WHITE) : [0, 0, 0];
    rgba.set([...c, o ? 255 : 0], i * 4);
  });
  return { t, rgba };
}

test('细凸起颜色像邻件（上衣下摆的黄边挂在袖子上）→ 还给邻件', () => {
  const { t, rgba } = armScene((yellow) => yellow);
  cleanupOwnership(t, AW, AH, { rgba });
  assert.equal(t[16 * AW + 52], 'body', '伸出去的黄色细条应该归上衣');
  assert.equal(t[10 * AW + 20], 'body', '袖子上沿的黄边应该归上衣');
  assert.equal(t[11 * AW + 20], 'body');
  assert.equal(t[30 * AW + 20], 'arm', '袖子主体不动');
  assert.equal(t[12 * AW + 20], 'arm', '白色的袖子上沿不动');
});

test('细凸起颜色像自己（自己的一缕发丝、袖口褶）→ 留着', () => {
  const { t, rgba } = armScene((yellow, white) => white);
  cleanupOwnership(t, AW, AH, { rgba });
  assert.equal(t[16 * AW + 52], 'arm');
  assert.equal(t[10 * AW + 20], 'arm');
});

test('邻件边吸走后，夹在中间没吸走的暗点（描边像素）不能留成孤立碎点', () => {
  const { t, rgba } = armScene((yellow) => yellow);
  rgba.set([40, 40, 40, 255], (10 * AW + 20) * 4);   // 黄带里一颗描边色像素，颜色判不出像谁
  cleanupOwnership(t, AW, AH, { rgba });
  assert.equal(t[11 * AW + 20], 'body');
  assert.equal(t[10 * AW + 20], 'body', '周围都归了上衣，这一颗留在手臂上就是飘着的碎点');
});

/*
 * 2026-11-02 kkk 实测副作用：模板让黄短袖归手臂，left_upper_arm 上三分之一是黄的。
 * 邻件边规则把它和上衣交界那 4px 里的黄像素吸走、描边像素留下，两边肩线都成了锯齿。
 * 自己身上大片有的颜色不是「挂错的」。
 */
test('自己大片拥有的颜色（归手臂的黄短袖）不当挂错的邻件边', () => {
  const YELLOW = [225, 160, 50], WHITE = [230, 222, 205];
  const t = table((x, y) => (y < 10 ? 'body' : x >= 5 && x < 25 && y < 30 ? 'arm' : null));
  const rgba = Buffer.alloc(W * H * 4);
  // 手臂上半截（y 10..17）是黄短袖，占手臂 40%
  t.forEach((o, i) => { const y = (i / W) | 0; rgba.set([...(o === 'body' || (o === 'arm' && y < 18) ? YELLOW : WHITE), o ? 255 : 0], i * 4); });
  cleanupOwnership(t, W, H, { rgba });
  for (const y of [10, 11, 12, 13]) assert.equal(t[y * W + 15], 'arm', `(15,${y}) 被吸回了上衣`);
});

/*
 * 2026-11-03 结算图实测：Complete 那行字的蓝描边外沿、投影、外发光有 10 多像素宽，
 * 切口只吃到字身，那圈留在了横幅上——横幅补完字以后，中间一圈蓝边和淡色晕。
 * 4px 的邻件边带子只吸回了里面那截。
 * 发光和投影是**前层**画在后层上的：后层挨着前层、颜色像前层的那圈，带子放宽还给前层；
 * 后层让出来的地方由补图重画。反方向（前层身上像后层的颜色）仍然只动 4px。
 */
const GW = 240, GH = 140;
function glowScene() {
  const PURPLE = [120, 70, 200], PINK = [250, 170, 210], BLUE = [40, 110, 230];
  // 字：x 100..139, y 60..79，外 3px 是自己的蓝描边；横幅：其余全部，字外 1..10px 是字的蓝色外沿
  const inText = (x, y) => x >= 100 && x < 140 && y >= 60 && y < 80;
  const ring = (x, y) => Math.max(100 - x, x - 139, 60 - y, y - 79);
  const t = [], rgba = Buffer.alloc(GW * GH * 4);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x;
    t.push(inText(x, y) ? 'text' : 'banner');
    const d = ring(x, y);
    const c = inText(x, y) ? (d > -3 ? BLUE : PINK) : d <= 10 ? BLUE : PURPLE;
    rgba.set([...c, 255], i * 4);
  }
  return { t, rgba };
}

test('前层的外发光/投影留在后层上（字的蓝边挂在横幅上 10px 宽）→ 整圈还给前层', () => {
  const { t, rgba } = glowScene();
  cleanupOwnership(t, GW, GH, { rgba, depthOf: new Map([['banner', 0], ['text', 3]]) });
  assert.equal(t[70 * GW + 98], 'text', '离字 2px');
  assert.equal(t[70 * GW + 92], 'text', '离字 8px：4px 带子够不到');
  assert.equal(t[70 * GW + 90], 'text', '离字 10px');
  assert.equal(t[70 * GW + 85], 'banner', '外沿以外的紫色横幅不动');
});

test('没有深度、或者挂着的是后层的颜色：带子仍是 4px（人物部件的老行为不变）', () => {
  const a = glowScene();
  cleanupOwnership(a.t, GW, GH, { rgba: a.rgba });
  assert.equal(a.t[70 * GW + 92], 'banner', '不给深度时照旧只吸 4px');
  const b = glowScene();
  cleanupOwnership(b.t, GW, GH, { rgba: b.rgba, depthOf: new Map([['banner', 3], ['text', 0]]) });
  assert.equal(b.t[70 * GW + 92], 'banner', '字在横幅后面时，横幅身上那圈不是字的发光');
});

test('后层身上挂的发光很多时（几个字的蓝边加起来），后层的颜色分布按远离前层的部分算', () => {
  // 蓝色外沿占横幅 ~15%：按整个横幅算，蓝色就成了横幅「自己大片拥有」的颜色，旧判据一口不吸
  const PURPLE = [120, 70, 200], PINK = [250, 170, 210], BLUE = [40, 110, 230];
  const w = 120, h = 80;
  const inText = (x, y) => x >= 45 && x < 75 && y >= 30 && y < 50;
  const ring = (x, y) => Math.max(45 - x, x - 74, 30 - y, y - 49);
  const t = [], px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    t.push(inText(x, y) ? 'text' : 'banner');
    const d = ring(x, y);
    px.set([...(inText(x, y) ? (d > -3 ? BLUE : PINK) : d <= 10 ? BLUE : PURPLE), 255], (y * w + x) * 4);
  }
  cleanupOwnership(t, w, h, { rgba: px, depthOf: new Map([['banner', 0], ['text', 3]]) });
  assert.equal(t[40 * w + 41], 'text', '离字 4px');
  assert.equal(t[40 * w + 37], 'text', '离字 8px');
  assert.equal(t[40 * w + 25], 'banner');
});

test('整个都贴着前层的小件（离前层全在发光带子里），不按发光处理，只动 4px', () => {
  // 小件 12px 宽，紧挨前层；颜色和前层一样，但它就是自己的内容
  const BLUE = [40, 110, 230];
  const w = 60, h = 40;
  const t = [], px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    t.push(x < 30 ? 'front' : x < 42 && y >= 10 && y < 30 ? 'small' : null);
    px.set([...BLUE, t[t.length - 1] ? 255 : 0], (y * w + x) * 4);
  }
  cleanupOwnership(t, w, h, { rgba: px, depthOf: new Map([['small', 0], ['front', 2]]) });
  assert.equal(t[20 * w + 38], 'small', '离前层 8px 的像素是小件自己的');
});
