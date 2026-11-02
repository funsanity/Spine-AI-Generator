// 部件拆解对标图：左原图，右边每个部件一张卡片，按流程顺序排五格
//   归属蒙版 → 被擦除 → 被遮挡 → 模型补画 → 最终部件
// 五格按原图坐标对齐（同一张卡片里同一个比例尺），所以能直接看出补的那片落在哪。
//
// 用法：node scripts/parts-sheet.mjs <response.json> [原图] [输出]
//   response.json 是 /api/generate 的完整响应（或 temp/fullrun.mjs 写的那份），
//   要用里面 cutResults 的 maskBox / hiddenBox / bbox 定位每张图。
import sharp from 'sharp';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const respPath = process.argv[2];
const srcPath = process.argv[3] ?? 'test_assets/kkk.png';
const outPath = process.argv[4] ?? 'docs/images/parts-sheet.png';
if (!respPath) {
  console.error('用法：node scripts/parts-sheet.mjs <response.json> [原图] [输出]');
  process.exit(1);
}
const resp = JSON.parse(readFileSync(respPath, 'utf-8'));
const cuts = resp.cutResults.filter((c) => !c.name.startsWith('_'));

// ── 版式 ──
const BG = '#0d1017', CARD = '#161b24', LINE = '#2a3240', TEXT = '#e6e9ef', MUTED = '#7d8796';
const COLS = [
  { key: 'mask', label: '归属蒙版', sub: 'MASK', color: [94, 234, 212], desc: '切图时归这个部件的像素（看得见的那部分）' },
  { key: 'erased', label: '被擦除', sub: 'ERASED', color: [251, 146, 60], desc: '部件轮廓里被前面部件盖住、切掉的那片' },
  { key: 'hidden', label: '被遮挡', sub: 'HIDDEN', color: [232, 121, 249], desc: '外扩 15% 的画布里被前面部件占着的位置，补图只在这里用模型画的' },
  { key: 'model', label: '模型补画', sub: 'MODEL', desc: '模型画出的完整部件，已抠底并对齐到原图' },
  { key: 'part', label: '最终部件', sub: 'PART', desc: '可见像素 + 被遮挡处的模型补画，进骨骼的就是它' },
];
// README 里整图会被缩到约 1000px 宽（约 0.25 倍），字号按缩小后还能读来定
const PAD = 56, CW = 170, CH = 250, CGAP = 8, CARD_PAD = 14, HEAD_H = 54;
const CARD_W = CARD_PAD * 2 + COLS.length * CW + (COLS.length - 1) * CGAP;
const CARD_H = CARD_PAD * 2 + HEAD_H + CH;
// 四列等宽网格：第 0 列上面是原图、脚底是一栏卡片，第 1-3 列每行三张
// 列间距比行间距宽，原图和卡片之间的树干就画在第 0、1 列的空隙里
const GRID_COLS = 4, COL_GAP = 48, ROW_GAP = 18;
const TOP_ROWS = Math.min(4, Math.ceil(cuts.length / (GRID_COLS - 1)));
const topCuts = cuts.slice(0, TOP_ROWS * (GRID_COLS - 1));
const bottomCuts = cuts.slice(topCuts.length);
const TITLE_H = 100, COLHEAD_H = 60;
const colX = (c) => PAD + c * (CARD_W + COL_GAP);

const srcTop = PAD + TITLE_H;
const top = srcTop + COLHEAD_H;
const rowY = (r) => top + r * (CARD_H + ROW_GAP);
const rowEnd = rowY(TOP_ROWS) - ROW_GAP;
const bottomY = rowEnd + COLHEAD_H;
const W = colX(GRID_COLS) - COL_GAP + PAD;
const H = (bottomCuts.length ? bottomY + CARD_H : rowEnd) + PAD;

// 原图先裁掉四周空白，人物才不会占掉一大块宽度；高度跟右边四行卡片齐平
const srcTrim = await sharp(srcPath).trim({ threshold: 10 }).extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const srcMeta = await sharp(srcTrim).metadata();
const PANEL_H = rowEnd - srcTop;
let SRC_H = PANEL_H - 20, SRC_W = Math.round(srcMeta.width * SRC_H / srcMeta.height);
if (SRC_W > CARD_W - 20) { SRC_W = CARD_W - 20; SRC_H = Math.round(srcMeta.height * SRC_W / srcMeta.width); }
const source = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = `font-family="PingFang SC, Helvetica Neue, Arial, sans-serif"`;
const colorOf = (col) => (col.color ? `rgb(${col.color.join(',')})` : TEXT);

// ── 单元格图像：都画到这个部件的「联合窗口」U 上，再整体缩放 ──
async function loadRGBA(p) {
  const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
function unionBox(boxes) {
  const bs = boxes.filter(Boolean);
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.width)), y1 = Math.max(...bs.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
/** 在 U 画布上放一张图（box 是它在原图上的位置）；tint 给掩码上色，ghost 垫一层暗化的原图 */
function place(U, img, box, { tint, ghost } = {}) {
  const out = Buffer.alloc(U.width * U.height * 4);
  if (ghost) {
    for (let y = 0; y < U.height; y++) for (let x = 0; x < U.width; x++) {
      const sx = x + U.x, sy = y + U.y;
      if (sx < 0 || sy < 0 || sx >= source.info.width || sy >= source.info.height) continue;
      const si = (sy * source.info.width + sx) * 4, o = (y * U.width + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = source.data[si + k];
      out[o + 3] = Math.round(source.data[si + 3] * 0.22);
    }
  }
  if (img) {
    const ox = box.x - U.x, oy = box.y - U.y;
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      const cx = x + ox, cy = y + oy;
      if (cx < 0 || cy < 0 || cx >= U.width || cy >= U.height) continue;
      const i = (y * img.w + x) * 4, o = (cy * U.width + cx) * 4;
      const a = img.data[i + 3] / 255;
      if (!a) continue;
      const c = tint ?? [img.data[i], img.data[i + 1], img.data[i + 2]];
      const ba = out[o + 3] / 255, oa = a + ba * (1 - a);
      for (let k = 0; k < 3; k++) out[o + k] = Math.round((c[k] * a + out[o + k] * ba * (1 - a)) / oa);
      out[o + 3] = Math.round(oa * 255);
    }
  }
  return { data: out, w: U.width, h: U.height };
}
async function fit(img, bw, bh) {
  const s = Math.min(bw / img.w, bh / img.h);
  const w = Math.max(1, Math.round(img.w * s)), h = Math.max(1, Math.round(img.h * s));
  const buf = await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
  return { buf, w, h };
}
function checker(w, h, a = '#1d232e', b = '#232a36', step = 8) {
  let r = '';
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step)
      if (((x + y) / step) % 2) r += `<rect x="${x}" y="${y}" width="${step}" height="${step}" fill="${b}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${a}"/>${r}</svg>`);
}
/** 补图存的模型图：编号最大的那张就是采用的（合格即停；都不合格时是兜底，不一定是它） */
function modelImagePath(cut) {
  const d = join(dirname(cut.path), '_inpaint');
  if (!existsSync(d)) return null;
  const re = new RegExp(`^${cut.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.png$`);
  const hits = readdirSync(d).map((f) => [f, re.exec(f)]).filter(([, m]) => m).sort((a, b) => b[1][1] - a[1][1]);
  return hits.length ? join(d, hits[0][0]) : null;
}

const composites = [];
let svg = '', bg = '';

// 标题
svg += `<text x="${PAD}" y="${PAD + 60}" ${FONT} font-size="68" font-weight="700" fill="${TEXT}">部件拆解</text>`;
svg += `<text x="${PAD + 304}" y="${PAD + 60}" ${FONT} font-size="36" fill="${MUTED}">LAYER BREAKDOWN · ${cuts.length} parts · 切图 → 补图</text>`;

// 列头：每列卡片上方标一次，卡片里就不用每格写字
function colHeads(cx, y) {
  for (let i = 0; i < COLS.length; i++) {
    const x = cx + CARD_PAD + i * (CW + CGAP) + CW / 2;
    svg += `<text x="${x}" y="${y}" ${FONT} font-size="30" font-weight="600" fill="${colorOf(COLS[i])}" text-anchor="middle">${COLS[i].label}</text>`;
  }
}
for (let c = 1; c < GRID_COLS; c++) colHeads(colX(c), srcTop + 42);
for (let j = 0; j < bottomCuts.length; j++) colHeads(colX(j), rowEnd + 42);

// 原图
bg += `<rect x="${PAD}" y="${srcTop}" width="${CARD_W}" height="${PANEL_H}" rx="14" fill="${CARD}" stroke="${LINE}"/>`;
const srcBuf = await sharp(srcTrim).resize(SRC_W, SRC_H).png().toBuffer();
composites.push({ input: srcBuf, left: PAD + Math.round((CARD_W - SRC_W) / 2), top: srcTop + Math.round((PANEL_H - SRC_H) / 2) });
svg += `<text x="${PAD + 22}" y="${srcTop + 52}" ${FONT} font-size="32" font-weight="600" fill="#ffffff" opacity="0.85">原图 SOURCE</text>`;

// 树干：原图右侧竖线，每行一条分支；脚底那栏左右各分一支
const line = (d) => (svg += `<path d="${d}" stroke="${LINE}" stroke-width="3" fill="none"/>`);
const dot = (x, y) => (svg += `<circle cx="${x}" cy="${y}" r="6" fill="#3b4656"/>`);
const trunkX = colX(1) - COL_GAP / 2;
const mid = (y) => y + CARD_H / 2;
const lastMid = bottomCuts.length ? mid(bottomY) : mid(rowY(TOP_ROWS - 1));
line(`M${PAD + CARD_W} ${srcTop + PANEL_H / 2} H${trunkX}`);
line(`M${trunkX} ${mid(rowY(0))} V${lastMid}`);
for (let r = 0; r < TOP_ROWS; r++) { line(`M${trunkX} ${mid(rowY(r))} H${colX(1)}`); dot(trunkX, mid(rowY(r))); }
if (bottomCuts.length) {
  line(`M${PAD + CARD_W} ${lastMid} H${bottomCuts.length > 1 ? colX(1) : trunkX}`);
  dot(trunkX, lastMid);
}

// 卡片
const check = checker(CW, CH);
async function card(cut, k, cx, cy) {
  bg += `<rect x="${cx}" y="${cy}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="${CARD}" stroke="${LINE}"/>`;
  svg += `<text x="${cx + CARD_PAD + 4}" y="${cy + CARD_PAD + 36}" ${FONT} font-size="38" font-weight="600" fill="${TEXT}">${esc(cut.name)}</text>`;
  svg += `<text x="${cx + CARD_W - CARD_PAD - 4}" y="${cy + CARD_PAD + 36}" ${FONT} font-size="28" fill="${MUTED}" text-anchor="end">#${String(k + 1).padStart(2, '0')}</text>`;

  const erasedPath = cut.path.replace(/\.png$/, '.erased.png');
  const modelPath = cut.hiddenPath ? modelImagePath(cut) : null;
  const layers = {
    mask: cut.maskPath && existsSync(cut.maskPath) ? [cut.maskPath, cut.maskBox] : null,
    erased: existsSync(erasedPath) ? [erasedPath, cut.maskBox] : null,
    hidden: cut.hiddenPath ? [cut.hiddenPath, cut.hiddenBox] : null,
    model: modelPath ? [modelPath, cut.hiddenBox] : null,
    part: [cut.path, cut.bbox],
  };
  const U = unionBox(Object.values(layers).map((l) => l?.[1]));
  for (let i = 0; i < COLS.length; i++) {
    const col = COLS[i];
    const x = cx + CARD_PAD + i * (CW + CGAP), y = cy + CARD_PAD + HEAD_H;
    composites.push({ input: check, left: x, top: y });
    const l = layers[col.key];
    if (l) {
      const img = place(U, await loadRGBA(l[0]), l[1], { tint: col.color, ghost: !!col.color });
      const f = await fit(img, CW - 8, CH - 8);
      composites.push({ input: f.buf, left: x + Math.round((CW - f.w) / 2), top: y + Math.round((CH - f.h) / 2) });
    } else {
      const why = col.key === 'model' ? '没被挡' : '无';
      svg += `<text x="${x + CW / 2}" y="${y + CH / 2 + 10}" ${FONT} font-size="28" fill="#4a5363" text-anchor="middle">${why}</text>`;
    }
    svg += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${CW - 1}" height="${CH - 1}" rx="6" fill="none" stroke="${LINE}"/>`;
  }
}
for (let k = 0; k < topCuts.length; k++) {
  await card(topCuts[k], k, colX(1 + (k % (GRID_COLS - 1))), rowY(Math.floor(k / (GRID_COLS - 1))));
}
for (let j = 0; j < bottomCuts.length; j++) await card(bottomCuts[j], topCuts.length + j, colX(j), bottomY);

// 脚底那栏剩下的位置放图例
if (bottomCuts.length && bottomCuts.length < GRID_COLS) {
  const lx = colX(bottomCuts.length), lw = colX(GRID_COLS) - COL_GAP - lx;
  bg += `<rect x="${lx}" y="${bottomY}" width="${lw}" height="${CARD_H}" rx="12" fill="${CARD}" stroke="${LINE}"/>`;
  svg += `<text x="${lx + 36}" y="${bottomY + 62}" ${FONT} font-size="38" font-weight="600" fill="${TEXT}">图例 <tspan fill="${MUTED}" font-size="28" font-weight="400">LEGEND · 同一张卡片里五格按原图坐标对齐，掩码格垫了暗化的原图</tspan></text>`;
  const step = (CARD_H - 100) / COLS.length;
  COLS.forEach((col, i) => {
    const y = bottomY + 100 + i * step + step / 2;
    svg += `<rect x="${lx + 36}" y="${y - 15}" width="30" height="30" rx="7" fill="${colorOf(col)}"/>`;
    svg += `<text x="${lx + 84}" y="${y + 11}" ${FONT} font-size="30" font-weight="600" fill="${TEXT}">${col.label}</text>`;
    svg += `<text x="${lx + 84 + 150}" y="${y + 11}" ${FONT} font-size="28" fill="${MUTED}">${col.sub} · ${col.desc}</text>`;
  });
}

const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`);
// 先铺卡片底，再贴图，最后盖 SVG（线框/文字在最上层）
await sharp({ create: { width: W, height: H, channels: 4, background: BG } })
  .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg}</svg>`), left: 0, top: 0 },
    ...composites, { input: overlay, left: 0, top: 0 }])
  .png({ compressionLevel: 9, palette: true, quality: 95, effort: 10 })
  .toFile(outPath);
console.log(outPath, W, H, cuts.length, 'parts');
