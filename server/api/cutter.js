/**
 * 切图与补图。
 *
 * 硬切 bbox 会留下两个必现问题：
 *
 *   1. 黑边。切片边缘的透明像素 RGB 通常是 (0,0,0)，纹理双线性采样会把它
 *      和相邻不透明像素平均，边上就出现一圈暗线。图集缩放越多越明显。
 *      解法是 alpha 扩散：把不透明像素的颜色往外推进透明区，alpha 保持 0。
 *      形状一点没变，采样时被平均进来的却是正确的颜色。
 *
 *   2. 透明缝。网格在关节处会被拉伸到原 bbox 之外，那里没有像素，
 *      转动时接缝直接透出背景。解法是外扩切图：多切一圈原图内容，
 *      让拉伸有料可用。
 *
 * 外扩会改变 bbox，所以切图必须把改过的 bbox 交回调用方——
 * pivot 是相对 bbox 原点的，bbox 左上角挪了，pivot 要同量补偿，
 * 否则骨骼原点会整体偏掉。
 *
 * 部件轮廓有两个来源，按优先级：
 *
 *   SAM 掩码（opts.samMasks）—— 像素级，由 MobileSAM 从 bbox 提示算出。
 *     天然只包含这件东西**可见**的像素：提手压在番茄上的那条弧不在番茄
 *     掩码里。不需要深度推理，切出来就是干净的。
 *
 *   polygon（part.polygon）—— AI 给的顶点，粗。作为没有 SAM 时的退化路径。
 *
 * 两者的取舍见 docs/mobilesam-feasibility.md。
 */

import sharp from 'sharp';
import { cleanupOwnership } from './ownership-cleanup.js';
import { penEdge, snapOwnership } from './pen-edge.js';
import { mkdir } from 'fs/promises';
import { join } from 'path';

/** 外扩像素数。4 px 足够覆盖关节处的拉伸量，再大就会把邻件内容切进来 */
const DEFAULT_MARGIN = 4;

/** alpha 扩散轮数。每轮往外推一圈，2 轮够覆盖双线性采样的取样半径 */
const DEFAULT_BLEED = 2;

/** alpha 低于此值算透明，可被扩散填充 */
const ALPHA_CUTOFF = 8;

/**
 * 按归属表撑窗口时，每条边最多往外撑多少像素。
 *
 * 认领是基于连通性的推断，偶尔会顺着相邻的大色块传染出去（实测掩码外溢
 * 时 head 吃到过 torso）。没有上限的话，一次误判就能把窗口撑到整张图，
 * 切出来的图又大又脏，还会连带把邻件圈进擦除表。
 */
const GROW_CAP = 120;

/** SAM 掩码最多可以超出自己的多边形多少像素（见 clipToPolygon） */
const POLY_SLACK = 15;

/** 方形膨胀（切比雪夫距离 ≤ r）：两遍一维滑窗，O(像素数) */
function dilateSquare(mask, W, H, r) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let cnt = 0;
    const row = y * W;
    for (let x = 0; x < Math.min(W, r); x++) cnt += mask[row + x] ? 1 : 0;
    for (let x = 0; x < W; x++) {
      if (x + r < W && mask[row + x + r]) cnt++;
      if (x - r - 1 >= 0 && mask[row + x - r - 1]) cnt--;
      if (cnt > 0) tmp[row + x] = 1;
    }
  }
  for (let x = 0; x < W; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(H, r); y++) cnt += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H && tmp[(y + r) * W + x]) cnt++;
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * W + x]) cnt--;
      if (cnt > 0) out[y * W + x] = 1;
    }
  }
  return out;
}

/** 被挡位置掩码的画布：部件窗口四周各外扩这个比例（见 .hidden.png 那段） */
const HIDDEN_PAD = 0.15;

/**
 * 把 SAM 掩码 PNG 解码成布尔掩码（源图尺寸）。
 *
 * worker 回的是「255=属于该部件」的灰度 PNG，这里解成 Uint8Array。
 * 每个部件解码一次，结果缓存起来——擦除阶段还要用它判断遮挡者的位置，
 * 重复解码会白白多花时间。
 *
 * @param {Buffer} png - 掩码 PNG（灰度）
 * @param {number} W - 期望宽（源图宽）
 * @param {number} H - 期望高（源图高）
 * @returns {Promise<Uint8Array>} 长度 W*H，1 = 属于该部件
 */
export async function decodeMask(png, W, H) {
  const { data, info } = await sharp(png)
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(W * H);
  // worker 回来的掩码就是源图尺寸，但留一道尺寸兜底：
  // 万一哪天 worker 换了输出尺度，这里退化成按比例取样而不是错位
  if (info.width === W && info.height === H) {
    for (let i = 0; i < W * H; i++) mask[i] = data[i] > 127 ? 1 : 0;
  } else {
    for (let y = 0; y < H; y++) {
      const sy = Math.min(info.height - 1, Math.floor(y * info.height / H));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(info.width - 1, Math.floor(x * info.width / W));
        mask[y * W + x] = data[sy * info.width + sx] > 127 ? 1 : 0;
      }
    }
  }
  return mask;
}

/**
 * 多边形填充（扫描线算法）→ Uint8Array 掩码（1 = 部件内部）。
 *
 * polygon 是像素坐标数组，相对于整张源图左上角。
 * 输出是与源图等宽等高的掩码，或局部裁剪区（offset x0/y0）的掩码。
 *
 * 用于两个地方：
 *   1. 切图：只保留 polygon 内的像素，把框里的邻件扣掉
 *   2. 擦除：判断"遮挡者的哪些像素落在本部件的 polygon 里"，只擦那些
 *
 * @param {Array<{x, y}>} polygon - 像素坐标顶点（相对源图）
 * @param {number} W - 输出掩码宽（裁剪区宽，= x1 - x0）
 * @param {number} H - 输出掩码高（裁剪区高，= y1 - y0）
 * @param {number} [offX=0] - 裁剪区左上角 x（源图坐标）
 * @param {number} [offY=0] - 裁剪区左上角 y（源图坐标）
 * @returns {Uint8Array} 长度 W*H，1 = 在多边形内
 */
export function fillPolygon(polygon, W, H, offX = 0, offY = 0) {
  const mask = new Uint8Array(W * H);
  const n = polygon.length;
  if (n < 3) return mask;

  const px = polygon.map((p) => p.x - offX);
  const py = polygon.map((p) => p.y - offY);

  for (let y = 0; y < H; y++) {
    // 扫描线求与多边形各边的交点
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = py[i], yj = py[j];
      if ((yi > y) !== (yj > y)) {
        xs.push(px[i] + (y - yi) / (yj - yi) * (px[j] - px[i]));
      }
    }
    xs.sort((a, b) => a - b);
    /*
     * 奇偶规则：成对交点之间的区域属于多边形内部。
     *
     * 边界按「像素中心落在区间内」判定，也就是左闭右开 [ceil(lo), ceil(hi))。
     * 不能简单地取 [ceil(lo), floor(hi)]：两个部件共边时（西红柿的右缘正好
     * 挨着西瓜的左缘），闭区间会把交界那一列同时判给两边，两个部件都带着
     * 对方的一条——实测红色切图里混进 80 像素蓝边就是这么来的。
     * 左闭右开则让交界列只属于一侧，正好贴合"轮廓之间不重叠"的语义。
     */
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(W, Math.ceil(xs[k + 1]));
      for (let x = x0; x < x1; x++) mask[y * W + x] = 1;
    }
  }

  return mask;
}

/*
 * 剪影吸附。
 *
 * AI 给的 bbox 是矩形，可部件几乎从来不是矩形。实测 test_role_arbg.png
 * 那条右小臂：AI 给的框 65x188，框里不透明像素只占 50.1%，而且最下面
 * 12 行「内容宽度」全是 65px（顶满框宽）——手臂真实宽度只有 21px。
 * 也就是说框的下端已经伸进躯干，切出来的是「手臂 + 一横条身体」。
 * 动画一转，那条多余的身体跟着手臂走，用户看到的就是「缺块」「错位」。
 *
 * 解法是在框内找出「和中间那块连在一起的不透明区域」，把 bbox 收紧到它，
 * 再按 margin 外扩。这是纯本地计算，不额外调用一次 API。
 *
 * 判据不能用「离框中心最近的连通块」——手臂的框中心常常落在躯干上
 * （框已经偏了），那会吸到躯干。改用「和框中心所在那块相连的整体」，
 * 中心落在透明区时退化成找面积最大的块。
 */

/** 吸附后 bbox 至少留这么大，防住 AI 给的小框被收成一条缝 */
const SNAP_MIN_SIDE = 4;

/** 连通块小于这个面积就不认，宁可保留原框 */
const SNAP_MIN_AREA = 24;

/** 中心点周围这个半径内的不透明像素算「中心那块」。手臂这类细长部件也覆盖得到 */
const SNAP_SEED_RADIUS = 2;

/*
 * 宽度剖面突变判据。
 *
 * 部件和邻件**贴合**时（手臂下端接在躯干上，中间没有透明带），连通域会把
 * 两块并成一块，上面那三级选块判据全都无从分辨——选出来的框仍然是整个
 * 躯干那么宽。实测 test_role_arbg 的右小臂就是这种：
 *
 *   框内逐行不透明像素数  21,21,21,...(窄带)  →  39,46,51,...,65（躯干）
 *
 * 手臂真实宽度 21px，躯干段 65px，差三倍多。所以加一条：从上往下扫，
 * 找到第一处「宽度突然变成前面典型宽度的 WIDTH_JUMP 倍」的位置，在那里截断。
 *
 * 只在窄带段够长、突变够猛时才截，避免把正常部件（比如鞋跟、裙摆）
 * 从中间截成两半。
 */
const WIDTH_JUMP = 2.2;

/** 窄带段至少要占这么多行，才认为「上面那段才是部件」 */
const WIDTH_MIN_RUN = 6;

/**
 * 在 bbox 内找连通的不透明区域，返回收紧后的 bbox（源图像素坐标）。
 *
 * @param {Buffer} srcData - 源图 RGBA 原始像素
 * @param {number} srcW - 源图宽
 * @param {number} srcH - 源图高
 * @param {{x,y,width,height}} bbox - AI 给的框（像素坐标）
 * @returns {{bbox, area, blobs}|null} null 表示无法吸附（框内没内容等）
 */
export function snapToSilhouette(srcData, srcW, srcH, bbox) {
  // 夹到图片范围内再取整，负数或越界会让下面的索引算错
  const bx0 = Math.max(0, Math.floor(bbox.x));
  const by0 = Math.max(0, Math.floor(bbox.y));
  const bx1 = Math.min(srcW, Math.ceil(bbox.x + bbox.width));
  const by1 = Math.min(srcH, Math.ceil(bbox.y + bbox.height));
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw < 2 || bh < 2) return null;

  const opaque = (x, y) => srcData[((y * srcW) + x) * 4 + 3] >= ALPHA_CUTOFF;

  // 8 邻域连通域标记（迭代版并查集，避免递归在几千像素的部件上爆栈）
  const label = new Int32Array(bw * bh).fill(-1);
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (!opaque(bx0 + x, by0 + y)) continue;
      const idx = y * bw + x;
      const id = parent.length;
      parent.push(id);
      label[idx] = id;
      // 只看左、上、左上、右上——这四边已经能覆盖 8 邻域连通
      if (x > 0 && label[idx - 1] >= 0) union(label[idx - 1], id);
      if (y > 0 && label[idx - bw] >= 0) union(label[idx - bw], id);
      if (y > 0 && x > 0 && label[idx - bw - 1] >= 0) union(label[idx - bw - 1], id);
      if (y > 0 && x < bw - 1 && label[idx - bw + 1] >= 0) union(label[idx - bw + 1], id);
    }
  }

  // 归并出每个块的外接矩形与面积
  const blobs = new Map();
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const l = label[y * bw + x];
      if (l < 0) continue;
      const root = find(l);
      let b = blobs.get(root);
      if (!b) { b = { x0: x, y0: y, x1: x, y1: y, area: 0 }; blobs.set(root, b); }
      if (x < b.x0) b.x0 = x;
      if (y < b.y0) b.y0 = y;
      if (x > b.x1) b.x1 = x;
      if (y > b.y1) b.y1 = y;
      b.area++;
    }
  }
  if (!blobs.size) return null;

  /*
   * 选块，三级判据，从严到宽：
   *
   *   ① 覆盖框中心的块。框基本对的时候走这条，最准。
   *   ② 外接矩形中心离框中心最近的块。中心落在透明区时（框偏了，
   *      或者部件中间本来就空心）走这条——比"面积最大"准得多：
   *      细长的手臂面积小，但它的矩形中心离框中心近，不会被躯干抢走。
   *   ③ 面积最大的块。前两条都无从判断时的兜底。
   */
  const cx = Math.round(bw / 2);
  const cy = Math.round(bh / 2);
  let chosen = null;
  let bestDist = Infinity;
  for (let dy = -SNAP_SEED_RADIUS; dy <= SNAP_SEED_RADIUS && !chosen; dy++) {
    for (let dx = -SNAP_SEED_RADIUS; dx <= SNAP_SEED_RADIUS; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
      const l = label[y * bw + x];
      if (l < 0) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < bestDist) { bestDist = d; chosen = find(l); }
    }
  }
  if (chosen === null) {
    let nearest = Infinity;
    for (const [root, b] of blobs) {
      const bx = (b.x0 + b.x1) / 2;
      const by = (b.y0 + b.y1) / 2;
      const d = Math.hypot(bx - cx, by - cy);
      if (d < nearest) { nearest = d; chosen = root; }
    }
  }

  const b = blobs.get(chosen);
  if (!b || b.area < SNAP_MIN_AREA) return null;

  let x1 = b.x1;
  const y1 = b.y1;
  let cutRow = null;

  /*
   * 宽度突变截断。窄带段（部件本体）+ 宽段（邻件）贴合在一起时，
   * 连通域分不开，靠宽度剖面切。判据见 WIDTH_JUMP 的注释。
   *
   * 只往下截（y 方向），不处理左右——手臂接在躯干侧面这种情形先不做，
   * 判据不够稳，宁可保留原框让用户看诊断。
   */
  const rowWidth = [];
  for (let y = b.y0; y <= y1; y++) {
    let n = 0;
    for (let x = b.x0; x <= b.x1; x++) {
      const l = label[y * bw + x];
      // 只数选中的那一块。框里别的连通块不算——它们的宽度会把剖面带偏
      if (l >= 0 && find(l) === chosen) n++;
    }
    rowWidth.push(n);
  }
  // 取稀疏行的中位数当"典型宽度"，避开轮廓弧线那几行的极值
  const samples = rowWidth.filter((_, i) => i % 3 === 0).sort((p, q) => p - q);
  const median = samples[Math.floor(samples.length / 2)] || 0;

  if (median >= SNAP_MIN_SIDE) {
    let run = 0;
    for (let i = 0; i < rowWidth.length; i++) {
      if (rowWidth[i] <= median * 1.5) { run++; continue; }
      // 突变出现了：前面窄带段够长，且这一行宽得过了阈值，就在这儿截断
      if (run >= WIDTH_MIN_RUN && rowWidth[i] > median * WIDTH_JUMP) {
        cutRow = b.y0 + i;
        break;
      }
      run = 0;
    }
  }

  const newH = cutRow === null ? y1 - b.y0 + 1 : cutRow - b.y0;
  const w = x1 - b.x0 + 1;
  if (w < SNAP_MIN_SIDE || newH < SNAP_MIN_SIDE) return null;

  return {
    bbox: { x: bx0 + b.x0, y: by0 + b.y0, width: w, height: newH },
    area: b.area,
    blobs: blobs.size,
    truncatedAt: cutRow === null ? null : by0 + cutRow
  };
}

/**
 * 按 bbox 切图并补图。
 *
 * @param {string} sourcePath - 源图路径
 * @param {Array} parts - 部件列表（带 bbox / pivot）
 * @param {string} outputDir - 输出目录
 * @param {object} opts - { margin, bleed, snap }
 *   snap=false 关掉剪影吸附，退回「AI 的矩形框 + margin」
 * @returns {Promise<Array>} 切图结果，含补偿后的 bbox / pivot
 */
export async function cutImageParts(sourcePath, parts, outputDir, opts = {}) {
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const bleed = opts.bleed ?? DEFAULT_BLEED;
  // 剪影吸附默认开。关掉就退回「AI 的矩形框 + margin」的老行为
  const snap = opts.snap !== false;
  // 按归属表撑窗口时每条边的上限；0 = 关掉这条规则（退回归属对但画不出）
  const growCap = opts.growCap ?? GROW_CAP;

  const results = [];
  await mkdir(outputDir, { recursive: true });

  const meta = await sharp(sourcePath).metadata();
  const srcW = meta.width;
  const srcH = meta.height;

  /*
   * 吸附要在源图上做连通域，所以整张图读一次原始像素，
   * 循环里复用。298x838 的图是 1MB 缓冲，比起每个部件各读一次划算得多。
   */
  const src = snap
    ? (await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data
    : null;

  /*
   * 按深度序擦除：抽出每个部件"只属于自己"的那张图。
   *
   * 目标形态（以篮子为例）：篮筐前层是干净的前圈、西红柿是完整的西红柿、
   * 西瓜是完整的西瓜、篮筐后层是干净的后景——每张图里不能混进别的部件。
   * 单靠 bbox 抠图做不到这点：bbox 是矩形，一定框进旁边的东西。
   *
   * 做法是一条单向规则：
   *
   *     depth(X) 最小的在最里面。对每个部件 X，擦掉所有 depth > depth(X)
   *     的部件在 X 框内的**不透明像素**，再补图把擦掉的区域填回来。
   *
   * 为什么是"排序"而不是"逐个声明谁盖谁"：逐对声明会绕成环
   * （AI 实测会输出 A 盖 B、B 盖 A），成环后两边互相擦，部件直接消失。
   * 全局序号天然无环——"比我靠前的"是一个全序，不存在互相擦。
   *
   * 擦的是遮挡者的不透明像素而不是它的矩形框：框会把被擦方自己也擦掉
   * （两者的框必然相交）。只有遮挡者真的画了东西的地方才属于它。
   */
  const byName = new Map(parts.map((p) => [p.name, p]));
  const srcAlpha = src ?? (await sharp(sourcePath).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true })).data;

  /*
   * 解码 SAM 掩码（如果有）。
   *
   * 掩码是源图尺寸的，切图时按窗口切片，擦除时直接查遮挡者的掩码——
   * 比多边形扫描线又快又准。解码一次存起来，两处复用。
   */
  const samMasks = new Map();
  if (opts.samMasks?.size) {
    for (const [name, entry] of opts.samMasks) {
      try {
        samMasks.set(name, await decodeMask(entry.png, srcW, srcH));
      } catch (e) {
        console.warn(`[切图] ⚠ ${name} 的 SAM 掩码解码失败，退回多边形: ${e.message}`);
      }
    }
    console.log(`[切图] ⛶ ${samMasks.size}/${parts.length} 个部件用 SAM 像素级掩码`);
  }

  const overlaps = (a, b) =>
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;

  // 每个部件的 depth 缺失时按 0 处理（最靠后）：少擦只是接缝糙，猜大了会擦空别人
  const depthOf = new Map(parts.map((p) => [p.name, Number.isFinite(p.depth) ? p.depth : 0]));

  /*
   * 像素归属表：每个源像素**只能**属于一个部件。
   *
   * 这张表解决用户报的那个最严重的问题——"一个部位在很多张图上都会出现，
   * 头部在多个部件都有，组成 spine 动画的时候看到头部在断裂滑动"。
   *
   * 成因不是擦除漏了，而是擦除被自己的掩码豁免掉了。SAM 给每个部件独立预测，
   * 掩码之间会重叠（可行性报告实测 23076px）：body 的框圈住整个躯干，SAM 从
   * 框提示出发很容易把连在一起的头颈一起认领进来。原来擦除那里有一条
   * 「本部件的 SAM 掩码认领的像素不让位」，于是 body 把头的像素留下了，
   * head 自己也有一份——同一块内容进了两张图。两张图挂在不同骨头上，
   * 一旦动起来就是各走各的，看着就是"头在滑"。
   *
   * 规则改成唯一归属：一个源像素交给**认领它的、depth 最大的那个部件**
   * （depth 大 = 靠前 = 实际可见的那一层），其余部件一律擦掉并记进
   * erasedMask，交给补图填。头的像素归 head，body 上那块被擦掉后补成脖子/
   * 肩膀，两张图不再共享同一块内容。
   *
   * 同 depth 打平时按「掩码面积小的优先」：面积小的那个更具体
   * （glasses 对 head、shoes 对 body），大的那个多半是把邻件顺带圈进来了。
   * 再平就按名字，只为了让结果稳定可复现——同一张图跑两次不该给出两种归属。
   *
   * **所有部件都进归属表，不管有没有 SAM 掩码**。polygon 路径之前「在轮廓内
   * 就保留」，实测 kkk.png 那轮 body 的轮廓把披风整个圈住了，于是披风在 body
   * 切图里留一整份，串味率从没掩码那一遍的 6% 暴涨到 17.7%。改成「先问归属表」
   * 之后，轮廓内也得看是不是自己的，不是的就让位。
   *
   * 声明分三档，按精度从高到低，前一档定了的像素后一档不再改判：
   *   SAM 掩码 —— 像素级、只含可见部分，最可信
   *   polygon   —— AI 的顶点，粗，但按要求是含被遮挡部分的完整形状
   *   bbox      —— 只剩框时按框认领（第三遍）
   * SAM 压过 polygon 是因为 polygon 粗：前层手臂的轮廓多划进一条披风边，
   * 那条边 SAM 说是披风，就该是披风。
   */
  const ownerOf = new Array(srcW * srcH).fill(null);
  {
    // 面积先算好：打平时要比，放在循环里会重复扫整张掩码
    const areaOf = new Map();
    for (const [name, mask] of samMasks) {
      let n = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
      areaOf.set(name, n);
    }

    /** 谁更有资格认领同一个像素：depth 大的赢，平了面积小的赢，再平按名字 */
    const better = (a, b, area = areaOf) => {
      const da = depthOf.get(a) ?? 0, db = depthOf.get(b) ?? 0;
      if (da !== db) return da > db;
      const aa = area.get(a) ?? Infinity, ab = area.get(b) ?? Infinity;
      if (aa !== ab) return aa < ab;
      return a < b;
    };

    /*
     * 掩码先夹到部件自己的框里。
     *
     * MobileSAM 是纯框提示，回来的掩码经常**溢出到框外**。实测眼镜那个框
     * （67,112 135x111），掩码覆盖 10039px，横跨 x 70..207、y 118..228，
     * 而眼镜自己只有 9889px 的内容——多出来的那片是**整张脸**。
     * 眼镜 depth=3 比 head 的 depth=1 深，于是脸被判给眼镜、从 head 上整片
     * 擦掉再被补图压成透明，切出来的 head 是一张没有脸的头。
     *
     * 框是 SAM 的提示，也是这个部件位置的**上界**：掩码再像，也没道理
     * 认领框外的像素。夹一下之后，眼镜只能拿走框内那块，脸留给 head。
     *
     * 只夹 SAM 掩码，不动第三遍"按框补齐"——那一遍本来就是按框算的。
     */
    const clipToBox = (name, mask) => {
      const b = byName.get(name)?.bbox;
      if (!b) return mask;
      const bx0 = Math.max(0, Math.round(b.x));
      const by0 = Math.max(0, Math.round(b.y));
      const bx1 = Math.min(srcW, Math.round(b.x + b.width));
      const by1 = Math.min(srcH, Math.round(b.y + b.height));
      const out = new Uint8Array(mask.length);
      for (let y = by0; y < by1; y++) {
        const row = y * srcW;
        for (let x = bx0; x < bx1; x++) {
          if (mask[row + x]) out[row + x] = 1;
        }
      }
      return out;
    };

    /*
     * 再夹到「自己的多边形外扩 POLY_SLACK」以内。
     *
     * 框挡得住溢出到框外的，挡不住框内的：手臂和披风的框大片重叠时，
     * MobileSAM 给手臂的掩码会把披风内侧整片吃进来（实测 kkk right_upper_arm
     * 带着一大片墨绿披风，补图时模型被要求「保留可见像素」，只好照画）。
     * 多边形是 AI 按「这个部件的完整形状」描的，粗但不会描到别的部件身上。
     * 留 15px 余量是因为多边形顶点稀、边是直线：实测 body/left_thigh 落在多边形外
     * 15px 以内的合法像素各有上千，15px 外只剩几百，而手臂那片披风 15px 外有 4111px。
     */
    // 每个带多边形的部件「能认领的范围」= 多边形外扩 POLY_SLACK。SAM 夹边和第三遍框认领共用
    const nearPoly = new Map();
    for (const p of parts) {
      if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
        nearPoly.set(p.name, dilateSquare(fillPolygon(p.polygon, srcW, srcH, 0, 0), srcW, srcH, POLY_SLACK));
      }
    }
    const mayClaim = (name, i) => !nearPoly.has(name) || !!nearPoly.get(name)[i];

    const clipToPolygon = (name, mask) => {
      const near = nearPoly.get(name);
      if (!near) return mask;
      const out = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) if (mask[i] && near[i]) out[i] = 1;
      return out;
    };

    let contested = 0;
    let clippedOut = 0;
    for (const [name, rawMask] of samMasks) {
      const mask = clipToPolygon(name, clipToBox(name, rawMask));
      let raw = 0;
      for (let i = 0; i < rawMask.length; i++) if (rawMask[i]) raw++;
      let kept = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) kept++;
      if (kept < raw) clippedOut += raw - kept;
      samMasks.set(name, mask);

      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        // 源图这里本来就空：不是任何人的内容，不用判归属
        if (srcAlpha[i * 4 + 3] < ALPHA_CUTOFF) continue;
        const cur = ownerOf[i];
        if (cur === null) { ownerOf[i] = name; continue; }
        contested++;
        if (better(name, cur)) ownerOf[i] = name;
      }
    }
    if (clippedOut) {
      console.log(`[切图] ✂ 掩码超出自己的框或多边形 ${POLY_SLACK}px 外，已裁掉 ${clippedOut}px（SAM 会外溢到邻件上）`);
    }
    if (contested) {
      console.log(`[切图] ⚖ 掩码重叠 ${contested}px，已按「depth 最大者独占」定归属（避免同一块内容进多张图）`);
    }

    /*
     * 第二遍：polygon 认领 SAM 没定下来的像素，多边形之间按 depth 判。
     *
     * 实测 kkk.png：sam3 对 13 个部件里 7 个"无命中"（"upper arm l" 这种
     * 提示词它不认），全退回 polygon。polygon 分支原来「轮廓内一律保留」，
     * 不进归属表——body 的完整轮廓圈住了压在它上面的披风，披风就在 body
     * 里留一整份：body ← cape 48803px，全图 17.7% 的可见像素进了两张图。
     *
     * 有 SAM 掩码的部件也拿 polygon 参与这一遍：sam3 的掩码常常只盖住一部分
     * （cape 只占框内 32.6%），掩码没盖到、自己轮廓又圈住的地方，
     * 比起交给更靠后的大轮廓，归它更合理。
     */
    const samClaimed = new Uint8Array(srcW * srcH);
    for (let i = 0; i < ownerOf.length; i++) if (ownerOf[i] !== null) samClaimed[i] = 1;
    const polyArea = new Map();
    const polyMasks = [];
    for (const part of parts) {
      if (!Array.isArray(part.polygon) || part.polygon.length < 3) continue;
      const m = fillPolygon(part.polygon, srcW, srcH, 0, 0);
      let n = 0;
      for (let i = 0; i < m.length; i++) if (m[i]) n++;
      polyArea.set(part.name, n);
      polyMasks.push([part.name, m]);
    }
    let polyClaimed = 0, polyContested = 0;
    for (const [name, m] of polyMasks) {
      for (let i = 0; i < m.length; i++) {
        if (!m[i] || samClaimed[i]) continue;
        if (srcAlpha[i * 4 + 3] < ALPHA_CUTOFF) continue;
        const cur = ownerOf[i];
        if (cur === null) { ownerOf[i] = name; polyClaimed++; continue; }
        polyContested++;
        if (better(name, cur, polyArea)) ownerOf[i] = name;
      }
    }
    if (polyClaimed) {
      console.log(`[切图] ⬡ 多边形认领 ${polyClaimed}px（其中 ${polyContested}px 有多个轮廓重叠，按 depth 判给最靠前的）`);
    }

    /*
     * 第三遍：**框认领** —— 按 bbox 补上无掩码、无轮廓、也没被别人认领的像素。
     *
     * 这是用户报的"头部在断裂滑动"的真正成因。MobileSAM 是纯框提示，
     * 取的是 score 最高的那张掩码——头这个框里它给的是**头发**，
     * 实测掩码只盖住框内 32.5% 的不透明像素，脸、下巴、耳朵、眼镜全没进去。
     * 于是：
     *
     *   - 脸的一部分被 torso 的掩码认领（两个框有约 100px 重叠带）
     *   - 剩下的谁都不认领 → 不进任何切图 → 补图又把它当"外部留白"保持透明
     *   - 头一转，脸留在原地不跟着动，就是"断裂滑动"
     *
     * 实测这张图有 24327 个像素是这种情况，其中 21083 落在某个部件的 bbox 里。
     * 框是 SAM 的提示，也应当被当成一次**声明**：框里的内容至少有资格归它。
     *
     * 多个框都圈住时归**面积最小**的那个——框小 = 声明更具体。
     * 头（129x173）和 torso（218x211）都圈住下巴，该给头。
     *
     * 只在这块内容确实有不透明像素时才认领（源图那儿本来就空的不管），
     * 且仍然遵守 depth：框里已经有明确掩码归属的像素不受这一遍影响。
     */
    const boxArea = new Map(parts.map((p) => {
      const b = p.bbox;
      return [p.name, b ? b.width * b.height : Infinity];
    }));
    let rescued = 0;
    const rescuedBy = new Map();
    for (const part of parts) {
      const b = part.bbox;
      if (!b) continue;
      const bx0 = Math.max(0, Math.round(b.x));
      const by0 = Math.max(0, Math.round(b.y));
      const bx1 = Math.min(srcW, Math.round(b.x + b.width));
      const by1 = Math.min(srcH, Math.round(b.y + b.height));

      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          const i = y * srcW + x;
          if (ownerOf[i] !== null) continue;                  // 已有明确归属
          if (srcAlpha[i * 4 + 3] < ALPHA_CUTOFF) continue;   // 源图这儿本来就空
          // 离自己的多边形太远：框小也不领。SAM 刚因为溢出把这片放掉，
          // 这里要是按「框最小」再领回去，等于白夹（实测手臂又把披风内侧领了回来）
          if (!mayClaim(part.name, i)) continue;

          // 别的部件用更小的框也圈住了这里？那该归它，不是归我
          let mine = true;
          for (const other of parts) {
            if (other === part || !other.bbox) continue;
            if (!mayClaim(other.name, i)) continue;
            const o = other.bbox;
            if (x < o.x || y < o.y || x >= o.x + o.width || y >= o.y + o.height) continue;
            if ((boxArea.get(other.name) ?? Infinity) < (boxArea.get(part.name) ?? Infinity)) {
              mine = false;
              break;
            }
          }
          if (!mine) continue;

          ownerOf[i] = part.name;
          rescued++;
          rescuedBy.set(part.name, (rescuedBy.get(part.name) ?? 0) + 1);
        }
      }
    }
    if (rescued) {
      const top = [...rescuedBy].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, c]) => `${n} ${c}px`).join('，');
      console.log(`[切图] ⊕ 补齐 ${rescued}px 无掩码认领的内容（按框归属，主要是 ${top}）`);
    }

    /*
     * 第四遍：**连通性认领** —— 落在所有框之外的无主内容，跟着它连着的内容走。
     *
     * 前三遍都建立在"AI 给的框圈住了这个部件"这个假设上。假设不成立时
     * （实测 role11：AI 这轮只给了 right_arm_with_scissors，框 x 102..237
     * 只圈住剪刀，右臂那条袖子整条在框外）那 14646px 谁都认不了，
     * 切图里没有、动画一动手臂就断开一截。
     *
     * 框是 AI 的估算，**内容自身的连通性比框可靠得多**：袖子在源图里
     * 和手臂是同一块不透明区域，沿着它泛洪就能找到手臂。
     *
     * 做法：对每个"源图不透明、还没归属、且不在任何框内"的像素做 BFS，
     * 只穿过同样无主的像素；碰到已有归属的像素就记一票。整块连通区里
     * 谁票最多就归谁（平局按 depth 深、再按名字）。
     *
     * 只处理**框外**的无主像素。框内的留给第三遍（按面积最小的框认领），
     * 那条规则更具体，不该被这里的连通性覆盖。
     */
    /*
     * 第四遍：**连通性认领** —— 落在所有框之外的无主内容，跟着它连着的内容走。
     *
     * 前三遍都建立在「AI 给的框圈住了这个部件」这个假设上。假设不成立时就漏：
     *  - role11 那轮 AI 只给了 `right_arm_with_scissors`、框只圈住剪刀，
     *    右臂那条袖子整条在框外，14646px 谁都认不了；
     *  - 同一张图另一轮，`left_arm` 的框整个偏内（x49..118），
     *    肘弯那一弧在框外 x6..48，2846px 漏掉。
     *
     * 框是 AI 的估算，**内容自身的连通性比框可靠得多**：肘部在源图里
     * 和手臂是同一块不透明区域，沿着它泛洪就能找到手臂。
     *
     * 做法：从每个「源图不透明、还没归属」的像素出发，对**整个不透明
     * 连通片**做 BFS（穿过无主像素继续走，也穿过已归属像素但不越过它们
     * 往外扩），数这片挨着的每个部件多少次；整片里谁票最多就归谁
     * （平局按 depth 深、再按名字）。
     *
     * 关键：BFS 必须能**走到已归属的那部分**才数得到票。第一版只让 BFS
     * 在「框外无主像素」的子集里走，肘部那块自己内部一个已归属像素都没有，
     * 票数是空的，整块直接跳过——修完还剩 5.85% 就是这么来的。
     *
     * 只写**框外**的无主像素。框内的留给第三遍（按面积最小的框认领，
     * 那条规则更具体，不该被这里的连通性覆盖）。
     */
    const inAnyBox = (x, y) => parts.some((p) => {
      const b = p.bbox;
      return b && x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
    });
    const unclaimed = new Uint8Array(srcW * srcH);
    let unclaimedN = 0;
    for (let i = 0; i < srcW * srcH; i++) {
      if (ownerOf[i] !== null) continue;
      if (srcAlpha[i * 4 + 3] < ALPHA_CUTOFF) continue;
      unclaimed[i] = 1;
      unclaimedN++;
    }
    let adopted = 0;
    const adoptedBy = new Map();
    if (unclaimedN) {
      /*
       * 每个像素只处理一次。visited 记的是"这片已经处理过了"，
       * 所以 BFS 从一个无主像素进来、走遍整片之后，片里其余无主像素
       * 也都被标记，外层循环直接跳过。
       */
      const visited = new Uint8Array(srcW * srcH);
      for (let i0 = 0; i0 < srcW * srcH; i0++) {
        if (!unclaimed[i0] || visited[i0]) continue;
        const votes = new Map();
        const mine = [];          // 这片里"还没归属"的像素，事后统一写
        let q = [i0];
        visited[i0] = 1;
        while (q.length) {
          const nq = [];
          for (const j of q) {
            if (ownerOf[j] === null) mine.push(j);
            const x = j % srcW, y = (j / srcW) | 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= srcW || ny >= srcH) continue;
                const k = ny * srcW + nx;
                if (srcAlpha[k * 4 + 3] < ALPHA_CUTOFF) continue;   // 源图这儿空
                if (visited[k]) continue;
                const o = ownerOf[k];
                if (o === null) {
                  visited[k] = 1;
                  nq.push(k);                    // 无主：继续往里走
                } else {
                  // 已归属：只投票，不越过它往外扩（那是别人的地盘了）
                  votes.set(o, (votes.get(o) ?? 0) + 1);
                }
              }
            }
          }
          q = nq;
        }
        if (!votes.size) continue;
        const winner = [...votes.entries()]
          .sort((a, b) => (b[1] - a[1])
            || ((depthOf.get(b[0]) ?? 0) - (depthOf.get(a[0]) ?? 0))
            || a[0].localeCompare(b[0]))[0][0];
        let taken = 0;
        for (const j of mine) {
          const x = j % srcW, y = (j / srcW) | 0;
          if (inAnyBox(x, y)) continue;          // 框内的留给第三遍
          ownerOf[j] = winner;
          taken++;
        }
        if (!taken) continue;
        adopted += taken;
        adoptedBy.set(winner, (adoptedBy.get(winner) ?? 0) + taken);
      }
    }
    if (adopted) {
      const top = [...adoptedBy].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([n, c]) => `${n} ${c}px`).join('，');
      console.log(`[切图] ⊹ 连通性认领 ${adopted}px 落在所有框外的内容（跟着相接的部件走，主要是 ${top}）`);
    }
  }

  /*
   * 归属表算完了，但**归属对不等于画得出来**：窗口是 bbox ± margin，
   * 认领到的像素只要落在窗口外，就还是进不了切图。
   *
   * 第四遍的连通性认领专门处理"内容在框外"的情形（AI 这轮框漏了一条袖子），
   * 可它认领的那片像素**本来就在框外**——不动窗口的话，认了也画不出，
   * 那 17031px 白认。实测 role 名部件表：认领 17031px，孤儿仍占 9.78%。
   *
   * 所以这里按归属表把窗口撑到"这个部件真正拥有的内容"的范围。
   * 每条边单独夹一个上限：认领是基于连通性的推断，偶尔会顺着相邻的
   * 大色块传染出去，没有上限的话一个误判就能把窗口撑到整张图
   * （实测 role5 有过 head 掩码吃到 torso 的情况）。
   */
  let reseamed = 0;
  for (let pass = 0, n = 1; pass < SEAM_PASSES && n; pass++) {
    n = refineSeamOwnership(ownerOf, srcAlpha, srcW, srcH, depthOf);
    reseamed += n;
  }
  if (reseamed) console.log(`[切图] ✂ 接缝上 ${reseamed}px 颜色属于后层，还给后层（前层切口不再带一条邻件的颜色）`);

  // 钢笔吸附：前层切口吸到描线外沿（挂错的邻件色还给后层，被切走的描线收回来）。
  // 在归属表上改而不是在图层上擦：擦掉的那格要靠后层补图盖，补不到就露线
  if (opts.pen !== false) {
    const snap = await snapOwnership(ownerOf, srcAlpha, srcW, srcH, depthOf);
    if (snap.toBehind || snap.toFront) {
      console.log(`[切图] ✒ 切口吸到描线：${snap.toBehind}px 邻件色还给后层，${snap.toFront}px 描线收回前层`);
    }
  }

  // 孤岛和 1px 线头改判给邻件：四遍认领叠出来的边角料，跟错了骨头一动就飘（见 ownership-cleanup.js）
  // opts.halo：前层的发光/投影整圈还给前层（UI、特效这类带外发光的素材）。
  // 角色不开：kkk 实测放宽后上臂皮肤被前臂吸走、腿的描边挂到靴子上，人物切图保持原样
  const tidy = opts.cleanup === false
    ? { islandPx: 0, hairPx: 0, moved: new Map(), islands: [] }
    : cleanupOwnership(ownerOf, srcW, srcH, { rgba: srcAlpha, foreignEdges: opts.foreignEdges !== false, depthOf: opts.halo ? depthOf : null });
  if (tidy.islandPx || tidy.hairPx || tidy.edgePx) {
    const top = [...tidy.moved].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}px`).join('，');
    console.log(`[切图] ✂ 清理归属：孤岛 ${tidy.islandPx}px、线头 ${tidy.hairPx}px、挂错的邻件边 ${tidy.edgePx ?? 0}px 改判给邻件（主要给了 ${top}）`);
    for (const e of (tidy.edges ?? []).filter((e) => e.px >= 100).sort((a, b) => b.px - a.px)) {
      console.log(`[切图]   邻件边 ${e.from} → ${e.to} ${e.px}px`);
    }
    // 大块改判单独列出来：碎屑归位是预期的，几百像素以上的整块挪走值得人看一眼
    for (const i of tidy.islands.filter((i) => i.px >= 300)) {
      console.log(`[切图]   ${i.from} 的 ${i.px}px（主体的 ${(i.ofLargest * 100).toFixed(0)}%）→ ${i.to}`);
    }
  }

  const ownsBox = new Map();
  if (growCap > 0) {
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const o = ownerOf[y * srcW + x];
        if (o === null) continue;
        const e = ownsBox.get(o);
        if (!e) ownsBox.set(o, { x0: x, y0: y, x1: x + 1, y1: y + 1 });
        else {
          if (x < e.x0) e.x0 = x;
          if (y < e.y0) e.y0 = y;
          if (x >= e.x1) e.x1 = x + 1;
          if (y >= e.y1) e.y1 = y + 1;
        }
      }
    }
  }
  let grown = 0;
  for (const part of parts) {
    const b = part.bbox;
    const own = part.name != null ? ownsBox.get(part.name) : null;
    if (!b || !own) continue;
    const nx0 = Math.max(Math.round(b.x) - growCap, own.x0);
    const ny0 = Math.max(Math.round(b.y) - growCap, own.y0);
    const nx1 = Math.min(Math.round(b.x + b.width) + growCap, own.x1);
    const ny1 = Math.min(Math.round(b.y + b.height) + growCap, own.y1);
    const gx0 = Math.min(Math.round(b.x), nx0);
    const gy0 = Math.min(Math.round(b.y), ny0);
    const gx1 = Math.max(Math.round(b.x + b.width), nx1);
    const gy1 = Math.max(Math.round(b.y + b.height), ny1);
    if (gx0 === Math.round(b.x) && gy0 === Math.round(b.y)
        && gx1 === Math.round(b.x + b.width) && gy1 === Math.round(b.y + b.height)) continue;
    const before = `${Math.round(b.width)}x${Math.round(b.height)}`;
    part.bbox = { x: gx0, y: gy0, width: gx1 - gx0, height: gy1 - gy0 };
    grown++;
    const dL = Math.round(b.x) - gx0, dT = Math.round(b.y) - gy0;
    const dR = gx1 - Math.round(b.x + b.width), dB = gy1 - Math.round(b.y + b.height);
    console.log(`[切图] ⇱ ${part.name} 窗口撑到归属范围 ${before} → `
      + `${part.bbox.width}x${part.bbox.height}（左${dL} 上${dT} 右${dR} 下${dB}）`);
  }
  if (grown) {
    console.log(`[切图] ⇱ ${grown}/${parts.length} 个部件的窗口按归属表撑开了——`
      + '认领到框外的内容，得让窗口装得下才画得出来');
  }

  /*
   * 擦除表：X → 所有 depth 比 X 大、且 bbox 与 X 相交的部件。
   *
   * 不相交的不用进表——它们的像素不可能落在 X 框里，遍历是白跑。
   * 注意用的是**撑开之后**的框：窗口变大了，原本不相交的邻件现在可能压进来。
   */
  const frontOf = new Map();
  for (const part of parts) {
    const myDepth = depthOf.get(part.name);
    const ahead = parts.filter(o =>
      o !== part &&
      depthOf.get(o.name) > myDepth &&
      o.bbox && part.bbox && overlaps(part.bbox, o.bbox));
    frontOf.set(part.name, ahead);
  }

  const layered = [...frontOf.values()].filter((l) => l.length).length;
  const depthSpread = new Set([...depthOf.values()]).size;
  const polyCount = parts.filter((p) => Array.isArray(p.polygon) && p.polygon.length >= 3).length;
  console.log(`[切图] 开始切图，共 ${parts.length} 个部件（外扩 ${margin}px，扩散 ${bleed} 轮，剪影吸附 ${snap ? '开' : '关'}）`);
  console.log(`[切图] 深度共 ${depthSpread} 层，${layered} 个部件需要擦除前方内容`);
  console.log(`[切图] ${polyCount}/${parts.length} 个部件带多边形轮廓${polyCount < parts.length ? '（其余退回矩形切图）' : ''}`);
  if (depthSpread === 1 && parts.length > 1) {
    console.warn('[切图] ⚠ 所有部件在同一层，不会擦除任何内容——AI 没给出有效的 depth');
  }

  for (const part of parts) {
    try {
      const { name } = part;
          // 原框先留一份：下面剪影吸附会把 bbox 收紧，诊断要看收紧前后的差
      const rawBbox = part.bbox;
      let bbox = rawBbox;

      if (!bbox || typeof bbox.x !== 'number') {
        console.warn(`[切图] 部件 ${name} 缺少有效 bbox，跳过`);
        continue;
      }

      /*
       * 剪影吸附：把矩形框收紧到「框里那块真正属于它的内容」。
       *
       * 必须在算 margin 之前做——吸附改的是部件自己的边界，
       * margin 是吸附完之后再往外取的料。
       *
       * 吸附失败（框里没内容、内容太碎太小）时保留原框，
       * 宁可多切也不要把部件本身切没了。
       *
       * 有轮廓（SAM 掩码或 polygon）时整段跳过：吸附解决的是"矩形框里混进了
       * 邻件"，而轮廓已经把邻件排掉了，再做一次连通域吸附只会把 bbox 收到
       * "可见的那块内容"上——被遮挡的部分（西红柿底部）不在连通域里，
       * bbox 一收就把轮廓的下半截切出窗口，补图连该补的位置都看不到。
       * 另外 SAM 掩码是拿 AI 原框算出来的，改了 bbox 就和掩码对不上了。
       */
      const poly = part.polygon;
      const hasPoly = Array.isArray(poly) && poly.length >= 3;
      const hasSam = samMasks.has(name);

      let snapped = null;
      if (snap && !hasPoly && !hasSam) {
        snapped = snapToSilhouette(src, srcW, srcH, bbox);
        if (snapped) {
          const before = `${Math.round(bbox.width)}x${Math.round(bbox.height)}`;
          bbox = snapped.bbox;
          const after = `${bbox.width}x${bbox.height}`;
          if (before !== after) console.log(`[切图] ⇲ ${name} 吸附 ${before} → ${after}`);
        }
      }

      /*
       * 有 polygon 时把窗口撑到覆盖整个轮廓。
       *
       * polygon 是"这个部件应有的完整形状"（含被遮挡的推算部分），
       * 而 AI 给的 bbox 常常只圈住了可见的那块。以 bbox 为窗口的话，
       * 轮廓探出窗口的那部分会被 fillPolygon 之外的像素一并丢弃——
       * 补图就看不到该补的区域了。
       */
      if (hasPoly) {
        let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
        for (const p of poly) {
          if (p.x < px0) px0 = p.x;
          if (p.y < py0) py0 = p.y;
          if (p.x > px1) px1 = p.x;
          if (p.y > py1) py1 = p.y;
        }
        const ux = Math.min(bbox.x, px0);
        const uy = Math.min(bbox.y, py0);
        const ux1 = Math.max(bbox.x + bbox.width, px1);
        const uy1 = Math.max(bbox.y + bbox.height, py1);
        if (ux !== bbox.x || uy !== bbox.y || ux1 !== bbox.x + bbox.width || uy1 !== bbox.y + bbox.height) {
          bbox = { x: ux, y: uy, width: ux1 - ux, height: uy1 - uy };
          console.log(`[切图] ⬡ ${name} 窗口撑到多边形范围 ${Math.round(ux1 - ux)}x${Math.round(uy1 - uy)}`);
        }
      }

      // 外扩后夹到原图范围内。贴边的部件扩不出去，实际外扩量按边分别算，
      // 所以不能假设四边都扩了 margin。
      const x0 = Math.max(0, Math.round(bbox.x) - margin);
      const y0 = Math.max(0, Math.round(bbox.y) - margin);
      const x1 = Math.min(srcW, Math.round(bbox.x + bbox.width) + margin);
      const y1 = Math.min(srcH, Math.round(bbox.y + bbox.height) + margin);

      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) {
        console.warn(`[切图] 部件 ${name} 外扩后尺寸非法，跳过`);
        continue;
      }

      const { data, info } = await sharp(sourcePath)
        .extract({ left: x0, top: y0, width: w, height: h })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      /*
       * 切图：只留归属表判给本部件的像素。
       *
       * 归属表已经把 SAM 掩码、polygon、框、连通性四种声明按 depth 合成了
       * 「每个源像素归谁」，这里只照判决执行，三种轮廓来源走同一条路。
       * 以前是三条分支各管各的：SAM 分支看归属表，polygon 分支「轮廓内一律
       * 保留」，矩形分支整窗保留——后两条正是串味的来源（实测 kkk 那轮
       * 7 个部件退回 polygon，body ← cape 48803px）。
       *
       * 不归我的像素 RGB 一并清零，不只是 alpha：补图把整张图送进模型，
       * 模型看的是 RGB。透明像素底下存着源图原色的话，模型拿到的其实是
       * 整张场景裁剪（实测 kkk 的 body.png，alpha=0 但源图有内容的像素里
       * 95.9% 原样存着披风、上衣的颜色），照着补出来的就是邻件。
       * 清零之后再扩散，透明区铺开的只是本部件自己的颜色。
       */
      const samMask = samMasks.get(name);
      const usedSam = !!samMask;
      const masked = Buffer.from(data);
      let kept = 0, given = 0;
      for (let y = 0; y < h; y++) {
        const srcRow = (y + y0) * srcW;
        for (let x = 0; x < w; x++) {
          const di = (y * w + x) * 4;
          const opaque = data[di + 3] >= ALPHA_CUTOFF;
          if (opaque && ownerOf[srcRow + x + x0] === name) { kept++; continue; }
          if (opaque) given++;
          masked[di] = 0; masked[di + 1] = 0; masked[di + 2] = 0; masked[di + 3] = 0;
        }
      }

      /*
       * 补图区：本部件自己的形状延伸到这里、但这里被**更靠前**的部件占着。
       *
       * 「自己的形状」= SAM 掩码 ∪ polygon（polygon 按要求含被遮挡部分），
       * 两样都没有才退回框。以前标的是「遮挡者在窗口里的整个轮廓」：
       * 披风比身体宽，body 的补图区就成了一块披风形状，补出来 body.png 里
       * 多一块披风剪影。
       *
       * 只认更靠前的占位者：被同层或更靠后的部件占着，说明那里看得见的
       * 是它们、本部件根本没延伸过去（polygon 划宽了），不该补。
       *
       * SAM 掩码重叠、判给前层的那片（归属让位）也落在这条规则里：
       * 它在本部件的掩码内、被前层占着。
       *
       * 补图区不写源图颜色：那里的源图像素画的是遮挡者，不是本部件。
       * 以前把它当"真值"贴回 body，body.png 里就多了一份披风——实测
       * 串味率从 17.7% 涨到 45.4%。
       */
      const polyMask = hasPoly ? fillPolygon(poly, w, h, x0, y0) : null;
      const rx0 = Math.round(bbox.x), ry0 = Math.round(bbox.y);
      const rx1 = Math.round(bbox.x + bbox.width), ry1 = Math.round(bbox.y + bbox.height);
      const myDepth = depthOf.get(name) ?? 0;
      let erasedMask = null;
      const erasedBy = new Map();
      for (let y = 0; y < h; y++) {
        const srcRow = (y + y0) * srcW;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const si = srcRow + x + x0;
          const owner = ownerOf[si];
          if (owner === null || owner === name) continue;
          if ((depthOf.get(owner) ?? 0) <= myDepth) continue;
          const inShape = samMask || polyMask
            ? !!(samMask?.[si] || polyMask?.[i])
            : x + x0 >= rx0 && x + x0 < rx1 && y + y0 >= ry0 && y + y0 < ry1;
          if (!inShape) continue;
          (erasedMask ??= new Uint8Array(w * h))[i] = 1;
          erasedBy.set(owner, (erasedBy.get(owner) ?? 0) + 1);
        }
      }

      const contourTag = usedSam ? 'SAM' : (hasPoly ? '多边形' : '矩形');
      if (given) {
        console.log(`[切图] ⚖ ${name}（${contourTag}）留下 ${kept}px，窗口里 ${given}px 归别的部件，已让出`);
      }
      if (erasedMask) {
        const n = [...erasedBy.values()].reduce((s, v) => s + v, 0);
        const by = [...erasedBy].sort((a, b) => b[1] - a[1]).map(([o, c]) => `${o} ${c}px`).join('，');
        console.log(`[切图] ⌫ ${name} 被前方部件盖住 ${n}px（${by}），交给补图`);
      }

      // 切口抗锯齿：只在本部件压着更靠后部件的那条边上往外羽化一圈
      // 被更靠前部件压着的那条边，颜色还原成自己的纯色（前层会按混合比例叠上来）
      const mine = new Uint8Array(w * h);
      const behind = new Uint8Array(w * h);
      const front = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const srcRow = (y + y0) * srcW;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (masked[i * 4 + 3]) { mine[i] = 1; continue; }
          const owner = ownerOf[srcRow + x + x0];
          if (data[i * 4 + 3] < ALPHA_CUTOFF || owner === null || owner === name) continue;
          const d = depthOf.get(owner) ?? 0;
          if (d < myDepth) behind[i] = 1;
          else if (d > myDepth) front[i] = 1;
        }
      }
      let smooth = featherFrontEdge(unmixBackEdge(masked, w, h, mine, front, data), w, h, mine, behind, data);
      // 钢笔路径：压着后层的切口描成曲线，抗锯齿往外画一圈（吸附已在归属表上做过）
      if (opts.pen !== false) {
        const pen = await penEdge(smooth, w, h, mine, behind, data, { snap: false });
        smooth = pen.buf;
        if (pen.anchors) console.log(`[切图] ✒ ${name} 切口 ${pen.anchors} 个锚点`);
      }

      const filled = bleed > 0 ? bleedAlpha(smooth, info.width, info.height, bleed) : smooth;

      const outputPath = join(outputDir, `${name}.png`);
      await sharp(filled, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toFile(outputPath);

      /*
       * 归属掩码（.mask.png）：归属表判给本部件的像素，和切图同窗口。
       * 补图之后 .png 的 alpha 会把补出来的那片也算进去，事后就看不出原来归谁了。
       */
      const maskPath = join(outputDir, `${name}.mask.png`);
      {
        const mb = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (ownerOf[(y + y0) * srcW + x + x0] === name) mb[(y * w + x) * 4 + 3] = 255;
          }
        }
        await sharp(mb, { raw: { width: w, height: h, channels: 4 } }).png().toFile(maskPath);
      }

      /*
       * 擦除掩码：alpha 255 = 这一格要补，0 = 不用管。RGB 一律 0。
       *
       * alpha 是**掩码语义**，没被擦的必须留 0，否则整窗都会被当成擦除区、
       * 补图把矩形贴实（实测就是把部件补成了 100% 不透明的实心矩形）。
       */
      if (erasedMask) {
        const maskBuf = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) if (erasedMask[i]) maskBuf[i * 4 + 3] = 255;
        await sharp(maskBuf, { raw: { width: w, height: h, channels: 4 } })
          .png()
          .toFile(join(outputDir, `${name}.erased.png`));
      }

      /*
       * 被挡位置掩码（.hidden.png）：给补图画「完整部件」用。
       *
       * 和上面的 erasedMask 有两处不同：
       *   - 画布四周外扩 15%。被挡的部分可能伸出原窗口——实测用户那轮 body 在披风
       *     底下的肩颈整片落在窗口上沿之外，窗口不外扩，模型画了也装不下。
       *   - 不和本部件的 polygon/SAM 求交，只看「被 depth 更大的部件占着」。
       *     形状交给模型画出来的轮廓决定；求交的话 polygon 划窄了就补不全，
       *     划宽了就是用户截图里那块按披风形状铺的鼓包。
       */
      const padX = Math.round(w * HIDDEN_PAD), padY = Math.round(h * HIDDEN_PAD);
      const hx0 = Math.max(0, x0 - padX), hy0 = Math.max(0, y0 - padY);
      const hx1 = Math.min(srcW, x1 + padX), hy1 = Math.min(srcH, y1 + padY);
      const hw = hx1 - hx0, hh = hy1 - hy0;
      let hiddenPath = null;
      {
        const hb = Buffer.alloc(hw * hh * 4);
        let n = 0;
        for (let y = 0; y < hh; y++) {
          for (let x = 0; x < hw; x++) {
            const owner = ownerOf[(y + hy0) * srcW + x + hx0];
            if (owner === null || owner === name) continue;
            if ((depthOf.get(owner) ?? 0) <= myDepth) continue;
            hb[(y * hw + x) * 4 + 3] = 255;
            n++;
          }
        }
        if (n) {
          hiddenPath = join(outputDir, `${name}.hidden.png`);
          await sharp(hb, { raw: { width: hw, height: hh, channels: 4 } }).png().toFile(hiddenPath);
        }
      }

      /*
       * SAM 掩码和 AI 多边形的重叠率（IoU），给框偏诊断用。
       * 两者都是「这个部件长什么样」的独立估计，互相对不上才说明有一方偏了。
       */
      let maskPolyIoU = null;
      if (samMask && hasPoly) {
        const pm = fillPolygon(poly, srcW, srcH, 0, 0);
        let inter = 0, uni = 0;
        for (let i = 0; i < pm.length; i++) {
          const a = samMask[i] ? 1 : 0, b = pm[i] ? 1 : 0;
          if (a && b) inter++;
          if (a || b) uni++;
        }
        maskPolyIoU = uni ? +(inter / uni).toFixed(3) : null;
      }

      // bbox 左上角挪了多少，pivot 就要往回补多少
      const dx = Math.round(bbox.x) - x0;
      const dy = Math.round(bbox.y) - y0;
      const basePivot = part.pivot ?? { x: bbox.width / 2, y: bbox.height / 2 };

      console.log(`[切图] ✓ ${name}.png - ${w}x${h}（原 ${Math.round(bbox.width)}x${Math.round(bbox.height)}）`);

      results.push({
        name,
        path: outputPath,
        size: { width: w, height: h },
        bbox: { x: x0, y: y0, width: w, height: h },
        pivot: { x: basePivot.x + dx, y: basePivot.y + dy },
        margin: { left: dx, top: dy, right: x1 - Math.round(bbox.x + bbox.width), bottom: y1 - Math.round(bbox.y + bbox.height) },
        // AI 标注的遮挡方向，补图据此生成定向 prompt
        occlusionEdges: part.occlusion_edges ?? [],
        // 诊断用：吸附前后的框，供前端算出「AI 的框偏了多少」
        snapped: !!snapped,
        // 轮廓来源：'sam' = 像素级掩码，'polygon' = AI 顶点，'rect' = 纯矩形。
        // 靠这个区分「这张切图为什么干净（或为什么脏）」
        contour: usedSam ? 'sam' : (hasPoly ? 'polygon' : 'rect'),
        // 始终带上吸附前的框：snap 关掉时它就是 AI 原框，
        // 开着时是 AI 原框、bbox 是收紧后的。两者的差就是 AI 的误差量
        originalBbox: { ...rawBbox },
        maskPath,
        // 归属掩码和 .erased.png 的窗口。补图会把 bbox 换成补完后的窗口，这里留住切图时的
        maskBox: { x: x0, y: y0, width: w, height: h },
        hiddenPath,
        hiddenBox: { x: hx0, y: hy0, width: hw, height: hh },
        maskPolyIoU
      });

    } catch (error) {
      console.error(`[切图] ✗ ${part.name} 失败:`, error.message);
    }
  }

  console.log(`[切图] 完成，成功切出 ${results.length}/${parts.length} 张图片`);

  return results;
}

/**
 * 接缝修正最多跑几轮。SAM 掩码外溢常常不止一格，一轮只能剥掉最外一圈；
 * 每轮都按颜色判，纯前层颜色的格子 f≈1 永远不会被剥，所以多轮不会往里啃。
 */
const SEAM_PASSES = 3;

/**
 * 混合模型解释不了的颜色（残差超过这个 RGB 距离）不拆：多半是描线、高光
 * 这类第三种颜色。实测 kkk 上把黑色描线当成「头发+皮肤的混合」拆掉，
 * 描线变成平涂色，拼起来那条线就淡了。
 */
const SEAM_MAX_RESIDUAL = 30;

/** 两侧颜色差不到这个距离（RGB 欧氏），按颜色拆不出混合比例，退回按几何 */
const SEAM_MIN_CONTRAST = 40;

/**
 * 接缝上一个像素的颜色里，A 侧占几成。
 *
 * 画师在两块颜色交界画的是半透明过渡，那一两格的颜色 c ≈ f·A + (1−f)·B。
 * A、B 取 5x5 邻域里两侧「内部」像素（四邻都同侧）的平均色，f 是 c 在 A−B
 * 连线上的投影。两侧颜色太近（同色系接缝）或某侧没有内部样本时返回 null；
 * c 离 f·A + (1−f)·B 太远（描线、高光）时 fits=false，调用方不该按 f 动它。
 * 一并返回两侧内部平均色：前层的过渡格涂「纯的 A」，后层那格还原成「纯的 B」，
 * 叠起来才等于源图那格的 f·A + (1−f)·B。
 *
 * @param {Buffer} rgba - 整幅 RGBA，行宽 width
 * @param {(j:number)=>boolean} inA
 * @param {(j:number)=>boolean} inB
 */
export function mixFraction(rgba, width, height, x, y, inA, inB) {
  const sa = [0, 0, 0, 0], sb = [0, 0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= width - 1 || ny >= height - 1) continue;
      const j = ny * width + nx;
      for (const [inSet, acc] of [[inA, sa], [inB, sb]]) {
        if (!inSet(j) || !inSet(j - 1) || !inSet(j + 1) || !inSet(j - width) || !inSet(j + width)) continue;
        acc[0] += rgba[j * 4]; acc[1] += rgba[j * 4 + 1]; acc[2] += rgba[j * 4 + 2]; acc[3]++;
      }
    }
  }
  if (sa[3] < 2 || sb[3] < 2) return null;
  let dot = 0, len = 0;
  const i = (y * width + x) * 4;
  for (let c = 0; c < 3; c++) {
    const a = sa[c] / sa[3], b = sb[c] / sb[3];
    dot += (rgba[i + c] - b) * (a - b);
    len += (a - b) * (a - b);
  }
  if (len < SEAM_MIN_CONTRAST * SEAM_MIN_CONTRAST) return null;
  const f = Math.min(1, Math.max(0, dot / len));
  let res = 0;
  for (let c = 0; c < 3; c++) {
    const a = sa[c] / sa[3], b = sb[c] / sb[3];
    res += (rgba[i + c] - (f * a + (1 - f) * b)) ** 2;
  }
  return {
    f,
    fits: res <= SEAM_MAX_RESIDUAL * SEAM_MAX_RESIDUAL,
    color: [0, 1, 2].map((c) => Math.round(sa[c] / sa[3])),
    other: [0, 1, 2].map((c) => Math.round(sb[c] / sb[3]))
  };
}

/**
 * 前层切口抗锯齿：切口外侧、压在更靠后部件身上的那一圈像素，给一点 alpha，
 * 颜色取自己的。
 *
 * 归属表按像素 0/1 判，前层（头发压脸）的切口是硬阶梯；源图自带的轮廓
 * 对着透明背景，画师画好了过渡，不用管。只往外扩、不往里收：往里收会让
 * 前层边缘半透明，后层那格要是没补到就露缝；往外扩只是盖在后层自己的
 * 像素上，后层一格不缺，动起来也不会裂。
 *
 * 给多少 alpha：两侧颜色拆得开时按 mixFraction（画师那格本来就是 f 成头发，
 * 叠回去和源图一致），颜色用前层内部平均色；拆不开（同色系）退回 3x3 高斯核
 * 的几何覆盖率，颜色用相邻自己像素的加权平均。
 *
 * @param {Buffer} buf - RGBA，本部件已切好的像素（不归自己的 alpha=0）
 * @param {Uint8Array} mine - 1 = 归本部件
 * @param {Uint8Array} behind - 1 = 源图不透明、归一个更靠后的部件
 * @param {Buffer} src - 窗口内的源图 RGBA；alpha 不会比源图更实
 * @returns {Buffer} 新缓冲，原缓冲不变
 */
export function featherFrontEdge(buf, width, height, mine, behind, src) {
  const out = Buffer.from(buf);
  const inMine = (j) => mine[j] === 1;
  const inBehind = (j) => behind[j] === 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mine[i] || !behind[i]) continue;
      let cov = 0, r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (!mine[j]) continue;
          const k = (dx ? 1 : 2) * (dy ? 1 : 2);
          cov += k;
          r += k * buf[j * 4]; g += k * buf[j * 4 + 1]; b += k * buf[j * 4 + 2];
        }
      }
      if (!cov) continue;
      const m = mixFraction(src, width, height, x, y, inMine, inBehind);
      if (m && !m.fits) continue;   // 描线之类，原样留给后层
      const a = Math.round((m ? m.f : cov / 16) * src[i * 4 + 3]);
      if (!a) continue;
      const [cr, cg, cb] = m ? m.color : [r / cov, g / cov, b / cov];
      out[i * 4] = Math.round(cr);
      out[i * 4 + 1] = Math.round(cg);
      out[i * 4 + 2] = Math.round(cb);
      out[i * 4 + 3] = a;
    }
  }
  return out;
}

/**
 * 后层接缝还原：本部件被前层羽化压着的那一圈，颜色换回自己的纯色。
 *
 * 源图那格是画师画的过渡 f·前 + (1−f)·后。前层已经按 f 叠了一层自己的颜色，
 * 后层要是还留着源图原色，拼起来前层颜色算了两遍（边缘发暗/发脏）；
 * 单独看后层也会带一圈前层的颜色。换成后层内部平均色，叠回去正好等于源图。
 * 两侧颜色拆不开时不动（前层那边也是按几何羽化的，原色最接近）。
 *
 * @param {Uint8Array} mine - 1 = 归本部件
 * @param {Uint8Array} front - 1 = 归一个更靠前的部件
 */
export function unmixBackEdge(buf, width, height, mine, front, src) {
  const out = Buffer.from(buf);
  const inMine = (j) => mine[j] === 1;
  const inFront = (j) => front[j] === 1;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!mine[i]) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1; dx++) if (front[i + dy * width + dx]) { touches = true; break; }
      if (!touches) continue;
      const m = mixFraction(src, width, height, x, y, inFront, inMine);
      if (!m || !m.fits || m.f < 0.02) continue;
      out[i * 4] = m.other[0];
      out[i * 4 + 1] = m.other[1];
      out[i * 4 + 2] = m.other[2];
    }
  }
  return out;
}

/**
 * 接缝归属修正：前层切口上那一两格，颜色多半是后层的，就还给后层。
 *
 * SAM 掩码是像素级 0/1，边缘常常多吃进邻件 1~2px——头发掩码沿着脸多带
 * 一条肤色。那条肤色在 hair.png 里是一道浅色阶梯（用户报的「锯齿」），
 * 拼起来时它压在脸上倒看不出，但头发一单独动就露。
 *
 * 只把 f < 0.5（后层颜色占多数）的格子改判给后层；改判后后层那格是源图
 * 原样、全不透明，前层再用 featherFrontEdge 按 f 叠一层过渡——拼起来和
 * 源图一致，任何一格都有主、不会露底。先算完再统一改，避免一圈圈往里啃。
 *
 * @returns {number} 改判的像素数
 */
export function refineSeamOwnership(ownerOf, rgba, width, height, depthOf) {
  const moves = [];
  const depth = (n) => depthOf.get(n) ?? 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const p = ownerOf[i];
      if (p === null || rgba[i * 4 + 3] < ALPHA_CUTOFF) continue;
      let q = null;
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        const o = ownerOf[j];
        if (o !== null && o !== p && depth(o) < depth(p) && rgba[j * 4 + 3] >= ALPHA_CUTOFF) { q = o; break; }
      }
      if (q === null) continue;
      const m = mixFraction(rgba, width, height, x, y, (j) => ownerOf[j] === p, (j) => ownerOf[j] === q);
      if (m && m.fits && m.f < 0.5) moves.push([i, q]);
    }
  }
  for (const [i, q] of moves) ownerOf[i] = q;
  return moves.length;
}

/**
 * alpha 扩散（edge bleed）。
 *
 * 逐轮把不透明像素的颜色推进相邻透明像素，只写 RGB、不动 alpha。
 * 不动 alpha 是关键：形状完全不变，肉眼看不出差别，
 * 但采样时被平均进来的不再是黑色，暗边就消失了。
 *
 * @param {Buffer} src - RGBA 原始像素
 * @returns {Buffer} 新缓冲，原缓冲不变
 */
export function bleedAlpha(src, width, height, passes = DEFAULT_BLEED) {
  const buf = Buffer.from(src);
  // 已经有颜色可用的像素：本轮可作为颜色来源
  const solid = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    solid[i] = buf[i * 4 + 3] >= ALPHA_CUTOFF ? 1 : 0;
  }

  for (let pass = 0; pass < passes; pass++) {
    // 本轮新填的像素要等整轮结束才能当来源，否则颜色会沿扫描方向拖出条纹
    const added = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (solid[idx]) continue;

        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nidx = ny * width + nx;
            if (!solid[nidx]) continue;
            r += buf[nidx * 4];
            g += buf[nidx * 4 + 1];
            b += buf[nidx * 4 + 2];
            n++;
          }
        }

        if (!n) continue;
        added.push(idx);
        buf[idx * 4] = Math.round(r / n);
        buf[idx * 4 + 1] = Math.round(g / n);
        buf[idx * 4 + 2] = Math.round(b / n);
        // alpha 不动
      }
    }

    if (!added.length) break;
    for (const idx of added) solid[idx] = 1;
  }

  return buf;
}

/**
 * 把切图返回的补偿后 bbox / pivot 写回部件定义。
 *
 * 外扩改了 bbox，网格和骨骼都得按新 bbox 算，否则贴图与顶点差一个 margin。
 * 返回新数组，不改原对象——原始 AI 分析结果留着好排查。
 */
export function applyCutGeometry(parts, cutResults) {
  const byName = new Map(cutResults.map((r) => [r.name, r]));
  return parts.map((p) => {
    const r = byName.get(p.name);
    if (!r?.bbox) return p;
    return { ...p, bbox: r.bbox, pivot: r.pivot ?? p.pivot };
  });
}

/**
 * 对齐诊断：AI 的框到底偏了多少。
 *
 * 用户看到动画里"缺块"时，最需要回答的问题不是"模型画得好不好"，
 * 而是"这个部件的框是不是根本框错了地方"。AI 只给矩形框、不给形状，
 * 而部件几乎从来不是矩形——框多框进来的内容会跟着部件一起动，
 * 少框的则永远露不出来。
 *
 * 三个指标：
 *   - fillRatio：框里不透明像素的占比。低于 0.5 说明框里一大半是空的，
 *     多半把邻件的空白区或者别的部件框进来了。
 *   - bleedRatio：框内不透明像素里，属于「远离框中心的那一大块」的比例。
 *     高说明框伸进了隔壁部件的地盘。
 *   - drift：吸附把框挪动了多少像素（吸附关闭时是 0）。
 *
 * 纯统计，不调用模型，跟着 /api/generate 的响应一起回给前端画框用。
 *
 * @param {Array} cutResults - cutImageParts 的返回值
 * @returns {Promise<Array>} 每个部件一条诊断
 */
export async function diagnoseAlignment(cutResults) {
  const out = [];
  for (const cut of cutResults) {
    try {
      const { data, info } = await sharp(cut.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width: w, height: h } = info;
      let solid = 0;
      for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= ALPHA_CUTOFF) solid++;
      const fillRatio = solid / (w * h);

      const raw = cut.originalBbox;
      const drift = raw
        ? {
            x: Math.round(cut.bbox.x - raw.x),
            y: Math.round(cut.bbox.y - raw.y),
            width: Math.round(cut.bbox.width - raw.width),
            height: Math.round(cut.bbox.height - raw.height)
          }
        : null;

      // 判定：框里空得离谱，或者吸附把它挪得很多，都值得看一眼
      const flags = [];
      /*
       * 原来的判据是「框内不透明不到一半」。斜着的肢体天然占不满一个正框：
       * 双臂张开那张图 11 个部件报了 9 个，全是误报。改看 SAM 掩码和 AI 轮廓
       * 对不对得上——两份独立估计重叠不到一半，才说明框或分割真的偏了。
       */
      if (typeof cut.maskPolyIoU === 'number' && cut.maskPolyIoU < 0.5) {
        flags.push('SAM 掩码和 AI 轮廓重叠不到一半，框或分割可能偏了');
      }
      if (drift && (Math.abs(drift.width) > w * 0.3 || Math.abs(drift.height) > h * 0.3)) {
        flags.push('AI 的框比实际内容大很多，已按轮廓收紧');
      }

      out.push({
        name: cut.name,
        size: `${w}x${h}`,
        fillRatio: +fillRatio.toFixed(3),
        snapped: !!cut.snapped,
        drift,
        originalBbox: raw ? { ...raw } : null,
        bbox: { ...cut.bbox },
        flags
      });
    } catch (err) {
      out.push({ name: cut.name, error: err.message });
    }
  }
  return out;
}

/** 获取图片尺寸 */
export async function getImageSize(imagePath) {
  const metadata = await sharp(imagePath).metadata();
  return {
    width: metadata.width,
    height: metadata.height
  };
}

export { DEFAULT_MARGIN, DEFAULT_BLEED };
