/**
 * 底板（base plate）——源图里「没有任何部件认领」的那些像素。
 *
 * 为什么必须有它：
 *
 * 现役流程只产出部件切图。每个部件的轮廓（SAM 掩码或 AI 多边形）都只覆盖
 * 它自己那块，于是源图上**没被任何轮廓圈中的像素就彻底消失了** ——
 * 不在任何一张切图里，拼回去也拼不出来。实测 test_role_arbg.png：
 * 源图 140936px 不透明像素，9 个部件的并集只盖住 69.9%，
 * **30.1%（42425px）凭空不见了**。走多边形那条路更糟，只盖 65.1%。
 *
 * 这不是「轮廓不够准」，是流程里少了一层。AI 只枚举它认得出的部件
 * （head / left_arm / ...），领口、腰侧、鞋跟旁边那些零碎它不会单独报，
 * 谁都不认领 —— 但源图里它们是有内容的，用户要求「图片全部内容需要显示」。
 *
 * 做法是把它补成一层，放在所有部件**后面**：
 *
 *   底板 = 源图 - 所有切图的并集
 *
 * 于是 `底板 ∪ 全部部件 ≡ 源图不透明像素`，按构造成立，不依赖任何
 * 轮廓质量。轮廓再差也只是「这块像素归底板还是归部件」的分配问题，
 * 不会再丢东西。
 *
 * ## 并集为什么从切图本身算，而不是重算一遍掩码
 *
 * 切图那边经过掩码裁剪、深度擦除、剪影吸附好几道处理，重算掩码很容易
 * 和实际落盘的 PNG 不一致 —— 一旦不一致，底板就会和部件重叠（同一块
 * 像素画两遍，动起来穿插）或者留缝（还是丢内容）。直接读落盘的切图，
 * 「谁认领了哪些像素」就是它本来的定义，不会跑偏。
 *
 * ## 窟窿与补图
 *
 * 部件被挖走的地方，底板上是个洞。默认姿势下这些洞正好被部件盖住，
 * 看不出来；部件一动（手臂摆开）洞就露出来了。所以顺手写一张
 * `_base_plate.erased.png` 标出这些洞，补图那边（inpaint.js）本来就认
 * 这张掩码 —— 它用来区分「部件外的留白」（保持透明）和「该填实的缺口」。
 * 洞有没有连到图边都不影响，正是这张掩码存在的理由。
 *
 * 注意补图填的是「根据四周推断这里本来该是什么」，不是把部件的颜色抄回来：
 * 抄回来等于把部件画了两遍，部件一动就露出一个它自己的残影。
 */

import sharp from 'sharp';
import { join } from 'path';
import { bleedAlpha } from './cutter.js';

/** 与 cutter.js / worker.py 保持一致：低于此 alpha 算透明 */
const ALPHA_CUTOFF = 8;

/** 底板部件名。不以点开头（listArtifacts 会跳过点开头的文件） */
export const BASE_PLATE_NAME = '_base_plate';

/**
 * 无人认领的像素少于源图的这个比例时就不做底板了。
 *
 * 剩下的都是 1px 抗锯齿描边那一类，单独铺一层没有意义，
 * 反而多一个槽位、多一次补图调用。阈值给得很低（0.5%）：
 * 只要真丢了一块看得见的内容就一定会做。
 */
const MIN_ORPHAN_RATIO = 0.005;

/**
 * 造底板。
 *
 * @param {string} sourcePath - 源图（已去背、和切图同一份）
 * @param {Array} cutResults - cutImageParts 的返回值。必须是**补图之前**的，
 *   补图会往洞里填颜色、改 alpha，那时候算出来的并集就不是「部件认领了什么」了
 * @param {string} outputDir - 和切图同一个目录（补图靠同名 .erased.png 找掩码）
 * @param {object} [opts]
 * @param {number} [opts.bleed=2] - 边缘扩散轮数，和切图用同一个值
 * @param {(msg:string, level?:string)=>void} [opts.onLog]
 * @returns {Promise<object|null>} cutResult 形状的一条；无需底板时返回 null
 */
export async function buildBasePlate(sourcePath, cutResults, outputDir, opts = {}) {
  const { bleed = 2, onLog = () => {} } = opts;

  const { data: src, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  // 源图哪里真有内容。底板和部件的并集要对得上的就是这一片
  const opaque = new Uint8Array(W * H);
  let srcTotal = 0;
  for (let i = 0; i < W * H; i++) {
    if (src[i * 4 + 3] >= ALPHA_CUTOFF) { opaque[i] = 1; srcTotal++; }
  }
  if (!srcTotal) {
    onLog('底板：源图整张都是透明的，跳过', 'info');
    return null;
  }

  /*
   * 所有切图认领的像素并集。
   *
   * 每张切图按自己的 bbox 贴回源图坐标系 —— bbox 就是 extract 的窗口
   * 左上角（见 cutter.js 的 results.push），所以这里不需要再算偏移。
   */
  const claimed = new Uint8Array(W * H);
  for (const cut of cutResults) {
    const { data: m, info: mi } = await sharp(cut.path)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ox = Math.round(cut.bbox.x);
    const oy = Math.round(cut.bbox.y);
    for (let y = 0; y < mi.height; y++) {
      const cy = oy + y;
      if (cy < 0 || cy >= H) continue;
      for (let x = 0; x < mi.width; x++) {
        const cx = ox + x;
        if (cx < 0 || cx >= W) continue;
        if (m[(y * mi.width + x) * 4 + 3] >= ALPHA_CUTOFF) claimed[cy * W + cx] = 1;
      }
    }
  }

  // 无人认领 = 源图有、谁都没拿走。这就是现在正在丢的东西
  let orphan = 0;
  for (let i = 0; i < W * H; i++) if (opaque[i] && !claimed[i]) orphan++;

  const ratio = orphan / srcTotal;
  if (ratio < MIN_ORPHAN_RATIO) {
    onLog(
      `底板：无人认领只有 ${orphan}px（源图的 ${(ratio * 100).toFixed(2)}%），都是描边级的碎屑，不铺底板`,
      'info'
    );
    return null;
  }

  /*
   * 底板像素 = 源图，部件认领过的地方置透明。
   *
   * RGB 一律保留原值（连被挖掉的地方也留着）：下面 bleedAlpha 只推 RGB
   * 不动 alpha，留着原色能让洞的边缘采样时有料，缩放时不会糊出黑边。
   */
  const plate = Buffer.alloc(W * H * 4);
  src.copy(plate);
  const holes = new Uint8Array(W * H);
  let holeN = 0;
  for (let i = 0; i < W * H; i++) {
    if (!claimed[i]) continue;
    plate[i * 4 + 3] = 0;
    // 洞 = 源图本来有内容、被部件拿走了。纯背景不算洞，没什么可补的
    if (opaque[i]) { holes[i] = 1; holeN++; }
  }

  const filled = bleed > 0 ? bleedAlpha(plate, W, H, bleed) : plate;

  const platePath = join(outputDir, `${BASE_PLATE_NAME}.png`);
  await sharp(filled, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(platePath);

  /*
   * 洞的掩码交给补图。
   *
   * 补图默认把「连到图边的透明区」当部件外的留白保持透明，而底板的洞
   * 常常连到图边（人物贴着画布边缘），不给这张掩码的话模型补出来的内容
   * 会被整片丢掉 —— 和当初 basket_back「报补了 99%、落盘只有 0.8%」
   * 是同一个坑。
   */
  const maskPath = join(outputDir, `${BASE_PLATE_NAME}.erased.png`);
  const maskBuf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = holes[i] ? 255 : 0;
    maskBuf[i * 4] = v;
    maskBuf[i * 4 + 1] = v;
    maskBuf[i * 4 + 2] = v;
    maskBuf[i * 4 + 3] = 255;
  }
  await sharp(maskBuf, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(maskPath);

  onLog(
    `✓ 底板：接住 ${orphan}px 无人认领的内容（源图的 ${(ratio * 100).toFixed(1)}%），` +
    `另标出 ${holeN}px 被部件挖走的缺口待补`,
    'success'
  );

  return {
    name: BASE_PLATE_NAME,
    path: platePath,
    size: { width: W, height: H },
    // 整张画布。底板不做外扩也不吸附，坐标就是源图坐标
    bbox: { x: 0, y: 0, width: W, height: H },
    pivot: { x: W / 2, y: H / 2 },
    margin: { left: 0, top: 0, right: 0, bottom: 0 },
    occlusionEdges: [],
    snapped: false,
    contour: 'base',
    originalBbox: { x: 0, y: 0, width: W, height: H },
    // 诊断用：这层到底接住了多少、还留了多少洞
    orphanPixels: orphan,
    holePixels: holeN
  };
}

/**
 * 底板对应的「部件」条目，喂给 generateSkeleton。
 *
 * `parent: null` + 放在 parts 数组**最前面**：生成器的绘制顺序就是
 * topologicalSort 之后的槽位顺序，排第一就画在最底层，被所有部件压住。
 * depth 给 -1 只是为了语义上一眼看出它在最后面（绘制顺序不看这个字段）。
 */
export function basePlatePart(width, height) {
  return {
    name: BASE_PLATE_NAME,
    parent: null,
    depth: -1,
    bbox: { x: 0, y: 0, width, height },
    pivot: { x: width / 2, y: height / 2 },
    occlusion_edges: []
  };
}
