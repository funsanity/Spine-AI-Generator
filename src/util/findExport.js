/**
 * 在导出目录里找回 Spine 生成的骨架 JSON。
 *
 * 为什么需要这个：
 *   Spine CLI 的 -o 指定的是输出**目录**，文件名由工程内部的名字决定，
 *   调用方无法预知。同时导出目录里还会混入 .atlas、.png 等文件，
 *   甚至可能有多个 JSON（图集索引也是 JSON）。
 *   所以只能按"内容特征"认领，不能按文件名。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 判据：同时含 bones 和 slots 的 JSON 才是骨架，图集索引没有这两个键 */
export async function findExportedJson(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.json')) continue;
    // 明确排除已知的非骨架 JSON
    if (e.name.endsWith('.atlas.json') || e.name.includes('atlas')) continue;
    candidates.push(join(dir, e.name));
  }

  // 优先选体积大的：骨架 JSON 远大于图集索引
  const sized = [];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      sized.push({ path: p, size: s.size });
    } catch {
      // 读不到就跳过
    }
  }
  sized.sort((a, b) => b.size - a.size);

  for (const { path } of sized) {
    if (await looksLikeSkeleton(path)) return path;
  }
  return null;
}

async function looksLikeSkeleton(path) {
  try {
    const text = await readFile(path, 'utf-8');
    // 只看前 4KB，避免为判定读入整个大文件
    const head = text.slice(0, 4096);
    // 骨架 JSON 必有 bones，slots 可能为空（最小骨架）
    return head.includes('"bones"');
  } catch {
    return false;
  }
}
