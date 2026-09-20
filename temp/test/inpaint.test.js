/**
 * 部件补图的测试。
 *
 * 用本地假中转站当图像接口：真接口要 key、要钱、还很慢，
 * 而这里要验的是"蒙版对不对、合成有没有越界"，和模型画得好看不好看无关。
 * 假中转站把蒙版区域涂成纯绿，于是"补进去的内容"就是可断言的确切值。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import Busboy from 'busboy';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMaskFromAlpha, maskCoverage, readMask, inpaintPart, editImage, ALPHA_CUTOFF
} from '../../server/api/inpaint.js';

const GREEN = [0, 255, 0];
const ART = [200, 120, 120];

/** 造一个测试部件：中间一块不透明，四周透明 */
async function makePart(path, W, H, block) {
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = x >= block.x0 && x < block.x1 && y >= block.y0 && y < block.y1;
      px[i] = ART[0]; px[i + 1] = ART[1]; px[i + 2] = ART[2];
      px[i + 3] = inside ? 255 : 0;
    }
  }
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path);
}

/** 假中转站：把蒙版区域涂绿返回 */
function startFakeRelay() {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (!req.url.includes('/v1/images/edits')) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }

    const files = {}, fields = {};
    const bb = Busboy({ headers: req.headers });

    bb.on('file', (name, stream) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { files[name] = Buffer.concat(chunks); });
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('error', () => { if (!res.headersSent) res.writeHead(500).end('{}'); });

    bb.on('close', async () => {
      calls.push({ fields, fileNames: Object.keys(files) });
      try {
        const img = await sharp(files.image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const mask = await sharp(files.mask).raw().toBuffer({ resolveWithObject: true });
        const w = img.info.width, h = img.info.height;

        const out = Buffer.from(img.data);
        for (let i = 0; i < w * h; i++) {
          if (mask.data[i * mask.info.channels] > 127) {
            out[i * 4] = GREEN[0]; out[i * 4 + 1] = GREEN[1];
            out[i * 4 + 2] = GREEN[2]; out[i * 4 + 3] = 255;
          }
        }
        const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
        if (res.headersSent) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: e.message } }));
      }
    });

    req.pipe(bb);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, baseURL: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let dir, relay;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spine-inpaint-'));
  relay = await startFakeRelay();
});

after(async () => {
  relay?.server.close();
  await rm(dir, { recursive: true, force: true });
});

test('buildMaskFromAlpha: 透明处为白、不透明处为黑', async () => {
  const W = 100, H = 80;
  const part = join(dir, 'mask-src.png');
  await makePart(part, W, H, { x0: 30, x1: 70, y0: 20, y1: 60 });

  const mask = await buildMaskFromAlpha(part);
  const m = await readMask(mask);

  assert.equal(m.width, W);
  assert.equal(m.height, H);
  // 方块中心是内容，必须留黑，否则模型会连原内容一起重画
  assert.equal(m.data[40 * W + 50], 0);
  // 四角是透明区，必须涂白
  assert.equal(m.data[0], 255);
  assert.equal(m.data[W - 1], 255);
});

test('buildMaskFromAlpha: 白区占比正好等于透明区占比', async () => {
  const W = 100, H = 80;
  const part = join(dir, 'mask-cov.png');
  await makePart(part, W, H, { x0: 30, x1: 70, y0: 20, y1: 60 });

  const coverage = await maskCoverage(await buildMaskFromAlpha(part));
  const opaque = (70 - 30) * (60 - 20);
  assert.equal(coverage, 1 - opaque / (W * H));
});

test('readMask: 单通道读取，不受 PNG 编码通道数影响', async () => {
  // sharp 会把灰度图编成 3 通道 sRGB。readMask 必须压回 1 通道，
  // 否则按"1 像素 1 字节"去读会整体错位，合成位置全偏。
  const W = 100, H = 80;
  const part = join(dir, 'mask-ch.png');
  await makePart(part, W, H, { x0: 30, x1: 70, y0: 20, y1: 60 });

  const mask = await buildMaskFromAlpha(part);
  const m = await readMask(mask);

  assert.equal(m.data.length, W * H, '字节数必须等于像素数');
});

test('readMask: alpha 刚好在阈值上下时判定正确', async () => {
  const W = 8, H = 1;
  const px = Buffer.alloc(W * H * 4);
  for (let x = 0; x < W; x++) {
    const i = x * 4;
    px[i] = 10; px[i + 1] = 10; px[i + 2] = 10;
    px[i + 3] = x < 4 ? ALPHA_CUTOFF - 1 : ALPHA_CUTOFF;
  }
  const part = join(dir, 'mask-cutoff.png');
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(part);

  const m = await readMask(await buildMaskFromAlpha(part));
  assert.equal(m.data[0], 255, '低于阈值算透明，要补');
  assert.equal(m.data[3], 255);
  assert.equal(m.data[4], 0, '等于阈值算不透明，保留');
});

test('inpaintPart: 只改蒙版内，蒙版外一个像素都不动', async () => {
  const W = 100, H = 80;
  const block = { x0: 30, x1: 70, y0: 20, y1: 60 };
  const part = join(dir, 'compose.png');
  await makePart(part, W, H, block);

  const before = await sharp(part).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await readMask(await buildMaskFromAlpha(part));

  const result = await inpaintPart(part, {
    apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'hair'
  });
  assert.equal(result.ok, true);

  const after = await sharp(part).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // 尺寸必须不变：骨骼位置是按 bbox 算的，切片尺寸一变骨头就全偏
  assert.equal(after.info.width, before.info.width);
  assert.equal(after.info.height, before.info.height);

  let outsideChanged = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask.data[i] > 127) continue;
    for (let c = 0; c < 4; c++) {
      if (before.data[i * 4 + c] !== after.data[i * 4 + c]) { outsideChanged++; break; }
    }
  }
  assert.equal(outsideChanged, 0, '蒙版外必须一字不动，否则会污染原画');

  // 原内容原样保留
  const center = 40 * W + 50;
  assert.deepEqual(
    [after.data[center * 4], after.data[center * 4 + 1], after.data[center * 4 + 2]],
    ART
  );

  // 蒙版内填上了模型给的内容
  const hole = 5 * W + 5;
  assert.deepEqual(
    [after.data[hole * 4], after.data[hole * 4 + 1], after.data[hole * 4 + 2]],
    GREEN
  );
});

test('inpaintPart: 内部孔洞的 alpha 被放行（否则渲染出来还是缺块）', async () => {
  /*
   * 部件形状是一个空心矩形（外圈不透明，内部透明）。
   * 内部孔洞在不透明内容的包围盒之内，是真正需要补图的区域，
   * 补完之后 alpha 必须放行——否则渲染出来还是缺块。
   */
  const W = 100, H = 80;
  const part = join(dir, 'alpha.png');

  // 造一个空心矩形：外圈不透明，内部 (35..65 × 25..55) 透明
  {
    const px = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const onRim = x >= 30 && x < 70 && y >= 20 && y < 60
          && (x < 35 || x >= 65 || y < 25 || y >= 55);
        px[i] = ART[0]; px[i + 1] = ART[1]; px[i + 2] = ART[2];
        px[i + 3] = onRim ? 255 : 0;
      }
    }
    await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(part);
  }

  const transparentBefore = await countTransparent(part);
  assert.ok(transparentBefore > 0, '测试用的部件本身要有透明区');

  const r = await inpaintPart(part, { apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'hair' });
  assert.equal(r.ok, true);

  const { data } = await sharp(part).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  /*
   * 孔洞像素 (36, 26)：在空心矩形内侧边缘，距轮廓 1px，在 INPAINT_EXPAND_PX(4px) 范围内。
   * 补完必须不透明且有模型颜色。
   * (50, 40) 在空心矩形正中，距轮廓 15px，超出 4px 范围，仍为透明——这是正常的：
   * 深洞的 alpha 不自动放行；snap 会确保 bbox 贴紧轮廓，深洞在实际素材里很少见。
   */
  const holeX = 36, holeY = 26;  // 1px inside the inner hole, adjacent to the rim
  assert.equal(data[(holeY * W + holeX) * 4 + 3], 255, '洞边缘（1px 内）的 alpha 必须放行');
  assert.deepEqual(
    [data[(holeY * W + holeX) * 4], data[(holeY * W + holeX) * 4 + 1], data[(holeY * W + holeX) * 4 + 2]],
    GREEN,
    '洞里的颜色该来自模型'
  );

  // 外圈本体不透明像素一个字节都不能动
  const body = (22 * W + 32) * 4;  // 外圈上某点
  assert.equal(data[body + 3], 255, '本体 alpha 不变');
  assert.equal(data[body], ART[0], '本体 RGB 不能被模型覆盖');

  // 外侧大片 padding——距轮廓 29px，远超 INPAINT_EXPAND_PX(4px)——仍然透明
  assert.equal(data[(5 * W + 5) * 4 + 3], 0, '外侧 padding 距轮廓 29px，超出放行范围，应保持透明');
});

test('补图不会把内容包围盒之外的 padding 写成不透明', async () => {
  const W = 60, H = 60;
  const part = join(dir, 'pad.png');
  await makePart(part, W, H, { x0: 15, x1: 45, y0: 15, y1: 45 });

  await inpaintPart(part, { apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'pad' });

  const { data } = await sharp(part).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  /*
   * alpha 放行范围：不透明内容的紧包围盒（15..44 × 15..44）往外推 ALPHA_EXPAND_PX（2px）
   * → x/y 在 13..46 之内。四角 (0,0) 等距离包围盒边 ≈ 13..21px，超出放行范围，
   * 必须仍然透明。
   */
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) {
    assert.equal(data[(y * W + x) * 4 + 3], 0, `角落 (${x},${y}) 超出内容包围盒，必须保持透明`);
  }
  // 部件本体仍是不透明的
  assert.equal(data[(30 * W + 30) * 4 + 3], 255, '部件本体应仍不透明');
});

test('inpaintPart: 被内容围住的内部孔洞补完必须不透明，否则"补了等于没补"', async () => {
  /*
   * 这是「缺块」的直接成因。
   *
   * 曾经的规则是：alpha 只在「原轮廓往外推 2 像素」内放行，蒙版内其余
   * 一律压回 0。紧贴轮廓切分时每个部件的框里都留着一大片透明（被遮挡的
   * 部分不框进来），补图把颜色正确画了进去，alpha 却是 0——渲染时那些
   * 像素根本不显示，用户看到的就是一块缺的。
   *
   * 现在的规则：蒙版内 ∪ 内部孔洞 都放行。判据是**连通性**不是距离——
   * 被内容围住、泛洪走不到图边的透明区才填实；连到图边的留白保持透明，
   * 所以「糊成实心矩形」那个老问题不会回来。
   *
   * 深度擦除（被前方部件挖掉的一大片）是第三种情况：它按定义连到图边，
   * 却正是该填的地方，靠切图阶段落的 .erased.png 掩码豁免。
   */
  const W = 100, H = 80;
  const part = join(dir, 'inner-hole.png');

  /*
   * 一个方环：外圈 10..90 / 10..70 不透明，中间 25..75 / 25..55 是洞。
   * 洞四周被内容围死，泛洪到不了——这正是「内部孔洞」的定义。
   */
  {
    const px = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        px[i] = ART[0]; px[i + 1] = ART[1]; px[i + 2] = ART[2];
        const outer = x >= 10 && x < 90 && y >= 10 && y < 70;
        const hole = x >= 25 && x < 75 && y >= 25 && y < 55;
        px[i + 3] = outer && !hole ? 255 : 0;
      }
    }
    await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(part);
  }

  const r = await inpaintPart(part, { apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'ring' });
  assert.equal(r.ok, true);

  const { data } = await sharp(part).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // 洞正中：距四周内容各 15px，距离判据下会被压成透明，连通判据下必须填实
  const hole = (40 * W + 50) * 4;
  assert.equal(data[hole + 3], 255, '被内容围住的洞补完必须不透明');
  assert.deepEqual(
    [data[hole], data[hole + 1], data[hole + 2]],
    GREEN,
    '洞里的颜色该来自模型'
  );

  // 洞紧贴内边缘的像素同样要填实——不能只在洞口放行一圈
  const edge = (25 * W + 50) * 4;
  assert.equal(data[edge + 3], 255, '洞边缘像素也要填实，否则渲染时留一圈缝');

  // 部件的环形本体一个字节都不动
  const ring = (15 * W + 50) * 4;
  assert.equal(data[ring + 3], 255);
  assert.deepEqual([data[ring], data[ring + 1], data[ring + 2]], ART);

  // 环外的留白连到图边，泛洪可达，必须保持透明（这就是「不糊成实心矩形」）
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [5, 40], [95, 40]]) {
    assert.equal(data[(y * W + x) * 4 + 3], 0, `留白 (${x},${y}) 连得到图边，必须保持透明`);
  }
});

test('inpaintPart: 连到图边的缺口不填实（留白与洞的分界就是连通性）', async () => {
  /*
   * 上下两条带，左右两侧敞口——中间那片透明连通到图边，按定义算留白。
   *
   * 这条曾经被当成「该填的洞」：早先用「距不透明像素 ≤4px」判，洞口那圈
   * 会被放行，于是部件外侧糊出白边。现在按连通性判，整片连通区一律透明，
   * 只有 RGB 扩散（拉伸取色有料，但不多出不透明像素）。
   *
   * 真正需要填的深度擦除区不走这条路，由 .erased.png 掩码豁免。
   */
  const W = 100, H = 80;
  const part = join(dir, 'open-gap.png');
  {
    const px = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        px[i] = ART[0]; px[i + 1] = ART[1]; px[i + 2] = ART[2];
        const inBand = x >= 10 && x < 90 && ((y >= 10 && y < 25) || (y >= 55 && y < 70));
        px[i + 3] = inBand ? 255 : 0;
      }
    }
    await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(part);
  }

  const r = await inpaintPart(part, { apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'bands' });
  assert.equal(r.ok, true);

  const { data } = await sharp(part).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // 带之间那片：距上带只有 3px，但左右连通到图边，仍是留白
  assert.equal(data[(28 * W + 50) * 4 + 3], 0, '连通到图边的缺口必须保持透明');
  assert.equal(data[(40 * W + 50) * 4 + 3], 0, '同理');

  // 两条带本身不动
  for (const y of [15, 60]) {
    const i = (y * W + 50) * 4;
    assert.equal(data[i + 3], 255, `带 y=${y} 应保持不透明`);
    assert.deepEqual([data[i], data[i + 1], data[i + 2]], ART);
  }
});

test('inpaintPart: 没有透明区时跳过，不浪费一次调用', async () => {
  const W = 50, H = 50;
  const part = join(dir, 'solid.png');
  await makePart(part, W, H, { x0: 0, x1: W, y0: 0, y1: H });

  const callsBefore = relay.calls.length;
  const r = await inpaintPart(part, {
    apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'solid'
  });

  assert.equal(r.skipped, true);
  assert.equal(relay.calls.length, callsBefore, '不该发出请求');
});

test('inpaintPart: 非方形部件也能补（尺寸取最长边缩放）', async () => {
  const W = 300, H = 40;
  const part = join(dir, 'wide.png');
  await makePart(part, W, H, { x0: 100, x1: 200, y0: 10, y1: 30 });

  const r = await inpaintPart(part, {
    apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'wide'
  });
  assert.equal(r.ok, true);
  assert.equal(r.size, `${W}x${H}`, '补完尺寸必须回到原尺寸');

  const after = await sharp(part).metadata();
  assert.equal(after.width, W);
  assert.equal(after.height, H);
});

test('editImage: 请求里带上了模型、提示词、原图与蒙版', async () => {
  const img = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#fff' } })
    .png().toBuffer();
  const mask = await sharp(Buffer.alloc(32 * 32), { raw: { width: 32, height: 32, channels: 1 } })
    .png().toBuffer();

  await editImage({
    apiKey: 'k', baseURL: relay.baseURL, model: 'my-image-model',
    imageBuf: img, maskBuf: mask, prompt: '补全发丝', size: '32x32'
  });

  const last = relay.calls.at(-1);
  assert.equal(last.fields.model, 'my-image-model');
  assert.equal(last.fields.prompt, '补全发丝');
  assert.deepEqual(last.fileNames.sort(), ['image', 'mask']);
});

test('editImage: 服务端报错时抛出服务端原话，便于排查', async () => {
  const bad = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '模型不存在' } }));
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));

  const img = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#fff' } })
    .png().toBuffer();

  await assert.rejects(
    () => editImage({
      apiKey: 'k', baseURL: `http://127.0.0.1:${bad.address().port}`,
      model: 'x', imageBuf: img, maskBuf: img, prompt: 'p'
    }),
    /模型不存在/
  );

  bad.close();
});

async function countTransparent(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] < 8) n++;
  return n;
}

/*
 * 这一组是回归测试，针对真实中转站上踩到的坑：
 * 图像编辑接口只认白名单里的 size 值，传自定义尺寸一律 400。
 */
test('inpaintPart: 发出的 size 必须是 auto，不能是算出来的尺寸', async () => {
  const W = 256, H = 576;
  const part = join(dir, 'sized.png');
  await makePart(part, W, H, { x0: 20, x1: 60, y0: 20, y1: 200 });

  const before = relay.calls.length;
  await inpaintPart(part, {
    apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'sized'
  });

  const call = relay.calls.slice(before).at(-1);
  assert.ok(call, '应该发出了请求');
  assert.equal(
    call.fields.size, 'auto',
    '必须是 auto——中转站只认白名单 size，传 256x576 这类自定义值会返回 400'
  );
});

test('editImage: 中转站返回的图尺寸与请求无关时，照样能缩回原尺寸', async () => {
  // 真实接口用 size=auto 时会返回和输入完全不同的分辨率
  // （实测 256x576 的输入返回 836x1880），合成前必须缩回部件原尺寸。
  const W = 180, H = 90;
  const part = join(dir, 'odd.png');
  await makePart(part, W, H, { x0: 40, x1: 120, y0: 20, y1: 70 });

  const r = await inpaintPart(part, {
    apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'odd'
  });
  assert.equal(r.ok, true);

  const after = await sharp(part).metadata();
  assert.equal(after.width, W, '宽度必须回到原尺寸');
  assert.equal(after.height, H, '高度必须回到原尺寸');
});

/**
 * 被前方部件盖住的那片：有源图真值就直接贴回去，不让模型编。
 *
 * 成因见 cutter.js 写 .erased.png 那段：模型看不到被盖住的地方下面是什么，
 * 只能照着画面里还看得见的东西推——推出来就是遮挡者的一份复制品。
 * 实测 body 在裙摆底下补出 [119,113,129]，源图那格是 [108,96,118]（裙摆
 * 的紫灰）；head 在镜片底下补出 [246,183,157]，源图那格是 [225,173,159]。
 * 静态切图看不出来（那片被盖着），两片按不同骨头转起来就是一层错色的重影。
 *
 * 源图那个像素不是猜的——它就是当时真正显示的颜色，也正是用户要的
 * 「完整 Object RGBA」。所以 cutter 把真值写进 .erased.png 的像素，
 * 补图选完轮次后把这片贴回来、alpha 给 255（留 0 就是个洞，
 * 围裙甩开时底下该有身体）。
 *
 * 这里用假中转站复现：蒙版区一律涂绿（模拟"模型照着遮挡者画"）。
 * cutter 在 .erased.png 里给了真值的那半边，落盘必须是真值色而不是绿。
 */
test('inpaintPart: 被前方盖住但有真值的那片，用源图真值贴回而不是模型的想象', async () => {
  const W = 96, H = 96;
  const png = join(dir, 'front-a.png');

  // 右半边不透明（部件自己的内容），左半边透明（被前方盖住的那片）
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = ART[0]; px[i + 1] = ART[1]; px[i + 2] = ART[2];
      px[i + 3] = x >= W / 2 ? 255 : 0;
    }
  }
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(png);

  /*
   * 擦除掩码：整个左半边，像素里存源图在那里的真值色 TRUE。
   * 假中转站一律涂绿——所以落盘只要不是绿，就说明贴回生效了。
   */
  const TRUE = [200, 30, 90];
  const em = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const on = x < W / 2;
      const i = (y * W + x) * 4;
      if (on) { em[i] = TRUE[0]; em[i + 1] = TRUE[1]; em[i + 2] = TRUE[2]; }
      em[i + 3] = 255;
    }
  }
  await sharp(em, { raw: { width: W, height: H, channels: 4 } }).png()
    .toFile(png.replace(/\.png$/, '.erased.png'));

  const r = await inpaintPart(png, {
    baseURL: relay.baseURL, apiKey: 'k', partName: 'front-a',
    maxQualityAttempts: 1
  });
  assert.ok(!r.skipped, '右半边还有内容要补，不该跳过');

  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const GREEN = [0, 200, 0];
  let leftOpaque = 0, leftTruth = 0, leftGreen = 0, rightOpaque = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (data[i + 3] < 128) continue;
      if (x >= info.width / 2) { rightOpaque++; continue; }
      leftOpaque++;
      const dT = Math.abs(data[i] - TRUE[0]) + Math.abs(data[i + 1] - TRUE[1]) + Math.abs(data[i + 2] - TRUE[2]);
      if (dT < 30) leftTruth++;
      const dG = Math.abs(data[i] - GREEN[0]) + Math.abs(data[i + 1] - GREEN[1]) + Math.abs(data[i + 2] - GREEN[2]);
      if (dG < 30) leftGreen++;
    }
  }
  const half = (info.width / 2) * info.height;
  assert.equal(leftOpaque, half,
    `被前方盖住的左半边要落成完整 RGBA（用户要的「完整 Object RGBA」），实际不透明 ${leftOpaque}/${half}px` +
    `——alpha 留 0 就是个洞，围裙甩开时底下什么都没有`);
  assert.ok(leftTruth > half * 0.9,
    `左半边应该是源图真值（${TRUE}），实际只有 ${leftTruth}/${half}px 对得上`);
  assert.ok(leftGreen < half * 0.1,
    `左半边有 ${leftGreen}px 是模型画的绿——模型照着遮挡者编了内容，转起来就是一层重影`);
  assert.ok(rightOpaque > 0, '部件自己的内容不能被吃掉');

  await rm(png.replace(/\.png$/, '.erased.png'), { force: true });
});
