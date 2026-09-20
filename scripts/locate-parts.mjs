/**
 * 从切图反推每个部件在原图里的位置。
 *
 * 为什么需要这个：预览要把部件摆回原位才看得出效果，而 bbox 是 AI 分析
 * 时给的、**没有落盘**。落盘的只有一张张切图。
 *
 * 如果偷懒把每个部件的 bbox 都写成 {x:0, y:0}，所有部件会全叠在原点，
 * 截图看起来像"重影/叠加"——排查时会被这个假象带偏很久（实实在在被坑过）。
 *
 * 这里用模板匹配把位置找回来：
 *   1. 取切图的 alpha 通道作为模板（只看形状，不受补图改动的颜色影响）
 *   2. 在原图的 alpha 上滑窗，找形状最吻合的位置
 *   3. 用"不匹配像素数"评分，取最小值的偏移
 *
 * 切图是原图的一个矩形区域，所以模板一定能在原图里找到完全吻合的位置
 * （除非部件在原图里是纯透明——那种直接丢掉）。
 *
 * 为了速度，滑窗按 step 跳着走，先粗定位再在邻域内精修。
 */

import sharp from 'sharp';

/** 取 alpha 通道，压成 0/1 */
async function alphaMask(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(info.width * info.height);
  for (let i = 0; i < m.length; i++) m[i] = data[i * 4 + 3] >= 8 ? 1 : 0;
  return { mask: m, width: info.width, height: info.height };
}

/** 模板在 (ox, oy) 处的不匹配像素数（越小越好） */
function mismatch(srcMask, srcW, srcH, tpl, tplW, tplH, ox, oy, step) {
  let bad = 0;
  for (let y = 0; y < tplH; y += step) {
    const sy = oy + y;
    for (let x = 0; x < tplW; x += step) {
      const sx = ox + x;
      const s = srcMask[sy * srcW + sx];
      const t = tpl[y * tplW + x];
      if (s !== t) bad++;
    }
  }
  return bad;
}

/**
 * 找出每个切图在原图中的位置。
 *
 * @param {string} sourcePath - 原图
 * @param {Array<{name:string, path:string}>} cuts - 切图列表
 * @returns {Promise<Map<string, {x:number,y:number,width:number,height:number}>>}
 */
export async function locateParts(sourcePath, cuts) {
  const src = await alphaMask(sourcePath);
  const out = new Map();

  for (const c of cuts) {
    const tpl = await alphaMask(c.path);
    if (tpl.width > src.width || tpl.height > src.height) {
      console.warn(`[定位] ${c.name} 比原图还大，跳过`);
      continue;
    }

    // 模板全透明就没法定位（原图那块本来就是空的）
    let tplOpaque = 0;
    for (let i = 0; i < tpl.mask.length; i++) tplOpaque += tpl.mask[i];
    if (!tplOpaque) {
      console.warn(`[定位] ${c.name} 的形状是全透明的，跳过`);
      continue;
    }

    // 粗搜：大步长扫全图
    const COARSE = 4;
    let best = { x: 0, y: 0, bad: Infinity };
    for (let oy = 0; oy + tpl.height <= src.height; oy += COARSE) {
      for (let ox = 0; ox + tpl.width <= src.width; ox += COARSE) {
        const bad = mismatch(src.mask, src.width, src.height, tpl.mask, tpl.width, tpl.height, ox, oy, COARSE);
        if (bad < best.bad) best = { x: ox, y: oy, bad };
      }
    }

    // 精修：在粗搜结果附近逐像素扫
    const R = COARSE;
    for (let oy = Math.max(0, best.y - R); oy <= Math.min(src.height - tpl.height, best.y + R); oy++) {
      for (let ox = Math.max(0, best.x - R); ox <= Math.min(src.width - tpl.width, best.x + R); ox++) {
        const bad = mismatch(src.mask, src.width, src.height, tpl.mask, tpl.width, tpl.height, ox, oy, 1);
        if (bad < best.bad) best = { x: ox, y: oy, bad };
      }
    }

    const total = Math.ceil(tpl.width) * Math.ceil(tpl.height);
    const score = 1 - best.bad / total;
    out.set(c.name, {
      x: best.x, y: best.y, width: tpl.width, height: tpl.height,
      match: score
    });
  }

  return out;
}
