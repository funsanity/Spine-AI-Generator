/**
 * 真流程端到端测试：上传一张图，走完整的 AI 分析 → 切图 → 补图 → 骨骼。
 *
 * 这是唯一一条会真的花钱、真的调模型的测试，所以默认不跑。
 * 它的价值在于：前面那些测试都假设"AI 分析结果是对的"，
 * 而这一条会连 AI 一起验——排查问题时最怕的就是改了补图、结果 AI 那侧也变了。
 *
 * 用法:
 *   E2E=1 node --test test/e2e.test.js
 *   E2E=1 E2E_IMAGE=test_assets/level_83/hidden/01.png node --test test/e2e.test.js
 *   E2E=1 E2E_MODEL=gpt-image-2.5-sunburst node --test test/e2e.test.js
 *   E2E=1 E2E_PROJECT=myproj E2E_SOURCE_NAME=角色A node --test test/e2e.test.js
 *
 * 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY，以及 .env 里的 ANTHROPIC_BASE_URL。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { checkCoverage, checkDuplicates, checkGhosts, checkMissingContent } from '../../server/api/isolate.js';

// 凭据在 .env 里；node --test 不会自动加载，这里显式来一次
dotenv.config({ path: resolve(import.meta.dirname, '../../.env') });

const ROOT = resolve(import.meta.dirname, '../..');
const ENABLED = process.env.E2E === '1';
const ALPHA_CUTOFF = 8;
const IMAGE = process.env.E2E_IMAGE || 'test_assets/test_role_arbg.png';
const PROJECT = process.env.E2E_PROJECT || 'e2e';
const PORT = Number(process.env.E2E_PORT || 3993);
/** 输入图名：产物落在 output/<工程名>/<它>/ 下，骨架文件也叫它 */
const SOURCE_NAME = process.env.E2E_SOURCE_NAME
  || IMAGE.split('/').pop().replace(/\.[^.]+$/, '');
let OUT_DIR = join(ROOT, 'output', PROJECT);

/**
 * 重放模式：拿上一轮落盘的 AI 部件表 + SAM 掩码重跑切图/补图/断言，不再调模型。
 *
 * 要它是因为**同一个素材每一轮 AI 给的部件表不一样**（role 实测：一轮 9 个部件、
 * 另一轮 8 个，左袖一会儿独立、一会儿并进 body，框也各不相同）。于是
 * 「改了切图逻辑」的效果被 AI 方差盖住：孤儿 6.76% → 9.78%，看起来像回归，
 * 实际是这轮的框本身就漏了左袖那条袖子。
 *
 * 只有固定住 AI 那一侧，"改动前 vs 改动后"才是单变量对比。
 * 用法：
 *   E2E_REPLAY=1 E2E=1 E2E_PROJECT=e2e_role node --test test/e2e.test.js
 * 前提是那个工程目录里已经有 <名字>_temp/{cut-input.json, masks/*.mask.png}。
 */
const REPLAY = process.env.E2E_REPLAY === '1';

/**
 * 直接 require 服务端的 analyzeImage / cutImageParts / inpaintPart 来跑，
 * 而不是发 HTTP 请求：multer 那层跟被测逻辑无关，
 * 走真流程的关键是"真的调模型"，不是"真的走 HTTP"。
 */
async function runPipeline() {
  const { analyzeImage } = await import('../../server/ai/claude.js');
  const { cutImageParts } = await import('../../server/api/cutter.js');
  const { inpaintPart } = await import('../../server/api/inpaint.js');
  const { generateSkeleton, generateAnimations } = await import('../../server/api/generator.js');
  const { prepareProjectDir } = await import('../../server/api/workspace.js');

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = process.env.ANTHROPIC_BASE_URL;

  const imageSize = await sharp(IMAGE).metadata().then((m) => ({ width: m.width, height: m.height }));
  /*
   * 重放时**不能 clean**：要读的 cut-input.json 和 masks/ 就在上一轮的产物目录里，
   * 一擦就没了。其余情况照旧清干净，免得上一轮的残留混进断言。
   */
  const ws = await prepareProjectDir('./output', PROJECT, { clean: !REPLAY, sourceName: SOURCE_NAME });
  OUT_DIR = ws.sourceDir;
  if (ws.migrated) console.log(`  旧产物已收进 ${ws.migrated}/`);

  /*
   * 重放：从上一轮落盘的文件里把 AI 那侧拿回来。
   *
   * 注意拿的是 cut-input.json（AI 原框），不是 verify-input.json（切完回填的框）——
   * 后者已经外扩过 margin，再喂回去会二次外扩，重放结果和原始那轮对不上。
   * 落盘位置在上一轮被 clean 擦掉了，所以重放时 CLEAN 要关掉（见下）。
   */
  let analysis, tAnalyze, samMasks = null;
  if (REPLAY) {
    const { readFile, readdir } = await import('node:fs/promises');
    const src = join(ROOT, 'output', PROJECT, `${SOURCE_NAME}_temp`);
    const inp = JSON.parse(await readFile(join(src, 'cut-input.json'), 'utf-8'));
    analysis = { parts: inp.parts, imageSize };
    tAnalyze = 0;
    const maskDir = join(src, 'masks');
    samMasks = new Map();
    for (const f of await readdir(maskDir).catch(() => [])) {
      if (!f.endsWith('.mask.png')) continue;
      samMasks.set(f.replace(/\.mask\.png$/, ''), { png: await readFile(join(maskDir, f)) });
    }
    console.log(`  ⏪ 重放：AI 部件表 ${analysis.parts.length} 个、掩码 ${samMasks.size} 张（跳过分析，不花钱）`);
  } else {
    const t0 = Date.now();
    analysis = await analyzeImage(IMAGE, '生成动感跳舞的角色', {
      apiKey, baseURL, imageSize, model: process.env.E2E_MODEL || 'claude-opus-5', tightCutout: true
    });
    tAnalyze = Date.now() - t0;
  }

  /*
   * 像素级分割。以前 e2e 完全没走这一步，于是 SAM 相关的逻辑（掩码裁图、
   * 归属表、按框补齐）在真流程里一次都没被验证过——清洁的绿勾给了假信心。
   * 环境没装时 segmentParts 自己返回 null，切图退回多边形，不影响本测试。
   */
  const { segmentParts } = await import('../../server/sam/segment.mjs');
  const { stopSamClient } = await import('../../server/sam/client.mjs');
  if (!REPLAY) {
    try {
      const tSam = Date.now();
      samMasks = await segmentParts(IMAGE, analysis.parts, {
        onLog: (m) => console.log(`  ${m}`)
      });
      if (samMasks?.size) {
        console.log(`  SAM 分割 ${samMasks.size} 个掩码，耗时 ${((Date.now() - tSam) / 1000).toFixed(1)}s`);
      }
    } catch (e) {
      console.log(`  SAM 分割失败（退回多边形）: ${e.message}`);
    }
  }

  const cut = await cutImageParts(IMAGE, analysis.parts, ws.imagesDir, {
    margin: 5, bleed: 1, samMasks
  });

  /*
   * 把 SAM 掩码落盘。
   *
   * 掩码本来只在内存里，出了"某块内容没进任何切图"的问题就只能重跑
   * （一次分析 + 一次分割，好几分钟）。落盘之后：
   *   - scripts/render-animation.mjs 能拿它渲染动画，肉眼看接缝
   *   - 量"谁认领了哪个像素"时不用再调一次 MobileSAM
   */
  if (samMasks?.size) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const maskDir = join(OUT_DIR, 'masks');
    await mkdir(maskDir, { recursive: true });
    for (const [name, entry] of samMasks) {
      await writeFile(join(maskDir, `${name}.mask.png`), entry.png);
    }
    console.log(`  SAM 掩码已存: ${maskDir}（${samMasks.size} 张）`);
  }

  /*
   * 补图前先把每个部件的"不透明像素数"记下来。
   *
   * 这是判断"轮廓有没有被补图改掉"的基准——绝对占比说明不了问题
   * （眼镜、手这类部件本来就接近矩形），只有相对增长才是判据。
   */
  const before = new Map();
  /*
   * 补图前的原始像素也要留一份。
   *
   * 判断"新增的不透明像素是不是落在留白上"必须逐像素比对补图前后的 alpha——
   * 只比总数分不清"填了该填的擦除区"和"把 padding 糊实了"，
   * 而这两件事增长量级相同、性质相反。
   */
  const beforeRaw = new Map();
  for (const c of cut) {
    const b = await opaqueCount(c.path);
    before.set(c.name, b);
    beforeRaw.set(c.name, b.data);
  }

  const t1 = Date.now();
  const report = { done: 0, skipped: 0, failed: 0, failedNames: [], guarded: [] };
  /*
   * 重放时补图默认也跳过：这一步又要花钱又要好几分钟，而「改了切图逻辑
   * 会不会多出/漏掉内容」这个问题只取决于切图的输出，补图只是往上涂色。
   *
   * 代价要看清楚：跳过补图后，**.erased.png 那些区域在切图里是透明的**，
   * 于是下面的「重影」和「补图改轮廓」两条断言变成走过场（必然 0）。
   * 所以跳过时明确打一行提示，别让绿勾给假信心——这正是这套测试栽过的坑。
   * 要连补图一起验就加 E2E_REPLAY_INPAINT=1。
   */
  const doInpaint = !REPLAY || process.env.E2E_REPLAY_INPAINT === '1';
  if (!doInpaint) {
    console.log('  ⏭  重放模式跳过补图：本轮只验切图（孤儿/悬空），重影与轮廓断言不成立');
  }
  for (const c of doInpaint ? cut : []) {
    try {
      const r = await inpaintPart(c.path, {
        apiKey, baseURL,
        model: process.env.E2E_IMAGE_MODEL || 'gpt-image-2.5-sunburst',
        partName: c.name,
        // 走面板默认那条路：最多 2 轮，模型审核不合格才重补
        maxQualityAttempts: Number(process.env.E2E_INPAINT_ATTEMPTS || 2)
      });
      if (r.skipped) report.skipped++;
      else report.done++;
      // 守卫比例：>2% 说明这一轮画得不好（补成一片白/黑），是质量重试的判据
      if (Number.isFinite(r.guardedFrac)) {
        report.guarded.push({ name: c.name, frac: r.guardedFrac });
      }
    } catch (e) {
      report.failed++;
      report.failedNames.push(`${c.name}: ${e.message}`);
    }
  }
  const tInpaint = Date.now() - t1;

  const geom = { ...analysis, parts: analysis.parts.map((p) => {
    const r = cut.find((c) => c.name === p.name);
    return r ? { ...p, bbox: r.bbox, pivot: r.pivot ?? p.pivot } : p;
  }) };
  const skeleton = generateSkeleton(geom, '3.8', { imageSize, density: 8 });
  generateAnimations(skeleton);

  // python worker 不关掉的话测试进程不会退出（子进程还挂着）
  if (samMasks) await stopSamClient?.();

  /*
   * 诊断数据先落盘，再返回。
   *
   * 以前是在断言通过之后才写，于是**失败的那一轮什么证据都没留下**——
   * 想查"哪个像素跑到留白上了"只能重跑一次真流程（几分钟 + 花钱）。
   * 失败的时候恰恰最需要这些数据。
   */
  {
    const { writeFile } = await import('node:fs/promises');
    const partsWithGeom = analysis.parts.map((p) => {
      const c = cut.find((x) => x.name === p.name);
      return c ? { ...p, bbox: c.bbox, pivot: c.pivot ?? p.pivot } : p;
    });
    await writeFile(join(OUT_DIR, `${SOURCE_NAME}.parts.json`),
      JSON.stringify(partsWithGeom, null, 2));
    await writeFile(join(OUT_DIR, `${SOURCE_NAME}.report.json`),
      JSON.stringify({ report, tAnalyze, tInpaint, imageSize }, null, 2));

    /*
     * 把**喂给 cutImageParts 的原始入参**也落一份盘。
     *
     * 为什么不能拿 verify-input.json 代替：那份里的 bbox 是切完回填的，
     * 已经外扩过 margin 和 bleed。再喂回 cutImageParts 会**二次外扩**，
     * 于是离线复现永远和 e2e 差一口气——想对比"改了切图逻辑前后"时，
     * 这点差异足以让结论翻转（试过，孤儿 7.47% vs 6.76%）。
     *
     * 这份存的是 AI 原框 + 原掩码，重放的结果和 e2e 逐像素一致。
     */
    await writeFile(join(OUT_DIR, 'cut-input.json'), JSON.stringify({
      sourceImage: IMAGE,
      imageSize,
      opts: { margin: 5, bleed: 1, samMasks: samMasks?.size ?? 0 },
      parts: analysis.parts,
    }, null, 2));

    /*
     * 合成一份 render-animation / checkGhosts 要的输入（parts + bones + slots）。
     *
     * 在这里写而不是留给脚本：这三块数据在同一次跑里都在内存，脚本事后拼
     * 要么重跑一次 SAM、要么从半成品里反推。落一次盘，两个消费方都能直接用：
     *   - 下面那条「部件不能互相重复」的断言
     *   - scripts/render-animation.mjs 渲染动画，肉眼看接缝
     */
    await writeFile(join(OUT_DIR, 'verify-input.json'), JSON.stringify({
      sourceImage: IMAGE,
      /*
       * 切图窗口在源图里的**真实位置**。
       *
       * checkCoverage 判「框外孤儿」要拿窗口位置去贴切图，可它默认读的
       * parts[].bbox 是 AI 的框（或切完回填的框）——窗口一旦按归属表撑开
       * （见 cutter.js 的 growCap），两者就不一样了，拿旧框贴新图会把
       * 撑出来的那圈算成"不在任何框里"，报一堆假孤儿（实测 9.78% 被误算成
       * 16.86%）。这份是切图自己回的 bbox，和 PNG 的实际尺寸逐像素对得上。
       */
      bboxActual: Object.fromEntries(cut.map((c) => [c.name, c.bbox])),
      parts: analysis.parts.map((p) => {
        const c = cut.find((x) => x.name === p.name);
        return {
          name: p.name,
          depth: p.depth ?? 0,
          polygon: p.polygon,
          ...(c ? { bbox: c.bbox, pivot: c.pivot ?? p.pivot } : {}),
        };
      }),
      bones: skeleton.bones,
      slots: skeleton.slots,
    }, null, 2));

    /*
     * 补图前的切图也留一份。
     *
     * 判断"新增的不透明像素落在留白上还是孔洞里"必须拿补图前的 alpha 逐像素比，
     * 而原位 PNG 已经被补图覆盖了。存进 before/ 子目录，事后随时能重算。
     */
    const beforeDir = join(OUT_DIR, 'before');
    await (await import('node:fs/promises')).mkdir(beforeDir, { recursive: true });
    for (const [name, buf] of beforeRaw) {
      await sharp(buf, { raw: { width: before.get(name).width, height: before.get(name).height, channels: 4 } })
        .png().toFile(join(beforeDir, `${name}.png`));
    }
  }

  return { analysis, cut, report, skeleton, imageSize, tAnalyze, tInpaint, imagesDir: ws.imagesDir, outDir: OUT_DIR, before, beforeRaw };
}

/** 数不透明像素 */
async function opaqueCount(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] >= 8) n++;
  }
  return { n, total: info.width * info.height, width: info.width, height: info.height, data, info };
}

/**
 * 数 erased 掩码里有几个像素。
 *
 * 这张掩码是切图时写的 `<部件名>.erased.png`：被深度擦除或归属让位挖走的
 * 位置，补图应该把它们填实。补图后新变不透明的像素绝大多数落在这里。
 */
async function erasedPixels(pngPath) {
  const maskPath = pngPath.replace(/\.png$/, '.erased.png');
  try {
    const { data, info } = await sharp(maskPath).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    let n = 0;
    // alpha 是掩码语义（255 = 被擦）；RGB 装的是真值色，不能拿来判掩码
    for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] > 127) n++;
    return n;
  } catch {
    return 0;   // 没写掩码 = 这个部件什么都没被擦，正常
  }
}

/**
 * 数「悬空」的新增不透明像素：长在留白里、和任何已有内容都不相连的块。
 *
 * 要抓的回归只有一个：bbox 外扩的那圈 **padding** 被补成了不透明，
 * 部件糊成实心矩形，预览里互相盖成黑框。
 *
 * 为什么不能按「不在 erased 掩码里的新增不透明像素」直接数——那样是误报。
 * 实测 test_role_arbg 一轮：hair 240px、apron 175px、hand_scissors 91px
 * 落在擦除区之外，看着像回归，逐点复核后 **一个都不是**：
 * 全部是内部孔洞（四周 8 邻域都是已不透明的内容），
 * 孤立块 0 个、贴图边 0 个、近白 0 个。
 * 补图的 alpha 放行规则本来就是「连不到图边的透明区才填实」，那些是部件
 * 接缝处的缝，填上是对的；它们不在 erased 掩码里，只是因为擦除掩码记的是
 * 「深度擦除挖走的」，而孔洞是源图本来就透明的。
 * 另外「补图前那个像素透明」也不等于「那儿本该透明」——补图前透明的原因
 * 可能是被 SAM 裁掉、被归属让位，两者都该填。
 *
 * 所以判据换成形状 + 连通性：
 *   对「补图后才不透明、补图前不透明、又不在 erased 掩码里」的像素做 8 邻接
 *   连通块标记。任一块只要有一个像素 8 邻域里挨着**补图前就不透明的**内容
 *   （或擦除区），整块就算「贴着轮廓长出来的」，合法；整块都不挨着任何依托
 *   的，才是悬空——padding 被填实的话，那片矩形离轮廓有几十像素，长出来的
 *   第一块必然四面皆空。
 *
 * 实测这轮 11 个部件：新增块 39/16/5/2… 全部锚定，悬空 0px。
 * @returns {number} 悬空不透明像素数
 */
async function strayOpaque(pngPath, beforeRaw) {
  if (!beforeRaw) return 0;

  const { data, info } = await sharp(pngPath).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  let erased = null;
  try {
    const m = await sharp(pngPath.replace(/\.png$/, '.erased.png')).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    erased = m.data;
  } catch { /* 没有掩码 = 没被擦过 */ }

  const W = info.width, H = info.height;
  const idx = (x, y) => y * W + x;

  /** 补图前这里有内容（或属于擦除区，补图应该填它） */
  const anchored = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = idx(x, y);
    return beforeRaw[i * 4 + 3] >= ALPHA_CUTOFF || (erased !== null && erased[i * 4 + 3] > 127);
  };
  /** 补图后才出现的不透明像素 */
  const isNew = (x, y) => {
    const i = idx(x, y);
    if (data[i * 4 + 3] < ALPHA_CUTOFF) return false;
    if (beforeRaw[i * 4 + 3] >= ALPHA_CUTOFF) return false;
    if (erased !== null && erased[i * 4 + 3] > 127) return false;
    return true;
  };

  const seen = new Uint8Array(W * H);
  let stray = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (seen[i] || !isNew(x, y)) continue;
      seen[i] = 1;
      const stack = [[x, y]];
      let size = 0, touching = false;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        size++;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (anchored(nx, ny)) touching = true;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ni = idx(nx, ny);
            if (seen[ni] || !isNew(nx, ny)) continue;
            seen[ni] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      if (!touching) stray += size;
    }
  }
  return stray;
}


test('真流程：分析 → 切图 → 补图 → 骨骼，产出必须是可用的', {
  skip: !ENABLED && '默认不跑（要花真钱）。设 E2E=1 开启'
}, async (t) => {
  assert.ok(existsSync(IMAGE), `找不到测试图 ${IMAGE}`);
  assert.ok(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    '缺少 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN');
  assert.ok(process.env.ANTHROPIC_BASE_URL, '缺少 ANTHROPIC_BASE_URL');

  await t.test('分析能识别出部件', async () => {
    const r = await runPipeline();
    console.log(`  分析 ${r.analysis.parts.length} 个部件，耗时 ${(r.tAnalyze / 1000).toFixed(1)}s`);
    console.log(`  补图 ${r.report.done} 成功 / ${r.report.skipped} 跳过 / ${r.report.failed} 失败，耗时 ${(r.tInpaint / 1000).toFixed(1)}s`);
    if (r.report.failedNames.length) {
      console.log('  失败部件:\n' + r.report.failedNames.map((n) => '    ' + n).join('\n'));
    }

    assert.ok(r.analysis.parts.length >= 2, `只识别出 ${r.analysis.parts.length} 个部件，太少了`);
    assert.equal(r.cut.length, r.analysis.parts.length, '每个部件都应切出图');
    assert.equal(r.report.failed, 0, `${r.report.failed} 个部件补图失败`);

    /*
     * 最关键的一条：补图不能把部件糊成实心矩形。
     *
     * 判据要分清楚两种"变大"，它们看着一样，性质完全相反：
     *
     *   ① 合法：补上了**被擦除的区域**。切图阶段按深度/归属擦掉的内容
     *      （被前方部件盖住的、判给更靠前那一层的）本来就该由补图填回来，
     *      填完不透明像素当然变多。实测 body 擦掉 38136px、补完长了 28872px，
     *      skirt 擦掉 78763px、长了 71314px——数字一一对得上，这是对的。
     *
     *   ② 出 bug：把 bbox 外扩的那片 **padding** 也写成了不透明。
     *      外部留白按定义连到图边、不是部件的一部分，放行它就会把每个部件
     *      变成实心矩形，预览里互相糊成黑框。旧 bug 的成因正是如此。
     *
     * 所以不能再用"增长上限 = 外扩 2px 的理论值"一把尺子量所有部件
     * （那是按②写出来的，会把①全部误判成失败）。改成逐像素判位置：
     * 新变不透明的像素，要么落在 erased 掩码里（①，合法），
     * 要么落在原内容往外 bleed 的那圈里（锯齿补齐）。落在这两处之外的，
     * 就是 padding 漏了出来（②，才是要抓的回归）。
     */
    const bad = [];
    for (const c of r.cut) {
      const now = await opaqueCount(c.path);
      const was = r.before.get(c.name);
      const grew = now.n - was.n;
      const ratio = now.n / now.total;

      const erased = await erasedPixels(c.path);
      const stray = await strayOpaque(c.path, r.beforeRaw.get(c.name));

      console.log(
        `    ${c.name.padEnd(14)} ${now.width}x${now.height}` +
        ` 不透明 ${(ratio * 100).toFixed(1)}%` +
        ` 比补图前 ${grew >= 0 ? '+' : ''}${grew}px` +
        `（其中擦除区 ${erased}px，悬空新不透明 ${stray}px）`
      );

      // ② 才是回归：原内容之外、又不在擦除区里的地方冒出了不透明像素
      if (stray > 0) {
        bad.push(`${c.name}（${stray}px 悬空不透明：既不连着已有内容、也不在擦除区里，padding 被填实）`);
      }
      if (grew < -was.n * 0.02) {
        bad.push(`${c.name}（缩了 ${-grew}px，内容被吃掉）`);
      }
      // 形状整体不能糊成实心
      if (ratio > 0.95) {
        bad.push(`${c.name}（不透明 ${(ratio * 100).toFixed(1)}%，已经接近实心矩形）`);
      }
    }
    assert.equal(bad.length, 0,
      `补图改动了轮廓，这些部件不合格: ${bad.join(', ')}`);

    // 补出来的内容不能是黑的
    const blackish = [];
    for (const c of r.cut) {
      const { data, info } = await sharp(c.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let opaque = 0, dark = 0;
      for (let i = 0; i < info.width * info.height; i++) {
        if (data[i * 4 + 3] < 8) continue;
        opaque++;
        if (data[i * 4] < 40 && data[i * 4 + 1] < 40 && data[i * 4 + 2] < 40) dark++;
      }
      const ratio = opaque ? dark / opaque : 0;
      if (ratio > 0.5) blackish.push(`${c.name} (${(ratio * 100).toFixed(1)}%)`);
    }
    assert.equal(blackish.length, 0,
      `这些部件大半是黑的，透明区被补成了黑块: ${blackish.join(', ')}`);

    /*
     * 部件之间不能互相重复——「同一块内容出现在多张切图上」。
     *
     * 这是用户报的那个问题的下线断言：头部在 body 上也有一份、脸在 head 上、
     * 两片按不同骨头转起来就是断裂滑动。
     *
     * **判据被推翻过两次，记在这里免得再走回去。**
     *
     * ① 「同一个源像素被两张切图都画了不透明」—— 错。用户要的产物是
     *    「隐藏区域(AI补全/Inpaint) → 完整 Object RGBA」：围裙甩开的时候
     *    底下必须有身体。那么 body 在围裙底下有内容、围裙自己也有内容，
     *    按这个判据一定算重复，正确设计下永远过不了。实测 role7 75.1%、
     *    12 62.2%，全"红"，却全是设计使然。现在只打印不判定。
     *
     * ② 「补出来的颜色像不像遮挡者」（|A色-B色| 小就算重影）—— 也错，
     *    假阳性一片。实测 12 的 handle<tomato 那对 |handle-tomato|=0 的
     *    有 7260px，可那些点**两边都精确等于源图色**，根本不是重影：
     *    那件素材整体偏暗（源图 rgb(1,0,0)、rgb(53,68,2)），任何两个暗色
     *    像素的绝对色差都低于任何合理门槛。色差只能相对地看。
     *
     * 真正的定义是**和真值差多少**。源图那一格就是真值——它就是当时真正
     * 显示的颜色（cutter 把它写进 .erased.png，补图贴回，见 inpaint.js）。
     * 实测那两个典型：body 在裙摆底下补出 [119,113,129]、源图 [108,96,118]；
     * head 在镜片底下补出 [246,183,157]、源图 [225,173,159]——静止时被盖着
     * 看不见，转起来就是一层错色的重影。
     *
     * 判据（checkGhosts，server/api/isolate.js）：
     *   落在某部件擦除区、且那格**有真值**、且该部件在那里不透明，
     *   而 |部件色 - 源图那格色| ≥ 120（L1，三通道合计 ≈ 每通道 40）。
     *
     * 两个必须排除的：
     *   - 源图里彻底空掉的真洞（两件素材合计 412px）——补图在那儿编内容是
     *     它的职责，画成什么都对。实测 12 的 watermelon_slice 46px"重影"
     *     色差高达 628，一查全是真洞，补图照着旁边画了红瓤和浅绿，完全合理。
     *   - 没真值的擦除区，同上。
     *
     * 阈值 5%：实测修好之后 role 0.00%、12 0.00%，这一版之前的中间态是
     * 1.9%（全是贴回边缘渗出来的一两像素锯齿，260 个连通块里 216 个 ≤4px）。
     * 阳性对照：往干净产物里有真值的擦除区涂一层"照着自己可见部分画"的色，
     * 立刻报 35%——判据不是假门。
     */
    const dup = await checkDuplicates(r.outDir, IMAGE);
    console.log(
      `  部件重叠 ${dup.dup}/${dup.covered}px = ${(dup.dupRatio * 100).toFixed(1)}%` +
      `（隐蔽重建，属设计使然；其中落在擦除区里 ${(dup.dupInErased / Math.max(1, dup.dup) * 100).toFixed(1)}%）`
    );

    const gh = await checkGhosts(r.outDir, IMAGE);
    console.log(
      `  重影 ${gh.ghost}/${gh.covered}px = 占覆盖 ${(gh.ghostOfCovered * 100).toFixed(2)}%、` +
      `占有真值的擦除区 ${(gh.ghostOfErased * 100).toFixed(2)}%`
    );
    const topGhost = gh.pairs.slice(0, 3)
      .map((p) => `${p.key} ${p.n}px(色差max ${p.max})`).join('，');
    if (topGhost) console.log(`    最多的三处: ${topGhost}`);

    assert.ok(gh.ghostOfCovered < 0.05,
      `重影 ${(gh.ghostOfCovered * 100).toFixed(2)}% 太高（上限 5%）——` +
      `被盖住那片画的不是源图真值，转起来会断裂滑动。最多的是 ${topGhost}`);

    /*
     * 反过来的一面：**有没有内容谁都没画**。
     *
     * 每个部件只画自己认领的像素，所以源图里任何一块内容只要没被认领，
     * 就谁的切图里都没有它，动画一动就露出背景——这就是用户看到的
     * "头转了脸不转"。
     *
     * 这条是**从渲染视频里肉眼发现才补的**：role10 有 17416px 这种孤儿
     * （9.2% 的源图内容），前面所有断言全绿，因为它们量的都是"画了什么"，
     * 没人量"漏了什么"。
     *
     * 根因是 SAM 分支和 polygon 分支不对称：`right_arm_and_scissors` 的
     * SAM 掩码几乎是空的（占框内 11.0%）被降级到 polygon 路径，可那份小掩码
     * 仍然参与归属表、把框内像素判给了它，然后 polygon 那句「轮廓外的删掉」
     * 又把它们全删了。SAM 分支早有「按框认领」（ownerOf === name 就保留），
     * polygon 分支漏了。
     *
     * 判据用 checkMissingContent：只问"源图这块内容有没有人画"，**不经过
     * 任何 bbox**。checkCoverage 也可以量总量，但它先把切图贴回源图坐标
     * 才能分类，位置取自哪个框就决定结果对不对——而这个项目已经因为
     * "判据量的不是那件事"翻过两次车（重复率一次、框外孤儿一次）。
     * 位置取错会把结果算错，不会算对，所以门槛交给不依赖位置的那条。
     *
     * 历史（免得再走回去）：这条断言原先是 `outsideBoxOfSrc < 0.08`，
     * 测出 role 9.78% 判红。查下去发现**是度量本身错了**：三个 check* 都拿
     * verify-input.json 里 AI 的框去贴切图 PNG，而窗口已经按归属表撑开过，
     * 两者差几十像素，整张图错位贴。同一份切图，框用错的报 9.78%、
     * 框用对的报 0.00%。现在统一走 bboxActual。
     */
    const miss = await checkMissingContent(r.outDir);
    const cov = await checkCoverage(r.outDir, IMAGE);
    console.log(
      `  内容漏失 ${miss.missing}/${miss.srcOpaque}px = ${(miss.ofSrc * 100).toFixed(2)}%` +
      `（诊断：其中落在所有窗口之外的 ${cov.outsideBox}px = ${(cov.outsideBoxOfSrc * 100).toFixed(2)}%）`
    );
    const topOrphan = cov.byPart.slice(0, 3)
      .map((p) => `${p.key} ${p.n}px`).join('，');
    if (topOrphan) console.log(`    最多的三处: ${topOrphan}`);

    assert.ok(miss.ofSrc < 0.01,
      `源图有 ${(miss.ofSrc * 100).toFixed(2)}% 的内容没有任何切图画它` +
      `（上限 1%）——动画一动就露出背景。最多的是 ${topOrphan}`);

    // 骨架要合理
    assert.ok(r.skeleton.bones.length >= r.analysis.parts.length,
      `骨骼数 ${r.skeleton.bones.length} 少于部件数 ${r.analysis.parts.length}`);

    // 把骨架存下来，供截图测试复用（省一次真跑）
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(OUT_DIR, `${SOURCE_NAME}.json`), JSON.stringify(r.skeleton, null, 2));

    // 部件表（含 bbox）在 runPipeline 里就写了，失败的那一轮也留得下
    console.log(`  骨架已存: ${join(OUT_DIR, `${SOURCE_NAME}.json`)}`);
    console.log(`  诊断数据: ${OUT_DIR}/{${SOURCE_NAME}.parts.json, ${SOURCE_NAME}.report.json, before/, masks/}`);
  });
});
