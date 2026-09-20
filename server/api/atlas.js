/**
 * 图集打包。
 *
 * 为什么必须打图集：
 *   Cocos / Unity 的 Spine 运行时加载的是「.json + .atlas + .png」三件套，
 *   .atlas 描述每个附件在图集里的位置。我们之前只产出一张张独立 PNG，
 *   在编辑器里拖进去会直接报缺少 atlas，导出物等于不能用。
 *
 * 布局用「按高度排序的货架装箱」（shelf packing）：
 *   部件按高度降序排，逐行摆放，一行放不下就换行。
 *   之所以不用更优的 MaxRects：部件数量在几十个量级，
 *   货架装箱的浪费率已经够低，而且行结构让生成的图集便于肉眼核对。
 *
 * 3.8 与 4.x 的 atlas 是两种格式，不能混：
 *   3.8  区域用 xy/size/orig/offset，页头字段顺序固定（size→format→filter→repeat），
 *        运行时是按顺序读的，插错位置直接解析失败。
 *   4.x  区域用 bounds/offsets，页头字段用 key:value 自由顺序。
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

/** 区域之间留的透明间距，避免采样时相邻区域的像素渗进来 */
const PADDING = 2;

/** 图集页最大边长，超过就说明该分页了 */
const MAX_PAGE = 4096;

/**
 * 把部件图打成图集。
 *
 * @param {Array<{name:string,path:string,size:{width:number,height:number}}>} parts - cutImageParts 的返回值
 * @param {string} outDir - 输出目录
 * @param {object} opts - { name, spineVersion }
 * @returns {Promise<{atlasPath:string,pagePath:string,regions:Array,page:{width:number,height:number}}>}
 */
export async function packAtlas(parts, outDir, opts = {}) {
  const name = opts.name ?? 'skeleton';
  const spineVersion = opts.spineVersion ?? '3.8';

  const usable = parts.filter((p) => p.path && p.size?.width > 0 && p.size?.height > 0);
  if (!usable.length) {
    throw new Error('没有可打包的部件图片');
  }

  const layout = shelfPack(usable);
  await mkdir(outDir, { recursive: true });

  const pageName = `${name}.png`;
  const pagePath = join(outDir, pageName);

  // 先铺一张全透明底图，再把每个部件合成到它算好的位置上
  const composites = layout.placements.map((p) => ({
    input: p.path,
    left: p.x,
    top: p.y
  }));

  await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .png()
    .toFile(pagePath);

  // 不写 pma：图集是直通 alpha，运行时也按直通混合，两边一致才不会出黑边
  const atlasText = isLegacy(spineVersion)
    ? writeLegacyAtlas(pageName, layout)
    : writeModernAtlas(pageName, layout);

  const atlasPath = join(outDir, `${name}.atlas`);
  await writeFile(atlasPath, atlasText, 'utf-8');

  return {
    atlasPath,
    pagePath,
    page: { width: layout.width, height: layout.height },
    regions: layout.placements.map((p) => ({ name: p.name, x: p.x, y: p.y, w: p.w, h: p.h })),
    atlasText
  };
}

/** 3.8 及更早用旧格式；4.0 起用新格式 */
function isLegacy(version) {
  return String(version).startsWith('3.');
}

/**
 * 货架装箱。
 * 按高度降序摆放，同一行共享行高，行宽超上限就换行。
 * 页宽先估一个接近正方形的值，再按实际占用收紧到 2 的幂。
 */
function shelfPack(parts) {
  const items = parts
    .map((p) => ({
      name: p.name,
      path: p.path,
      w: Math.round(p.size.width),
      h: Math.round(p.size.height)
    }))
    .sort((a, b) => b.h - a.h || b.w - a.w);

  // 面积开方作为初始页宽，保证结果接近正方形——纹理越方，显存对齐浪费越小
  const area = items.reduce((s, it) => s + (it.w + PADDING) * (it.h + PADDING), 0);
  const widest = Math.max(...items.map((it) => it.w + PADDING));
  const pageWidth = Math.min(MAX_PAGE, Math.max(widest, ceilPow2(Math.sqrt(area) * 1.1)));

  const placements = [];
  let x = PADDING;
  let y = PADDING;
  let rowHeight = 0;
  let used = 0;

  for (const it of items) {
    if (x + it.w + PADDING > pageWidth && placements.length) {
      // 换行
      y += rowHeight + PADDING;
      x = PADDING;
      rowHeight = 0;
    }

    placements.push({ ...it, x, y });
    x += it.w + PADDING;
    rowHeight = Math.max(rowHeight, it.h);
    used = Math.max(used, y + it.h + PADDING);
  }

  // 页宽取 2 的幂（对齐友好），页高用实际占用即可：
  // 高度再往上凑 2 的幂常常凭空多出一半空白，而 Spine 自带打包器也不强制页面是方幂。
  const height = Math.min(MAX_PAGE, Math.ceil(used / 4) * 4);
  if (used > MAX_PAGE) {
    throw new Error(`部件总面积超出单页图集上限（需要 ${used}px，上限 ${MAX_PAGE}px），请减少部件或降低分辨率`);
  }

  return { width: pageWidth, height, placements };
}

function ceilPow2(n) {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/**
 * Spine 3.8 格式（Cocos 3.8.x 默认运行时用这个）。
 *
 * 页头字段顺序是硬要求：运行时先读一个二元组当 size，
 * 再依次读 format、filter、repeat。少一行或调换顺序都会解析错位。
 * 区域参数间不能出现空行——空行会让运行时认为当前页结束。
 */
function writeLegacyAtlas(pageName, layout) {
  const out = [''];
  out.push(pageName);
  out.push(`size: ${layout.width},${layout.height}`);
  out.push('format: RGBA8888');
  out.push('filter: Linear,Linear');
  out.push('repeat: none');

  for (const r of layout.placements) {
    out.push(r.name);
    out.push('  rotate: false');
    out.push(`  xy: ${r.x}, ${r.y}`);
    out.push(`  size: ${r.w}, ${r.h}`);
    out.push(`  orig: ${r.w}, ${r.h}`);
    out.push('  offset: 0, 0');
    out.push('  index: -1');
  }

  return out.join('\n') + '\n';
}

/**
 * Spine 4.x 格式。
 * 区域用 bounds（x,y,w,h 合一），页头字段是自由顺序的 key:value。
 */
function writeModernAtlas(pageName, layout) {
  const out = [pageName];
  out.push(`size: ${layout.width}, ${layout.height}`);
  out.push('filter: Linear, Linear');

  for (const r of layout.placements) {
    out.push(r.name);
    out.push(`  bounds: ${r.x}, ${r.y}, ${r.w}, ${r.h}`);
  }

  return out.join('\n') + '\n';
}

/**
 * 把图集区域信息回填到骨架的附件上。
 *
 * 为什么要回填：
 *   附件的 path 默认等于部件名，运行时拿 path 去 atlas 里找同名区域。
 *   打包后区域名就是部件名，所以 path 保持不变即可；
 *   但 region 附件的 width/height 必须等于图集里的实际尺寸，
 *   否则运行时按错误尺寸缩放，拼出来的图会错位。
 */
export function applyAtlasToSkeleton(skeleton, regions) {
  const byName = new Map(regions.map((r) => [r.name, r]));
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [];

  for (const skin of skins) {
    for (const slotAttachments of Object.values(skin.attachments ?? {})) {
      for (const [attName, att] of Object.entries(slotAttachments)) {
        const region = byName.get(att.path?.replace(/\.png$/, '') ?? attName);
        if (!region) continue;

        // path 去掉扩展名：atlas 区域名不带后缀
        att.path = region.name;
        if (att.type === 'region' || !att.type) {
          att.width = region.w;
          att.height = region.h;
        }
      }
    }
  }

  return skeleton;
}

export { PADDING, MAX_PAGE };
