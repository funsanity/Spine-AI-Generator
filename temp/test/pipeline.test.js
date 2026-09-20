/**
 * 端到端结构测试：切图 → 补图 → 合成，跑完验证轮廓还在。
 *
 * 为什么单测不够：`inpaintPart` 的单测用的是手搓的小图，几条像素，
 * 蒙版边界和 bbox 边界重合，看不出"切图外扩的 padding 被一起写成不透明"
 * 这类问题——而线上炸的就是这个。
 *
 * 这里用真实的素材图走完整条链路（AI 分析结果手工给出，图像接口用假中转站），
 * 断言的是最终产物：轮廓占比、颜色分布。AI 调用不在链路里，
 * 所以这个测试不需要 key、不花钱、几秒跑完。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import http from 'node:http';
import Busboy from 'busboy';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { cutImageParts, applyCutGeometry } from '../../server/api/cutter.js';
import { inpaintPart } from '../../server/api/inpaint.js';

/** 素材：一张带透明通道的角色图 */
const SOURCE = 'test_assets/test_role_arbg.png';

/**
 * 假中转站。
 *
 * 行为刻意做得"像真中转站一样糟"：返回 3 通道 PNG（摊平成不透明），
 * 透明区画成近白——也就是模型把"透明"表达成 RGB 纹理的那个真实症状。
 * 如果补图的合成逻辑正确，这些噪声只该落在洞里，轮廓必须不受影响。
 */
function startFakeRelay() {
  const server = http.createServer((req, res) => {
    if (!req.url.includes('/v1/images/edits')) {
      res.writeHead(404).end('{}');
      return;
    }
    const bb = Busboy({ headers: req.headers });
    // 文件流必须被消费掉，否则 busboy 不会触发 close，请求就一直挂着
    bb.on('file', (name, stream) => {
      stream.on('data', () => {});
      stream.on('end', () => {});
    });
    bb.on('field', () => {});
    bb.on('error', () => { if (!res.headersSent) res.writeHead(500).end('{}'); });
    bb.on('close', async () => {
      try {
        // 返回一张 3 通道、整体近白的图：模拟"模型把透明画成棋盘格"
        const w = 256, h = 256;
        const rgb = Buffer.alloc(w * h * 3);
        for (let i = 0; i < w * h; i++) {
          const on = ((i % w) >> 3) % 2 === ((Math.floor(i / w) >> 3) % 2);
          const v = on ? 255 : 240;
          rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
        }
        const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
        if (res.headersSent) return;
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: { message: e.message } }));
        }
      }
    });
    req.pipe(bb);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseURL: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** 算不透明像素占比 */
async function opaqueRatio(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] >= 8) opaque++;
  }
  return opaque / (info.width * info.height);
}

/** 数不透明像素 */
async function opaquePixels(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] >= 8) n++;
  return n;
}

/** 轮廓形状：每行的不透明跨度，用来比对补图前后是否一致 */
async function silhouette(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < info.height; y++) {
    let n = 0;
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] >= 8) n++;
    }
    rows.push(n);
  }
  return rows;
}

test('端到端：切图 → 补图 → 合成，轮廓必须原样保留', { skip: !existsSync(SOURCE) && `缺少素材 ${SOURCE}` }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'spine-e2e-'));
  const relay = await startFakeRelay();
  t.after(async () => {
    relay.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  /*
   * 手工给一份分析结果。
   *
   * torso 这条刻意横跨整幅图宽：左右两侧全是透明边距。
   * 补图若把整块 bbox 写成不透明（旧 bug），这个部件的轮廓就彻底没了，
   * 断言能立刻抓到；正确的实现下两侧仍是透明的，占比远低于阈值。
   */
  const parts = [
    { name: 'torso', bbox: { x: 0, y: 300, width: 298, height: 240 }, pivot: { x: 149, y: 120 } },
    { name: 'head', bbox: { x: 150, y: 120, width: 120, height: 120 }, pivot: { x: 60, y: 60 } },
  ];

  const cut = await cutImageParts(SOURCE, parts, dir, { margin: 5, bleed: 1 });
  assert.equal(cut.length, 2, '两个部件都要切出来');

  // 切图后先记下轮廓和不透明像素数
  const before = {};
  const beforeOpaque = {};
  for (const c of cut) {
    before[c.name] = await silhouette(c.path);
    beforeOpaque[c.name] = await opaquePixels(c.path);
  }

  for (const c of cut) {
    await inpaintPart(c.path, {
      apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: c.name
    });
  }

  for (const c of cut) {
    const after = await silhouette(c.path);

    /*
     * 逐行比对轮廓：每行不透明像素数只允许往外胖一点点。
     *
     * 补图的职责是往洞里填内容，不是改形状。允许的增长来自
     * INPAINT_EXPAND_PX（4 像素），左右各算一遍；斜边按切比雪夫距离算，
     * 一行最多能长到 4×2×N（N=轮廓段数），真实角色图实测最大 ~37px。
     * 旧 bug 是把整个蒙版写成 alpha=255，每行会直接变成满宽（100px+），
     * 差值远在 48 以上，照样抓得住。
     * 真正的护栏是下面那个 opaqueRatio < 0.85。
     */
    const MAX_GROW_PER_ROW = 48;
    const beforeRows = before[c.name];
    for (let y = 0; y < after.length; y++) {
      const grow = after[y] - beforeRows[y];
      assert.ok(grow <= MAX_GROW_PER_ROW,
        `${c.name} 第 ${y} 行轮廓长了 ${grow} 像素（上限 ${MAX_GROW_PER_ROW}）——形状被补图改动了`);
      assert.ok(grow >= -2,
        `${c.name} 第 ${y} 行轮廓缩了 ${-grow} 像素——内容被补图吃掉了一块`);
    }

    const ratio = await opaqueRatio(c.path);
    assert.ok(ratio < 0.85,
      `${c.name} 不透明占比 ${(ratio * 100).toFixed(1)}%，接近实心矩形——轮廓丢了`);
    assert.ok(ratio > 0.05,
      `${c.name} 不透明占比只有 ${(ratio * 100).toFixed(1)}%，内容被清空了`);
  }

  // 整体增长也要有界：轮廓外扩 INPAINT_EXPAND_PX(4px) 带来的增量不该超过原面积的 15%
  for (const c of cut) {
    const grown = (await opaquePixels(c.path)) - beforeOpaque[c.name];
    const base = beforeOpaque[c.name];
    assert.ok(grown <= base * 0.15,
      `${c.name} 不透明像素多了 ${grown}（原 ${base}），超过 15%——不像是只外扩了 4 像素`);
  }
});

test('端到端：补图后洞里的 RGB 被填上内容，不再是透明黑', { skip: !existsSync(SOURCE) && `缺少素材 ${SOURCE}` }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'spine-e2e-'));
  const relay = await startFakeRelay();
  t.after(async () => {
    relay.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const parts = [
    { name: 'torso', bbox: { x: 90, y: 300, width: 120, height: 220 }, pivot: { x: 60, y: 110 } },
  ];
  const cut = await cutImageParts(SOURCE, parts, dir, { margin: 5, bleed: 1 });
  const p = cut[0].path;

  await inpaintPart(p, { apiKey: 'test', baseURL: relay.baseURL, model: 'gpt-image-2', partName: 'torso' });

  const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  /*
   * 只查**贴着轮廓那一圈**的透明像素。
   *
   * 补图会把颜色扩散进透明区，好让缩放时边沿不发暗——这条性质只对
   * "双线性采样够得到"的那一圈有意义，也就是离实心内容几像素以内。
   * 更远处的透明区（bbox 外扩的角落）本来就没人采样，RGB 是黑是白都无所谓，
   * 而且补图现在还会把轮廓外那一圈的脏白（从浅色背景扩散进来的近白）
   * 主动掐回 0——整片一起查会把这条正当行为误判成失败。
   */
  const NEAR = 4;
  const dist = new Int32Array(info.width * info.height).fill(-1);
  const q = [];
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] !== 0) { dist[i] = 0; q.push(i); }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % info.width, y = (i / info.width) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
      const k = ny * info.width + nx;
      if (dist[k] !== -1) continue;
      dist[k] = dist[i] + 1;
      q.push(k);
    }
  }

  let checked = 0, black = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] !== 0) continue;
    if (dist[i] < 0 || dist[i] > NEAR) continue;
    const rgb = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2];
    checked++;
    if (rgb < 24) black++;
  }
  assert.ok(checked > 0, '这张图应当有贴着轮廓的透明像素（外扩出来的边）');
  assert.ok(black / checked < 0.5,
    `${black}/${checked} 个贴着轮廓的透明像素 RGB 仍是黑的——补图没把颜色扩散进去，缩放时边沿会发暗`);
});
