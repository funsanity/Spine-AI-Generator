/**
 * 蒙皮网格与权重计算。
 *
 * 为什么不用 AI 出网格：
 *   网格顶点、三角剖分、权重这些是纯几何问题，有确定解。
 *   让视觉模型去猜逐点坐标，既慢又会在每张图上抖。
 *   AI 只做它擅长的部分——语义拆图（哪个部件、谁是谁的父级、转轴在哪），
 *   几何部分在这里用确定性算法算出来。
 *
 * 权重怎么来的：
 *   刚性拼合的问题不是"部件不动"，而是接缝两侧属于不同骨骼、
 *   动起来时错开。接缝要合得上，接缝上的顶点就得**完全**跟父骨骼走，
 *   往末梢方向再渐渐交还给自身骨骼：
 *     d       = 顶点沿「关节 → 部件中心」方向离关节多远（投影，不是直线距离）
 *     wParent = 1 - smoothstep(S, S + R, d)
 *   S、R 分别是部件沿这个方向长度的 SOLID_SPAN、BLEND_SPAN
 *   关节就是 pivot（AI 给的转轴，本来就落在和父件的连接处）。
 *
 *   之前是 wParent = 0.5 × (1 - dJoint / (dSelf + dJoint))，有两处毛病，
 *   idle 呼吸一跑就露裂缝（kkk 实测静止是实的、动起来成洞的像素 1298px）：
 *     - 封顶 0.5：上身起伏 19px，大腿顶边只跟上一半，裙摆下面裂开一道横缝；
 *       手臂转 1.8°，肩膀接缝只合上一半。
 *     - 远端不归零：大腿下摆离关节最远的点父权重还有 ~0.25，跟着上身漂几像素，
 *       可下面的靴子是钉住的，膝盖处又裂一道。
 *   用投影距离而不是直线距离：大腿顶边整条线都是 d=0，两个角不会比中间松。
 */

/** Spine 最多支持 4 个骨骼影响一个顶点，这里只用到 2 个 */
const MAX_INFLUENCES = 4;

/**
 * 父骨骼影响从关节往末梢铺多远（占部件沿关节方向长度的比例）。
 * 太小：交接带窄，子件一转，交接处的三角被拧得很厉害；
 * 太大：子件自己的转动被父骨骼吃掉一大半，手臂摆不起来。
 */
const BLEND_SPAN = 0.4;

/**
 * 关节往外这一段（同样按部件长度的比例）完全跟父骨骼走，再往外才开始过渡。
 * 接缝不总是一条贴着 pivot 的直线：护膝斜盖在大腿下摆上、袖口斜着搭在披风上，
 * 交界线离 pivot 能有几十像素。交界处父权重哪怕只差 5%，上身起伏 19px
 * 就是 1px 的缝（kkk 膝盖实测）。
 */
const SOLID_SPAN = 0.2;

/**
 * 为一个部件构建网格顶点与权重。
 *
 * 坐标系约定（与 Spine 运行时一致）：
 *   - 原点在骨骼自身原点（也就是 pivot 处），不是图片中心
 *   - Y 轴向上
 * 之所以必须是这个约定：运行时算的是 currentWorld × restWorld⁻¹ × 顶点，
 * 顶点若带别的基准，rotation 一小就会整体偏移。
 *
 * @param {object} part - { name, parent, bbox, pivot }
 * @param {object|null} parentPart - 父部件的 bbox/pivot，用于定位关节
 * @param {object} opts - { density }
 * @returns {{ vertices: number[], uvs: number[], triangles: number[], weights: Array }}
 */
export function buildSkinnedMesh(part, parentPart, opts = {}) {
  const density = opts.density ?? 8;
  const bb = part.bbox;

  // 关节位置：与父部件的接触点。用父部件中心到本部件中心的连线，
  // 与本部件边界的交点作为关节，比"父部件中心"更贴近真实的连接处。
  const pivot0 = part.pivot ?? { x: bb.width / 2, y: bb.height / 2 };
  const joint = parentPart ? jointFrame(part, parentPart, pivot0) : null;

  // 顶点采样：外轮廓一圈 + 内部网格。
  // 只在边界采样会导致中心区域无顶点、旋转时整块板结；
  // 加内部点后形变能渗透进去。
  const outer = sampleOutline(bb, density);
  const innerSteps = Math.max(2, Math.floor(density / 3));
  const inner = sampleInterior(bb, innerSteps);
  const points = [...outer, ...inner];

  const vertices = [];
  const uvs = [];
  const weights = [];
  const pivot = part.pivot ?? { x: bb.width / 2, y: bb.height / 2 };

  // mesh 的静止顶点用「图片像素」为单位。
  // Y 轴在顶点空间里向上，而采样是照 bbox 的图片坐标（Y 向下）来的，
  // 所以对 bbox 内的 y 取负：bbox 顶边变成 0，底边变成 -h。
  for (const p of points) {
    vertices.push(p.x, -p.y);
    // UV 原点在图片左上角，Y 向下，和顶点坐标的翻转无关
    uvs.push(p.x / bb.width, p.y / bb.height);
    weights.push(computeWeight(p, joint));
  }

  const triangles = triangulate(points, outer.length, innerSteps);

  // 顶点空间的原点是「骨骼原点」（也就是 pivot 处），Y 轴向上。
  // 采样用的是 bbox 图片坐标（Y 向下，顶边=0，底边=h），顶点存的是 -p.y，
  // 于是 bbox 顶边落在 y=0、底边落在 y=-h，pivot 在 y=-pivot.y。
  // 把原点从 bbox 左上搬到 pivot：
  //   x: 左边缘在 0，要移到 pivot.x → 减去 pivot.x
  //   y: pivot 在 -pivot.y，要移到 0 → 加上 pivot.y
  const offset = {
    x: -pivot.x,
    y: pivot.y
  };

  // hull = 外轮廓顶点数。外轮廓排在采样点数组最前面，所以就是 outer.length。
  // 3.8 的运行时靠它区分轮廓边与内部边（编辑器画网格线、裁剪都要）。
  return { vertices, uvs, triangles, weights, offset, hull: outer.length };
}

/**
 * 估计关节位置（相对 bbox 左上角）。
 * 取两个包围盒中心连线，与本部件边界相交处。
 */
function estimateJoint(part, parentPart) {
  const a = part.bbox;
  const b = parentPart.bbox;

  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };

  // 从父中心指向子中心的方向
  const dx = ac.x - bc.x;
  const dy = ac.y - bc.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // 中心重合，退化成用部件中心
    return { x: ac.x - a.x, y: ac.y - a.y };
  }

  // 沿方向从子中心往回走到子包围盒边界
  const halfW = a.width / 2;
  const halfH = a.height / 2;
  const scaleX = Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(scaleX, scaleY, 1);

  const jx = ac.x - dx * t;
  const jy = ac.y - dy * t;

  return { x: jx - a.x, y: jy - a.y };
}

/**
 * 关节坐标系：原点 + 指向末梢的单位方向 + 沿这个方向的混合长度 R（bbox 局部坐标）。
 *
 * 原点优先用 pivot：AI 标的转轴就是和父件的连接处（大腿在顶边、头在脖子、
 * 手臂在肩膀）。pivot 落在部件正中时它说明不了连接在哪一侧，
 * 退回两个包围盒中心连线和本部件边界的交点。
 */
function jointFrame(part, parentPart, pivot) {
  const bb = part.bbox;
  const c = { x: bb.width / 2, y: bb.height / 2 };
  const diag = Math.hypot(bb.width, bb.height);
  let origin = pivot;
  if (Math.hypot(c.x - pivot.x, c.y - pivot.y) < diag * 0.08) origin = estimateJoint(part, parentPart);
  let dx = c.x - origin.x;
  let dy = c.y - origin.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // 关节就在正中，没有方向可言：整块平分给父子
    return { x: origin.x, y: origin.y, dir: null, solid: 0, span: 0 };
  }
  dx /= len;
  dy /= len;
  // 部件沿这个方向从关节到最远角的长度
  let far = 0;
  for (const [px, py] of [[0, 0], [bb.width, 0], [bb.width, bb.height], [0, bb.height]]) {
    far = Math.max(far, (px - origin.x) * dx + (py - origin.y) * dy);
  }
  return {
    x: origin.x,
    y: origin.y,
    dir: { x: dx, y: dy },
    solid: far * SOLID_SPAN,
    span: Math.max(1, far * BLEND_SPAN)
  };
}

/**
 * 计算单个顶点的权重。
 * @param {object} point - bbox 局部坐标（左上原点）
 * @param {object|null} joint - jointFrame 的结果
 * @returns {Array<{boneIndex:number, weight:number}>} boneIndex 0 = 父骨骼，1 = 自身骨骼
 */
function computeWeight(point, joint) {
  if (!joint) {
    // 根部件没有父级，完全由自身骨骼驱动
    return [{ boneIndex: 0, weight: 1 }];
  }

  let wParent;
  if (!joint.dir) {
    wParent = 0.5;
  } else {
    // 关节背后（d < 0）的顶点也全归父级：那一截本来就压在父件底下
    const d = (point.x - joint.x) * joint.dir.x + (point.y - joint.y) * joint.dir.y;
    const t = Math.max(0, Math.min(1, (d - joint.solid) / joint.span));
    wParent = 1 - t * t * (3 - 2 * t);
  }

  // 只剩一条影响时 boneIndex 0 就是「唯一那条」：父级全占写父骨骼，否则写自身
  if (wParent > 0.999) return [{ boneIndex: 0, weight: 1 }];
  if (wParent < 0.001) return [{ boneIndex: 1, weight: 1 }];

  const wp = +wParent.toFixed(4);
  return [
    { boneIndex: 0, weight: wp },
    { boneIndex: 1, weight: +(1 - wp).toFixed(4) }
  ];
}

/** 沿 bbox 边缘等距采样一圈点（不含重复的首尾点） */
function sampleOutline(bb, density) {
  const pts = [];
  const { width: w, height: h } = bb;

  const edgeCounts = [
    Math.max(1, Math.round(density * (w / (w + h)))), // 上边
    Math.max(1, Math.round(density * (h / (w + h)))), // 右边
    Math.max(1, Math.round(density * (w / (w + h)))), // 下边
    Math.max(1, Math.round(density * (h / (w + h))))  // 左边
  ];

  // 上边：左 → 右
  for (let i = 0; i < edgeCounts[0]; i++) {
    pts.push({ x: (w * i) / edgeCounts[0], y: 0 });
  }
  // 右边：上 → 下
  for (let i = 0; i < edgeCounts[1]; i++) {
    pts.push({ x: w, y: (h * i) / edgeCounts[1] });
  }
  // 下边：右 → 左
  for (let i = 0; i < edgeCounts[2]; i++) {
    pts.push({ x: w - (w * i) / edgeCounts[2], y: h });
  }
  // 左边：下 → 上
  for (let i = 0; i < edgeCounts[3]; i++) {
    pts.push({ x: 0, y: h - (h * i) / edgeCounts[3] });
  }

  return pts;
}

/** 在 bbox 内部按网格采样点，让形变能渗透到部件中部 */
function sampleInterior(bb, steps) {
  const pts = [];
  const { width: w, height: h } = bb;

  for (let i = 1; i <= steps; i++) {
    for (let j = 1; j <= steps; j++) {
      pts.push({ x: (w * i) / (steps + 1), y: (h * j) / (steps + 1) });
    }
  }

  return pts;
}

/**
 * 三角剖分。
 *
 * 点集有已知结构，不需要通用三角化算法：
 *   - 前 hullCount 个是环形有序的 bbox 边界点（上 L→R、右 T→B、下 R→L、左 B→T）
 *   - 其后是 steps × steps 的规则内部栅格，行主序（i 索引 x、j 索引 y）
 * 于是分两块铺：
 *   1. 内部栅格按四边形剖分，每格 2 个三角
 *   2. 边界环与栅格外圈之间的环带，按绕中心的角度归并缝合
 * 两块拼起来正好铺满 bbox，面积之和 = w×h，既不重叠也不留洞。
 *
 * 为什么不再用扇形剖分：旧实现把所有点按质心角度排序，再拿 order[0]
 * 连每一对相邻点。内部栅格点和边界点会落在同一条射线上，扇形就自己叠了上去。
 * 实测 head 部件 density 8：16 个三角里 9 个的重心落在别的三角内部，
 * 三角面积之和 36843 vs 凸包 26741（1.38 倍）。Spine 导入时报
 * "Fixed mesh (invalid triangles)" 然后自己改掉，但那是 Spine 好心，
 * Cocos / Unity 的运行时不保证也这么做；而且重叠区域的顶点会被加权变换
 * 算两遍，接缝处的形变量凭空翻倍。
 *
 * @param {Array<{x:number,y:number}>} points - outer 在前、inner 在后的采样点
 * @param {number} hullCount - 外轮廓点数（= outer.length）
 * @param {number} steps - 内部栅格的边长（sampleInterior 的 steps）
 */
function triangulate(points, hullCount, steps) {
  const tris = [];

  // 统一绕向 + 丢掉退化三角。
  // 判据用叉积而不是"索引有没有重复"：三个索引互不相同、但三点共线的情况
  // 才是真正的来源，只查重复索引一个都抓不到。
  // 零面积三角在有的运行时里会让整片网格的法线或 UV 插值出问题。
  const EPS = 1e-6;
  const emit = (a, b, c) => {
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    if (Math.abs(area) < EPS) return;           // 共线，这一片没有面积可画

    // 绕向统一成「顶点空间里的逆时针」。
    // 注意这里的 area 是在采样点空间（Y 向下）算的，而写进 vertices 的是 -p.y，
    // 一次 Y 取负会把叉积符号整体翻过来 —— 所以顶点空间的逆时针，
    // 在这里对应 area < 0。判反了不会报错，只是整片网格背朝外，
    // 遇上开了背面剔除的运行时就整块不见。
    if (area > 0) tris.push(a, c, b);
    else tris.push(a, b, c);
  };

  const gridCount = steps * steps;
  const hasGrid = steps >= 2 && points.length >= hullCount + gridCount;

  if (!hasGrid) {
    // 没有内部栅格可用时退回扇形。外轮廓是凸的（bbox 边界），
    // 单独对凸多边形做扇形不会自交。
    for (let k = 1; k < hullCount - 1; k++) emit(0, k, k + 1);
    return tris;
  }

  // 栅格点在点集里的下标。sampleInterior 是 i 外层、j 内层，所以行主序按 i 走。
  const gi = (i, j) => hullCount + (i - 1) * steps + (j - 1);

  // 1. 内部栅格：每个小格切成两个三角
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const a = gi(i, j);
      const b = gi(i + 1, j);
      const c = gi(i + 1, j + 1);
      const d = gi(i, j + 1);
      emit(a, b, c);
      emit(a, c, d);
    }
  }

  // 2. 栅格外圈，方向和 sampleOutline 完全一致（各边不含末点），
  //    这样两个环从同一个角度起步，缝合时不用额外对齐。
  const innerRing = [];
  for (let i = 1; i < steps; i++) innerRing.push(gi(i, 1));        // 上：左 → 右
  for (let j = 1; j < steps; j++) innerRing.push(gi(steps, j));    // 右：上 → 下
  for (let i = steps; i > 1; i--) innerRing.push(gi(i, steps));    // 下：右 → 左
  for (let j = steps; j > 1; j--) innerRing.push(gi(1, j));        // 左：下 → 上

  const outerRing = [];
  for (let k = 0; k < hullCount; k++) outerRing.push(k);

  stitchRings(points, outerRing, innerRing, emit);

  return tris;
}

/**
 * 缝合两个同心环之间的环带。
 *
 * 外环是 bbox 边界，内环是内部栅格的外圈——两个轴对齐、同心、同长宽比的矩形，
 * 都对中心星形可见。这种情况下"谁的下一个点角度小就推进谁"的归并走法
 * 会把环带切成不重叠的 O+I 个三角，正好铺满，这是标准结论。
 *
 * 角度用相对外环首点的展开角 u ∈ [0, 2π)，基准再往回挪 1e-9，
 * 免得首点自己被浮点误差甩到 2π 那头去。
 */
function stitchRings(points, outerRing, innerRing, emit) {
  const TAU = Math.PI * 2;

  // 中心取外环的包围盒中心：边采样各边点数不同，算术平均不一定落在正中
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const idx of outerRing) {
    const p = points[idx];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const first = points[outerRing[0]];
  const base = Math.atan2(first.y - cy, first.x - cx) - 1e-9;
  const uOf = (idx) => {
    const p = points[idx];
    let a = (Math.atan2(p.y - cy, p.x - cx) - base) % TAU;
    if (a < 0) a += TAU;
    return a;
  };

  // 环本身是按角度单调排的，这里只是保证从最小角起步（防浮点把首点甩到尾部）
  const rotateToMin = (ring) => {
    let m = 0;
    let best = uOf(ring[0]);
    for (let k = 1; k < ring.length; k++) {
      const u = uOf(ring[k]);
      if (u < best) {
        best = u;
        m = k;
      }
    }
    return ring.slice(m).concat(ring.slice(0, m));
  };

  const O = rotateToMin(outerRing);
  const I = rotateToMin(innerRing);
  const uO = O.map(uOf);
  const uI = I.map(uOf);

  // 走完一圈：每次推进一个指针，正好 O.length + I.length 个三角。
  // 指针走到 length 表示这个环已经绕回起点，取模拿回首点收尾。
  let oi = 0;
  let ii = 0;
  while (oi < O.length || ii < I.length) {
    const nO = oi >= O.length ? Infinity : (oi + 1 < O.length ? uO[oi + 1] : TAU);
    const nI = ii >= I.length ? Infinity : (ii + 1 < I.length ? uI[ii + 1] : TAU);
    const curO = O[oi % O.length];
    const curI = I[ii % I.length];
    if (nO <= nI) {
      emit(curO, O[(oi + 1) % O.length], curI);   // 外环一条边 + 内环一个点
      oi++;
    } else {
      emit(curO, curI, I[(ii + 1) % I.length]);   // 内环一条边 + 外环一个点
      ii++;
    }
  }
}

/**
 * 判断一个部件是否需要蒙皮。
 * 根部件没有父级可混合，单独一片的区域混合也没意义，
 * 这两种情况直接返回 null，省掉无谓的顶点数据。
 */
export function shouldSkin(part, parentPart) {
  if (!part.bbox) return false;
  if (!parentPart?.bbox) return false;
  return true;
}

export { MAX_INFLUENCES };
