/**
 * 把一次生成的骨架 + 切图渲染成动画视频（Issue 2 的验证工具）。
 *
 * 为什么要渲染视频而不是只看静态切图：用户报的问题是"组成 spine 动画的时候，
 * 看到头部在断裂滑动"。断裂滑动只在**动起来**的时候才看得见——静态切图里
 * 一张图看着干干净净，两张图底下的内容却是重叠的；只有把部件按骨骼转起来，
 * 重叠区各自跟着不同的骨头走，才会露出接缝。
 *
 * 用法：
 *   node scripts/render-animation.mjs <parts.json> <imagesDir> <outDir> [源图.png]
 *
 * parts.json 需要两块数据：
 *   { "parts": [ {name, bbox:{x,y,width,height}, depth} ... ],
 *     "bones": [ {name, x, y, parent} ... ],
 *     "slots": [ {bone, attachment} ... ] }
 *
 * e2e 测试的产物正好是这个形状（skeleton 里带 bones/slots，外挂 analysis.parts），
 * 所以 dump-verify-input.mjs 负责把它们合成这一个文件。
 */
import sharp from 'sharp';
import { readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

const [,, dataPath, imgDir, outDir, srcPathArg] = process.argv;
if (!dataPath || !imgDir || !outDir) {
  console.error('用法: node scripts/render-animation.mjs <parts.json> <imagesDir> <outDir> [源图.png]');
  process.exit(1);
}

const data = JSON.parse(await readFile(dataPath, 'utf-8'));
const parts = data.parts ?? [];
const bones = data.bones ?? [];
const slots = data.slots ?? [];

const bboxOf = new Map(parts.filter((p) => p.bbox).map((p) => [p.name, p.bbox]));

// 画布就是源图那块：骨骼的 x/y 和 attachment 的偏移都是相对源图左上角对齐的
let W, H;
if (srcPathArg) {
  const m = await sharp(srcPathArg).metadata();
  W = m.width; H = m.height;
} else {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { x, y, width, height } of bboxOf.values()) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + width); y1 = Math.max(y1, y + height);
  }
  W = Math.ceil(x1); H = Math.ceil(y1);
  console.warn(`  ⚠ 没给源图，按 bbox 并集取画布 ${W}x${H}`);
}

/*
 * 部件贴图。
 *
 * 点名要用 slot.attachment ?? slot.bone：实测的骨架里 slot 上根本没有
 * attachment 字段（只有 bone），老脚本只读 attachment，于是每个槽位都取不到图、
 * 渲染出来一片空白——静默失败，比报错还难查。
 */
const partData = new Map();
for (const slot of slots) {
  const name = slot.attachment ?? slot.bone;
  if (!name || partData.has(name)) continue;
  try {
    const { data: px, info } = await sharp(join(imgDir, `${name}.png`))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    partData.set(name, { data: px, w: info.width, h: info.height });
  } catch {
    console.warn(`  ⚠ ${name}.png 读不到，跳过`);
  }
}
if (!partData.size) {
  console.error(`切图目录里一张图都没读到: ${imgDir}`);
  process.exit(1);
}

/*
 * 姿态：按骨骼名的关键词给角度。
 *
 * 不写死具体名字——老脚本写死了 left_upper_arm 这类，换一张图全部落空、
 * 动画纹丝不动，看着像"渲染没问题"。按语义分组，换任何图都能动起来。
 */
function poseFor(t) {
  const swing = Math.sin(t * Math.PI * 2);
  const pose = new Map();
  for (const b of bones) {
    const n = b.name.toLowerCase();
    let deg;
    if (/head|neck|face/.test(n)) deg = swing * 9;
    else if (/hair|bun|ponytail|braid/.test(n)) deg = swing * 9;
    else if (/glasses|eye/.test(n)) deg = swing * 9;
    else if (/arm|hand|sleeve|scissors/.test(n)) deg = swing * 22;
    else if (/leg|foot|feet|shoe|boot|thigh|shin/.test(n)) deg = swing * 7;
    else if (/skirt|apron|dress|cloak|robe/.test(n)) deg = swing * 4;
    else if (/body|torso|trunk|waist|hip|tie|back|plate|base/.test(n)) deg = 0;
    else deg = swing * 3;
    // 左右反相才像挥手/迈步，同相看起来是整块平移
    if (/\bleft|_l$|^l_/.test(n)) deg = -deg;
    pose.set(b.name, deg);
  }
  return pose;
}

function rot(px, py, cx, cy, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/**
 * 渲染一帧。
 *
 * 绘制顺序 = slots 顺序（生成器已按 depth 排好），重叠区由靠前的部件覆盖。
 * 归属表修好之后同一块内容只属于一个部件，这里就不会出现两块内容各转各角。
 */
async function renderPose(t, outFile) {
  const pose = poseFor(t);
  const canvas = Buffer.alloc(W * H * 4);

  for (const slot of slots) {
    const name = slot.attachment ?? slot.bone;
    const pd = partData.get(name);
    const bbox = bboxOf.get(name);
    if (!pd || !bbox) continue;

    /*
     * 贴图位置 = bbox 本身，旋转中心 = bbox 内的 pivot。
     *
     * 不能累加骨骼的 x/y 来定位：那是**导出给 Spine 的**骨骼偏移，
     * 这里的 bbox 已经是源图里的绝对坐标。两套都算一遍等于把偏移
     * 翻倍应用，画出来就是同一个角色错开叠了三份。
     */
    const pivot = data.parts.find((x) => x.name === name)?.pivot;
    const cx = bbox.x + (pivot?.x ?? pd.w / 2);
    const cy = bbox.y + (pivot?.y ?? pd.h / 2);
    const ang = pose.get(slot.bone ?? name) ?? 0;

    for (let y = 0; y < pd.h; y++) {
      for (let x = 0; x < pd.w; x++) {
        const si = (y * pd.w + x) * 4;
        const a = pd.data[si + 3] / 255;
        if (a <= 0) continue;

        const sx = bbox.x + x, sy = bbox.y + y;
        const [tx, ty] = ang ? rot(sx, sy, cx, cy, ang) : [sx, sy];
        const dx = Math.round(tx), dy = Math.round(ty);
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;

        const di = (dy * W + dx) * 4;
        const da = canvas[di + 3] / 255;
        const oa = a + da * (1 - a);
        if (oa <= 0) continue;
        canvas[di]     = Math.round((pd.data[si]     * a + canvas[di]     * da * (1 - a)) / oa);
        canvas[di + 1] = Math.round((pd.data[si + 1] * a + canvas[di + 1] * da * (1 - a)) / oa);
        canvas[di + 2] = Math.round((pd.data[si + 2] * a + canvas[di + 2] * da * (1 - a)) / oa);
        canvas[di + 3] = Math.round(oa * 255);
      }
    }
  }

  await sharp(canvas, { raw: { width: W, height: H, channels: 4 } })
    .flatten({ background: { r: 245, g: 245, b: 248 } })
    .png().toFile(outFile);
}

const framesDir = join(outDir, 'frames');
await mkdir(framesDir, { recursive: true });

// 一个完整来回 + 回到起点，方便循环播放看不出接缝
const FRAMES = Number(process.env.FRAMES || 48);
console.log(`渲染 ${FRAMES} 帧到 ${framesDir}（画布 ${W}x${H}，${partData.size} 个部件）`);
for (let i = 0; i < FRAMES; i++) {
  const t = i / FRAMES;
  await renderPose(t, join(framesDir, `f${String(i).padStart(3, '0')}.png`));
}

const video = join(outDir, 'animation.mp4');
try {
  await run('ffmpeg', [
    '-y', '-framerate', '24',
    '-i', join(framesDir, 'f%03d.png'),
    // 偶数尺寸是 yuv420p 的硬要求，奇数宽高会让 ffmpeg 直接报错
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
    video
  ]);
  console.log(`✓ 视频: ${video}`);
} catch (e) {
  console.warn(`ffmpeg 合成失败（帧序列仍在 ${framesDir}）: ${e.message}`);
}

// 九宫格：不装播放器也能一眼对比 9 个姿态
const picks = [0, 3, 6, 9, 12, 15, 21, 27, 33].filter((i) => i < FRAMES);
const cellW = Math.ceil(W / 3), cellH = Math.ceil(H / 3);
const strip = Buffer.alloc(cellW * 3 * cellH * 3 * 4);
for (let k = 0; k < picks.length && k < 9; k++) {
  const { data } = await sharp(join(framesDir, `f${String(picks[k]).padStart(3, '0')}.png`))
    .resize(cellW, cellH, { fit: 'contain', background: { r: 245, g: 245, b: 248 } })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const gx = (k % 3) * cellW, gy = Math.floor(k / 3) * cellH;
  for (let y = 0; y < cellH; y++) {
    for (let x = 0; x < cellW; x++) {
      const s = (y * cellW + x) * 4;
      const d = ((gy + y) * cellW * 3 + gx + x) * 4;
      strip[d] = data[s]; strip[d + 1] = data[s + 1]; strip[d + 2] = data[s + 2]; strip[d + 3] = 255;
    }
  }
}
await sharp(strip, { raw: { width: cellW * 3, height: cellH * 3, channels: 4 } })
  .png().toFile(join(outDir, 'contact-sheet.png'));
console.log(`✓ 九宫格: ${join(outDir, 'contact-sheet.png')}`);
