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
   * 只在有 SAM 掩码时建表。polygon 路径继续走原来的按遮挡者轮廓擦除：
   * polygon 是 AI 报的顶点，粗到会把细弧整块划给大色块，拿它定"唯一归属"
   * 会擦掉大片本该可见的内容，比重复更糟。
   */
  let ownerOf = null;
  if (samMasks.size) {
    // 面积先算好：打平时要比，放在循环里会重复扫整张掩码
    const areaOf = new Map();
    for (const [name, mask] of samMasks) {
      let n = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
      areaOf.set(name, n);
    }

    /** 谁更有资格认领同一个像素：depth 大的赢，平了面积小的赢，再平按名字 */
    const better = (a, b) => {
      const da = depthOf.get(a) ?? 0, db = depthOf.get(b) ?? 0;
      if (da !== db) return da > db;
      const aa = areaOf.get(a) ?? Infinity, ab = areaOf.get(b) ?? Infinity;
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

    ownerOf = new Array(srcW * srcH).fill(null);
    let contested = 0;
    let clippedOut = 0;
    for (const [name, rawMask] of samMasks) {
      const mask = clipToBox(name, rawMask);
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
      console.log(`[切图] ✂ 掩码超出自己的框，已裁掉 ${clippedOut}px（SAM 会外溢到邻件上）`);
    }
    if (contested) {
      console.log(`[切图] ⚖ 掩码重叠 ${contested}px，已按「depth 最大者独占」定归属（避免同一块内容进多张图）`);
    }

    /*
     * 第三遍：补上**没有任何掩码认领**的像素。
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

          // 别的部件用更小的框也圈住了这里？那该归它，不是归我
          let mine = true;
          for (const other of parts) {
            if (other === part || !other.bbox) continue;
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
  const ownsBox = new Map();
  if (ownerOf && growCap > 0) {
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
       * 掩码切图：只保留"轮廓内、且源图上真有内容"的像素。
       *
       * 这是「西红柿里不能有篮子」的唯一解法。矩形 extract 必然框进邻件：
       * 西红柿的 bbox 一旦扩到包含被遮住的底部，框里就同时出现了提手、
       * 篮圈和旁边西瓜的一块——实测就是这样，用户看到的"不干净"。
       *
       * 轮廓有两个来源，优先用 SAM：
       *
       *   SAM 掩码 —— 像素级，只包含这件东西**可见**的像素。提手压在
       *     番茄上的那条弧天然不在番茄掩码里，切出来就是纯番茄；被挡住
       *     的地方留成透明，正好是补图该接手的输入。
       *
       *   polygon —— AI 给的顶点，粗。让语言模型报顶点时，它倾向于把
       *     "细弧压在大色块上"的边界整块划给大色块，所以提手会被包进
       *     番茄轮廓。中空结构（提手那种拱形）它更会连洞一起框住，
       *     实测轮廓内 44~53% 的像素源图上根本是透明的。
       *
       * 两者都要再和源图不透明像素求交集：轮廓定"哪里可能属于我"，
       * 源图定"哪里真的画了东西"。被遮挡处（源图透明）不属于任何部件。
       *
       * 都没有时退回纯矩形切图，行为与改造前一致。
       */
      let masked = data;
      const samMask = samMasks.get(name);
      const usedSam = !!samMask;
      /*
       * 归属判给别人、因此从本部件擦掉的那些像素。
       *
       * 和深度擦除的 erasedMask 是一回事（都是"这里原来有内容、被拿走了、
       * 补图该填"），只是来源不同：一个来自 depth 表，一个来自归属表。
       * 落盘前并成同一张掩码，补图那边不需要区分。
       */
      let yieldedMask = null;

      if (samMask) {
        /*
         * 窗口内逐像素套用掩码。窗口就是 extract 出来的那块，
         * 掩码是源图尺寸的，按 (x0, y0) 偏移对齐。
         */
        masked = Buffer.from(data);
        let clipped = 0;
        let yielded = 0;
        let keptByBox = 0;
        for (let y = 0; y < h; y++) {
          const srcRow = (y + y0) * srcW;
          const winRow = y * w;
          for (let x = 0; x < w; x++) {
            const di = (winRow + x) * 4;
            if (masked[di + 3] < ALPHA_CUTOFF) continue;   // 源图这儿本来就空
            const si = srcRow + x + x0;

            if (!samMask[si]) {
              /*
               * 掩码没盖住这里，但归属表判给了本部件 —— 保留。
               *
               * 归属表判给本部件、而本部件的 SAM 掩码又没盖住，只有一种来源：
               * 第三遍「按框补齐」。MobileSAM 是纯框提示，头这个框里它给出的
               * 是**头发**（实测只盖住框内 32.5% 的不透明像素），脸、下巴、
               * 耳朵全在掩码外。不认这一遍，这些像素就会被当成"掩码外"删掉——
               * 而它们恰恰是头的一部分，删掉就是用户看到的"头转了脸不转"。
               */
              if (ownerOf && ownerOf[si] === name) {
                keptByBox++;
                continue;
              }
              masked[di + 3] = 0;                            // 掩码外且不归我：让位
              clipped++;
              continue;
            }
            /*
             * 掩码内、但归属判给了别人（更靠前的那一层）：让位。
             *
             * 这就是「头部不再出现在多张图上」的落点。上面的归属表已经把
             * 重叠区判给了 depth 最大的那个部件，这里照判决执行。
             * 让位的像素下面会记进 erasedMask，补图把它填成合理的内容。
             */
            if (ownerOf && ownerOf[si] !== null && ownerOf[si] !== name) {
              masked[di + 3] = 0;
              yielded++;
            }
          }
        }
        if (clipped || yielded || keptByBox) {
          const total = w * h;
          const extra = (yielded ? `，另让给更靠前的层 ${yielded}px` : '') +
                        (keptByBox ? `，按框认回掩码外的 ${keptByBox}px` : '');
          console.log(`[切图] ⛶ ${name} 按 SAM 掩码裁掉 ${clipped}px（占窗口 ${(clipped / total * 100).toFixed(1)}%）${extra}`);
        }
        // 让位的像素要补：记下来，下面和深度擦除的结果并进同一张 erasedMask
        if (yielded) {
          yieldedMask = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) {
            const srcRow = (y + y0) * srcW;
            for (let x = 0; x < w; x++) {
              const si = srcRow + x + x0;
              if (!samMask[si]) continue;
              if (srcAlpha[si * 4 + 3] < ALPHA_CUTOFF) continue;
              if (ownerOf[si] !== null && ownerOf[si] !== name) yieldedMask[y * w + x] = 1;
            }
          }
        }
      } else if (hasPoly) {
        const polyMask = fillPolygon(poly, w, h, x0, y0);
        masked = Buffer.from(data);
        let clipped = 0, keptByBox = 0;
        for (let y = 0; y < h; y++) {
          const srcRow = (y + y0) * srcW;
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (masked[i * 4 + 3] < ALPHA_CUTOFF) continue;   // 源图这儿本来就空
            if (polyMask[i]) continue;                        // 在轮廓内，保留
            /*
             * 轮廓外，但归属表判给了本部件 —— 保留。
             *
             * 和 SAM 分支的「按框认领」是同一条规则，以前只写在 SAM 分支里。
             * 后果实测出来的：`right_arm_and_scissors` 的 SAM 掩码几乎是空的
             * （占框内 11.0%），被降级到 polygon 路径；可那份小掩码仍然参与
             * 了归属表，把框内属于它的像素都判给了它，然后 polygon 这一句
             * 又把它们当"轮廓外的邻件"删掉——17416px 有内容却谁都没画，
             * 渲染出来手臂中间一串竖直白碎片。
             *
             * 边界情况：polygon 是 AI 给的粗略轮廓，正常应该收得比内容紧，
             * 所以"轮廓外归属于我"本身就已经说明多边形不准了，此时以归属
             * 表的判决为准（框是 SAM 的提示，也是这个部件位置的上界）。
             */
            const owner = ownerOf ? ownerOf[srcRow + x + x0] : null;
            if (owner === name) {
              keptByBox++;
              continue;
            }

            /*
             * 归属表里**根本没有本部件**时（掩码被判太差、没进表），
             * 上面那条判断永远为假，轮廓外属于它的内容会被整片删掉。
             *
             * 实测 role2：`left_arm` 的掩码几乎为空（占框内 8.9%）被丢掉，
             * 它整条袖子在框外的那 1577px 就谁都不画了（漏失 1.12%，
             * 主块 1343px 在 x232..290 y587..740，正是袖子的下段）。
             *
             * 兜底只认领**别的框都没圈住**的像素：没有掩码就没有证据说这块
             * 是我的，只能靠"没有别人声索"来判。有别的框压着就让给那个框
             * ——那条规则（面积小的框更具体）已经在第二遍里定过案了。
             */
            if (!owner) {
              const claimedByOther = parts.some((o) => {
                if (o.name === name || !o.bbox) return false;
                const b = o.bbox;
                return x + x0 >= b.x && x + x0 < b.x + b.width
                  && y + y0 >= b.y && y + y0 < b.y + b.height;
              });
              if (!claimedByOther) {
                keptByBox++;
                continue;
              }
            }

            masked[i * 4 + 3] = 0;
            clipped++;
          }
        }
        if (clipped || keptByBox) {
          const total = w * h;
          const extra = keptByBox ? `，按框认回轮廓外的 ${keptByBox}px` : '';
          console.log(`[切图] ⬟ ${name} 裁掉轮廓外的邻件 ${clipped}px（占窗口 ${(clipped / total * 100).toFixed(1)}%）${extra}`);
        }
      }

      /*
       * 按深度擦除：把所有比本部件靠前的部件的不透明像素从切图里挖掉。
       *
       * 必须在 bleedAlpha 之前做——扩散会把颜色推进透明区，先擦后扩散，
       * 补图才有「这里缺内容」的信号；先扩散后擦，擦完边缘没有可扩散的
       * 邻色，补图接不上。
       *
       * 擦的是遮挡者的**不透明像素**而不是它的矩形框：框会把被擦方自己
       * 也一起擦掉（两者的框必然相交）。只有遮挡者真正画了东西的地方
       * 才属于它，那里才是该让位的区域。
       *
       * src 只在开 snap 时读取；这里需要它来判断遮挡者的实际轮廓，
       * 所以没开 snap 时按需读一次。
       */
      const ahead = frontOf.get(name) ?? [];
      /*
       * 记下"哪些像素是被擦掉的"，交给补图。
       *
       * 补图那边靠「透明区连不连到图边」区分"部件外的 padding"（保持透明）
       * 和"部件身上的洞"（填实）。深度擦除造出了第三种东西：被前方部件
       * 挖掉的一大片，它按定义连到图边，却正是最该填的地方。
       * 不把这张掩码传过去，补图会把模型补出来的内容整片丢掉——
       * 实测 basket_back 报"补了 99%"，落盘却只有 0.8% 不透明。
       */
      let erasedMask = null;
      /*
       * frontMask：被擦掉的像素里，有多少是**盖在前面的那个部件的轮廓**。
       *
       * 这一片和"部件自己身上的洞"要分开对待。自己身上的洞（接缝、被邻件
       * 挡掉的一小块）该由补图填实，那是真缺口；而这一片是被前方部件整个
       * 盖住的区域，补图**没有真值可参考**——它看不到下面是什么，只能照着
       * 画面里还看得见的东西推。
       *
       * 实测就是这么翻的车：围裙压在裙子上，裙子那片擦除区里补出来的
       * 全是围裙的紫灰（108,99,120），平均比源图暗 27 个色阶，只有 4.3%
       * 的像素和源图接近。静态切图看不出来——那片像素 alpha 是 0，预览里
       * 不显示；可两片按不同骨头转起来，它就是围裙的一份重影。实测
       * skirt∩apron 重叠 69669px、98% 落在裙子这个擦除区里。
       *
       * 所以这片要单独标出来，补图把它的 alpha 一律留 0（内容随便补，
       * 反正看不见），别再产出"看起来像内容"的重影。
       */
      let frontMask = null;
      /*
       * 归属让位的像素同样要补，所以 erasedMask 的起点是 yieldedMask。
       *
       * 两者合并而不是二选一：一个部件可能既让位给了重叠判决（头颈那块），
       * 又被深度擦除挖掉了另一片（前方部件盖住的地方）。只传一张，
       * 另一片就会被补图当成"部件外的留白"留成透明，预览里就是个黑洞。
       */
      if (yieldedMask) erasedMask = yieldedMask;

      if (ahead.length && masked) {
        erasedMask ??= new Uint8Array(w * h);
        let cleared = 0;
        for (const occ of ahead) {
          /*
           * 遮挡者的掩码 = 它的轮廓 ∩ 源图上它真正画了东西的地方。
           *
           * 只用轮廓：轮廓内的透明像素（比如提手两弧之间的空隙）不算遮挡，
           * 擦掉它会把本部件在那里本来就有的内容误伤——这正是"提手内侧
           * 多出一个方形缺口"的成因，老代码按矩形擦所以整片都挖了。
           *
           * 轮廓优先用 SAM 掩码（像素级），没有就退回 polygon，
           * 再没有就退回矩形范围（改造前的老行为）。
           */
          const ob = occ.bbox;
          const ox0 = Math.max(0, Math.round(ob.x) - x0);
          const oy0 = Math.max(0, Math.round(ob.y) - y0);
          const ox1 = Math.min(w, Math.round(ob.x + ob.width) - x0);
          const oy1 = Math.min(h, Math.round(ob.y + ob.height) - y0);
          if (ox1 <= ox0 || oy1 <= oy0) continue;

          const occSam = samMasks.get(occ.name) ?? null;
          const occPoly = !occSam && Array.isArray(occ.polygon) && occ.polygon.length >= 3
            ? fillPolygon(occ.polygon, w, h, x0, y0)
            : null;

          for (let y = Math.max(0, oy0); y < oy1; y++) {
            const srcRow = (y + y0) * srcW;
            for (let x = Math.max(0, ox0); x < ox1; x++) {
              const i = y * w + x;
              // 有 SAM 掩码只认掩码；有 polygon 只认轮廓内；都没有就整框
              if (occSam) {
                if (!occSam[srcRow + x + x0]) continue;
                /*
                 * 遮挡者还得**真的拥有**这里，否则不算它盖住了。
                 *
                 * SAM 的掩码会外溢：实测眼镜那个框，掩码覆盖 10039px，
                 * 而眼镜本身只有 9889px——多出来的是整张脸。眼镜 depth=3
                 * 比头深，于是 head 的脸（脸中心 rgb(249,190,163) 皮肤色）
                 * 被当成"被眼镜盖住"整片擦掉，补图再把 alpha 压成 0，
                 * 切出来的 head 是一张没有脸的头。
                 *
                 * 归属表已经按 depth 判过每个像素归谁，这里照判决执行：
                 * 判给遮挡者的才算遮挡。没有归属表（polygon 路径）时维持原行为。
                 */
                if (ownerOf && ownerOf[srcRow + x + x0] !== null
                    && ownerOf[srcRow + x + x0] !== occ.name) continue;
              } else if (occPoly && !occPoly[i]) {
                continue;
              }

              /*
               * 归属表判给本部件的像素不让位。
               *
               * 这里原来的判据是「本部件的 SAM 掩码认领的像素不让位」，为的是
               * 防止擦空：SAM 掩码之间会重叠，擦除只看遮挡者的掩码，会把本部件
               * 真正可见的内容一起删（实测 left_arm 只剩 4.3% 不透明）。
               *
               * 但这条豁免同时放过了**重叠中不该保留的那一半**：body 的掩码把
               * 头颈一起圈了进来，豁免一生效，头的像素就在 body 上留下了一份，
               * head 自己也有一份，于是"头部在多个部件都有"、动画里断裂滑动。
               *
               * 改判归属表：重叠区已经按 depth 判过唯一归属，判给本部件的才留。
               * 防擦空的效果不变（真正属于自己的那一半照样留住），而判给别人的
               * 那一半这次会让位——两个问题一条规则同时解决。
               *
               * 没有 SAM 掩码时（polygon 路径）维持原行为。
               */
              if (ownerOf) {
                if (ownerOf[srcRow + x + x0] === name) continue;
              } else if (samMask && samMask[srcRow + x + x0]) {
                continue;
              }
              const si = ((y + y0) * srcW + (x + x0)) * 4 + 3;
              if (srcAlpha[si] < ALPHA_CUTOFF) {
                /*
                 * 遮挡者盖住这里，但源图**这里本来就是空的**。
                 *
                 * 没有内容要擦（masked 本来就是 0），可这片正是"补图没有
                 * 真值可参考"的地方——裙子画到围裙边缘就断了，那块源图是
                 * 透明的。所以不用 erased（没有内容要填回来），但要记进
                 * frontMask：下面统计"这片里有多少是空的"就靠它。
                 */
                if (occSam) (frontMask ??= new Uint8Array(w * h))[i] = 2;
                continue;
              }
              const di = i * 4;
              /*
               * 用源图 alpha（si）而不是 masked[di+3] 判断"本来没内容"。
               *
               * masked 此时可能已被 SAM 裁过：前方部件（如围裙）覆盖的身体像素
               * 已被 SAM 置零。旧代码在这里判 masked[di+3] < ALPHA_CUTOFF 就
               * continue——结果这些像素也没写进 erasedMask，补图的 markExteriorGap
               * 把整片区域当外部留白保持透明，预览里上半身变成黑洞。
               *
               * 改用 srcAlpha 判断后，只要源图这里有内容就写 erasedMask；
               * masked 仍然需要置零（polygon 路径下这里可能还是原值）。
               */
              masked[di + 3] = 0;
              erasedMask[i] = 1;
              cleared++;
            }
          }
        }
        if (cleared) console.log(`[切图] ⌫ ${name} 擦除前方遮挡 ${cleared}px（${ahead.map(o => o.name).join(', ')}）`);

        /*
         * frontMask：被前方部件盖住的那片 —— 「补图看不到下面是什么」的区域。
         *
         * 这一片和"部件自己身上的洞"要分开对待。自己身上的洞（接缝、被邻件
         * 挡掉的一小块）该由补图填实，那是真缺口；而这一片是被前方部件整个
         * 盖住的区域，补图没有真值可参考，只能照着画面里还看得见的东西推。
         *
         * 实测就是这么翻的车：围裙压在裙子上，裙子那片擦除区里补出来的
         * 全是围裙的紫灰（108,99,120），平均比源图暗 27 个色阶。静态切图
         * 看不出来（那片 alpha 是 0），两片按不同骨头转起来就是一层重影。
         * 实测 body 在裙摆底下补出 [119,113,129]、源图那格是 [108,96,118]；
         * head 在镜片底下补出 [246,183,157]、源图那格是 [225,173,159]。
         *
         * 判据按定义扫，不看擦除循环写了什么：擦除循环走到归属判决已经
         * 让位的像素会提前 continue，压根到不了写记录那一支。所以这里直接
         * 扫「遮挡者的掩码 ∩ 本部件的窗口」。
         *
         * 曾经这里还有一条"源图那块必须是空的才算 front"的门槛，用来防
         * 小配件盖住大部件时把下面整片真值也压掉（眼镜盖脸）。那条门槛是
         * 错的：源图那块之所以有内容，正是因为遮挡者本人画在那里，不是
         * 被盖者自己的真值。眼镜那个 case 的真正病根是 SAM 掩码外溢到
         * 自己的框外（10039px 掩码 vs 9889px 自身内容），已由 clipToBox 修掉，
         * 不该在这里再用面积比兜一遍。实测那条门槛把 role7 和 12 的 front
         * 全部判成 null（源图被盖处 100% 有内容），两件素材的重影直接漏网。
         */
        if (ahead.length && samMasks.size) {
          const occUnion = new Uint8Array(w * h);
          for (const occ of ahead) {
            const occSam = samMasks.get(occ.name);
            if (!occSam) continue;
            const ob = occ.bbox;
            const ox0 = Math.max(0, Math.round(ob.x) - x0);
            const oy0 = Math.max(0, Math.round(ob.y) - y0);
            const ox1 = Math.min(w, Math.round(ob.x + ob.width) - x0);
            const oy1 = Math.min(h, Math.round(ob.y + ob.height) - y0);
            for (let y = Math.max(0, oy0); y < oy1; y++) {
              const srcRow = (y + y0) * srcW;
              for (let x = Math.max(0, ox0); x < ox1; x++) {
                if (occSam[srcRow + x + x0]) occUnion[y * w + x] = 1;
              }
            }
          }
          let n = 0;
          frontMask = new Uint8Array(w * h);
          for (let i = 0; i < w * h; i++) {
            if (!occUnion[i]) continue;
            frontMask[i] = 1;
            n++;
          }
          if (!n) frontMask = null;
          else console.log(`[切图] ↺ ${name} 被前方部件盖住 ${n}px（${ahead.map(o => o.name).join(', ')}）——这片交给源图真值，别让模型编`);
        }
      }

      /*
       * 被挖走的地方，把**源图的真实颜色**填回去，但 alpha 保持 0。
       *
       * 只把 alpha 置零是不够的：那片区域的 RGB 也一起变成 0（透明黑），
       * 补图拿到一张"挖空了颜色"的图，只能照着画面里还看得见的东西猜——
       * 而围裙正好盖在裙子上，它就照着围裙的紫灰画满了整片，
       * 补出来的每一块都是**前面那个部件的一份复制品**。
       * 实测 skirt∩apron 重叠 69669px，其中 98% 落在裙子自己的擦除区里、
       * 颜色是围裙的紫灰（108,99,120）而不是裙子该有的深灰（69,59,73）——
       * 静态切图看不出来，两片一起按不同骨头转起来就是一层重影。
       *
       * 填回真实颜色之后，模型看到的是"这里本来就是裙子"，补出来接得上；
       * 就算它还是照着围裙画，下面这张真实颜色 + 补图的 RGB 扩散也会把
       * 边缘拉回裙子的色。alpha 一律不动，形状还是原轮廓。
       *
       * 只对**擦除区**这么做：源图本来就透明的 padding 不碰，那里没有真值。
       */
      if (erasedMask && src) {
        for (let i = 0; i < w * h; i++) {
          if (!erasedMask[i]) continue;
          const sx = i % w, sy = (i / w) | 0;
          const si = ((sy + y0) * srcW + (sx + x0)) * 4;
          masked[i * 4] = src[si];
          masked[i * 4 + 1] = src[si + 1];
          masked[i * 4 + 2] = src[si + 2];
          masked[i * 4 + 3] = 0;   // 形状不变
        }
      }

      const filled = bleed > 0 ? bleedAlpha(masked, info.width, info.height, bleed) : masked;

      const outputPath = join(outputDir, `${name}.png`);
      await sharp(filled, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toFile(outputPath);

      // 前方轮廓掩码：1 = 这一片是被前方部件整个盖住的，补图别把它算成形状
      if (frontMask) {
        const fmPath = join(outputDir, `${name}.front.png`);
        const fmBuf = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const val = frontMask[i] ? 255 : 0;
          fmBuf[i * 4] = val;
          fmBuf[i * 4 + 1] = val;
          fmBuf[i * 4 + 2] = val;
          fmBuf[i * 4 + 3] = 255;
        }
        await sharp(fmBuf, { raw: { width: w, height: h, channels: 4 } })
          .png()
          .toFile(fmPath);
      }

      /*
       * 擦除掩码：1 = 这个像素被深度擦除挖掉了，inpaint 应该填它。
       *
       * 顺手把**源图在那里的原样 RGB** 也写进这张 PNG 的像素里（alpha 仍是
       * 掩码语义，255 = 被擦）。补图拿到它就能把这片直接贴回去，不用猜。
       *
       * 为什么必须贴回去而不是让模型补：被前方部件盖住的那片，模型看不到
       * 下面是什么，只能照着画面里还看得见的东西推——推出来就是遮挡者的
       * 一份复制品。实测 body 在裙摆底下补出 [119,113,129]，而源图那格是
       * [108,96,118]（裙摆的紫灰）；head 在镜片底下补出 [246,183,157]，
       * 源图那格是 [225,173,159]。静态切图看不出来，两片按不同骨头转起来
       * 就是一层错色的重影。
       *
       * 源图那个像素不是"猜"——它就是当时真正显示的颜色。用户要的
       * 「完整 Object RGBA」要的正是这一份，而不是模型的想象。
       * 只有源图**那里本来就是空的**（真洞，实测两件素材合计 412px）才
       * 留给模型补。
       */
      if (erasedMask) {
        const maskPath = join(outputDir, `${name}.erased.png`);
        const maskBuf = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          /*
           * alpha 是**掩码语义**：255 = 这一格被擦、要补。没被擦的留 0，
           * 否则整窗都会被当成擦除区、补图把矩形贴实（实测就是把部件
           * 补成了 100% 不透明的实心矩形）。
           * RGB 只在被擦且**有真值**时才有意义。
           */
          if (!erasedMask[i]) continue;
          const sx = i % w, sy = (i / w) | 0;
          const si = ((sy + y0) * srcW + (sx + x0)) * 4;
          const inside = sx + x0 >= 0 && sy + y0 >= 0 && sx + x0 < srcW && sy + y0 < srcH;
          const hasTruth = inside && srcAlpha[si + 3] >= ALPHA_CUTOFF;
          if (hasTruth) {
            maskBuf[i * 4] = srcAlpha[si];
            maskBuf[i * 4 + 1] = srcAlpha[si + 1];
            maskBuf[i * 4 + 2] = srcAlpha[si + 2];
          }
          // 没真值的真洞留 0,0,0：补图只看 alpha 是掩码，看 RGB 才知道能不能贴
          maskBuf[i * 4 + 3] = 255;
        }
        await sharp(maskBuf, { raw: { width: w, height: h, channels: 4 } })
          .png()
          .toFile(maskPath);
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
        originalBbox: { ...rawBbox }
      });

    } catch (error) {
      console.error(`[切图] ✗ ${part.name} 失败:`, error.message);
    }
  }

  console.log(`[切图] 完成，成功切出 ${results.length}/${parts.length} 张图片`);

  return results;
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
      if (fillRatio < 0.5) flags.push('框内过半是空的，可能框进了邻件或背景');
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
