/**
 * 钢笔路径切口：前层压在后层身上的那条切口，描成锚点 + 曲线再抗锯齿画回去。
 *
 * 归属表逐像素 0/1，切口是台阶和锯齿。这里做 Photoshop 钢笔那套：
 *   1. 等值线（marching squares）把切口描成闭合路径；
 *   2. 沿法线看源图亮度，有黑色描线就把路径点吸到描线外沿（磁性套索）——
 *      自己的描线被切给后层的往外推，描线外挂着邻件颜色的往回收；
 *   3. Ramer-Douglas-Peucker 抽锚点，Catmull-Rom 转三次贝塞尔；
 *   4. 栅格化成覆盖率，只改切口两侧几像素的 alpha。
 *
 * 锚点不让 AI 点：视觉模型给的坐标偏 10~30px，比像素掩码还粗。精度来自像素。
 * 对着透明背景的外轮廓不动——那是画师画好的过渡。
 * 被更靠前部件压着的切口也不动——它藏在前层底下。
 *
 * 平滑只往外长；往里收只发生在吸附处（去掉挂错的邻件颜色），露出来的是后层的补图。
 */
import sharp from 'sharp';

const BAND_R = 5;          // 只改切口两侧这么宽
const SNAP_REACH = 4.5;    // 沿法线最远看这么远（像素）
const INK_MAX_LUM = 110;   // 描线够黑
const INK_CONTRAST = 45;   // 且比两侧明显暗
const INK_MAX_RUN = 4;     // 再宽就不是描线，是深色块
const RDP_EPS = 0.6;
const MAX_SEG = 3;         // 锚点间最长这么远：长直段补点，Catmull-Rom 不会把拐角圆成一大团

const lumAt = (src, i) => (src[i * 4 + 3] < 8 ? 255 : 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2]);

/**
 * marching squares：M=0 区域（后层）的边界，坐标是像素中心系，闭环。
 * 窗口四周先按边缘值复制 PAD 圈、再外面一圈算 1：环一定闭合，
 * 而贴着窗口边的那几个拐角落在窗口外，平滑时圆掉的角不会啃进窗口。
 */
const PAD = 4;
function traceLoops(M, w0, h0) {
  const w = w0 + 2 * PAD, h = h0 + 2 * PAD;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 1
    : M[Math.min(h0 - 1, Math.max(0, y - PAD)) * w0 + Math.min(w0 - 1, Math.max(0, x - PAD))]);
  const segs = new Map();
  const key = (x, y) => y * (2 * w + 4) + x + 2 * (2 * w + 4) + 2;
  const add = (a, b) => { const k = key(a[0], a[1]); let e = segs.get(k); if (!e) segs.set(k, e = []); e.push(b); };
  const TABLE = { 1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['R', 'T']], 5: [['L', 'T'], ['R', 'B']], 6: [['B', 'T']], 7: [['L', 'T']], 8: [['T', 'L']], 9: [['T', 'B']], 10: [['T', 'R'], ['B', 'L']], 11: [['T', 'R']], 12: [['R', 'L']], 13: [['R', 'B']], 14: [['B', 'L']] };
  for (let y = -1; y < h; y++) for (let x = -1; x < w; x++) {
    const c = at(x, y) * 8 + at(x + 1, y) * 4 + at(x + 1, y + 1) * 2 + at(x, y + 1);
    const list = TABLE[c];
    if (!list) continue;
    const P = { T: [2 * x + 1, 2 * y], R: [2 * x + 2, 2 * y + 1], B: [2 * x + 1, 2 * y + 2], L: [2 * x, 2 * y + 1] };
    for (const [a, b] of list) add(P[a], P[b]);
  }
  const loops = [];
  for (const [k0, ends0] of segs) {
    while (ends0.length) {
      const loop = [];
      let cur = ends0.pop();
      let guard = 0;
      while (guard++ < 4 * w * h + 16) {
        loop.push([cur[0] / 2 - PAD, cur[1] / 2 - PAD]);
        const k = key(cur[0], cur[1]);
        if (k === k0 && loop.length > 1) break;
        const e = segs.get(k);
        if (!e || !e.length) break;
        cur = e.pop();
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

function markZone(zone, w, h, cx, cy, r) {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) zone[y * w + x] = 1;
  }
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len
      ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len
      : Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

/** 闭环抽锚点：拆两半各跑一遍，起点不会被当成必留的角；再把长段按 MAX_SEG 补点 */
function anchorsOf(loop) {
  if (loop.length < 8) return loop;
  const half = loop.length >> 1;
  const s = [...rdp(loop.slice(0, half + 1), RDP_EPS).slice(0, -1), ...rdp([...loop.slice(half), loop[0]], RDP_EPS).slice(0, -1)];
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const a = s[i], b = s[(i + 1) % s.length];
    const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / MAX_SEG);
    for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  return out;
}

function bezierPath(s) {
  const n = s.length;
  if (n < 3) return '';
  const f = (v) => v.toFixed(2);
  let d = `M${f(s[0][0])},${f(s[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = s[(i - 1 + n) % n], p1 = s[i], p2 = s[(i + 1) % n], p3 = s[(i + 2) % n];
    const t = 1 / 6;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) * t)},${f(p1[1] + (p2[1] - p0[1]) * t)} ${f(p2[0] - (p3[0] - p1[0]) * t)},${f(p2[1] - (p3[1] - p1[1]) * t)} ${f(p2[0])},${f(p2[1])}`;
  }
  return d + 'Z';
}

/**
 * 沿法线找描线，返回路径点该挪多少（正 = 往后层那边推）。找不到返回 0。
 * n 指向后层；samples 落在 t = ±0.5, ±1.5 … 的像素上。
 */
function snapOffset(p, n, src, w, h, mine, behind) {
  const pix = (t) => {
    const x = Math.round(p[0] + n[0] * t), y = Math.round(p[1] + n[1] * t);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
  };
  const ts = [];
  for (let t = -SNAP_REACH; t <= SNAP_REACH + 1e-6; t += 1) ts.push(t);
  const idx = ts.map(pix);
  if (idx.some((i) => i < 0)) return 0;
  const lum = idx.map((i) => lumAt(src, i));
  const ref = Math.max(lum[0], lum[1], lum[lum.length - 1], lum[lum.length - 2]);
  const ink = lum.map((l) => l < INK_MAX_LUM && l < ref - INK_CONTRAST);
  // 描线段：连续的 ink，两头都得落在采样范围内（碰到边说明是深色块，不是线）
  const runs = [];
  for (let k = 0; k < ink.length; k++) {
    if (!ink[k]) continue;
    let e = k;
    while (e + 1 < ink.length && ink[e + 1]) e++;
    if (k > 0 && e < ink.length - 1 && e - k + 1 <= INK_MAX_RUN) runs.push([k, e]);
    k = e;
  }
  if (!runs.length) return 0;
  const mid = ts.length / 2;   // ts[mid-1] = -0.5, ts[mid] = +0.5
  const best = runs.reduce((a, r) => (Math.min(Math.abs(ts[r[0]]), Math.abs(ts[r[1]])) < Math.min(Math.abs(ts[a[0]]), Math.abs(ts[a[1]])) ? r : a));
  const [s, e] = best;
  if (s >= mid) {
    // 描线在后层那边：只有紧贴切口（中间没夹着后层颜色）才是被切走的自己的描线
    if (s !== mid || !behind[idx[s]]) return 0;
    return ts[e] + 0.5;
  }
  if (e < mid - 1) {
    // 描线在自己这边，外面还挂着一条：那条得是后层的颜色，才往回收
    const out = idx[ts.length - 1], inn = idx[0];
    for (let k = e + 1; k < mid; k++) {
      const i = idx[k];
      if (!mine[i]) return 0;
      let dOut = 0, dIn = 0;
      for (let c = 0; c < 3; c++) {
        dOut += (src[i * 4 + c] - src[out * 4 + c]) ** 2;
        dIn += (src[i * 4 + c] - src[inn * 4 + c]) ** 2;
      }
      if (dOut >= dIn) return 0;
    }
    return ts[e] + 0.5;
  }
  // 切口正好在描线中间：推到外沿
  return ts[e] + 0.5;
}

/**
 * 描出本部件压着后层的那条切口，可选吸附到描线，返回闭合路径。
 * 路径围的是后层区域：切口只出现在自己和后层之间，透明背景、前层那几条边
 * 都不在路径上。覆盖率取反就是本部件的。
 */
function buildPaths(mine, behind, src, w, h, snap) {
  const N = w * h;
  const band = new Uint8Array(N);
  let edges = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mine[i]) continue;
    if (!((x > 0 && behind[i - 1]) || (x < w - 1 && behind[i + 1]) || (y > 0 && behind[i - w]) || (y < h - 1 && behind[i + w]))) continue;
    edges++;
    for (let dy = -BAND_R; dy <= BAND_R; dy++) for (let dx = -BAND_R; dx <= BAND_R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) band[ny * w + nx] = 1;
    }
  }
  const snapZone = new Uint8Array(N);   // 吸附挪过的那几段附近
  if (!edges) return { edges, band, snapZone, paths: [], anchors: 0, snapped: 0 };

  const M = new Uint8Array(N);
  for (let i = 0; i < N; i++) M[i] = behind[i] ? 0 : 1;
  const loops = traceLoops(M, w, h);

  let anchors = 0, snapped = 0;
  const paths = [];
  for (const loop of loops) {
    const n = loop.length;
    if (snap && n >= 8) {
      const offs = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const a = loop[(k - 2 + n) % n], b = loop[(k + 2) % n];
        let tx = b[0] - a[0], ty = b[1] - a[1];
        const len = Math.hypot(tx, ty);
        if (!len) continue;
        tx /= len; ty /= len;
        let nrm = [-ty, tx];
        const p = loop[k];
        const side = (sg) => {
          const x = Math.round(p[0] + nrm[0] * 0.7 * sg), y = Math.round(p[1] + nrm[1] * 0.7 * sg);
          return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
        };
        let o = side(1), iIn = side(-1);
        if (o >= 0 && !behind[o]) { nrm = [-nrm[0], -nrm[1]]; [o, iIn] = [iIn, o]; }
        if (o < 0 || iIn < 0 || !behind[o] || !mine[iIn]) continue;
        offs[k] = snapOffset(p, nrm, src, w, h, mine, behind);
        loop[k] = [p[0], p[1], nrm[0], nrm[1]];
      }
      // 吸附量沿路径做中值 + 均值，单点误判不会拉出尖刺
      const med = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const win = [];
        for (let d = -2; d <= 2; d++) win.push(offs[(k + d + n) % n]);
        win.sort((x, y) => x - y);
        med[k] = win[2];
      }
      for (let k = 0; k < n; k++) {
        const v = (med[(k - 1 + n) % n] + med[k] + med[(k + 1) % n]) / 3;
        if (Math.abs(v) >= 0.25 && loop[k].length === 4) {
          snapped++;
          markZone(snapZone, w, h, loop[k][0], loop[k][1], Math.abs(v) + 2);
          loop[k] = [loop[k][0] + loop[k][2] * v, loop[k][1] + loop[k][3] * v];
        } else loop[k] = [loop[k][0], loop[k][1]];
      }
    }
    const pts = anchorsOf(loop.map((p) => [p[0], p[1]]));
    anchors += pts.length;
    if (pts.length >= 3) paths.push(pts.length >= 4 ? bezierPath(pts) : `M${pts.map((p) => p.join(',')).join(' L')}Z`);
  }
  return { edges, band, snapZone, paths, anchors, snapped };
}

/** 路径栅格化成「本部件覆盖率」0..255 */
async function mineCoverage(paths, w, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g transform="translate(0.5,0.5)"><path d="${paths.join(' ')}" fill="#fff" fill-rule="evenodd"/></g></svg>`;
  const cov = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer();
  for (let i = 0; i < cov.length; i++) cov[i] = 255 - cov[i];
  return cov;
}

/**
 * 切图阶段：切口抗锯齿画回去。
 *
 * @param {Buffer} buf - 本部件已切好的 RGBA（窗口坐标）
 * @param {Uint8Array} mine - 1 = 归本部件
 * @param {Uint8Array} behind - 1 = 源图不透明、归一个更靠后的部件
 * @param {Buffer} src - 窗口内的源图 RGBA
 * @param {{snap?: boolean}} [opts] - snap=false：吸附已经在归属表上做过（snapOwnership），这里只平滑
 * @returns {Promise<{buf: Buffer, anchors: number, snapped: number}>} 新缓冲，原缓冲不变
 */
export async function penEdge(buf, width, height, mine, behind, src, opts = {}) {
  const w = width, h = height, N = w * h;
  const { edges, band, snapZone, paths, anchors, snapped } = buildPaths(mine, behind, src, w, h, opts.snap !== false);
  if (!edges) return { buf: Buffer.from(buf), anchors: 0, snapped: 0 };
  const cov = await mineCoverage(paths, w, h);

  const out = Buffer.from(buf);
  for (let i = 0; i < N; i++) {
    if (!band[i] || !(mine[i] || behind[i])) continue;
    const c = cov[i] / 255;
    if (mine[i]) {
      // 只往外扩、不往里收：往里收那格要靠后层补图盖住，补得不实就露底
      // （实测 kkk 新增露底 374 格）。只有吸到描线、要去掉挂错的邻件颜色时才收
      if (snapZone[i]) out[i * 4 + 3] = Math.round(buf[i * 4 + 3] * c);
    } else {
      // 没吸附的地方，源图自带画师的过渡：按颜色拆出来的羽化比几何覆盖率准，取大的。
      // 吸附过的地方原切口已经作废，原来那圈羽化留着就是一道鬼影
      const a = Math.round(src[i * 4 + 3] * c);
      if (!snapZone[i] && buf[i * 4 + 3] >= a) continue;
      if (a > 0) { out[i * 4] = src[i * 4]; out[i * 4 + 1] = src[i * 4 + 1]; out[i * 4 + 2] = src[i * 4 + 2]; }
      out[i * 4 + 3] = a;
    }
  }
  return { buf: dropSplitPieces(buf, out, w, h), anchors, snapped };
}

const OWN_PAD = 8;

/**
 * 归属表阶段的吸附（磁性套索）：前层切口吸到描线外沿，改的是「谁拥有这格」。
 *
 * 不在切好的图层上改 alpha：往里收的格子在图层里变透明，要靠后层补图去盖，
 * 模型没把后层画到那里就露一道细线（实测护膝边上）。改判给后层，后层拿到的是
 * 源图原样、不透明，拼回去和源图一致；描线改判回前层，前层本来就盖在上面。
 *
 * 前层先处理：它的切口定了，后面的部件看到的已经是改过的归属。
 *
 * @param {Array<string|null>} ownerOf - 整图归属表，原地改
 * @param {Buffer} rgba - 整图源图 RGBA
 * @param {Map<string, number>} depthOf
 * @returns {Promise<{toBehind: number, toFront: number}>}
 */
export async function snapOwnership(ownerOf, rgba, W, H, depthOf) {
  const boxes = new Map();
  for (let i = 0; i < W * H; i++) {
    const o = ownerOf[i];
    if (o === null || o === undefined) continue;
    const x = i % W, y = (i / W) | 0;
    const b = boxes.get(o);
    if (!b) boxes.set(o, [x, y, x, y]);
    else { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  }
  const depth = (n) => depthOf.get(n) ?? 0;
  const names = [...boxes.keys()].sort((a, b) => depth(b) - depth(a));
  let toBehind = 0, toFront = 0;
  for (const name of names) {
    const [bx0, by0, bx1, by1] = boxes.get(name);
    const x0 = Math.max(0, bx0 - OWN_PAD), y0 = Math.max(0, by0 - OWN_PAD);
    const x1 = Math.min(W, bx1 + 1 + OWN_PAD), y1 = Math.min(H, by1 + 1 + OWN_PAD);
    const w = x1 - x0, h = y1 - y0, N = w * h;
    const mine = new Uint8Array(N), behind = new Uint8Array(N);
    const src = Buffer.alloc(N * 4);
    const myDepth = depth(name);
    let anyBehind = false;
    for (let y = 0; y < h; y++) {
      rgba.copy(src, y * w * 4, ((y + y0) * W + x0) * 4, ((y + y0) * W + x1) * 4);
      for (let x = 0; x < w; x++) {
        const si = (y + y0) * W + x + x0, o = ownerOf[si];
        if (o === name) mine[y * w + x] = 1;
        else if (o !== null && o !== undefined && rgba[si * 4 + 3] >= 8 && depth(o) < myDepth) { behind[y * w + x] = 1; anyBehind = true; }
      }
    }
    if (!anyBehind) continue;
    const { paths, snapZone, snapped } = buildPaths(mine, behind, src, w, h, true);
    if (!snapped) continue;
    const cov = await mineCoverage(paths, w, h);
    const changes = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!snapZone[i]) continue;
      if (mine[i] && cov[i] < 128) {
        // 交给最近的后层邻居（5x5 里出现最多的那个）
        const votes = new Map();
        for (let r = 1; r <= 3 && !votes.size; r++) {
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !behind[ny * w + nx]) continue;
            const o = ownerOf[(ny + y0) * W + nx + x0];
            votes.set(o, (votes.get(o) ?? 0) + 1);
          }
        }
        if (!votes.size) continue;
        const to = [...votes].sort((a, b) => b[1] - a[1])[0][0];
        changes.push([(y + y0) * W + x + x0, to]);
        toBehind++;
      } else if (behind[i] && cov[i] >= 128) {
        changes.push([(y + y0) * W + x + x0, name]);
        toFront++;
      }
    }
    for (const [si, to] of changes) ownerOf[si] = to;
  }
  return { toBehind, toFront };
}

const SPLIT_SMALL_PX = 200;
const SPLIT_SMALL_FRAC = 0.05;

function components(buf, w, h) {
  const lab = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const q = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] >= 0 || buf[s * 4 + 3] < 32) continue;
    const id = sizes.length;
    lab[s] = id; q.push(s);
    let n = 0;
    while (q.length) {
      const i = q.pop(); n++;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (lab[j] < 0 && buf[j * 4 + 3] >= 32) { lab[j] = id; q.push(j); }
      }
    }
    sizes.push(n);
  }
  return { lab, sizes };
}

/**
 * 平滑会削掉 1px 的细桥，桥那头的东西就成了孤立碎片（实测靴子边一条描线 80px）。
 * 原来连成一块、现在断开的：小块（线头）扔掉；大块说明削过头了，整块恢复原样。
 *
 * @param {Buffer} before - 钢笔之前
 * @param {Buffer} after - 钢笔之后
 * @returns {Buffer} after 本身（原地改）
 */
export function dropSplitPieces(before, after, w, h) {
  const B = components(before, w, h), A = components(after, w, h);
  // after 的每块挂到 before 里它所在的那块
  const parentOf = new Int32Array(A.sizes.length).fill(-1);
  for (let i = 0; i < w * h; i++) {
    const a = A.lab[i];
    if (a >= 0 && parentOf[a] < 0 && B.lab[i] >= 0) parentOf[a] = B.lab[i];
  }
  const kids = new Map();
  parentOf.forEach((p, a) => { if (p >= 0) (kids.get(p) ?? kids.set(p, []).get(p)).push(a); });
  const drop = new Set(), restore = new Set();
  for (const [p, list] of kids) {
    if (list.length < 2) continue;
    list.sort((x, y) => A.sizes[y] - A.sizes[x]);
    for (const a of list.slice(1)) {
      if (A.sizes[a] <= SPLIT_SMALL_PX && A.sizes[a] < SPLIT_SMALL_FRAC * B.sizes[p]) drop.add(a);
      else restore.add(p);
    }
  }
  if (!drop.size && !restore.size) return after;
  for (let i = 0; i < w * h; i++) {
    if (restore.has(B.lab[i])) { before.copy(after, i * 4, i * 4, i * 4 + 4); continue; }
    const a = A.lab[i];
    if (a >= 0 && drop.has(a) && !restore.has(parentOf[a])) after.fill(0, i * 4, i * 4 + 4);
  }
  return after;
}
