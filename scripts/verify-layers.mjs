/**
 * 分层质量验收：切口碎片、拼回原图、动起来的裂缝。
 *
 * 用法：
 *   node scripts/verify-layers.mjs <response.json> [--source test_assets/kkk.png] [--out dir]
 *
 * response.json 是 /api/generate 的完整响应（curl -o 存下来的那份）。
 * 裂缝那一项要用网页里的渲染器，所以 3000 端口上必须有服务在跑（npm run web）。
 *
 * 三项口径：
 *   - 碎片：每张切图 alpha≥32 的 8 邻接连通块，除最大块外都算碎片；
 *     线头 = 不透明像素的 4 邻居里有 ≥3 个透明（1px 宽伸出去的那种）。
 *   - 拼回：按 slot 顺序把切图叠回源图尺寸，只在源图和合成都 alpha≥250 处比颜色，
 *     三通道均差 >24 记一个不一致。
 *   - 裂缝：沿用 scripts/_debug/crack-check2.mjs 的办法——对渲染 alpha 做闭运算，
 *     闭运算补上、原画面却透明的就是细缝，减去静止帧本来就有的。
 *     帧集：生成的动画按 0.25s 采样；压力姿势 = 每根非 root 骨头单独转 ±20°。
 *     压力姿势用半径 3（只抓 ≤6px 的缝）：转 20° 后肢体和身体之间本来就会
 *     张开楔形空隙，半径 6 会把楔尖误报成裂缝。
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const respPath = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SOURCE = opt('--source', 'test_assets/kkk.png');
const OUT = opt('--out', null);
if (!respPath) {
  console.error('用法: node scripts/verify-layers.mjs <response.json> [--source png] [--out dir]');
  process.exit(1);
}
if (OUT) mkdirSync(OUT, { recursive: true });

const resp = JSON.parse(readFileSync(respPath, 'utf-8'));
const cuts = resp.cutResults;
const { width: W, height: H } = resp.imageSize;

// ---------- 1. 碎片 / 线头 ----------
async function fragStats(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const lab = new Int32Array(w * h).fill(-1);
  const sizes = [];
  for (let s = 0; s < w * h; s++) {
    if (data[s * 4 + 3] < 32 || lab[s] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const st = [s];
    lab[s] = id;
    while (st.length) {
      const p = st.pop(); n++;
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (lab[q] < 0 && data[q * 4 + 3] >= 32) { lab[q] = id; st.push(q); }
      }
    }
    sizes.push(n);
  }
  let hairs = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (data[i * 4 + 3] < 32) continue;
    let t = 0;
    for (const j of [i - 1, i + 1, i - w, i + w]) if (data[j * 4 + 3] < 32) t++;
    if (t >= 3) hairs++;
  }
  sizes.sort((a, b) => b - a);
  const strays = sizes.slice(1);
  return { strays: strays.length, strayPx: strays.reduce((a, b) => a + b, 0), hairs };
}

const frags = {};
for (const c of cuts) frags[c.name] = await fragStats(c.path);

// ---------- 2. 拼回原图 ----------
const slotOrder = resp.skeleton.slots.map((s) => s.attachment);
const byName = new Map(cuts.map((c) => [c.name, c]));
const layers = slotOrder.filter((n) => byName.has(n)).map((n) => ({
  input: byName.get(n).path, left: byName.get(n).bbox.x, top: byName.get(n).bbox.y
}));
const comp = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(layers).raw().toBuffer();
const src = await sharp(SOURCE).ensureAlpha().raw().toBuffer();
let mismatch = 0, compared = 0;
const misMap = OUT ? Buffer.alloc(W * H * 3) : null;
for (let i = 0; i < W * H; i++) {
  if (misMap) { const g = Math.round((src[i * 4] + src[i * 4 + 1] + src[i * 4 + 2]) / 3 * 0.4); misMap[i * 3] = misMap[i * 3 + 1] = misMap[i * 3 + 2] = g; }
  if (src[i * 4 + 3] < 250 || comp[i * 4 + 3] < 250) continue;
  compared++;
  const d = (Math.abs(src[i * 4] - comp[i * 4]) + Math.abs(src[i * 4 + 1] - comp[i * 4 + 1]) + Math.abs(src[i * 4 + 2] - comp[i * 4 + 2])) / 3;
  if (d > 24) { mismatch++; if (misMap) { misMap[i * 3] = 255; misMap[i * 3 + 1] = 0; misMap[i * 3 + 2] = 0; } }
}
// 源图有内容、合成却是空的：部件丢了内容
let lost = 0;
for (let i = 0; i < W * H; i++) if (src[i * 4 + 3] >= 250 && comp[i * 4 + 3] < 128) lost++;
if (OUT) {
  await sharp(misMap, { raw: { width: W, height: H, channels: 3 } }).resize(512).png().toFile(join(OUT, 'recompose-mismatch.png'));
  await sharp(comp, { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(OUT, 'recompose.png'));
}

// ---------- 3. 裂缝 ----------
const sk = JSON.parse(JSON.stringify(resp.skeleton));
const bones = sk.bones.map((b) => b.name).filter((n) => n !== 'root');
const frameSpecs = [];
for (const [name, anim] of Object.entries(sk.animations ?? {})) {
  let dur = 0;
  for (const track of Object.values(anim.bones ?? {})) for (const keys of Object.values(track)) for (const k of keys) dur = Math.max(dur, k.time ?? 0);
  for (let t = 0; t <= dur + 1e-6; t += 0.25) frameSpecs.push({ anim: name, t, kind: 'anim', R: 6 });
}
for (const b of bones) {
  for (const a of [20, -20]) {
    const name = `__stress_${b}_${a}`;
    sk.animations[name] = { bones: { [b]: { rotate: [{ time: 0, angle: a, value: a }] } } };
    frameSpecs.push({ anim: name, t: 0, kind: 'stress', R: 3, bone: b, angle: a });
  }
}
sk.animations.__rest = { bones: {} };

const urls = cuts.map((c) => [c.name, 'data:image/png;base64,' + readFileSync(c.path).toString('base64')]);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1700 }, deviceScaleFactor: 1 });
await page.goto('http://localhost:3000/');
await page.evaluate(async ({ sk, urls, imageSize }) => {
  const { SpinePreview } = await import('/renderer.js');
  document.body.innerHTML = '<div style="position:fixed;left:0;top:0;width:1200px;height:1700px"><canvas id="c" style="position:absolute;inset:0;width:100%;height:100%"></canvas></div>';
  const p = new SpinePreview(document.getElementById('c'));
  await p.load(sk, new Map(urls), imageSize);
  p.zoom = 1 / p.fitScale;
  const stroke = p.ctx.stroke.bind(p.ctx);
  p.ctx.stroke = (...a) => { if (String(p.ctx.strokeStyle).toLowerCase() !== '#161c28') stroke(...a); };
  const Wc = p.canvas.width, Hc = p.canvas.height;
  const ox = Math.round(Wc / 2 - imageSize.width / 2), oy = Math.round(Hc / 2 - imageSize.height / 2);
  // 逐帧回传：整段 RGBA 当 JS 数组传回来，二十几帧就把 node 的堆撑爆了
  window.__grab = (anim, t) => {
    p.playAnimation(anim); p.seek(t); p.draw();
    const d = p.ctx.getImageData(ox, oy, imageSize.width, imageSize.height).data;
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return btoa(s);
  };
}, { sk, urls, imageSize: { width: W, height: H } });
const grab = async (anim, t) => Buffer.from(await page.evaluate(([a, t]) => window.__grab(a, t), [anim, t]), 'base64');
const restRgba = await grab('__rest', 0);
const alphaOf = (rgba) => { const a = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) a[i] = rgba[i * 4 + 3]; return a; };
const frames = { rest: alphaOf(restRgba), out: [] };
for (const s of frameSpecs) {
  const rgba = await grab(s.anim, s.t);
  frames.out.push({ ...s, al: alphaOf(rgba), rgb: rgba });
}
await browser.close();

function close(m, r) {
  const pass = (src, isMax) => {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = isMax ? 0 : 1;
      for (let k = -r; k <= r; k++) { const xx = x + k; const s = xx < 0 || xx >= W ? 0 : src[y * W + xx]; v = isMax ? Math.max(v, s) : Math.min(v, s); }
      tmp[y * W + x] = v;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = isMax ? 0 : 1;
      for (let k = -r; k <= r; k++) { const yy = y + k; const s = yy < 0 || yy >= H ? 0 : tmp[yy * W + x]; v = isMax ? Math.max(v, s) : Math.min(v, s); }
      out[y * W + x] = v;
    }
    return out;
  };
  return pass(pass(m, true), false);
}
const gapsOf = (al, r) => {
  const m = Uint8Array.from(al, (v) => (v >= 128 ? 1 : 0));
  const c = close(m, r);
  const g = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (c[i] && !m[i]) g[i] = 1;
  return g;
};
const restGaps = { 3: gapsOf(frames.rest, 3), 6: gapsOf(frames.rest, 6) };
/*
 * idle 是整体纵向缩放（最多约 1.3%，脚底到头顶差出 ~20px），静止帧里本来就有的
 * 凹口跟着整体位移。逐像素减静止帧会把这些位移了的老凹口全算成新缝——
 * 基线实测 idle 报 2758px，几乎全是这个。动画帧减的是膨胀 24px 后的静止凹口。
 */
const dilate = (m, r) => {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < W) v = m[y * W + xx]; } tmp[y * W + x] = v; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < H) v = tmp[yy * W + x]; } out[y * W + x] = v; }
  return out;
};
const restAnim = dilate(restGaps[6], 24);
let animMax = 0, stressSum = 0;
const worst = [];
for (const f of frames.out) {
  const g = gapsOf(f.al, f.R);
  let extra = 0;
  const base = f.kind === 'anim' ? restAnim : restGaps[f.R];
  /*
   * 只数「内部」的缝：周围 17x17 里 ≥80% 不透明。部件之间裂开的缝两边都是实的；
   * 手指缝、发梢这类轮廓凹口一侧是外面的空白，占比到不了 80%。
   * 不加这道门，旋转后轮廓边缘重新采样出来的凹口会被当成裂缝——
   * 基线 body±20° 报 1200+px，看抽帧全是指尖发梢上的散点。
   */
  const integ = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += f.al[y * W + x] >= 128 ? 1 : 0; integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row; } }
  const solidAround = (x, y) => {
    const x0 = Math.max(0, x - 8), y0 = Math.max(0, y - 8), x1 = Math.min(W, x + 9), y1 = Math.min(H, y + 9);
    const n = integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
    return n / ((x1 - x0) * (y1 - y0));
  };
  for (let i = 0; i < W * H; i++) {
    if (!g[i] || base[i]) { g[i] = 0; continue; }
    if (solidAround(i % W, (i / W) | 0) < 0.8) { g[i] = 0; continue; }
    extra++;
  }
  if (f.kind === 'anim') animMax = Math.max(animMax, extra);
  else stressSum += extra;
  worst.push({ kind: f.kind, frame: f.kind === 'anim' ? `${f.anim}@${f.t}` : `${f.bone}${f.angle > 0 ? '+' : ''}${f.angle}`, extra });
  if (OUT && (f.kind === 'stress' || extra > 0)) {
    // 抽帧存图：灰底上画渲染结果，新增细缝标红
    const img = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const a = f.rgb[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) img[i * 3 + c] = Math.round(f.rgb[i * 4 + c] * a + 90 * (1 - a));
      if (g[i]) { img[i * 3] = 255; img[i * 3 + 1] = 0; img[i * 3 + 2] = 255; }
    }
    await sharp(img, { raw: { width: W, height: H, channels: 3 } }).png()
      .toFile(join(OUT, f.kind === 'stress'
        ? `stress-${f.bone}${f.angle > 0 ? 'p' : 'm'}${Math.abs(f.angle)}.png`
        : `anim-${f.anim}@${f.t}.png`));
  }
}
worst.sort((a, b) => b.extra - a.extra);

console.log(JSON.stringify({
  frags,
  fragTotals: {
    strays: Object.values(frags).reduce((s, f) => s + f.strays, 0),
    strayPx: Object.values(frags).reduce((s, f) => s + f.strayPx, 0),
    hairs: Object.values(frags).reduce((s, f) => s + f.hairs, 0)
  },
  recompose: { compared, mismatchPx: mismatch, mismatchFrac: +(mismatch / Math.max(1, compared)).toFixed(5), lostPx: lost },
  cracks: { animMax, stressSum, worstAnim: worst.filter((w) => w.kind === 'anim').slice(0, 3), worstStress: worst.filter((w) => w.kind === 'stress').slice(0, 8) }
}, null, 1));
