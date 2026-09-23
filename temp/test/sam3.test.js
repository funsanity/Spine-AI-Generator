/**
 * SAM 3 分割器的测试。
 *
 * 重点关注三件事，都是实际踩过坑之后才加上的：
 *
 *   1. **不被 transformers 的 stdout 噪音吓到**。它往 stdout（不是 stderr）
 *      打一行以 "[ERROR]" 开头的自检信息，误当成故障会让人白查半天。
 *      判据不能是"含 ERROR"，只能按形状白名单。
 *
 *   2. **没装环境时干净降级**。和 MobileSAM 一样，没装不能抛、不能中断生成，
 *      只能记一句日志然后退回多边形轮廓。
 *
 *   3. **两个分割器互不干扰**。segment.mjs 按 opts.segmenter / SPINE_SEGMENTER
 *      分流，路由错了会去拉错那个 worker（4GB vs 585MB，起错一个要等 9s）。
 *
 * 真环境（~/.spine-tool/sam3）不存在时成功路径自动跳过，降级路径照测。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Sam3Client, stopSam3Client } from '../../server/sam/client-sam3.mjs';
import { checkSam3, sam3Paths } from '../../server/sam/setup-sam3.mjs';
import { segmentParts } from '../../server/sam/segment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 真测试图：298x838 的透明底角色，仓库里已 tracked。
 * 成功路径必须用它——模型在色块合成图上是真的切不出东西，
 * 拿那种图测成功路径等于没测（会一路 skip 掉，看着是绿的其实没跑）。
 */
const CHAR_IMAGE = join(HERE, '..', '..', 'test_assets', 'test_role_arbg.png');

let dir;
let source;
let envReady = false;
const savedSam3Home = process.env.SPINE_SAM3_HOME;
const savedSegmenter = process.env.SPINE_SEGMENTER;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seg3-'));
  source = join(dir, 'src.png');

  // 一张小图，左边红块右边蓝块。只要能让 SAM 3 有东西可切就行，
  // 这里测的是通路而不是效果。
  const W = 96, H = 96;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const left = x < W / 2;
      px[i] = left ? 220 : 40;
      px[i + 1] = 60;
      px[i + 2] = left ? 60 : 220;
      px[i + 3] = 255;
    }
  }
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(source);

  if (savedSam3Home) process.env.SPINE_SAM3_HOME = savedSam3Home;
  envReady = existsSync(sam3Paths().weights) && existsSync(sam3Paths().python);
  if (!envReady) {
    // 环境不在默认位置就别猜了，后面的成功路径会 skip
    delete process.env.SPINE_SAM3_HOME;
  }
});

after(async () => {
  stopSam3Client();
  if (savedSam3Home) process.env.SPINE_SAM3_HOME = savedSam3Home;
  else delete process.env.SPINE_SAM3_HOME;
  if (savedSegmenter) process.env.SPINE_SEGMENTER = savedSegmenter;
  else delete process.env.SPINE_SEGMENTER;
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ── stdout 噪音过滤 ──────────────────────────────────────────────────
//
// _onLine 是私有的，但这条逻辑没有别的入口：worker 的 stdout 是唯一来源。
// 与其为了可测性把它抽成一个模块，不如直接喂行给它——这个函数没有副作用，
// 只往 onLog 和 stats 上写。

function linesOut(handle) {
  const seen = [];
  const c = new Sam3Client({ onLog: (m) => seen.push(m) });
  handle(c);
  return seen;
}

test('sam3: transformers 的 [ERROR] 自检不会当成故障转出来', () => {
  const seen = linesOut((c) =>
    c._onLine(
      "[ERROR] `image_like_kwargs` is part of BaseImageProcessor.preprocess's " +
      'signature, but not documented. Make sure to add it to the docstring of ' +
      'the function in .../image_processing_utils.py.'
    )
  );
  assert.deepEqual(seen, [], '这行是良性噪音，不该出现在日志里');
});

test('sam3: 良性噪音被挡掉但要留痕，便于区分"没发生"和"被拦下"', () => {
  const c = new Sam3Client({ onLog: () => {} });
  c._onLine('[transformers] `memory_attention_rope_theta` is deprecated');
  assert.equal(c.stats.suppressed, 1);
  assert.match(c.lastSuppressed, /memory_attention_rope_theta/);
});

test('sam3: 真的 Python 异常栈会被转出来', () => {
  const seen = linesOut((c) => {
    c._onLine('Traceback (most recent call last):');
    c._onLine('RuntimeError: MPS backend out of memory');
  });
  assert.equal(seen.length, 2);
  assert.match(seen[0], /Traceback/);
  assert.match(seen[1], /RuntimeError/);
});

test('sam3: 以 { 开头却不是 JSON 的协议行会被转出来', () => {
  const seen = linesOut((c) => c._onLine('{not json'));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /不是合法 JSON/);
});

test('sam3: 合法协议行不产生任何日志', () => {
  const seen = linesOut((c) => c._onLine(JSON.stringify({ id: 7, ok: true, pong: true })));
  assert.deepEqual(seen, []);
});

test('sam3: 空行和纯空白不产生日志', () => {
  const seen = linesOut((c) => {
    c._onLine('');
    c._onLine('   ');
    c._onLine('\n');
  });
  assert.deepEqual(seen, []);
});

// ── 环境检测与降级 ───────────────────────────────────────────────────

test('sam3: checkEnv 在环境不存在时返回 false，不抛异常', () => {
  process.env.SPINE_SAM3_HOME = join(dir, 'definitely-not-installed');
  const c = new Sam3Client({ onLog: () => {} });
  assert.equal(c.checkEnv(), false);
  delete process.env.SPINE_SAM3_HOME;
});

test('sam3: checkSam3 在环境不存在时给出 ok=false 而不是报错', async () => {
  process.env.SPINE_SAM3_HOME = join(dir, 'definitely-not-installed');
  const s = await checkSam3();
  assert.equal(s.ok, false);
  assert.equal(s.venv, false);
  assert.equal(s.weights, false);
  delete process.env.SPINE_SAM3_HOME;
});

test('sam3: 环境未装时 segmentParts 返回 null 并提示安装命令', async () => {
  process.env.SPINE_SAM3_HOME = join(dir, 'definitely-not-installed');
  const logs = [];
  const r = await segmentParts(source, [{ name: 'arm' }], {
    segmenter: 'sam3',
    onLog: (m) => logs.push(m),
  });
  assert.equal(r, null);
  assert.ok(
    logs.some((l) => l.includes('setup-sam3.mjs')),
    `日志里应给出安装命令，实际：${logs.join(' / ')}`
  );
  delete process.env.SPINE_SAM3_HOME;
});

test('sam3: requireEnv 为 true 且没装时抛错（测试/CLI 用）', async () => {
  process.env.SPINE_SAM3_HOME = join(dir, 'definitely-not-installed');
  await assert.rejects(
    () => segmentParts(source, [{ name: 'arm' }], { segmenter: 'sam3', requireEnv: true }),
    /SAM 3 环境未安装/
  );
  delete process.env.SPINE_SAM3_HOME;
});

// ── 分流：sam3 这条路不需要 bbox ─────────────────────────────────────

test('sam3: 部件只给 name 不给 bbox 也算可用（文本提示不吃框）', async (t) => {
  if (!envReady) return t.skip('本机没装 SAM 3 环境，跳过');
  // 不给 bbox。MobileSAM 这条会判成"没有可用部件"，SAM 3 不该。
  const logs = [];
  const r = await segmentParts(source, [{ name: 'object' }], {
    segmenter: 'sam3',
    onLog: (m) => logs.push(m),
  });
  assert.ok(
    !logs.some((l) => l.includes('没有可分割的部件')),
    `不该以缺 bbox 为由拒绝，实际日志：${logs.join(' / ')}`
  );
  // 小图上可能真的切不出东西，两种结果都合法——这里只验证它没被前置条件挡下
  assert.ok(r === null || r instanceof Map);
});

test('sam3: 环境变量能切成 sam3，且不需要传 opts', async () => {
  process.env.SPINE_SAM3_HOME = join(dir, 'definitely-not-installed');
  process.env.SPINE_SEGMENTER = 'sam3';
  const logs = [];
  const r = await segmentParts(source, [{ name: 'arm' }], { onLog: (m) => logs.push(m) });
  assert.equal(r, null);
  // 走的是 sam3 那条路才会提 setup-sam3.mjs；走 mobilesam 会提 setup.mjs
  assert.ok(logs.some((l) => l.includes('setup-sam3.mjs')), `实际日志：${logs.join(' / ')}`);
  delete process.env.SPINE_SEGMENTER;
  delete process.env.SPINE_SAM3_HOME;
});

test('sam3: SPINE_SEGMENTER 值不认识时退回 mobilesam（不能拼错就换模型）', async () => {
  process.env.SPINE_SEGMENTER = 'sam-3';   // 拼错了
  process.env.SPINE_SAM_HOME = join(dir, 'definitely-not-installed');
  delete process.env.SPINE_SAM3_HOME;
  const logs = [];
  const r = await segmentParts(source, [{ name: 'arm', bbox: { x: 0, y: 0, width: 8, height: 8 } }], {
    onLog: (m) => logs.push(m),
  });
  assert.equal(r, null);
  assert.ok(
    logs.some((l) => l.includes('MobileSAM') || l.includes('setup.mjs')),
    `拼错应退回 Mobilesam，实际日志：${logs.join(' / ')}`
  );
  delete process.env.SPINE_SEGMENTER;
  delete process.env.SPINE_SAM_HOME;
});

// ── 真环境成功路径 ───────────────────────────────────────────────────

test('sam3: 真环境下返回掩码，尺寸等于源图', async (t) => {
  if (!envReady) return t.skip('本机没装 SAM 3 环境，跳过成功路径');

  // 用真角色图 + 图上确实存在的部件。这里选 "glasses" 是因为它正是
  // MobileSAM 的失败案例（框里有脸也有眼镜时它挑脸），换 SAM 3 的理由就是它。
  const r = await segmentParts(CHAR_IMAGE, [{ name: 'glasses' }], {
    segmenter: 'sam3', requireEnv: true, onLog: () => {},
  });
  assert.ok(r, '真图上应至少切出一个掩码');
  assert.equal(r.size, 1);

  const m = r.get('glasses');
  assert.ok(m.png && m.png.length > 0, '掩码应是 PNG buffer');
  // 掩码尺寸必须是源图尺寸 298x838，而不是模型内部的 1008x1008
  assert.equal(m.width, 298);
  assert.equal(m.height, 838);
  const meta = await sharp(m.png).metadata();
  assert.equal(meta.width, 298);
  assert.equal(meta.height, 838);
});

test('sam3: 掩码是单通道灰度，255 表示属于该部件', async (t) => {
  if (!envReady) return t.skip('本机没装 SAM 3 环境，跳过');

  const r = await segmentParts(CHAR_IMAGE, [{ name: 'glasses' }], {
    segmenter: 'sam3', requireEnv: true, onLog: () => {},
  });
  const m = r && r.get('glasses');
  assert.ok(m, '真图上应切出 glasses');

  const meta = await sharp(m.png).metadata();
  assert.equal(meta.channels, 1, '掩码应是单通道');
  const { data } = await sharp(m.png).raw().toBuffer({ resolveWithObject: true });
  const vals = new Set(data);
  for (const v of vals) assert.ok(v === 0 || v === 255, `掩码只应有 0/255，出现了 ${v}`);
  assert.ok(m.area > 0, 'glasses 的掩码不该是空的');
});

test('sam3: 精细部件能分开切——眼睛是两只，不是一个"脸"', async (t) => {
  if (!envReady) return t.skip('本机没装 SAM 3 环境，跳过');
  // 这正是换 SAM 3 的核心理由：MobileSAM 只吃框，框里装了两件东西时
  // 它挑最大的那件，于是"眼镜"切出整张脸。文本提示没这个问题。
  const r = await segmentParts(CHAR_IMAGE, [{ name: 'eye' }], {
    segmenter: 'sam3', requireEnv: true, onLog: () => {},
  });
  const m = r && r.get('eye');
  assert.ok(m, '真图上应切出 eye');
  // 一次提示返回多个实例时，worker 会挑一个并报出候选数。
  // 双眼都命中说明模型确实分辨出了"眼睛"这个概念，而不是圈了整块脸。
  assert.ok(m.candidates >= 2, `应识别出两只眼睛，实际候选数 ${m.candidates}`);
});

test('sam3: 图上没有的部件被 presence 判否，不进返回的 Map', async (t) => {
  if (!envReady) return t.skip('本机没装 SAM 3 环境，跳过');
  // "图里没有眼镜"不叫失败。这类部件必须干脆不出现在 Map 里，
  // 让调用方走「没掩码 → 退回多边形」那条正常路径；给它一个 null 条目
  // 会让 cutter.js 掉进"PNG 解码失败"分支，打出误导性日志。
  const r = await segmentParts(CHAR_IMAGE, [{ name: 'backpack' }, { name: 'glasses' }], {
    segmenter: 'sam3', requireEnv: true, onLog: () => {},
  });
  assert.ok(r, '至少 glasses 应该切出来');
  assert.equal(r.has('backpack'), false, '不存在的部件不该出现在 Map 里');
  assert.equal(r.has('glasses'), true);
});
