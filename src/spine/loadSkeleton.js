/**
 * 统一的骨架加载入口。
 *
 * 二进制和 JSON 是同一份数据的两种编码。工具的所有上层逻辑
 * （校验、diff、按部件定位）都只面对归一化后的文档模型，
 * 不关心底层是哪种格式——这样新增格式支持不会污染上层。
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { readSkeletonBinary } from './readSkeletonBinary.js';
import { parseSkeletonJson, normalizeSkeleton } from './readSkeletonJson.js';

export async function loadSkeleton(filePath) {
  const buf = await readFile(filePath);
  return parseSkeletonBytes(buf, filePath);
}

export function parseSkeletonBytes(buf, filePath = '<buffer>') {
  const ext = extname(filePath).toLowerCase();

  // .skel.bytes 这类复合后缀要特殊处理：extname 只给 ".bytes"
  if (ext === '.skel' || ext === '.bytes') {
    return readSkeletonBinary(toUint8(buf));
  }

  if (ext === '.json' || ext === '.spine') {
    const text = new TextDecoder('utf-8').decode(toUint8(buf));
    const doc = parseSkeletonJson(text);
    if (!doc.version) doc.version = sniffVersionFromText(text);
    return doc;
  }

  // 后缀不可信时按内容嗅探：JSON 必然以 { 开头
  const head = toUint8(buf)[0];
  if (head === 0x7b /* { */) {
    return parseSkeletonJson(new TextDecoder('utf-8').decode(toUint8(buf)));
  }
  return readSkeletonBinary(toUint8(buf));
}

function toUint8(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/**
 * .spine 工程文件的版本写在根级 spine 字段；
 * 部分导出只写 skeleton.spine。这里做兜底扫描，
 * 避免为拿一个版本号再 parse 一遍。
 */
function sniffVersionFromText(text) {
  const m = text.match(/"spine"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** 把二进制文档转成与 JSON 文档同形的模型，供上层统一处理 */
export function binaryToDoc(bin) {
  return normalizeSkeleton({
    skeleton: {
      spine: bin.version,
      hash: bin.hash,
      x: bin.x,
      y: bin.y,
      width: bin.width,
      height: bin.height,
      fps: bin.fps,
      images: bin.imagesPath,
      audio: bin.audioPath,
    },
    bones: bin.bones,
    // 二进制的 slot.boneIndex 要还原成名字，否则与 JSON 侧对不上
    slots: bin.slots.map((s) => ({
      name: s.name,
      bone: bin.bones[s.boneIndex]?.name ?? null,
      attachment: s.attachment ?? null,
      color: s.color,
    })),
    skins: bin.skins.map((s) => ({
      name: s.name,
      attachments: Object.fromEntries(
        s.attachments.map((a) => [a.name, {}]),
      ),
    })),
    events: Object.fromEntries(bin.events.map((e) => [e.name, e])),
    animations: Object.fromEntries(
      bin.animations.map((a) => [
        a.name,
        {
          bones: Object.fromEntries(a.timelines.map((t, i) => [`__t${i}`, []])),
          duration: a.duration,
        },
      ]),
    ),
  });
}
