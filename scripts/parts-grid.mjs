// 部件总览图：左原图，右边只摆最终部件，一眼看出一张图被拆成了哪几块。
// 和 parts-sheet.mjs 的区别：不画蒙版/擦除/补画这些中间层，只看结果。
//
// 部件按原图里的同一个比例尺摆（大的大、小的小），读起来像把原图拆开摊平；
// 太小的部件（手、配件）单独放大到看得清，卡片角上标出放大倍数。
//
// 用法：node scripts/parts-grid.mjs <_temp 目录 | response.json> [原图] [输出]
import sharp from 'sharp';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('用法：node scripts/parts-grid.mjs <_temp 目录 | response.json> [原图] [输出]');
  process.exit(1);
}
const runDir = statSync(arg).isDirectory() ? arg : null;
const respPath = runDir ? join(runDir, 'response.json') : arg;
const srcPath = process.argv[3] ?? (runDir && existsSync(join(runDir, 'source.png')) ? join(runDir, 'source.png') : 'test_assets/kkk.png');
const outPath = process.argv[4] ?? 'docs/images/parts-grid.png';
const resp = JSON.parse(readFileSync(respPath, 'utf-8'));
// 从头到脚排：按部件在原图里的中心高度，读起来像从上往下把人拆开
const cy = (c) => c.bbox.y + c.bbox.height / 2;
const cuts = resp.cutResults.filter((c) => !c.name.startsWith('_')).sort((a, b) => cy(a) - cy(b));

// ── 配色与 parts-sheet 保持一致 ──
const BG = '#0d1017', CARD = '#161b24', LINE = '#2a3240', TEXT = '#e6e9ef', MUTED = '#7d8796';
const FONT = `font-family="PingFang SC, Helvetica Neue, Arial, sans-serif"`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ── 版式 ──
const PAD = 56, TITLE_H = 100, GAP = 20, NAME_H = 58, CELL_PAD = 18;
const PANEL_H = 1500;
// 行数让右边网格高度和原图面板齐平；列数按部件数定
const CELL_H = 350;
const MAX_ROWS = Math.max(1, Math.floor((PANEL_H + GAP) / (CELL_H + GAP)));
const COLS = Math.ceil(cuts.length / MAX_ROWS);
const ROWS = Math.ceil(cuts.length / COLS);
const CELL_W = 340;
const gridH = ROWS * CELL_H + (ROWS - 1) * GAP;
const top = PAD + TITLE_H;

const srcTrim = await sharp(srcPath).trim({ threshold: 10 })
  .extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const srcMeta = await sharp(srcTrim).metadata();
const SRC_H = gridH - 40;
const SRC_W = Math.round(srcMeta.width * SRC_H / srcMeta.height);
const PANEL_W = SRC_W + 80;
const gridX = PAD + PANEL_W + 96;
const W = gridX + COLS * CELL_W + (COLS - 1) * GAP + PAD;
const H = top + gridH + PAD;

// 统一比例尺：原图面板里人物是多大，部件就按同样比例摆
const scale = SRC_H / srcMeta.height;
const imgW = CELL_W - CELL_PAD * 2, imgH = CELL_H - NAME_H - CELL_PAD * 2;

function checker(w, h, a = '#262e3b', b = '#2e3747', step = 10) {
  let r = '';
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step)
      if (((x + y) / step) % 2) r += `<rect x="${x}" y="${y}" width="${step}" height="${step}" fill="${b}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="8" fill="${a}"/>${r}</svg>`);
}

const composites = [];
let bg = '', svg = '';

svg += `<text x="${PAD}" y="${PAD + 60}" ${FONT} font-size="68" font-weight="700" fill="${TEXT}">部件拆解</text>`;
svg += `<text x="${PAD + 304}" y="${PAD + 60}" ${FONT} font-size="36" fill="${MUTED}">PARTS · ${cuts.length} 个部件，被遮挡处已补全</text>`;

// 原图
bg += `<rect x="${PAD}" y="${top}" width="${PANEL_W}" height="${gridH}" rx="14" fill="${CARD}" stroke="${LINE}"/>`;
composites.push({
  input: await sharp(srcTrim).resize(SRC_W, SRC_H).png().toBuffer(),
  left: PAD + Math.round((PANEL_W - SRC_W) / 2), top: top + 20,
});
svg += `<text x="${PAD + 22}" y="${top + 52}" ${FONT} font-size="32" font-weight="600" fill="#ffffff" opacity="0.85">原图 SOURCE</text>`;

// 原图 → 部件的箭头
const ax = PAD + PANEL_W + 20, ay = top + gridH / 2;
svg += `<path d="M${ax} ${ay} H${gridX - 24}" stroke="#3b4656" stroke-width="6" fill="none"/>`;
svg += `<path d="M${gridX - 40} ${ay - 18} L${gridX - 18} ${ay} L${gridX - 40} ${ay + 18}" stroke="#3b4656" stroke-width="6" fill="none" stroke-linejoin="round"/>`;

const check = checker(imgW, imgH);
for (let k = 0; k < cuts.length; k++) {
  const cut = cuts[k];
  const c = k % COLS, r = Math.floor(k / COLS);
  const cx = gridX + c * (CELL_W + GAP), cy = top + r * (CELL_H + GAP);
  bg += `<rect x="${cx}" y="${cy}" width="${CELL_W}" height="${CELL_H}" rx="12" fill="${CARD}" stroke="${LINE}"/>`;
  const ix = cx + CELL_PAD, iy = cy + CELL_PAD;
  composites.push({ input: check, left: ix, top: iy });

  const meta = await sharp(cut.path).metadata();
  // 先按统一比例尺，放不下就缩；太小（不到格子的 40%）就放大到看得清，并标出倍数
  let s = Math.min(scale, (imgW - 16) / meta.width, (imgH - 16) / meta.height);
  const fill = Math.max(meta.width * s / imgW, meta.height * s / imgH);
  let zoom = 1;
  if (fill < 0.4) {
    const s2 = Math.min((imgW - 16) * 0.6 / meta.width, (imgH - 16) * 0.6 / meta.height);
    zoom = s2 / s;
    s = s2;
  }
  const w = Math.max(1, Math.round(meta.width * s)), h = Math.max(1, Math.round(meta.height * s));
  composites.push({
    input: await sharp(cut.path).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer(),
    left: ix + Math.round((imgW - w) / 2), top: iy + Math.round((imgH - h) / 2),
  });
  if (zoom > 1.05) {
    svg += `<text x="${ix + imgW - 12}" y="${iy + 32}" ${FONT} font-size="24" font-weight="600" fill="${MUTED}" text-anchor="end">×${zoom.toFixed(1)}</text>`;
  }
  const ny = cy + CELL_H - 22;
  // 长名字（right_forearm_hand）会顶到编号，按估算宽度缩字号
  const room = CELL_W - CELL_PAD * 2 - 64;
  const fs = Math.max(20, Math.min(32, Math.floor(room / (cut.name.length * 0.58))));
  svg += `<text x="${cx + CELL_PAD + 2}" y="${ny}" ${FONT} font-size="${fs}" font-weight="600" fill="${TEXT}">${esc(cut.name)}</text>`;
  svg += `<text x="${cx + CELL_W - CELL_PAD - 2}" y="${ny}" ${FONT} font-size="26" fill="${MUTED}" text-anchor="end">#${String(k + 1).padStart(2, '0')}</text>`;
}

const base = sharp({ create: { width: W, height: H, channels: 4, background: BG } });
const withBg = await base.composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg}</svg>`), left: 0, top: 0 }]).png().toBuffer();
await sharp(withBg)
  .composite([...composites, { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`), left: 0, top: 0 }])
  .png({ palette: true, quality: 95, compressionLevel: 9 })
  .toFile(outPath);
console.log(outPath, W, H, `${cuts.length} parts`);
