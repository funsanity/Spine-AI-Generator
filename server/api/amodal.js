/**
 * 完整部件合成：让模型把部件单独画完整，我们只取被挡住的那部分。
 *
 * 为什么这么做（2026-11-02 实测 kkk）：
 *   - 模型其实能把 body 画成参考图那样一件完整的上衣，披风底下的肩颈都补上了；
 *     从它的白底沿图边泛洪抠掉，就是干净完整的轮廓。
 *   - 旧流程不信模型：被挡区按「遮挡者盖住的范围」整块填实（形状成了披风形状的鼓包），
 *     再由守卫判「近白太多」整块铺成四周均色（body 16867px 里 16849px 被平涂）。
 *   - 模型输出从没和原图对齐过：整体偏约 11px、横向多拉伸 0.8%，
 *     直接贴回去平均色差 31.6，配准后 14.7。
 *
 * 所有函数都在「画布」坐标上工作：画布 = 部件窗口四周外扩 15%（cutter 的 hiddenBox），
 * 可见像素按它在源图上的位置放进画布。
 */

const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/*
 * 白底判据：三通道 ≥232 且通道差 ≤14。body 实测：模型背景是 (245~255) 的近白，
 * 带一点 JPEG 式的脏；部件自己的白内衬在轮廓线里面，泛洪进不去。
 */
const BG_MIN = 232;
const BG_SPREAD = 14;

/** 从图边泛洪抠掉近白背景，返回 alpha（0/255） */
export function keyWhiteBackground(rgb, w, h) {
  const n = w * h;
  const bg = new Uint8Array(n);
  const isBg = (i) => {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    return Math.min(r, g, b) >= BG_MIN && Math.max(r, g, b) - Math.min(r, g, b) <= BG_SPREAD;
  };
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (bg[i] || !isBg(i)) continue;
    bg[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = bg[i] ? 0 : 255;
  return alpha;
}

/*
 * 白边还原。
 *
 * 模型按自己的档位出图（1000~1600px），缩回部件大小后，轮廓外一两圈是「部件色 + 白底」
 * 的混色。keyWhiteBackground 是 0/255 判的，这圈留成全不透明、颜色偏白，拼到深色上就是
 * 一圈浅色白边（2026-11-03 实测 boot_left 整件重画）。
 *
 * 贴着背景的两圈像素，按「里面的部件色 F」和「白」拆出比例 a：C = a·F + (1−a)·白，
 * alpha 取 a，颜色还原成 (C − (1−a)·白)/a。比白还暗的（描线）a>1，原样不动；
 * 部件自己接近白（白袖子，F 离白不到 SOFT_MIN_CONTRAST）拆不开，也不动，免得吃掉部件。
 */
const SOFT_MIN_CONTRAST = 40;
const SOFT_RING = 2;

/** @param {Buffer} rgb - 原地改颜色  @param {Uint8Array} alpha - 原地改透明度 */
export function softenWhiteEdge(rgb, alpha, w, h) {
  const n = w * h;
  // 到背景的距离：1 = 贴着背景，2 = 再往里一圈，0 = 更里面或背景本身
  const ring = new Uint8Array(n);
  let frontier = [];
  for (let i = 0; i < n; i++) if (!alpha[i]) frontier.push(i);
  for (let d = 1; d <= SOFT_RING; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!alpha[k] || ring[k]) continue;
        ring[k] = d;
        next.push(k);
      }
    }
    frontier = next;
  }
  const R = 3;
  const updates = [];
  for (let i = 0; i < n; i++) {
    if (!ring[i]) continue;
    const x = i % w, y = (i / w) | 0;
    let fr = 0, fg = 0, fb = 0, cnt = 0;
    for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
      for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
        const k = yy * w + xx;
        if (!alpha[k] || ring[k]) continue;
        fr += rgb[k * 3]; fg += rgb[k * 3 + 1]; fb += rgb[k * 3 + 2]; cnt++;
      }
    }
    if (!cnt) continue;
    const d = [255 - fr / cnt, 255 - fg / cnt, 255 - fb / cnt];
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (len2 < SOFT_MIN_CONTRAST * SOFT_MIN_CONTRAST) continue;
    const a = ((255 - rgb[i * 3]) * d[0] + (255 - rgb[i * 3 + 1]) * d[1] + (255 - rgb[i * 3 + 2]) * d[2]) / len2;
    if (a >= 1) continue;
    updates.push([i, a]);
  }
  for (const [i, a] of updates) {
    if (a < 0.05) { alpha[i] = 0; continue; }
    alpha[i] = Math.round(a * 255);
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(255 - (255 - rgb[i * 3 + c]) / a)));
  }
}

/** 取可见像素（alpha≥250）的采样点，均匀抽到约 target 个 */
function samplesOf(visible, target) {
  const { rgba, w, h } = visible;
  let total = 0;
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] >= 250) total++;
  const stride = Math.max(1, Math.round(total / target));
  const out = [];
  let k = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (rgba[i * 4 + 3] < 250) continue;
      if (k++ % stride) continue;
      out.push(x, y, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    }
  }
  return out;
}

/*
 * 搜索时缩放绕可见内容的重心做：画布 (x,y) → 模型 ((x−cx)·sx + Cx, (y−cy)·sy + Cy)。
 * 绕左上角缩放的话，改一点缩放远处的点就跟着挪，缩放和平移耦合，
 * 交替细化会卡在半路（合成测试解出 sx 2.535，真值 2.55）。
 */
function costAt(samples, model, cx, cy, sx, sy, Cx, Cy) {
  const { rgb, w, h } = model;
  let d = 0, n = 0;
  for (let k = 0; k < samples.length; k += 5) {
    const X = Math.round((samples[k] - cx) * sx + Cx), Y = Math.round((samples[k + 1] - cy) * sy + Cy);
    n++;
    // 落到模型画面外：按最大差记，免得搜索把可见内容整个推出画面来「躲」误差
    if (X < 0 || Y < 0 || X >= w || Y >= h) { d += 100; continue; }
    const j = (Y * w + X) * 3;
    d += (Math.abs(samples[k + 2] - rgb[j]) + Math.abs(samples[k + 3] - rgb[j + 1]) + Math.abs(samples[k + 4] - rgb[j + 2])) / 3;
  }
  return n ? d / n : Infinity;
}

/**
 * 把模型输出配准到画布：找画布 (x,y) → 模型 (x·sx+tx, y·sy+ty)。
 *
 * 模型会重画整张图，输出尺寸和请求不一致（实测请求 384x608、返回 997x1577），
 * 内容还会整体挪动、轻微变形。先按尺寸比例给初值，粗搜缩放 ±3.2%（步长 0.8%）
 * 和平移（模型像素，范围取 40 与长边 6% 的较大者），再交替细化平移（1px）和缩放（0.2%）。
 *
 * @returns {{sx, sy, tx, ty, cost}} cost = 可见像素上三通道平均绝对差
 */
export function registerModel(visible, model) {
  const sx0 = model.w / visible.w, sy0 = model.h / visible.h;
  // 采样数定死而不是按步长取：真实部件可见像素 10 万+，按步长取时 body 一次配准要 21s
  const coarse = samplesOf(visible, 2000);
  const fine = samplesOf(visible, 8000);
  let cx = 0, cy = 0;
  for (let k = 0; k < fine.length; k += 5) { cx += fine[k]; cy += fine[k + 1]; }
  cx /= Math.max(1, fine.length / 5); cy /= Math.max(1, fine.length / 5);
  const C0x = cx * sx0, C0y = cy * sy0;

  const R = Math.max(40, Math.round(Math.max(model.w, model.h) * 0.06));
  const step = Math.max(2, Math.round(R / 10));

  let best = { cost: Infinity };
  for (let ks = -4; ks <= 4; ks++) {
    for (let kt = -4; kt <= 4; kt++) {
      const sx = sx0 * (1 + ks * 0.008), sy = sy0 * (1 + kt * 0.008);
      for (let dx = -R; dx <= R; dx += step) {
        for (let dy = -R; dy <= R; dy += step) {
          const c = costAt(coarse, model, cx, cy, sx, sy, C0x + dx, C0y + dy);
          if (c < best.cost) best = { sx, sy, Cx: C0x + dx, Cy: C0y + dy, cost: c };
        }
      }
    }
  }

  // 细化：平移（±step，1px）和缩放（±0.8%，0.2%）交替各两轮
  best = { ...best, cost: costAt(fine, model, cx, cy, best.sx, best.sy, best.Cx, best.Cy) };
  for (let round = 0; round < 2; round++) {
    const b0 = best;
    for (let dx = -step; dx <= step; dx++) {
      for (let dy = -step; dy <= step; dy++) {
        const c = costAt(fine, model, cx, cy, b0.sx, b0.sy, b0.Cx + dx, b0.Cy + dy);
        if (c < best.cost) best = { ...best, Cx: b0.Cx + dx, Cy: b0.Cy + dy, cost: c };
      }
    }
    const b1 = best;
    for (let ks = -4; ks <= 4; ks++) {
      for (let kt = -4; kt <= 4; kt++) {
        const sx = b1.sx * (1 + ks * 0.002), sy = b1.sy * (1 + kt * 0.002);
        const c = costAt(fine, model, cx, cy, sx, sy, b1.Cx, b1.Cy);
        if (c < best.cost) best = { ...best, sx, sy, cost: c };
      }
    }
  }
  // 收尾一轮联合细化：缩放 ±0.4%（0.1%）× 平移 ±2px，交替搜索剩下的那点耦合在这里收掉
  const b2 = best;
  for (let ks = -4; ks <= 4; ks++) {
    for (let kt = -4; kt <= 4; kt++) {
      const sx = b2.sx * (1 + ks * 0.001), sy = b2.sy * (1 + kt * 0.001);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const c = costAt(fine, model, cx, cy, sx, sy, b2.Cx + dx, b2.Cy + dy);
          if (c < best.cost) best = { sx, sy, Cx: b2.Cx + dx, Cy: b2.Cy + dy, cost: c };
        }
      }
    }
  }
  return { sx: best.sx, sy: best.sy, tx: best.Cx - cx * best.sx, ty: best.Cy - cy * best.sy, cost: best.cost };
}

/** 按配准结果把模型输出双线性采样到画布，返回画布 RGBA */
export function warpModel(model, t, outW, outH) {
  const { rgb, alpha, w, h } = model;
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const X = x * t.sx + t.tx, Y = y * t.sy + t.ty;
      if (X < 0 || Y < 0 || X > w - 1 || Y > h - 1) continue;
      const X0 = Math.floor(X), Y0 = Math.floor(Y);
      const X1 = Math.min(w - 1, X0 + 1), Y1 = Math.min(h - 1, Y0 + 1);
      const fx = X - X0, fy = Y - Y0;
      const o = (y * outW + x) * 4;
      const wts = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      const idx = [Y0 * w + X0, Y0 * w + X1, Y1 * w + X0, Y1 * w + X1];
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += rgb[idx[k] * 3 + c] * wts[k];
        out[o + c] = Math.round(v);
      }
      let a = 0;
      for (let k = 0; k < 4; k++) a += alpha[idx[k]] * wts[k];
      out[o + 3] = Math.round(a);
    }
  }
  return out;
}

/** 到最近可见像素（alpha≥128）的切比雪夫距离，超过 limit 记 0（表示「远」） */
function distanceToVisible(visible, w, h, limit) {
  const dist = new Uint8Array(w * h);
  let frontier = [];
  for (let i = 0; i < w * h; i++) if (visible[i * 4 + 3] >= 128) frontier.push(i);
  const seen = new Uint8Array(w * h);
  for (const i of frontier) seen[i] = 1;
  for (let d = 1; d <= limit && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (seen[k]) continue;
        seen[k] = 1;
        dist[k] = d;
        next.push(k);
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * 合成：可见像素用源图（原样），被挡位置用配准后的模型像素（形状取模型轮廓），其余透明。
 *
 * 交界 band 像素内做颜色过渡：模型重画的颜色和源图有系统性偏差（整体偏暗、偏色），
 * 在可见区里两者都有，差值就是这块的偏差。把它按距离线性衰减地加到模型像素上：
 * 紧贴交界的一列拉到和源图一致，第 band+1 列起保持模型原色。只改模型一侧，
 * 可见像素一个不动——拼回原图必须逐像素一致。
 */
export function composeAmodal({ visible, hidden, model, w, h, band = 3 }) {
  const out = Buffer.alloc(w * h * 4);
  const dist = distanceToVisible(visible, w, h, band);
  const R = band + 2;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (visible[o + 3] >= 8) {
      out[o] = visible[o]; out[o + 1] = visible[o + 1]; out[o + 2] = visible[o + 2]; out[o + 3] = visible[o + 3];
      continue;
    }
    if (!hidden[i] || model[o + 3] < 8) continue;
    let r = model[o], g = model[o + 1], b = model[o + 2];
    const d = dist[i];
    if (d) {
      const wgt = Math.max(0, 1 - (d - 1) / band);
      if (wgt > 0) {
        const x = i % w, y = (i / w) | 0;
        let dr = 0, dg = 0, db = 0, n = 0;
        for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
          for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
            const k = (yy * w + xx) * 4;
            if (visible[k + 3] < 250 || model[k + 3] < 128) continue;
            dr += visible[k] - model[k]; dg += visible[k + 1] - model[k + 1]; db += visible[k + 2] - model[k + 2];
            n++;
          }
        }
        if (n) {
          r += (dr / n) * wgt; g += (dg / n) * wgt; b += (db / n) * wgt;
        }
      }
    }
    out[o] = Math.max(0, Math.min(255, Math.round(r)));
    out[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
    out[o + 3] = model[o + 3];
  }
  return out;
}

/** 质量门（设计 B.6）：配准色差、模型轮廓对可见像素的覆盖、洋红残留 */
/*
 * softMaxCost：没有一轮达到 maxCost 时，色差 ≤ 它且轮廓对得上的最好一轮照样用。
 * 色差量的是可见像素上模型和原图差多少——可见像素我们用原图，模型重画的五官略有出入
 * 也会把色差抬上去（2026-11-02 实测 head 第三轮 28.8，画得很好）。略差的模型画远好过兜底。
 */
export const QUALITY = { maxCost: 25, softMaxCost: 40, minCoverage: 0.9, maxMagenta: 0.005 };

export function scoreAmodal({ visible, modelWarped, hidden, w, h, cost }) {
  let vis = 0, covered = 0, hid = 0, magenta = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (visible[o + 3] >= 128) {
      vis++;
      if (modelWarped[o + 3] >= 128) covered++;
    }
    if (hidden[i] && modelWarped[o + 3] >= 128) {
      hid++;
      if (modelWarped[o] >= 180 && modelWarped[o + 1] <= 90 && modelWarped[o + 2] >= 180) magenta++;
    }
  }
  const coverage = vis ? covered / vis : 0;
  const magentaFrac = hid ? magenta / hid : 0;
  return {
    cost, coverage, magentaFrac,
    ok: cost <= QUALITY.maxCost && coverage >= QUALITY.minCoverage && magentaFrac <= QUALITY.maxMagenta,
    usable: cost <= QUALITY.softMaxCost && coverage >= QUALITY.minCoverage && magentaFrac <= QUALITY.maxMagenta
  };
}

/**
 * 兜底：模型补不出合格内容时，在补图区里用边缘颜色**平滑渐变**地填上。
 *
 * 用户 2026-11-02：「色块可以补，但是能不能光滑些，看起来区别不要那么大」。
 *
 * 填法是求区域内的「最平滑」插值（拉普拉斯方程：每个像素等于四邻的平均）：
 * 先用多尺度平均（金字塔推拉）给个粗略初值，再反复做四邻平均把它磨平。
 * 边上明暗交替（描边、发丝）在这种解里几个像素就衰减掉，不会往里传。
 *
 * 之前是一圈圈往里推、每圈取已填邻居的均色：每个边缘像素的颜色沿直线一路
 * 带进去，头发底下那片头（几万像素）被拉成放射状长条纹（用户 2026-11-02 实测）。
 */
export function fallbackFill({ visible, region, w, h, iterations = 400 }) {
  const out = Buffer.from(visible);
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (visible[i * 4 + 3] >= 128) known[i] = 1;

  // 金字塔推：每层存已知像素的颜色和与权重
  const levels = [];
  let lw = w, lh = h;
  let sum = new Float64Array(w * h * 3), wt = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) if (known[i]) {
    sum[i * 3] = visible[i * 4]; sum[i * 3 + 1] = visible[i * 4 + 1]; sum[i * 3 + 2] = visible[i * 4 + 2]; wt[i] = 1;
  }
  levels.push({ lw, lh, sum, wt });
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, Math.ceil(lw / 2)), nh = Math.max(1, Math.ceil(lh / 2));
    const ns = new Float64Array(nw * nh * 3), nwt = new Float64Array(nw * nh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const a = y * lw + x, b = (y >> 1) * nw + (x >> 1);
      ns[b * 3] += sum[a * 3]; ns[b * 3 + 1] += sum[a * 3 + 1]; ns[b * 3 + 2] += sum[a * 3 + 2]; nwt[b] += wt[a];
    }
    lw = nw; lh = nh; sum = ns; wt = nwt;
    levels.push({ lw, lh, sum, wt });
  }
  // 拉：从最粗一层往下，没有已知像素的格子取上一层的颜色
  let col = null;
  for (let L = levels.length - 1; L >= 0; L--) {
    const { lw: cw, lh: ch, sum: cs, wt: cwt } = levels[L];
    const c = new Float64Array(cw * ch * 3);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const k = y * cw + x;
      if (cwt[k] > 0) { c[k * 3] = cs[k * 3] / cwt[k]; c[k * 3 + 1] = cs[k * 3 + 1] / cwt[k]; c[k * 3 + 2] = cs[k * 3 + 2] / cwt[k]; }
      else if (col) {
        const pw = levels[L + 1].lw, p = (y >> 1) * pw + (x >> 1);
        c[k * 3] = col[p * 3]; c[k * 3 + 1] = col[p * 3 + 1]; c[k * 3 + 2] = col[p * 3 + 2];
      }
    }
    col = c;
  }

  // 磨平：区域内反复取四邻平均（已知像素固定不动，区域外的未知像素不参与）
  const cells = [];
  for (let i = 0; i < w * h; i++) if (region[i] && !known[i]) cells.push(i);
  const usable = (k) => known[k] || region[k];
  for (let it = 0; it < iterations; it++) {
    for (const i of cells) {
      const x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (const k of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (k < 0 || !usable(k)) continue;
        r += col[k * 3]; g += col[k * 3 + 1]; b += col[k * 3 + 2]; n++;
      }
      if (n) { col[i * 3] = r / n; col[i * 3 + 1] = g / n; col[i * 3 + 2] = b / n; }
    }
  }
  for (const i of cells) {
    out[i * 4] = Math.round(col[i * 3]); out[i * 4 + 1] = Math.round(col[i * 3 + 1]); out[i * 4 + 2] = Math.round(col[i * 3 + 2]);
    out[i * 4 + 3] = 255;
  }
  return out;
}
