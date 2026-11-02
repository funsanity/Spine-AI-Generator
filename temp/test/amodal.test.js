/**
 * 完整部件合成的纯函数：抠白底、配准、合成、评分、兜底。
 *
 * 背景（2026-11-02 实测 kkk）：模型其实能把 body 画成一件完整的上衣（披风底下的
 * 肩颈都补上了），问题在我们怎么取用——它的输出整体偏了约 11px、横向多拉伸 0.8%，
 * 直接贴回去平均色差 31.6，配准后 14.7。所有坐标都在「画布」上：
 * 画布 = 部件窗口四周外扩 15%（cutter 的 hiddenBox），可见像素按原位置放在画布里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyWhiteBackground, registerModel, warpModel, composeAmodal, scoreAmodal, fallbackFill
} from '../../server/api/amodal.js';

function rgbaFill(w, h, f) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = f(x, y);
    if (!v) continue;
    const i = (y * w + x) * 4;
    b[i] = v[0]; b[i + 1] = v[1]; b[i + 2] = v[2]; b[i + 3] = v[3] ?? 255;
  }
  return b;
}

test('抠白底：只抠连到图边的白，部件内部的白点留着', () => {
  const w = 40, h = 40;
  const rgb = Buffer.alloc(w * h * 3, 255);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) {
    const i = (y * w + x) * 3;
    const dot = x >= 18 && x < 22 && y >= 18 && y < 22;
    rgb[i] = dot ? 255 : 230; rgb[i + 1] = dot ? 255 : 120; rgb[i + 2] = dot ? 255 : 30;
  }
  const a = keyWhiteBackground(rgb, w, h);
  assert.equal(a[0], 0);
  assert.equal(a[5 * w + 5], 0);
  assert.equal(a[15 * w + 15], 255);
  assert.equal(a[20 * w + 20], 255, '眼白、白内衬这种被轮廓围住的白不是背景');
});

/** 带纹理的可见图：随机色块，配准才有东西可对 */
function texture(w, h, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cells = [];
  for (let i = 0; i < 400; i++) cells.push([rnd() * 255, rnd() * 255, rnd() * 255]);
  return (x, y) => cells[((x / 12) | 0) % 20 + (((y / 12) | 0) % 20) * 20];
}

test('配准：模型输出放大 2.55x/2.6x 再平移 (9,-28)，能解回这个变换', () => {
  const w = 200, h = 300;
  const tex = texture(w, h);
  const visible = { rgba: rgbaFill(w, h, (x, y) => (x > 20 && x < 180 && y > 20 && y < 280 ? tex(x, y) : null)), w, h };
  const sx = 2.55, sy = 2.6, tx = 9, ty = -28;
  const mw = Math.round(w * sx), mh = Math.round(h * sy);
  const rgb = Buffer.alloc(mw * mh * 3, 255);
  for (let Y = 0; Y < mh; Y++) for (let X = 0; X < mw; X++) {
    const x = (X - tx) / sx, y = (Y - ty) / sy;
    if (x > 20 && x < 180 && y > 20 && y < 280) {
      const c = tex(Math.floor(x), Math.floor(y));
      const i = (Y * mw + X) * 3;
      rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
    }
  }
  const t = registerModel(visible, { rgb, w: mw, h: mh });
  // 看的是「内容对不对得上」：可见内容四个角映射到模型上，换回画布像素误差 ≤1px。
  // 不直接卡 sx/sy：纹理是 12px 纯色块，块内怎么挪色差都一样，缩放有 0.4% 的平坦区，
  // 落到 160px 宽的内容上不到半个像素
  for (const [x, y] of [[21, 21], [179, 21], [21, 279], [179, 279]]) {
    const ex = Math.abs((x * t.sx + t.tx) - (x * sx + tx)) / sx;
    const ey = Math.abs((y * t.sy + t.ty) - (y * sy + ty)) / sy;
    assert.ok(ex <= 1 && ey <= 1, `角 (${x},${y}) 偏了 (${ex.toFixed(2)}, ${ey.toFixed(2)})px`);
  }
  assert.ok(t.cost < 8, `cost ${t.cost}`);
});

test('warpModel：按变换把模型输出采样回画布', () => {
  const mw = 20, mh = 20;
  const rgb = Buffer.alloc(mw * mh * 3);
  const alpha = new Uint8Array(mw * mh);
  for (let Y = 0; Y < mh; Y++) for (let X = 0; X < mw; X++) {
    const i = Y * mw + X;
    rgb[i * 3] = X >= 10 ? 200 : 0;
    alpha[i] = 255;
  }
  // 画布 10x10，放大 2 倍：画布 x>=5 对应模型 X>=10
  const out = warpModel({ rgb, alpha, w: mw, h: mh }, { sx: 2, sy: 2, tx: 0, ty: 0 }, 10, 10);
  assert.equal(out[(3 * 10 + 2) * 4], 0);
  assert.ok(out[(3 * 10 + 7) * 4] > 190);
  assert.equal(out[(3 * 10 + 7) * 4 + 3], 255);
});

test('合成：可见像素逐像素等于源，被挡处取模型像素和模型轮廓，其余透明', () => {
  const w = 30, h = 10;
  const visible = rgbaFill(w, h, (x) => (x < 10 ? [200, 100, 0, 255] : null));
  const hidden = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 10; x < 20; x++) hidden[y * w + x] = 1;
  const model = rgbaFill(w, h, (x) => (x < 15 ? [200, 100, 0, 255] : [0, 0, 0, 0]));
  const out = composeAmodal({ visible, hidden, model, w, h });
  for (let x = 0; x < 10; x++) assert.deepEqual([...out.subarray((5 * w + x) * 4, (5 * w + x) * 4 + 4)], [200, 100, 0, 255]);
  assert.equal(out[(5 * w + 12) * 4 + 3], 255, '被挡处模型画了 → 不透明');
  assert.equal(out[(5 * w + 17) * 4 + 3], 0, '被挡处模型没画（轮廓外）→ 透明');
  assert.equal(out[(5 * w + 25) * 4 + 3], 0, '既不可见也不被挡 → 透明，模型画什么都不要');
});

test('合成：交界 3px 内把模型颜色拉向源图，第 4 列起是模型原色', () => {
  const w = 30, h = 10;
  const visible = rgbaFill(w, h, (x) => (x < 10 ? [200, 100, 0, 255] : null));
  const hidden = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 10; x < 30; x++) hidden[y * w + x] = 1;
  // 模型整体偏暗 (180,90,0)，包括它画在可见区的那部分
  const model = rgbaFill(w, h, () => [180, 90, 0, 255]);
  const out = composeAmodal({ visible, hidden, model, w, h, band: 3 });
  const r = (x) => out[(5 * w + x) * 4];
  assert.ok(Math.abs(r(10) - 200) <= 2, `紧贴交界的那列 ${r(10)}`);
  assert.ok(r(11) < r(10) && r(11) > 180);
  assert.equal(r(13), 180, `第 4 列 ${r(13)}`);
});

test('评分：模型轮廓盖不住可见像素（画歪了）判不合格', () => {
  const w = 20, h = 20;
  const visible = rgbaFill(w, h, (x) => (x < 10 ? [200, 100, 0, 255] : null));
  const hidden = new Uint8Array(w * h);
  const modelWarped = rgbaFill(w, h, (x) => (x < 5 ? [200, 100, 0, 255] : null));
  const s = scoreAmodal({ visible, modelWarped, hidden, w, h, cost: 5 });
  assert.ok(s.coverage < 0.9);
  assert.equal(s.ok, false);
});

test('评分：被挡区残留洋红占位纹判不合格', () => {
  const w = 20, h = 20;
  const visible = rgbaFill(w, h, (x) => (x < 10 ? [200, 100, 0, 255] : null));
  const hidden = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (i % w >= 10) hidden[i] = 1;
  const modelWarped = rgbaFill(w, h, (x, y) => (x >= 10 && y < 2 ? [255, 0, 255, 255] : [200, 100, 0, 255]));
  const s = scoreAmodal({ visible, modelWarped, hidden, w, h, cost: 5 });
  assert.ok(s.magentaFrac > 0.005);
  assert.equal(s.ok, false);
});

test('评分：色差大于 25 判不合格，都达标才合格', () => {
  const w = 20, h = 20;
  const visible = rgbaFill(w, h, (x) => (x < 10 ? [200, 100, 0, 255] : null));
  const hidden = new Uint8Array(w * h);
  const modelWarped = rgbaFill(w, h, () => [200, 100, 0, 255]);
  assert.equal(scoreAmodal({ visible, modelWarped, hidden, w, h, cost: 30 }).ok, false);
  assert.equal(scoreAmodal({ visible, modelWarped, hidden, w, h, cost: 12 }).ok, true);
});

test('兜底：补图区平滑渐变，不是一块平涂，也没有色阶跳变', () => {
  const w = 40, h = 40;
  // 可见区在左边一列：上半红、下半蓝；补图区是右边 20 列
  const visible = rgbaFill(w, h, (x, y) => (x < 10 ? (y < 20 ? [220, 40, 40, 255] : [40, 40, 220, 255]) : null));
  const region = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 10; x < 30; x++) region[y * w + x] = 1;
  const out = fallbackFill({ visible, region, w, h });

  assert.equal(out[(5 * w + 35) * 4 + 3], 0, '补图区外保持透明');
  assert.equal(out[(5 * w + 20) * 4 + 3], 255);
  assert.ok(out[(5 * w + 15) * 4] > out[(5 * w + 15) * 4 + 2], '靠上的偏红');
  assert.ok(out[(35 * w + 15) * 4 + 2] > out[(35 * w + 15) * 4], '靠下的偏蓝');
  // 从离可见边 2px 起量：紧贴可见边那一列延续的是源图自己 180 级的红蓝硬边（实测 32，
  // 往里一列 20、第四列 10），不是补出来的色阶
  let maxJump = 0;
  for (let y = 1; y < h; y++) for (let x = 12; x < 30; x++) {
    for (const [dx, dy] of [[-1, 0], [0, -1]]) {
      const a = (y * w + x) * 4, b = ((y + dy) * w + x + dx) * 4;
      for (let c = 0; c < 3; c++) maxJump = Math.max(maxJump, Math.abs(out[a + c] - out[b + c]));
    }
  }
  assert.ok(maxJump <= 30, `相邻像素最大色差 ${maxJump}`);
});

/*
 * 2026-11-02 用户实测：头发底下整片头（几万像素）走了兜底，一圈圈往里推的填法
 * 把边上的皮肤色、发色、描边拉成放射状的长条纹，比模型画的差得多。
 * 大面积兜底要是一块平滑渐变：沿任一行，颜色只能缓缓变，不能来回跳。
 */
test('兜底：大面积补图区没有条纹（沿一行颜色单调缓变）', () => {
  const w = 120, h = 120;
  // 四周一圈可见像素：左边一段一段交替深浅（像描边和皮肤交替），其余皮肤色
  const visible = rgbaFill(w, h, (x, y) => {
    const inHole = x >= 10 && x < 110 && y >= 10 && y < 110;
    if (inHole) return null;
    if (x < 10) return ((y / 6) | 0) % 2 ? [40, 30, 30, 255] : [240, 180, 150, 255];
    return [240, 180, 150, 255];
  });
  const region = new Uint8Array(w * h);
  for (let y = 10; y < 110; y++) for (let x = 10; x < 110; x++) region[y * w + x] = 1;
  const out = fallbackFill({ visible, region, w, h });
  // 离左边 10px 的一列（x=20）从上到下：左边 12px 一周期的明暗交替只该在边上几像素内消掉，
  // 不能被拉成横条纹传进来（旧的一圈圈推进法这里来回跳 11 次，条纹伸进 30px）
  let flips = 0, prev = 0;
  for (let y = 12; y < 108; y++) {
    const d = out[(y * w + 20) * 4] - out[((y - 1) * w + 20) * 4];
    if (Math.abs(d) > 1 && Math.sign(d) !== Math.sign(prev) && prev !== 0) flips++;
    if (Math.abs(d) > 1) prev = d;
  }
  assert.ok(flips <= 2, `中部一列颜色来回跳了 ${flips} 次——是条纹`);
});

/*
 * 模型 1000~1600px 的图缩回部件大小后，轮廓外那一两圈是「部件色 + 白底」的混色。
 * 抠白是 0/255 判的，它们留成全不透明、颜色偏白，拼到深色上就是一圈浅色白边
 * （2026-11-03 实测 boot_left 整件重画）。
 */
test('白边还原：缩小后轮廓上的混白像素变半透明、颜色还原成部件色', async () => {
  const { softenWhiteEdge } = await import('../../server/api/amodal.js');
  const sharp = (await import('sharp')).default;
  const BIG = 300, W = 100, BROWN = [120, 70, 40];
  const big = Buffer.alloc(BIG * BIG * 3, 255);
  for (let y = 0; y < BIG; y++) for (let x = 0; x < BIG; x++) {
    if (Math.hypot(x - 150, y - 150) < 100) big.set(BROWN, (y * BIG + x) * 3);
  }
  const rgb = await sharp(big, { raw: { width: BIG, height: BIG, channels: 3 } }).resize(W, W).raw().toBuffer();
  const alpha = keyWhiteBackground(rgb, W, W);
  softenWhiteEdge(rgb, alpha, W, W);
  let partial = 0, worst = 0;
  for (let i = 0; i < W * W; i++) {
    if (!alpha[i]) continue;
    if (alpha[i] < 255) partial++;
    for (let c = 0; c < 3; c++) worst = Math.max(worst, rgb[i * 3 + c] - BROWN[c]);
  }
  assert.ok(partial > 20, `轮廓应有半透明过渡，实际 ${partial}`);
  assert.ok(worst <= 25, `不透明像素里不该带白，最偏白的一格比部件色亮 ${worst}`);
});

test('白边还原：部件本身接近白（白袖子）时不动，不把袖子吃掉', async () => {
  const { softenWhiteEdge } = await import('../../server/api/amodal.js');
  const W = 40, SLEEVE = [228, 222, 210];
  const rgb = Buffer.alloc(W * W * 3, 255);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) rgb.set(SLEEVE, (y * W + x) * 3);
  const alpha = keyWhiteBackground(rgb, W, W);
  softenWhiteEdge(rgb, alpha, W, W);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) assert.equal(alpha[y * W + x], 255, `(${x},${y})`);
});
