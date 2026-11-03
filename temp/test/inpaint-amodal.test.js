/**
 * 补图新路径：模型画完整部件，我们只取被挡住的那部分（server/api/amodal.js）。
 *
 * 假中转站模仿真模型的两个习惯：
 *   - 把被挡区（洋红/白斜纹）画成部件颜色，背景留白；
 *   - 整体挪几个像素（真模型实测偏 ~11px、拉伸 0.8%），逼着走配准。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import Busboy from 'busboy';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inpaintPart } from '../../server/api/inpaint.js';

const PART = [210, 140, 60];

function startRelay(mode) {
  const calls = [];
  const prompts = [];
  const server = http.createServer((req, res) => {
    const files = {};
    const bb = Busboy({ headers: req.headers });
    bb.on('field', (name, val) => { if (name === 'prompt') prompts.push(val); });
    bb.on('file', (name, stream) => { const c = []; stream.on('data', (d) => c.push(d)); stream.on('end', () => { files[name] = Buffer.concat(c); }); });
    bb.on('close', async () => {
      calls.push(1);
      const { data, info } = await sharp(files.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const w = info.width, h = info.height;
      const out = Buffer.alloc(w * h * 3, 255);
      if (mode === 'draw' || mode === 'draw-big' || mode === 'draw-transparent' || mode === 'tinted' || mode === 'fixed-aspect' || mode === 'plaque') {
        const magenta = (i) => data[i * 3] > 200 && data[i * 3 + 1] < 60 && data[i * 3 + 2] > 200;
        const SHIFT = 6;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          // 斜纹的白条也算被挡区：往两边找 12px 内有没有洋红
          let hid = magenta(i);
          for (let k = 1; k <= 12 && !hid; k++) {
            if (x - k >= 0 && magenta(i - k)) hid = true;
            if (x + k < w && magenta(i + k)) hid = true;
          }
          const isBg = data[i * 3] > 245 && data[i * 3 + 1] > 245 && data[i * 3 + 2] > 245 && !hid;
          // 往左挪：被挡区贴着画布右边，往右挪会把最后几列挤出图外，等于模型真没画
          const X = x - SHIFT;
          if (X < 0) continue;
          const o = (y * w + X) * 3;
          // plaque：整件重画时模型在空白处凭空加了一块托盘（2026-11-03「Complete」后面多出紫色椭圆）
          if (isBg) { if (mode === 'plaque') { out[o] = 120; out[o + 1] = 60; out[o + 2] = 200; } continue; }
          // 透明底那个模式更像真模型：部件形状只占被挡区上半，下半留背景
          if (hid && mode === 'draw-transparent' && y > h * 0.55) continue;
          if (hid) { out[o] = PART[0]; out[o + 1] = PART[1]; out[o + 2] = PART[2]; }
          else {
            // tinted：可见部分整体画偏 32 个色阶（真模型重画脸时五官略有出入，色差 28.8）
            const t = mode === 'tinted' ? 32 : 0;
            out[o] = Math.min(255, data[i * 3] + t); out[o + 1] = Math.min(255, data[i * 3 + 1] + t); out[o + 2] = Math.min(255, data[i * 3 + 2] + t);
          }
        }
      }
      let png = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
      if (mode === 'draw-transparent') {
        // 中转站有时回透明底 RGBA：背景 (0,0,0,0)，不是白
        const rgba = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const white = out[i * 3] === 255 && out[i * 3 + 1] === 255 && out[i * 3 + 2] === 255;
          if (white) continue;
          rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1]; rgba[i * 4 + 2] = out[i * 3 + 2]; rgba[i * 4 + 3] = 255;
        }
        png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
      }
      // big：真模型按自己的固定档位出图（实测 1000~1600px），比画布大好几倍
      if (mode === 'draw-big') png = await sharp(png).resize(w * 3, h * 3).png().toBuffer();
      // fixed-aspect：真模型只按固定档位出图（1536x1024 等），内容保持自己的比例放进去、四周留白。
      // 送一张 6:1 的横幅进去，回来是 3:2 的图，中间一条是横幅（2026-11-03 结算图实测横幅被压扁一半）
      if (mode === 'fixed-aspect') {
        png = await sharp(png).resize(1536, 1024, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    req.pipe(bb);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, calls, prompts, baseURL: `http://127.0.0.1:${server.address().port}` })));
}

let dir, drawRelay, whiteRelay, clearRelay, tintRelay, bigRelay, aspectRelay, plaqueRelay;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spine-amodal-'));
  drawRelay = await startRelay('draw');
  whiteRelay = await startRelay('white');
  clearRelay = await startRelay('draw-transparent');
  tintRelay = await startRelay('tinted');
  bigRelay = await startRelay('draw-big');
  aspectRelay = await startRelay('fixed-aspect');
  plaqueRelay = await startRelay('plaque');
});
after(async () => {
  drawRelay.server.close(); whiteRelay.server.close(); clearRelay.server.close(); tintRelay.server.close(); bigRelay.server.close(); aspectRelay.server.close(); plaqueRelay.server.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * 场景：部件窗口 (100,100) 80x80，带纹理；右侧 20 列被前方部件盖着（窗口内 x 160..180），
 * 被挡区还伸出窗口右边 10px（x 180..190）。画布 = 窗口四周外扩 12px → (88,88) 104x104。
 */
async function scene(tag) {
  const W = 80, H = 80;
  const part = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < 60; x++) {
    const i = (y * W + x) * 4;
    const c = (((x / 8) | 0) + ((y / 8) | 0)) % 2;
    part[i] = c ? 230 : 120; part[i + 1] = c ? 120 : 200; part[i + 2] = c ? 40 : 90; part[i + 3] = 255;
  }
  const pngPath = join(dir, `${tag}.png`);
  await sharp(part, { raw: { width: W, height: H, channels: 4 } }).png().toFile(pngPath);

  const hb = { x: 88, y: 88, width: 104, height: 104 };
  const hidden = Buffer.alloc(hb.width * hb.height * 4);
  for (let y = 0; y < hb.height; y++) for (let x = 0; x < hb.width; x++) {
    const sx = x + hb.x, sy = y + hb.y;
    if (sx >= 160 && sx < 190 && sy >= 100 && sy < 180) hidden[(y * hb.width + x) * 4 + 3] = 255;
  }
  const hiddenPath = join(dir, `${tag}.hidden.png`);
  await sharp(hidden, { raw: { width: hb.width, height: hb.height, channels: 4 } }).png().toFile(hiddenPath);
  // 旧的擦除掩码（窗口坐标，被挡区 ∩ 本部件轮廓）：兜底时限定平滑填色的范围
  const erased = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 60; x < 75; x++) erased[(y * W + x) * 4 + 3] = 255;
  await sharp(erased, { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(dir, `${tag}.erased.png`));
  return { pngPath, hiddenPath, hiddenBox: hb, partBox: { x: 100, y: 100, width: W, height: H }, part };
}

const opts = (relay, s, extra = {}) => ({
  apiKey: 'k', baseURL: relay.baseURL, model: 'm', partName: 'body',
  hiddenPath: s.hiddenPath, hiddenBox: s.hiddenBox, partBox: s.partBox, maxQualityAttempts: 1, ...extra
});

test('没被挡住的部件不调模型，切图原样', async () => {
  const s = await scene('skip');
  const before = await readFile(s.pngPath);
  const n = drawRelay.calls.length;
  const r = await inpaintPart(s.pngPath, opts(drawRelay, s, { hiddenPath: null }));
  assert.equal(r.status, 'skipped');
  assert.equal(drawRelay.calls.length, n);
  assert.deepEqual(await readFile(s.pngPath), before);
});

test('被挡部分按模型画的补上，且和原图对齐，可见像素逐像素不变', async () => {
  const s = await scene('draw');
  const r = await inpaintPart(s.pngPath, opts(drawRelay, s));
  assert.equal(r.status, 'done', JSON.stringify(r));
  // 结果窗口装下了伸出原窗口的那 10px：x 100..190
  assert.equal(r.bbox.x, 100);
  assert.equal(r.bbox.x + r.bbox.width, 190);

  const { data, info } = await sharp(s.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (sx, sy) => { const i = ((sy - r.bbox.y) * info.width + (sx - r.bbox.x)) * 4; return [...data.subarray(i, i + 4)]; };
  for (const [sx, sy] of [[100, 100], [130, 140], [159, 179]]) {
    const i = ((sy - 100) * 80 + (sx - 100)) * 4;
    assert.deepEqual(at(sx, sy), [...s.part.subarray(i, i + 4)], `可见像素 (${sx},${sy}) 必须原样`);
  }
  const mid = at(175, 140);
  assert.equal(mid[3], 255, '被挡处补上了');
  assert.ok(Math.abs(mid[0] - PART[0]) < 30 && Math.abs(mid[1] - PART[1]) < 30, `被挡处颜色 ${mid}`);
  assert.equal(at(185, 140)[3], 255, '伸出原窗口那截也补上了');
});

test('saveRawDir 存的是抠掉背景、对齐到画布大小的透明图（不是模型 3 倍大的白底原图）', async () => {
  const s = await scene('raw');
  const rawDir = join(dir, 'raw');
  await inpaintPart(s.pngPath, opts(bigRelay, s, { saveRawDir: rawDir }));
  assert.deepEqual(await readdir(rawDir), ['body-1.png']);
  const { data, info } = await sharp(join(rawDir, 'body-1.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, s.hiddenBox.width, '和画布一样大');
  assert.equal(info.height, s.hiddenBox.height);
  const a = (sx, sy) => data[((sy - s.hiddenBox.y) * info.width + (sx - s.hiddenBox.x)) * 4 + 3];
  assert.equal(a(90, 90), 0, '背景透明');
  assert.equal(a(130, 140), 255, '部件可见处有内容');
  assert.equal(a(175, 140), 255, '被挡处模型画的内容');
});

test('模型按 3 倍大出图：照样对齐，可见像素原样，被挡处补上', async () => {
  const s = await scene('big');
  const r = await inpaintPart(s.pngPath, opts(bigRelay, s));
  assert.equal(r.status, 'done', JSON.stringify(r));
  const { data, info } = await sharp(s.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (sx, sy) => { const i = ((sy - r.bbox.y) * info.width + (sx - r.bbox.x)) * 4; return [...data.subarray(i, i + 4)]; };
  const i = (40 * 80 + 30) * 4;
  assert.deepEqual(at(130, 140), [...s.part.subarray(i, i + 4)]);
  const mid = at(175, 140);
  assert.equal(mid[3], 255);
  assert.ok(Math.abs(mid[0] - PART[0]) < 30 && Math.abs(mid[1] - PART[1]) < 30, `被挡处颜色 ${mid}`);
});

test('模型什么都没画：走兜底，在部件轮廓内平滑填色，轮廓外留透明', async () => {
  const s = await scene('fallback');
  const r = await inpaintPart(s.pngPath, opts(whiteRelay, s));
  assert.equal(r.status, 'fallback');
  const { data, info } = await sharp(s.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (sx, sy) => { const i = ((sy - r.bbox.y) * info.width + (sx - r.bbox.x)) * 4; return [...data.subarray(i, i + 4)]; };
  assert.equal(at(168, 140)[3], 255, '轮廓内（旧擦除区）的被挡处平滑补上');
  const fx = 182 - r.bbox.x;
  assert.ok(fx >= info.width || at(182, 140)[3] === 0, '轮廓外的被挡处不填');
});

test('重跑时骨架已定：keepWindow 把结果裁回原窗口，尺寸和位置都不变', async () => {
  const s = await scene('keep');
  const r = await inpaintPart(s.pngPath, opts(drawRelay, s, { keepWindow: true }));
  assert.equal(r.status, 'done');
  assert.deepEqual(r.bbox, s.partBox);
  const { data, info } = await sharp(s.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 80);
  assert.equal(info.height, 80);
  assert.equal(data[((140 - 100) * 80 + (175 - 100)) * 4 + 3], 255, '窗口内被挡处照样补上');
});

/*
 * 2026-11-02 用户实测：中转站这次回的是透明底 PNG（4 通道、66% 透明、背景 0,0,0,0）。
 * 只读 RGB 时透明底变成纯黑，抠白抠不掉，整片黑当成部件内容贴进被挡区——
 * 头的脖子下面、大腿顶上一大块黑，看着像「补图过度、范围太大」。
 */
test('模型回透明底 PNG：背景按透明处理，被挡区不贴黑块', async () => {
  const s = await scene('clear');
  const r = await inpaintPart(s.pngPath, opts(clearRelay, s));
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.equal(r.bbox.x + r.bbox.width, 190, '范围和白底时一样，不能被黑背景撑大');
  const { data, info } = await sharp(s.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let black = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] > 0 && data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] < 30) black++;
  }
  assert.equal(black, 0, `有 ${black}px 不透明纯黑`);
  assert.equal(r.bbox.y, 100);
});

/*
 * 2026-11-02 用户实测：head 三轮色差 56/63/28.8，全不合格，走了兜底，头发底下一大片放射条纹。
 * 第三轮其实画得很好——色差高是因为模型重画的五官和原图略有出入，而可见像素我们本来就不用模型的。
 * 稍差的一轮也远好过兜底：轮廓对得上（覆盖够、没洋红）且色差 ≤40 就用它。
 */
test('没有一轮达到严格线，但最好一轮只是略差：用它，不走兜底', async () => {
  const s = await scene('tint');
  const r = await inpaintPart(s.pngPath, opts(tintRelay, s));
  assert.ok(r.best.cost > 25 && r.best.cost <= 40, `假模型色差 ${r.best.cost} 应落在 25..40`);
  assert.equal(r.status, 'done', JSON.stringify(r));
});

/**
 * 长条部件（横幅 6:1）：中间一段被文字盖着。画布 = 窗口四周外扩 6px。
 * 模型按 3:2 出图时，送过去的画布必须先补白成模型的比例，否则拉回来高度只剩一半。
 */
async function bannerScene(tag) {
  const W = 300, H = 50;
  const part = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= 140 && x < 170) continue;
    const i = (y * W + x) * 4;
    const c = (((x / 10) | 0) + ((y / 10) | 0)) % 2;
    part[i] = c ? 230 : 120; part[i + 1] = c ? 120 : 200; part[i + 2] = c ? 40 : 90; part[i + 3] = 255;
  }
  const pngPath = join(dir, `${tag}.png`);
  await sharp(part, { raw: { width: W, height: H, channels: 4 } }).png().toFile(pngPath);
  const hb = { x: 94, y: 94, width: 312, height: 62 };
  const hidden = Buffer.alloc(hb.width * hb.height * 4);
  for (let y = 0; y < hb.height; y++) for (let x = 0; x < hb.width; x++) {
    const sx = x + hb.x, sy = y + hb.y;
    if (sx >= 240 && sx < 270 && sy >= 100 && sy < 150) hidden[(y * hb.width + x) * 4 + 3] = 255;
  }
  const hiddenPath = join(dir, `${tag}.hidden.png`);
  await sharp(hidden, { raw: { width: hb.width, height: hb.height, channels: 4 } }).png().toFile(hiddenPath);
  const erased = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 140; x < 170; x++) erased[(y * W + x) * 4 + 3] = 255;
  await sharp(erased, { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(dir, `${tag}.erased.png`));
  return { pngPath, hiddenPath, hiddenBox: hb, partBox: { x: 100, y: 100, width: W, height: H }, part };
}

test('长条部件：模型按固定比例出图也不会被压扁，被挡处按模型画的补上', async () => {
  const s = await bannerScene('banner');
  const r = await inpaintPart(s.pngPath, opts(aspectRelay, s));
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.ok(r.best.coverage >= 0.95, `可见像素覆盖 ${r.best.coverage}`);
  const { data, info } = await sharp(s.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (sx, sy) => { const i = ((sy - r.bbox.y) * info.width + (sx - r.bbox.x)) * 4; return [...data.subarray(i, i + 4)]; };
  for (const sy of [102, 125, 147]) {
    const px = at(255, sy);
    assert.equal(px[3], 255, `被挡处 (255,${sy}) 补上了`);
    assert.ok(Math.abs(px[0] - PART[0]) < 30 && Math.abs(px[1] - PART[1]) < 30, `被挡处颜色 ${px}`);
  }
});

test('补图提示词按用户的素材描述写，不写死「游戏角色」', async () => {
  const s = await scene('subject');
  const n = drawRelay.prompts.length;
  await inpaintPart(s.pngPath, opts(drawRelay, s, { subject: 'UI动效：结算界面，横幅是根部件' }));
  const p = drawRelay.prompts[n];
  assert.match(p, /结算界面/);
  assert.doesNotMatch(p, /character/i);
  // 没给描述时也不默认成角色
  const s2 = await scene('subject2');
  await inpaintPart(s2.pngPath, opts(drawRelay, s2));
  assert.doesNotMatch(drawRelay.prompts[n + 1], /character/i);
});

test('补图提示词点名其他部件是单独图层、不许画进来（横幅里被画回了 Complete 那行字）', async () => {
  const s = await scene('others');
  const n = drawRelay.prompts.length;
  await inpaintPart(s.pngPath, opts(drawRelay, s, {
    subject: 'UI动效：横幅上有 Level 和 Complete 两行字', others: ['text_Complete', 'cushion', 'body']
  }));
  const p = drawRelay.prompts[n];
  assert.match(p, /text_Complete/);
  assert.match(p, /cushion/);
  assert.match(p, /must NOT|do not/i);
  // 自己不在「不许画」的名单里
  assert.doesNotMatch(p.split(/must NOT/i)[1] ?? '', /\bbody\b/);
});

test('整件重画：模型在原图空白处多画的东西不进切图（「Complete」后面凭空多了一块托盘）', async () => {
  const s = await scene('plaque');
  const r = await inpaintPart(s.pngPath, opts(plaqueRelay, s, { redraw: true }));
  assert.equal(r.status, 'done', JSON.stringify(r));
  const { data, info } = await sharp(s.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (sx, sy) => {
    const x = sx - r.bbox.x, y = sy - r.bbox.y;
    if (x < 0 || y < 0 || x >= info.width || y >= info.height) return 0;
    return data[(y * info.width + x) * 4 + 3];
  };
  assert.equal(alphaAt(130, 140), 255, '可见处保留');
  assert.equal(alphaAt(175, 140), 255, '被挡处补上');
  assert.equal(alphaAt(92, 140), 0, '窗口左边原本是空白，模型画的托盘不要');
  assert.equal(alphaAt(130, 92), 0, '窗口上方原本是空白');
});
