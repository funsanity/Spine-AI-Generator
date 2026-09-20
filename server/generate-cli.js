/**
 * 命令行生成器，供 scripts/auto-improve.mjs 调用。
 *
 * 环境变量:
 *   SOURCE_IMAGE          输入图路径（必填）
 *   PROMPT                用户提示词
 *   MARGIN / BLEED / SNAP 切图参数
 *   INPAINT=0             跳过补图（快速迭代切图参数时用）
 *   USE_SAM=0             跳过 MobileSAM 像素级分割（默认开启，环境未装时自动降级）
 *   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL  见 .env
 *
 * 每轮开跑前会清空 images/。不清的话历史轮次的切图会留在目录里，
 * 质量评估脚本扫的是整个目录，算出来的分是几轮产物的混合——
 * 这正是之前 leg_back 连续 10 轮都是 21 分、白边都是 48px 的原因：
 * 那张图根本没被重新生成过。
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import sharp from 'sharp';

const SOURCE = process.env.SOURCE_IMAGE;
const PROMPT = process.env.PROMPT || '人物角色';
const MARGIN = parseInt(process.env.MARGIN || '4', 10);
const BLEED = parseInt(process.env.BLEED || '2', 10);
const SNAP = process.env.SNAP !== '0';
const DO_INPAINT = process.env.INPAINT !== '0';
const USE_SAM = process.env.USE_SAM !== '0';

const apiKey = process.env.ANTHROPIC_API_KEY;
const baseURL = process.env.ANTHROPIC_BASE_URL;
const model = process.env.AI_MODEL || 'claude-opus-5';
const imageModel = process.env.IMAGE_MODEL || 'gpt-image-2';

if (!SOURCE) { console.error('缺少 SOURCE_IMAGE'); process.exit(1); }
if (!apiKey) { console.error('缺少 ANTHROPIC_API_KEY'); process.exit(1); }

const sourceName = basename(SOURCE).replace(/\.(png|jpg|jpeg)$/i, '');
const outputDir = join(process.cwd(), 'output/generated', sourceName);
const imagesDir = join(outputDir, 'images');

async function main() {
  console.log(`[生成] margin=${MARGIN} bleed=${BLEED} snap=${SNAP} inpaint=${DO_INPAINT}`);

  // 清空上一轮产物，避免评分混入历史切图
  rmSync(imagesDir, { recursive: true, force: true });
  mkdirSync(imagesDir, { recursive: true });

  const meta = await sharp(SOURCE).metadata();
  console.log(`[生成] 尺寸: ${meta.width}×${meta.height}`);

  const { classifyImage, analyzeImage } = await import('./ai/claude.js');
  const { cutImageParts } = await import('./api/cutter.js');
  const { inpaintPart } = await import('./api/inpaint.js');
  const { generateSkeleton, generateAnimations } = await import('./api/generator.js');
  const { segmentParts } = await import('./sam/segment.mjs');
  const { stopSamClient } = await import('./sam/client.mjs');
  const { buildBasePlate, basePlatePart } = await import('./api/baseplate.js');

  const category = await classifyImage(SOURCE, { apiKey, baseURL, model });
  console.log(`[生成] 类别: ${category}`);

  let finalPrompt = PROMPT;
  try {
    /*
     * 模板在 config/ 下；根目录那份是 2026-09 之前的旧位置，留着兜底，
     * 老用户的模板放在那儿才不会因为这次搬家就读不到。
     */
    const candidates = [
      join(process.cwd(), 'config', 'prompt-templates.json'),
      join(process.cwd(), 'prompt-templates.json')
    ];
    const tplPath = candidates.find((p) => existsSync(p));
    if (!tplPath) throw new Error(`未找到模板文件（找过 ${candidates.join('、')}）`);
    const raw = await readFile(tplPath, 'utf-8');
    const tpl = JSON.parse(raw)[category]?.template;
    if (tpl) {
      finalPrompt = `${tpl}\n\n用户补充：${PROMPT}`;
      console.log(`[生成] 已套用 ${category} 模板`);
    }
  } catch (err) {
    console.warn(`[生成] 模板未加载: ${err.message}`);
  }

  const analysis = await analyzeImage(SOURCE, finalPrompt, {
    apiKey, baseURL, model, imageSize: { width: meta.width, height: meta.height }
  });
  console.log(`[生成] 部件: ${analysis.parts.length}`);

  // 调试用：把分析结果落盘，便于不调 AI 重放切图
  if (process.env.DUMP_ANALYSIS) {
    writeFileSync(process.env.DUMP_ANALYSIS, JSON.stringify(analysis, null, 2));
    console.log(`[生成] 分析已存 ${process.env.DUMP_ANALYSIS}`);
  }

  // SAM 像素级分割（与 index.js 同路径）：失败时 segmentParts 返回 null，自动降级多边形
  const samMasks = await segmentParts(SOURCE, analysis.parts, {
    useSam: USE_SAM,
    onLog: (msg) => console.log(msg)
  });

  const cutResults = await cutImageParts(SOURCE, analysis.parts, imagesDir,
    { margin: MARGIN, bleed: BLEED, snap: SNAP, samMasks });
  console.log(`[生成] 切图: ${cutResults.length}`);

  // 底板：接住没有任何部件认领的源图像素（见 api/baseplate.js）。
  // 必须在补图之前算，补图会改 alpha
  const basePlate = await buildBasePlate(SOURCE, cutResults, imagesDir,
    { bleed: BLEED, onLog: (m) => console.log(m) });
  if (basePlate) cutResults.unshift(basePlate);

  if (DO_INPAINT) {
    let done = 0, skipped = 0, failed = 0;
    for (const cut of cutResults) {
      try {
        const r = await inpaintPart(cut.path, {
          apiKey, baseURL, model: imageModel, partName: cut.name,
          occlusionEdges: cut.occlusionEdges
        });
        if (r.skipped) { skipped++; console.log(`  ○ ${cut.name}: ${r.reason}`); }
        else { done++; console.log(`  ✓ ${cut.name}: 补了 ${(r.coverage * 100).toFixed(0)}%`); }
      } catch (err) {
        // 单件失败不该中断整轮，但必须报出来——之前这里是 catch {}，
        // baseURL 未定义导致的 TypeError 被吞了 10 轮没人发现
        failed++;
        console.warn(`  ✗ ${cut.name} 补图失败: ${err.message}`);
      }
    }
    console.log(`[生成] 补图: ${done} 成功 / ${skipped} 无需补 / ${failed} 失败`);
  } else {
    console.log('[生成] 补图: 已跳过（INPAINT=0）');
  }

  const partsWithBase = basePlate
    ? [basePlatePart(meta.width, meta.height), ...analysis.parts]
    : analysis.parts;
  const skeleton = generateSkeleton({ ...analysis, parts: partsWithBase }, '3.8',
    { imageSize: { width: meta.width, height: meta.height }, density: 8 });
  generateAnimations(skeleton);

  writeFileSync(join(outputDir, `${sourceName}.json`), JSON.stringify(skeleton, null, 2));

  const rooted = skeleton.bones.filter((b) => b.parent && b.parent !== 'root').length;
  console.log(`[生成] 骨骼: ${skeleton.bones.length} 根，其中 ${rooted} 根有父级`);
  console.log('[生成] ✓ 完成');

  // SAM worker 的 stdio 是活动句柄，不显式关闭进程退不出去
  stopSamClient();
}

main().catch((err) => { console.error('✗', err.stack || err.message); process.exit(1); });
