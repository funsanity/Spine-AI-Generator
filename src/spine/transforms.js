/**
 * 骨架变换（transform）。
 *
 * 每个变换是纯粹的 doc → doc 函数，不改磁盘、不调 CLI。
 * 这样拆分的原因：变换是最容易出错的部分，必须能脱离 Spine 单独测试。
 * 往返闭环只负责把变换的输入输出搬进搬出编辑器。
 *
 * 风险分级（沿用社区 MCP 的成熟做法）：
 *   safe        只动名字或元数据，不改变渲染结果
 *   best-effort 会改变结构，可能需要人工确认
 *   experimental 可能破坏数据，默认禁止
 */

import { normalizeSkeleton } from './readSkeletonJson.js';

/**
 * 重命名骨骼，并同步所有引用。
 *
 * 这是验证往返闭环的理想测试用例：它同时触及 bones（自身）、
 * slots（bone 字段）、animations（bones 键），任何一处漏改
 * 都会在 validate 阶段被抓住。
 */
export function renameBone(doc, from, to) {
  const bone = doc.bones.find((b) => b.name === from);
  if (!bone) throw new Error(`骨骼不存在: ${from}`);
  if (doc.bones.some((b) => b.name === to)) {
    throw new Error(`目标骨骼名已被占用: ${to}`);
  }

  const raw = doc._raw;
  const next = structuredClone(raw);

  // 1. 骨骼自身
  const rawBone = (next.bones ?? []).find((b) => b.name === from);
  if (rawBone) rawBone.name = to;

  // 2. 其他骨骼的 parent 引用
  for (const b of next.bones ?? []) {
    if (b.parent === from) b.parent = to;
  }

  // 3. 槽位绑定的骨骼
  for (const s of next.slots ?? []) {
    if (s.bone === from) s.bone = to;
  }

  // 4. 动画时间轴：bones 的键名、以及 IK/Transform/Path 约束里引用的骨骼名
  for (const anim of Object.values(next.animations ?? {})) {
    if (anim.bones && from in anim.bones) {
      anim.bones[to] = anim.bones[from];
      delete anim.bones[from];
    }
    for (const group of ['ik', 'transform', 'path']) {
      const tracks = anim[group];
      if (!tracks) continue;
      // 键形如 "约束名/骨骼名"
      for (const key of Object.keys(tracks)) {
        const [constraint, target] = key.split('/');
        if (target === from) {
          tracks[`${constraint}/${to}`] = tracks[key];
          delete tracks[key];
        }
      }
    }
  }

  // 5. 骨骼皮肤（4.x 的 skinRequired）与 IK 约束的 bones 列表
  for (const skin of next.skins ?? []) {
    if (Array.isArray(skin.bones)) {
      skin.bones = skin.bones.map((n) => (n === from ? to : n));
    }
  }
  for (const group of ['ik', 'transform', 'path']) {
    for (const constraint of next[group] ?? []) {
      if (Array.isArray(constraint.bones)) {
        constraint.bones = constraint.bones.map((n) => (n === from ? to : n));
      }
      if (constraint.target === from) constraint.target = to;
    }
  }

  return { doc: rewrap(doc, next), kind: 'bone', from, to };
}

/**
 * 重命名槽位，同步动画里的槽位键与附件的归属。
 */
export function renameSlot(doc, from, to) {
  if (!doc.slots.some((s) => s.name === from)) throw new Error(`槽位不存在: ${from}`);
  if (doc.slots.some((s) => s.name === to)) throw new Error(`目标槽位名已被占用: ${to}`);

  const next = structuredClone(doc._raw);

  for (const s of next.slots ?? []) {
    if (s.name === from) s.name = to;
  }

  // 皮肤里按槽位名分组
  for (const skin of next.skins ?? []) {
    if (skin.attachments && from in skin.attachments) {
      skin.attachments[to] = skin.attachments[from];
      delete skin.attachments[from];
    }
  }

  // 动画里的 slots 键与 drawOrder 引用
  for (const anim of Object.values(next.animations ?? {})) {
    if (anim.slots && from in anim.slots) {
      anim.slots[to] = anim.slots[from];
      delete anim.slots[from];
    }
    if (Array.isArray(anim.drawOrder)) {
      for (const entry of anim.drawOrder) {
        if (entry && entry.slot === from) entry.slot = to;
      }
    }
  }

  return { doc: rewrap(doc, next), kind: 'slot', from, to };
}

/**
 * 给骨骼名批量加前缀。拆件工具用它把不同部件的骨骼分组，
 * 避免多个部件合并时命名冲突。
 */
export function prefixBones(doc, prefix, filter) {
  const targets = doc.bones
    .filter((b) => (filter ? filter(b) : true))
    .map((b) => b.name)
    .filter((n) => !n.startsWith(prefix));

  let current = doc;
  for (const name of targets) {
    // 逐个改名：每次都要重新取当前状态，因为前一次改名会影响后一次的引用查找
    const res = renameBone(current, name, `${prefix}${name}`);
    current = res.doc;
  }
  return { doc: current, kind: 'bone-prefix', prefix, renamed: targets };
}

/** 删除骨骼，并清理所有引用。保留给 P3 的部件删除功能。 */
export function deleteBone(doc, name) {
  if (!doc.bones.some((b) => b.name === name)) throw new Error(`骨骼不存在: ${name}`);

  // 有子骨骼时不能直接删——会留下悬空 parent
  const children = doc.bones.filter((b) => b.parent === name);
  if (children.length) {
    throw new Error(
      `骨骼 ${name} 还有 ${children.length} 个子骨骼 (${children.map((c) => c.name).join(', ')})，请先处理`,
    );
  }

  const next = structuredClone(doc._raw);
  next.bones = (next.bones ?? []).filter((b) => b.name !== name);

  // 槽位必须绑骨骼，所以挂在它上面的槽位一并删除
  const removedSlots = (next.slots ?? []).filter((s) => s.bone === name).map((s) => s.name);
  next.slots = (next.slots ?? []).filter((s) => s.bone !== name);

  for (const anim of Object.values(next.animations ?? {})) {
    if (anim.bones) delete anim.bones[name];
    for (const slotName of removedSlots) {
      if (anim.slots) delete anim.slots[slotName];
    }
  }

  return { doc: rewrap(doc, next), kind: 'bone-delete', name, removedSlots };
}

/** 变换注册表：CLI 按名字查找，风险等级决定是否需要 --force */
export const TRANSFORMS = {
  'rename-bone': { fn: renameBone, risk: 'safe', args: ['from', 'to'] },
  'rename-slot': { fn: renameSlot, risk: 'safe', args: ['from', 'to'] },
  'prefix-bones': { fn: prefixBones, risk: 'safe', args: ['prefix'] },
  'delete-bone': { fn: deleteBone, risk: 'best-effort', args: ['name'] },
};

/** 变换后重新归一化，让校验和 diff 看到的是最新结构 */
function rewrap(oldDoc, raw) {
  const doc = normalizeSkeleton(raw);
  // 归一化会丢掉编辑器附加字段之外的上下文，这里把原始形态标记带回去
  doc.format = oldDoc.format;
  return doc;
}
