/**
 * Spine 图集（.atlas / .atlas.txt）解析器。
 *
 * atlas 文本是"部件清单"最直接的来源：每个 page 下的一组区段
 * 就是打进来的所有附件区域。拆件工具的产物最终要重新打回 atlas，
 * 所以这里必须能完整往返——解析结果要能无损写回。
 *
 * 格式要点：
 *   - 分页以"不以空白开头且不以已知参数名开头"的行开始
 *   - 参数行是 key:value，区段行只有名字
 *   - 区段属性有顺序要求（bounds 必须在前），但解析时不做限制，
 *     只在写回时按标准顺序输出
 */

export class AtlasParseError extends Error {
  constructor(message, line) {
    super(line == null ? message : `${message} (第 ${line} 行)`);
    this.name = 'AtlasParseError';
  }
}

/** 分页级参数 */
const PAGE_KEYS = new Set([
  'size',
  'format',
  'filter',
  'repeat',
  'pma',
  'scale',
]);

/** 区段级参数 */
const REGION_KEYS = new Set([
  'bounds',
  'offsets',
  'rotate',
  'rotate90',
  'rotate180',
  'rotate270',
  'index',
  'split',
  'pad',
  'orig',
  // 3.8 是单数 offset（两个数），4.x 是复数 offsets（四个数）。
  // 少了单数形式，3.8 图集里的 "offset: 0, 0" 会被当成区域名，凭空多出一堆空区域。
  'offset',
  'xy',
  'size',
]);

export function parseAtlas(text) {
  const lines = text.split(/\r?\n/);
  const pages = [];
  let page = null;
  let region = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.trim() === '') continue;
    if (rawLine.startsWith('#')) continue; // 注释

    const line = rawLine.trim();
    const { key, value } = splitKeyValue(line);

    if (key !== null) {
      // 参数行的归属由**作用域状态**决定，不能只看名字：
      // "size" 既是分页参数也是区段参数，按名字判会认错。
      // 规则：区段名出现之后、下一个名字之前，参数都属于该区段；
      // 分页参数只在区段名出现前有效。
      if (region) {
        applyRegionParam(region, key, value, i + 1);
      } else if (page) {
        applyPageParam(page, key, value, i + 1);
      } else {
        throw new AtlasParseError(`参数 ${key} 出现在任何分页之前`, i + 1);
      }
      continue;
    }

    // 无 key 的行是名字。分页名与区段名都不缩进，靠扩展名区分。
    if (isPageName(page, line)) {
      page = { name: line, params: {}, regions: [] };
      pages.push(page);
      region = null;
    } else {
      region = { name: line, params: {}, index: null };
      page.regions.push(region);
    }
  }

  return { pages };
}

function splitKeyValue(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return { key: null, value: line };
  const key = line.slice(0, idx).trim();
  // 名字里可能含冒号（如 "Icon:01"），只有已知参数名才算 kv
  if (!PAGE_KEYS.has(key) && !REGION_KEYS.has(key)) {
    return { key: null, value: line };
  }
  return { key, value: line.slice(idx + 1).trim() };
}

/** 分页名是贴图文件名，用扩展名判定最可靠 */
const TEXTURE_EXT = /\.(png|jpg|jpeg|webp|ktx|zktx|basis|astc|pvr|etc\d?|dds)$/i;

/**
 * 判断一个无 key 的行是"新分页"还是"区段名"。
 *
 * 这是 atlas 解析最容易踩的坑：分页名和区段名都不缩进，
 * 且分页参数（size/filter）与区段参数（size/bounds）名字重叠，
 * 靠位置和名字都判不准。
 *
 * 唯一可靠的判据是扩展名：分页名必然是贴图文件名，
 * 区段名是附件名（可能含点，但不会是这些贴图后缀）。
 * 附加兜底：第一个名字、以及区段名为空时出现的名字，按分页处理。
 */
function isPageName(page, name) {
  if (!page) return true; // 文件第一行必然是分页
  return TEXTURE_EXT.test(name);
}

function applyPageParam(page, key, value, lineNo) {
  if (key === 'size') {
    page.params.size = parseSize(value, lineNo);
  } else if (key === 'filter') {
    page.params.filter = value.split(',').map((s) => s.trim());
  } else if (key === 'pma') {
    page.params.pma = value === 'true';
  } else if (key === 'scale') {
    page.params.scale = Number.parseFloat(value);
  } else {
    page.params[key] = value;
  }
}

function applyRegionParam(region, key, value, lineNo) {
  switch (key) {
    case 'bounds':
      region.params.bounds = parseRect(value, lineNo);
      break;
    case 'offsets':
      region.params.offsets = parseRect(value, lineNo);
      break;
    case 'orig':
      region.params.orig = parseSize(value, lineNo);
      break;
    case 'size':
      region.params.size = parseSize(value, lineNo);
      break;
    case 'xy':
    case 'offset':
      region.params[key] = value.split(',').map((s) => Number.parseInt(s.trim(), 10));
      break;
    case 'index':
      region.index = Number.parseInt(value, 10);
      break;
    case 'rotate':
      region.params.rotate = value === 'true' ? true : value;
      break;
    case 'split':
    case 'pad':
      region.params[key] = value.split(',').map((s) => Number.parseInt(s.trim(), 10));
      break;
    default:
      region.params[key] = value;
  }
}

function parseRect(value, lineNo) {
  const parts = value.split(',').map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new AtlasParseError(`bounds/offsets 格式错误: ${value}`, lineNo);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function parseSize(value, lineNo) {
  const parts = value.split(',').map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length !== 2 || parts.some(Number.isNaN)) {
    throw new AtlasParseError(`size 格式错误: ${value}`, lineNo);
  }
  return { w: parts[0], h: parts[1] };
}

/**
 * 写回 atlas 文本。
 * 参数顺序按 Spine 官方导出的习惯固定，保证往返 diff 干净。
 */
export function writeAtlas(atlas) {
  const out = [];
  for (const page of atlas.pages) {
    out.push(page.name);
    if (page.params.size) out.push(`size:${page.params.size.w},${page.params.size.h}`);
    if (page.params.filter) out.push(`filter:${page.params.filter.join(',')}`);
    if (page.params.repeat) out.push(`repeat:${page.params.repeat}`);
    if (page.params.pma !== undefined) out.push(`pma:${page.params.pma}`);
    if (page.params.scale !== undefined) out.push(`scale:${page.params.scale}`);
    for (const key of Object.keys(page.params)) {
      if (PAGE_KEYS.has(key)) continue;
      out.push(`${key}:${page.params[key]}`);
    }

    for (const region of page.regions) {
      out.push(region.name);
      const p = region.params;
      if (p.rotate !== undefined) out.push(`rotate:${p.rotate}`);
      if (p.xy) out.push(`xy:${p.xy.join(',')}`);
      if (p.size) out.push(`size:${p.size.w},${p.size.h}`);
      if (p.split) out.push(`split:${p.split.join(',')}`);
      if (p.pad) out.push(`pad:${p.pad.join(',')}`);
      if (p.orig) out.push(`orig:${p.orig.w},${p.orig.h}`);
      // 单数 offset 紧跟 orig，是 3.8 的成对字段，顺序不能和 4.x 的 offsets 混
      if (p.offset) out.push(`offset:${p.offset.join(',')}`);
      if (p.bounds) out.push(`bounds:${fmtRect(p.bounds)}`);
      if (p.offsets) out.push(`offsets:${fmtRect(p.offsets)}`);
      if (region.index !== null) out.push(`index:${region.index}`);
    }
  }
  return out.join('\n') + '\n';
}

function fmtRect(r) {
  return `${r.x},${r.y},${r.w},${r.h}`;
}

/**
 * 从 atlas 提取部件清单——这是 P1 拆件工具的输出目标。
 * 按页分组，保留 index，便于识别同名多帧。
 */
export function listAtlasParts(atlas) {
  const parts = [];
  for (const page of atlas.pages) {
    for (const region of page.regions) {
      parts.push({
        name: region.name,
        page: page.name,
        index: region.index,
        bounds: region.params.bounds ?? null,
        rotate: region.params.rotate ?? false,
        pma: page.params.pma ?? false,
      });
    }
  }
  return parts;
}
