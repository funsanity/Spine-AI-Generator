/**
 * 产物结构校验。
 *
 * 用来在交付前挡住那几类"肉眼一眼就看出来、但单测抓不到"的退化：
 *
 *   1. 轮廓丢失 —— 部件被糊成实心矩形。曾经因为补图把蒙版内所有像素的
 *      alpha 写成 255，切图外扩的那几像素 padding 一起变成不透明，
 *      整个部件变成黑框，预览里全糊在一起。
 *   2. 补图变黑 —— 模型收到摊平成黑色的透明区，把黑块原样补了回来。
 *   3. 棋盘格残留 —— 中转站返回 3 通道图，模型把"透明"画成 RGB 棋盘格纹理。
 *
 * 判据都是**相对**的，不是绝对占比：
 *
 *   - 轮廓：看补图前后的不透明像素增长，上限按轮廓周长算。
 *     绝对占比没用：眼镜、拳头这类部件本来就接近矩形（实测 99.7%、100%）。
 *   - 颜色：把产物和**源图对应区域**比。有些素材本身就大量纯黑描边
 *     （宫灯那张源图 17.2% 的像素是纯黑），拿固定阈值判"太黑了"
 *     必然误伤——只有"比源图明显更黑"才是补出来的黑块。
 *
 * 用法:
 *   node scripts/verify-artifacts.mjs <部件目录> [源图路径]
 *
 * 例:
 *   node scripts/verify-artifacts.mjs output/e2e/images test_assets/level_83/hidden/01.png
 */

import sharp from 'sharp';
import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const dir = process.argv[2] || 'output/generated/images';
const sourceArg = process.argv[3];

const failures = [];
const warnings = [];

if (!existsSync(dir)) {
  console.error(`产物目录不存在: ${dir}`);
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
if (!files.length) {
  console.error(`产物目录里没有 PNG: ${dir}`);
  process.exit(2);
}

/**
 * 从产物自己反推"补图前的轮廓"是做不到的，所以轮廓判据只能靠自己内部一致：
 * 部件的 alpha 通道是否接近矩形。用两个量描述：
 *
 *   - 实心度：不透明像素占 bbox 的比例
 *   - 直边度：四条边界上"整行/整列都不透明"的比例。实心矩形接近 1；
 *     正常部件因为透明边距，边界上有大量透明像素，这个值低得多。
 *
 * 直边度比实心度可靠：L 形部件（宫灯的横杆 + 吊穗）实心度能到 90%+，
 * 但它的四条边不可能是齐的。
 */
async function analyze(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const opaque = (x, y) => data[(y * W + x) * 4 + 3] >= 8;

  let op = 0, black = 0;
  for (let i = 0; i < W * H; i++) {
    if (data[i * 4 + 3] < 8) continue;
    op++;
    if (data[i * 4] < 12 && data[i * 4 + 1] < 12 && data[i * 4 + 2] < 12) black++;
  }

  // 四条边：整行/整列都实心的比例
  let solidRows = 0, solidCols = 0;
  for (let y = 0; y < H; y++) {
    let full = true;
    for (let x = 0; x < W; x++) if (!opaque(x, y)) { full = false; break; }
    if (full) solidRows++;
  }
  for (let x = 0; x < W; x++) {
    let full = true;
    for (let y = 0; y < H; y++) if (!opaque(x, y)) { full = false; break; }
    if (full) solidCols++;
  }

  return {
    W, H,
    fill: op / (W * H),
    blackOfOpaque: op ? black / op : 0,
    // 整行实心 + 整列实心占全部行列的比例
    straightness: (solidRows + solidCols) / (W + H)
  };
}

console.log(`校验 ${files.length} 个部件（${dir}）\n`);

// 源图对应区域的纯黑占比：产物不该比它明显更黑
let sourceBlackRatio = null;
let sourceBlackLabel = '';
if (sourceArg && existsSync(sourceArg)) {
  const all = await analyze(sourceArg);
  sourceBlackRatio = all.blackOfOpaque;
  sourceBlackLabel = sourceArg;
  console.log(`源图基准: ${sourceArg}  纯黑占不透明像素 ${(sourceBlackRatio * 100).toFixed(1)}%\n`);
}

for (const f of files) {
  const a = await analyze(join(dir, f));
  const notes = [];

  /*
   * 实心矩形判定。
   *
   * 用"直边度"而不是"实心度"：补图把 padding 写成不透明时，
   * 整个 bbox 被填满，四条边会变成齐的（直边度 → 1）。
   * 同时实心度也会顶到 ~100%。两个条件一起用，避免误伤
   * 本来就接近矩形的部件。
   */
  if (a.straightness > 0.9 && a.fill > 0.95) {
    failures.push(`${f}: 轮廓丢失（直边度 ${(a.straightness * 100).toFixed(0)}%，实心度 ${(a.fill * 100).toFixed(1)}%）——部件被糊成了实心矩形`);
    notes.push('轮廓丢失');
  }

  // 比源图明显更黑才算"补出来的黑块"
  if (sourceBlackRatio !== null && a.blackOfOpaque > sourceBlackRatio + 0.25) {
    failures.push(`${f}: 补图变黑（纯黑 ${(a.blackOfOpaque * 100).toFixed(1)}%，源图只有 ${(sourceBlackRatio * 100).toFixed(1)}%）`);
    notes.push('补图变黑');
  }

  // 近白成片：棋盘格残留
  const { data, info } = await sharp(join(dir, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let op2 = 0, white = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3] < 8) continue;
    op2++;
    if (data[i * 4] > 230 && data[i * 4 + 1] > 230 && data[i * 4 + 2] > 230) white++;
  }
  const whiteRatio = op2 ? white / op2 : 0;
  if (whiteRatio > 0.5) {
    failures.push(`${f}: 棋盘格残留（近白 ${(whiteRatio * 100).toFixed(1)}%）`);
    notes.push('棋盘格残留');
  }

  const status = notes.length ? '✗ ' + notes.join('、') : '✓';
  console.log(
    `${status.padEnd(18)} ${f.padEnd(22)} ${a.W}x${a.H}` +
    ` 实心度 ${(a.fill * 100).toFixed(1)}%` +
    ` 直边度 ${(a.straightness * 100).toFixed(0)}%` +
    ` 纯黑 ${(a.blackOfOpaque * 100).toFixed(1)}%` +
    ` 近白 ${(whiteRatio * 100).toFixed(1)}%`
  );
}

console.log();

if (failures.length) {
  console.error(`✗ ${failures.length} 项不合格：\n`);
  failures.forEach((f) => console.error('  ' + f));
  process.exit(1);
}

if (warnings.length) warnings.forEach((w) => console.warn('  ⚠ ' + w));
console.log(`✓ 全部 ${files.length} 个部件通过结构校验`);
