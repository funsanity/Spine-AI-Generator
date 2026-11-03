/**
 * 归属表清理：把孤岛和 1px 线头改判给真正的主人。
 *
 * 归属表（cutter.js 的 ownerOf）是 SAM 掩码、多边形、框认领、连通认领四遍叠出来的，
 * 每一遍都有自己的边角误差，叠完在部件边界上留下一堆边角料。实测 kkk 基线：
 * cape 主体之外还有 9 块碎片（1337px），body 里夹着披风的深绿碎片，
 * 全部部件合计 185 个 1px 线头——就是用户截图里圈出来的「边边角角」。
 * 这些像素在源图上画的是邻件的内容，跟错了骨头，一动就成了飘着的碎屑。
 *
 * 两条规则，都只在「挨着别的部件」时才改判：
 *   - 线头：1px 宽（左右都不是自己，或上下都不是自己）。
 *     不用 3x3 开运算：它连 2px 的发丝都会削掉。
 *   - 孤岛：8 邻接连通块里，面积不到最大块 15% 的小块。
 *     阈值 15% 是为了放过「被前层隔成两段」的部件（被手臂隔开的披风两片）。
 *
 * 只挨着空白（null）的线头和孤岛**留着**：那是源图里本来就独立存在的内容
 * （一缕分开的发丝、轮廓描边），改判成 null 就直接丢了——底板只在
 * 无主像素超过 0.5% 时才铺，这点零碎接不住。
 */

const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** 8 邻域里出现最多的「别的部件」（不含自己、不含 null）；没有就返回 undefined */
function majorityOther(ownerOf, width, height, x, y, self) {
  const votes = new Map();
  for (const [dx, dy] of N8) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const o = ownerOf[ny * width + nx];
    if (o === null || o === self) continue;
    votes.set(o, (votes.get(o) ?? 0) + 1);
  }
  let best, bestN = 0;
  for (const [o, n] of votes) if (n > bestN || (n === bestN && o < best)) { best = o; bestN = n; }
  return best;
}

function removeHairs(ownerOf, width, height, moved) {
  const changes = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? null : ownerOf[y * width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const me = ownerOf[y * width + x];
      if (me === null) continue;
      const thinH = at(x - 1, y) !== me && at(x + 1, y) !== me;
      const thinV = at(x, y - 1) !== me && at(x, y + 1) !== me;
      if (!thinH && !thinV) continue;
      const to = majorityOther(ownerOf, width, height, x, y, me);
      if (to !== undefined) changes.push([y * width + x, me, to]);
    }
  }
  /*
   * 整个部件本来就是 1px 线条画的（细框眼镜）：它的像素几乎全符合线头判据，
   * 照判就把这个部件清空了。线头占自己一半以上的部件不清。
   */
  const total = new Map(), thin = new Map();
  for (const o of ownerOf) if (o !== null) total.set(o, (total.get(o) ?? 0) + 1);
  for (const [, me] of changes) thin.set(me, (thin.get(me) ?? 0) + 1);
  const kept = changes.filter(([, me]) => thin.get(me) <= total.get(me) * 0.5);
  // 先收集再写：边扫边改会让同一条线的后半截看到已改判的前半截，判据跟着变
  for (const [i, , to] of kept) ownerOf[i] = to;
  for (const [, , to] of kept) moved.set(to, (moved.get(to) ?? 0) + 1);
  return kept.length;
}

/** 颜色量化到 8x8x8 = 512 档 */
const bin = (rgba, i) => ((rgba[i * 4] >> 5) << 6) | ((rgba[i * 4 + 1] >> 5) << 3) | (rgba[i * 4 + 2] >> 5);

/** 一组像素的颜色分布（归一化直方图） */
function histogram(rgba, pixels) {
  const h = new Float64Array(512);
  for (const i of pixels) h[bin(rgba, i)]++;
  const n = Math.max(1, pixels.length);
  for (let k = 0; k < 512; k++) h[k] /= n;
  return h;
}

/** 孤岛的像素颜色在这个分布里平均有多常见 */
function affinity(rgba, pixels, hist) {
  let s = 0;
  for (const i of pixels) s += hist[bin(rgba, i)];
  return s / Math.max(1, pixels.length);
}

/*
 * 大孤岛要看颜色才改判。
 *
 * 只按「挨着谁多」判会误伤：实测 kkk，披风绕过脖子露在右肩的那截领子
 * （2822px，主体的 10%）被手臂和身体隔开，挨着 body 最多，于是被判给了 body——
 * 可它画的是墨绿披风。碎屑（别人的描边、手臂的一弧皮肤）颜色像邻居，领子像自己。
 *
 * 比的是**颜色分布**而不是均色：均色在这里分不开——披风主体混着浅色镶边，
 * 均值被拉亮到 (85,92,79)；body 贴着领子那圈是暗描边和阴影 (41,51,47)，
 * 反而离领子 (49,66,66) 更近。分布看的是「领子这些颜色在谁身上常见」，
 * 墨绿在披风上大片都是，在黄上衣上几乎没有。
 *
 * 50px 以下的不看颜色：太小的块分布不稳，而且它们几乎都是描边碎屑。
 */
const COLOR_CHECK_MIN_PX = 50;

function removeIslands(ownerOf, width, height, minIslandFrac, moved, islands, rgba) {
  const n = width * height;
  const label = new Int32Array(n).fill(-1);
  const comps = [];   // { owner, pixels: number[] }
  for (let s = 0; s < n; s++) {
    if (ownerOf[s] === null || label[s] >= 0) continue;
    const owner = ownerOf[s];
    const id = comps.length;
    const pixels = [];
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const i = stack.pop();
      pixels.push(i);
      const x = i % width, y = (i / width) | 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const k = ny * width + nx;
        if (label[k] < 0 && ownerOf[k] === owner) { label[k] = id; stack.push(k); }
      }
    }
    comps.push({ owner, pixels });
  }

  const largest = new Map();
  const mainComp = new Map();
  for (const c of comps) {
    if (c.pixels.length > (largest.get(c.owner) ?? 0)) { largest.set(c.owner, c.pixels.length); mainComp.set(c.owner, c); }
  }
  const hists = new Map();

  let total = 0;
  for (const c of comps) {
    if (c.pixels.length >= largest.get(c.owner) * minIslandFrac) continue;
    // 数这块边界外挨着谁：每个外部邻居像素记一票
    const votes = new Map();
    for (const i of c.pixels) {
      const x = i % width, y = (i / width) | 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const o = ownerOf[ny * width + nx];
        if (o === null || o === c.owner) continue;
        votes.set(o, (votes.get(o) ?? 0) + 1);
      }
    }
    let to, best = 0;
    for (const [o, v] of votes) if (v > best || (v === best && o < to)) { to = o; best = v; }
    if (to === undefined) continue;

    if (rgba && c.pixels.length >= COLOR_CHECK_MIN_PX) {
      for (const o of [c.owner, to]) if (!hists.has(o)) hists.set(o, histogram(rgba, mainComp.get(o)?.pixels ?? []));
      if (affinity(rgba, c.pixels, hists.get(c.owner)) >= affinity(rgba, c.pixels, hists.get(to))) continue;
    }

    for (const i of c.pixels) ownerOf[i] = to;
    islands.push({ from: c.owner, to, px: c.pixels.length, ofLargest: +(c.pixels.length / largest.get(c.owner)).toFixed(3) });
    moved.set(to, (moved.get(to) ?? 0) + c.pixels.length);
    total += c.pixels.length;
  }
  return total;
}

/*
 * 挂错的邻件边：颜色像邻件、贴着邻件的窄条，还给邻件。
 *
 * 2026-11-02 用户截图：upper_arm_right 右上角两条橙线，是上衣短袖下摆的黄边——
 * 下摆压在白袖子上沿，切口偏了几个像素。一条贴着袖子上沿（2-4px 宽的带子），
 * 一条从袖子上伸出去卷进上衣（细凸起）。都连着手臂主体，不是孤岛；比 1px 宽，不是线头。
 *
 * 做法：从挨着邻件 B 的像素出发，只穿过「颜色像 B 远多于像自己」的像素往里长，
 * 且只能长在离 B ≤4px 的边带里，或窄于 5px 的凸起里（5x5 开运算开掉的部分）。
 * 限范围是因为模板让袖子归手臂：手臂上那截黄短袖颜色和上衣一样，
 * 不限的话整截袖子都会被吸回上衣；限了最多削掉交界处 4px。
 * 描边、阴影这种两边都有的暗色分不出「更像谁」，不动。
 */
const BAND_PX = 4;
/*
 * 前层的外发光、投影、描边外沿是画在后层上的，比切口误差宽得多：
 * 2026-11-03 结算图 Complete 那行字，横幅上像字的像素一直延到离字 12px，13px 起回到底噪。
 * 只有「后层身上像前层」这个方向放宽——反方向是前层挂了后层的边，那仍是切口误差。
 */
const HALO_BAND_PX = 24;
const HALO_MIN_CORE = 0.25;
const SPUR_R = 2;
const SPUR_MIN_PX = 6;
const FOREIGN_RATIO = 2;
// 实测分界：该吸回的 6.7-7.6%，自己的黄短袖 13.7%（见 foreignShare）
const OWN_COLOR_MAX = 0.1;

function openMask(mask, w, h, r) {
  const pass = (src, horizontal, isMax) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
        const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
        v = isMax ? (s > v ? s : v) : (s < v ? s : v);
      }
      out[y * w + x] = v;
    }
    return out;
  };
  const eroded = pass(pass(mask, true, false), false, false);
  return pass(pass(eroded, true, true), false, true);
}

function removeForeignEdges(ownerOf, width, height, moved, rgba, edges, depthOf) {
  const boxes = new Map();
  for (let i = 0; i < ownerOf.length; i++) {
    const o = ownerOf[i];
    if (o === null) continue;
    const x = i % width, y = (i / width) | 0;
    const b = boxes.get(o);
    if (!b) boxes.set(o, { x0: x, y0: y, x1: x, y1: y });
    else { if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; }
  }
  /*
   * 本来面目不到自己 1/4 的（整个部件都贴着前层的小件）分布不可靠，照旧只按 4px 带子处理，
   * 不然一个小件身上凡是像前层的颜色都会被吸走。
   */
  const sizes = new Map();
  for (const o of ownerOf) if (o !== null) sizes.set(o, (sizes.get(o) ?? 0) + 1);
  const isHalo = (own, other) => !!depthOf && (depthOf.get(other) ?? 0) > (depthOf.get(own) ?? 0)
    && coreOf(own).length >= (sizes.get(own) ?? 0) * HALO_MIN_CORE;
  /*
   * 后层的「本来面目」：离任何前层超过 HALO_BAND_PX 的那些像素。
   * 前层的发光挂在后层上时，按后层全部像素算分布，挂着的发光色也算进了「自己常见」——
   * 结算图横幅上几行字的蓝边加起来上万像素，字的蓝色在横幅分布里就不稀罕了，2 倍判据过不去。
   * 只在后层对前层这个方向用；其余方向照旧按全部像素算。
   */
  const cores = new Map();
  const coreOf = (o) => {
    if (cores.has(o)) return cores.get(o);
    const d0 = depthOf.get(o) ?? 0;
    const near = new Uint8Array(ownerOf.length);
    let frontier = [];
    for (let i = 0; i < ownerOf.length; i++) {
      const n = ownerOf[i];
      if (n === null || n === o || (depthOf.get(n) ?? 0) <= d0) continue;
      frontier.push(i);
    }
    for (let d = 0; d < HALO_BAND_PX && frontier.length; d++) {
      const next = [];
      for (const i of frontier) {
        const x = i % width, y = (i / width) | 0;
        for (const [dx, dy] of N8) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const k = ny * width + nx;
          if (ownerOf[k] === o && !near[k]) { near[k] = 1; next.push(k); }
        }
      }
      frontier = next;
    }
    const px = [];
    for (let i = 0; i < ownerOf.length; i++) if (ownerOf[i] === o && !near[i]) px.push(i);
    cores.set(o, px);
    return px;
  };
  const hists = new Map();
  const histOf = (o, core = false) => {
    const key = core ? `${o}\0core` : o;
    if (!hists.has(key)) {
      let px = core ? coreOf(o) : null;
      if (!px) {
        px = [];
        for (let i = 0; i < ownerOf.length; i++) if (ownerOf[i] === o) px.push(i);
      }
      hists.set(key, histogram(rgba, px));
    }
    return hists.get(key);
  };
  const ratioOk = (k, own, other) => {
    const pb = histOf(other)[k], pa = histOf(own, isHalo(own, other))[k];
    return pb > 0.002 && pb > pa * FOREIGN_RATIO;
  };
  /*
   * 自己身上有多少像素「颜色像 B」，只数亮色（最亮通道 ≥80）。kkk 实测：
   *   该吸回的：手臂上挂的上衣黄边 7.0%，披风上挂的脖子皮肤 6.7% / 7.6%
   *   不该吸的：模板让黄短袖归手臂，13.7%
   * 暗色不数：描边、腰带、阴影两边都大量有，算进来黄边那例被撑到 11.2%，和黄短袖分不开。
   * 不按色档邻域看：黄色暗部和肘部皮肤阴影挨着，一算就被皮肤撑大。
   * 后层对前层也只数本来面目那部分：挂着的发光本身不能算成「自己大片拥有」。
   */
  const shares = new Map();
  const foreignShare = (own, other) => {
    const key = `${own}→${other}`;
    if (!shares.has(key)) {
      const halo = isHalo(own, other);
      let n = 0, hit = 0;
      const count = (i) => {
        n++;
        if (Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) < 80) return;
        if (ratioOk(bin(rgba, i), own, other)) hit++;
      };
      if (halo) for (const i of coreOf(own)) count(i);
      else for (let i = 0; i < ownerOf.length; i++) if (ownerOf[i] === own) count(i);
      shares.set(key, n ? hit / n : 0);
    }
    return shares.get(key);
  };
  const bandOf = (own, other) => (isHalo(own, other) ? HALO_BAND_PX : BAND_PX);
  const looksLike = (i, own, other) => ratioOk(bin(rgba, i), own, other) && foreignShare(own, other) < OWN_COLOR_MAX;

  const changes = [];
  for (const [o, b] of boxes) {
    const pad = SPUR_R + 1;
    const bx = Math.max(0, b.x0 - pad), by = Math.max(0, b.y0 - pad);
    const bw = Math.min(width - 1, b.x1 + pad) - bx + 1, bh = Math.min(height - 1, b.y1 + pad) - by + 1;
    const mask = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) mask[y * bw + x] = ownerOf[(y + by) * width + x + bx] === o ? 1 : 0;
    const opened = openMask(mask, bw, bh, SPUR_R);
    const toLocal = (i) => ((((i / width) | 0) - by) * bw) + (i % width) - bx;

    // 种子：自己的像素，8 邻域挨着别的部件 B，且颜色像 B
    const claim = new Map();   // 全局下标 → 目标部件
    const depth = new Map();
    let frontier = [];
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
      const i = y * width + x;
      if (ownerOf[i] !== o) continue;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ownerOf[ny * width + nx];
        if (n === null || n === o) continue;
        if (looksLike(i, o, n)) { claim.set(i, n); depth.set(i, 1); frontier.push(i); }
        break;
      }
    }
    while (frontier.length) {
      const next = [];
      for (const i of frontier) {
        const to = claim.get(i), d = depth.get(i);
        const x = i % width, y = (i / width) | 0;
        for (const [dx, dy] of N8) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const k = ny * width + nx;
          if (ownerOf[k] !== o || claim.has(k)) continue;
          const spur = !opened[toLocal(k)];
          if (d + 1 > bandOf(o, to) && !spur) continue;
          if (!looksLike(k, o, to)) continue;
          claim.set(k, to); depth.set(k, d + 1); next.push(k);
        }
      }
      frontier = next;
    }
    // 太小的零星点（描边上的噪点）不动：按连通块数
    const seen = new Set();
    for (const s0 of claim.keys()) {
      if (seen.has(s0)) continue;
      const comp = [], stack = [s0];
      seen.add(s0);
      while (stack.length) {
        const i = stack.pop();
        comp.push(i);
        const x = i % width, y = (i / width) | 0;
        for (const [dx, dy] of N8) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const k = ny * width + nx;
          if (claim.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
        }
      }
      if (comp.length >= SPUR_MIN_PX) for (const i of comp) changes.push([i, claim.get(i), o]);
    }
  }
  const pairs = new Map();
  for (const [i, to, from] of changes) {
    ownerOf[i] = to;
    moved.set(to, (moved.get(to) ?? 0) + 1);
    const key = `${from}→${to}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  for (const [key, px] of pairs) { const [from, to] = key.split('→'); edges.push({ from, to, px }); }
  return changes.length;
}

/**
 * @param {Array<string|null>} ownerOf - 源图尺寸的归属表，原地修改
 * @param {object} [opts.rgba] - 源图 RGBA；给了才对大孤岛做颜色判断
 * @param {Map<string, number>} [opts.depthOf] - 部件深度（大的在前）；给了才把前层的发光/投影整圈还给前层
 * @returns {{ islandPx: number, hairPx: number, edgePx: number, edges: Array<{from,to,px}>, moved: Map<string, number>, islands: Array }}
 *   moved：每个部件因清理**新得到**的像素数；islands：每块被改判的孤岛 {from, to, px, ofLargest}
 */
export function cleanupOwnership(ownerOf, width, height, { minIslandFrac = 0.15, rgba = null, foreignEdges = true, depthOf = null } = {}) {
  const moved = new Map();
  // 先线头后孤岛：线头切断后，原来靠一根细线连着主体的小块才露出孤岛的真面目
  const hairPx = removeHairs(ownerOf, width, height, moved);
  const islands = [];
  const islandPx = removeIslands(ownerOf, width, height, minIslandFrac, moved, islands, rgba);
  // 挂错的邻件边只能靠颜色判，没给源图颜色就不做
  const edges = [];
  const edgePx = rgba && foreignEdges ? removeForeignEdges(ownerOf, width, height, moved, rgba, edges, depthOf) : 0;
  /*
   * 邻件边吸走后，带子里颜色判不出的那几颗（描边像素）会被孤立出来：再清一遍。
   * 这回先孤岛后线头：被孤立的那颗是 1px 孤岛；先跑线头的话，它下面刚吸走的那颗
   * 上下都是手臂、被判成竖线头还给手臂，两颗互换位置，碎点还在。
   */
  let hair2 = 0, island2 = 0;
  if (edgePx) {
    island2 = removeIslands(ownerOf, width, height, minIslandFrac, moved, islands, rgba);
    hair2 = removeHairs(ownerOf, width, height, moved);
  }
  return { islandPx: islandPx + island2, hairPx: hairPx + hair2, edgePx, edges, moved, islands };
}
