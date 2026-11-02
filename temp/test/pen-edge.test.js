/**
 * 钢笔路径切口：前层压在后层身上的那条切口，转成锚点 + 曲线再抗锯齿画回去。
 *
 * 归属表是逐像素 0/1，切口是台阶和锯齿（用户：「部件边缘还是不够干净，
 * 肉眼就可以看出来」）。描成路径再画能去掉台阶；锚点再吸到原图的黑色描线
 * 外沿上，切歪的地方（邻件颜色挂在边上、自己的描线被切给邻件）也一并纠正。
 * 对着透明背景的外轮廓是画师画好的过渡，不动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { penEdge } from '../../server/api/pen-edge.js';

const W = 40, H = 40;
const RED = [200, 40, 40], BLUE = [40, 40, 200], INK = [20, 20, 20];

/** colorAt(x,y) → [r,g,b] 或 null（透明）；ownerAt(x,y) → 'F' | 'B' | null */
function scene(colorAt, ownerAt) {
  const src = Buffer.alloc(W * H * 4);
  const mine = new Uint8Array(W * H), behind = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = colorAt(x, y);
    if (!c) continue;
    src.set([...c, 255], i * 4);
    const o = ownerAt(x, y);
    if (o === 'F') mine[i] = 1;
    else if (o === 'B') behind[i] = 1;
  }
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) if (mine[i]) src.copy(buf, i * 4, i * 4, i * 4 + 4);
  return { src, mine, behind, buf };
}
const alpha = (out, x, y) => out[(y * W + x) * 4 + 3];

test('斜线的 1px 锯齿：内角往外补成斜线，本部件自己一格不削（后层没补到也不露底）', async () => {
  // 斜率 1/3 的切口按像素 0/1 判出来就是一格一格的台阶
  const bx = (y) => 10 + Math.floor(y / 3);
  const s = scene((x, y) => (x < bx(y) ? RED : BLUE), (x, y) => (x < bx(y) ? 'F' : 'B'));
  const { buf: out } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  let shrunk = 0, grown = 0;
  for (let y = 4; y < 36; y++) for (let x = 0; x < W; x++) {
    const a = alpha(out, x, y), i = y * W + x;
    if (s.mine[i] && a < 255) shrunk++;
    if (s.behind[i] && a > 64) grown++;
  }
  assert.equal(shrunk, 0, '没吸附的地方不往里收');
  assert.ok(grown >= 3, `台阶内角应补上一点，实际 ${grown}`);
  assert.equal(alpha(out, 37, 20), 0, '远处的后层不归我');
});

test('自己描线外侧挂着一条邻件颜色 → 切口收回到描线外沿', async () => {
  // F 红色到 x=15，x=16..17 是 F 的描线，x=18..19 是挂错给 F 的蓝色窄条
  const s = scene(
    (x) => (x < 16 ? RED : x < 18 ? INK : BLUE),
    (x) => (x < 20 ? 'F' : 'B')
  );
  const { buf: out, snapped } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  assert.ok(snapped > 0);
  for (let y = 10; y < 30; y++) {
    assert.ok(alpha(out, 19, y) <= 40, `(19,${y}) 蓝条应去掉，实际 ${alpha(out, 19, y)}`);
    assert.ok(alpha(out, 18, y) <= 40, `(18,${y}) 蓝条应去掉，实际 ${alpha(out, 18, y)}`);
    assert.ok(alpha(out, 17, y) >= 200, `(17,${y}) 描线要留着`);
  }
});

test('自己的描线被切给了后层 → 切口外推到描线外沿，颜色取源图', async () => {
  const s = scene(
    (x) => (x < 16 ? RED : x < 18 ? INK : BLUE),
    (x) => (x < 16 ? 'F' : 'B')
  );
  const { buf: out } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  for (let y = 10; y < 30; y++) {
    assert.ok(alpha(out, 16, y) >= 200, `(16,${y}) 描线应归回 F，实际 ${alpha(out, 16, y)}`);
    assert.ok(alpha(out, 17, y) >= 200, `(17,${y}) 描线应归回 F，实际 ${alpha(out, 17, y)}`);
    assert.ok(alpha(out, 19, y) <= 40, `(19,${y}) 蓝色不该长过来`);
    const i = (y * W + 17) * 4;
    assert.ok(out[i] < 60 && out[i + 2] < 60, '长出来的像素用源图的描线色');
  }
});

test('明显的大台阶是真实形状，不被抹平', async () => {
  const bx = (y) => 10 + 6 * Math.floor(y / 10);
  const s = scene((x, y) => (x < bx(y) ? RED : BLUE), (x, y) => (x < bx(y) ? 'F' : 'B'));
  const { buf: out } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  assert.ok(alpha(out, 14, 15) >= 200, '台阶中段归 F');
  assert.ok(alpha(out, 17, 5) <= 40, '台阶中段归 B');
});

test('窗口上下边缘不会因为拐角平滑长进后层', async () => {
  const s = scene((x) => (x < 20 ? RED : BLUE), (x) => (x < 20 ? 'F' : 'B'));
  const { buf: out } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  for (const y of [0, 1, 38, 39]) {
    assert.ok(alpha(out, 21, y) <= 20, `(21,${y}) 实际 ${alpha(out, 21, y)}`);
    assert.ok(alpha(out, 19, y) >= 235, `(19,${y}) 实际 ${alpha(out, 19, y)}`);
  }
});

test('对着透明背景的外轮廓原样不动', async () => {
  const s = scene((x, y) => (x < 10 + 4 * Math.floor(y / 8) ? RED : null), (x) => 'F');
  const { buf: out } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  assert.ok(out.equals(s.buf));
});

test('后层本身是深色：找不到有界的描线就不吸附', async () => {
  const s = scene((x) => (x < 20 ? RED : [10, 10, 10]), (x) => (x < 20 ? 'F' : 'B'));
  const { buf: out } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  for (let y = 10; y < 30; y++) {
    assert.ok(alpha(out, 19, y) >= 200);
    assert.ok(alpha(out, 21, y) <= 40, `(21,${y}) 不该吃进深色后层`);
  }
});

test('2px 细线部件不会被平滑抹掉', async () => {
  const s = scene((x) => (x === 19 || x === 20 ? RED : BLUE), (x) => (x === 19 || x === 20 ? 'F' : 'B'));
  const { buf: out } = await penEdge(s.buf, W, H, s.mine, s.behind, s.src);
  for (let y = 5; y < 35; y++) {
    assert.ok(alpha(out, 19, y) >= 200 && alpha(out, 20, y) >= 200, `(19/20,${y}) 细线要留住`);
  }
});

test('平滑削断细桥后掉出来的小块一并去掉（靴子边那条描线碎片）', async () => {
  const { dropSplitPieces } = await import('../../server/api/pen-edge.js');
  // before：主体 x<15，外加一条 2x8 的小条，靠 (15..17, 20) 一格宽的桥连着
  const before = Buffer.alloc(W * H * 4), after = Buffer.alloc(W * H * 4);
  const on = (b, x, y, a = 255) => { b[(y * W + x) * 4 + 3] = a; };
  for (let y = 0; y < H; y++) for (let x = 0; x < 15; x++) { on(before, x, y); on(after, x, y); }
  for (let y = 16; y < 24; y++) for (let x = 18; x < 20; x++) { on(before, x, y); on(after, x, y); }
  for (let x = 15; x < 18; x++) on(before, x, 20);   // after 里桥没了
  const out = dropSplitPieces(before, after, W, H);
  assert.equal(alpha(out, 18, 18), 0, '掉出来的小条去掉');
  assert.equal(alpha(out, 5, 5), 255, '主体不动');
});

test('削断后掉出来的是大块 → 那一片恢复原样，不扔', async () => {
  const { dropSplitPieces } = await import('../../server/api/pen-edge.js');
  const before = Buffer.alloc(W * H * 4), after = Buffer.alloc(W * H * 4);
  const on = (b, x, y, a = 255) => { b[(y * W + x) * 4 + 3] = a; };
  // 左右两大块，中间一格宽的桥
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x < 18 || x > 21) { on(before, x, y); on(after, x, y); }
  }
  for (let x = 18; x <= 21; x++) on(before, x, 20);
  const out = dropSplitPieces(before, after, W, H);
  assert.equal(alpha(out, 30, 5), 255, '大块不能扔');
  assert.equal(alpha(out, 19, 20), 255, '桥恢复');
});

/*
 * 吸附放在归属表上做：往里收的那几格直接改判给后层（后层拿源图原样，不透明），
 * 不靠后层补图去盖——实测补图没画到那里，护膝边上露出一道浅色细线。
 */
function ownerScene(colorAt, ownerAt) {
  const rgba = Buffer.alloc(W * H * 4), owner = new Array(W * H).fill(null);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = colorAt(x, y); if (!c) continue;
    rgba.set([...c, 255], (y * W + x) * 4);
    owner[y * W + x] = ownerAt(x, y);
  }
  return { rgba, owner };
}
const depthOf = new Map([['F', 2], ['B', 1]]);

test('归属表吸附：描线外挂着的邻件色窄条改判给后层', async () => {
  const { snapOwnership } = await import('../../server/api/pen-edge.js');
  const s = ownerScene((x) => (x < 16 ? RED : x < 18 ? INK : BLUE), (x) => (x < 20 ? 'F' : 'B'));
  const r = await snapOwnership(s.owner, s.rgba, W, H, depthOf);
  for (let y = 10; y < 30; y++) {
    assert.equal(s.owner[y * W + 18], 'B', `(18,${y})`);
    assert.equal(s.owner[y * W + 19], 'B', `(19,${y})`);
    assert.equal(s.owner[y * W + 17], 'F', `(17,${y}) 描线留给 F`);
  }
  assert.ok(r.toBehind > 0);
});

test('归属表吸附：被切给后层的描线改判回前层', async () => {
  const { snapOwnership } = await import('../../server/api/pen-edge.js');
  const s = ownerScene((x) => (x < 16 ? RED : x < 18 ? INK : BLUE), (x) => (x < 16 ? 'F' : 'B'));
  const r = await snapOwnership(s.owner, s.rgba, W, H, depthOf);
  for (let y = 10; y < 30; y++) {
    assert.equal(s.owner[y * W + 16], 'F', `(16,${y})`);
    assert.equal(s.owner[y * W + 17], 'F', `(17,${y})`);
    assert.equal(s.owner[y * W + 18], 'B', `(18,${y}) 蓝色不动`);
  }
  assert.ok(r.toFront > 0);
});

test('归属表吸附：后层是深色块时不动', async () => {
  const { snapOwnership } = await import('../../server/api/pen-edge.js');
  const s = ownerScene((x) => (x < 20 ? RED : [10, 10, 10]), (x) => (x < 20 ? 'F' : 'B'));
  const before = [...s.owner];
  await snapOwnership(s.owner, s.rgba, W, H, depthOf);
  assert.deepEqual(s.owner, before);
});
