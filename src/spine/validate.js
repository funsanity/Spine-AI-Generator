/**
 * 骨架一致性校验。
 *
 * 这是 P0 往返闭环里的"守门人"：任何变换（改名、删骨骼、替换附件）
 * 之后都要过一遍，确保引用没有断。Spine 对断引用非常不宽容——
 * 一个指向不存在骨骼的 slot 会让整个导入失败，且报错信息通常
 * 只给出行号，定位成本极高。所以宁可在这里报清楚。
 *
 * 分级：
 *   error   一定会导致 Spine 导入失败
 *   warning 能导入，但行为可能不符合预期
 */

export function validateSkeleton(doc, options = {}) {
  const issues = [];
  const err = (code, message, where) => issues.push({ level: 'error', code, message, where });
  const warn = (code, message, where) => issues.push({ level: 'warning', code, message, where });

  const boneNames = new Set();
  const boneByName = new Map();

  // --- 骨骼 ---
  doc.bones.forEach((bone, i) => {
    if (!bone.name) {
      err('bone/no-name', `第 ${i} 根骨骼没有 name`, { kind: 'bone', index: i });
      return;
    }
    if (boneNames.has(bone.name)) {
      err('bone/duplicate-name', `骨骼名重复: ${bone.name}`, { kind: 'bone', name: bone.name });
    }
    boneNames.add(bone.name);
    boneByName.set(bone.name, bone);
  });

  // 父子关系：父必须存在，且不能成环（自引用是最常见的成环形式）
  for (const bone of doc.bones) {
    if (!bone.parent) continue;
    if (bone.parent === bone.name) {
      err('bone/self-parent', `骨骼 ${bone.name} 以自己为父`, { kind: 'bone', name: bone.name });
    } else if (!boneNames.has(bone.parent)) {
      err(
        'bone/missing-parent',
        `骨骼 ${bone.name} 的父 ${bone.parent} 不存在`,
        { kind: 'bone', name: bone.name },
      );
    }
  }

  const cycles = findBoneCycles(doc.bones, boneByName);
  for (const cycle of cycles) {
    err('bone/cycle', `骨骼父子成环: ${cycle.join(' → ')}`, { kind: 'bone', name: cycle[0] });
  }

  // --- 槽位 ---
  const slotNames = new Set();
  doc.slots.forEach((slot, i) => {
    if (!slot.name) {
      err('slot/no-name', `第 ${i} 个槽位没有 name`, { kind: 'slot', index: i });
      return;
    }
    if (slotNames.has(slot.name)) {
      err('slot/duplicate-name', `槽位名重复: ${slot.name}`, { kind: 'slot', name: slot.name });
    }
    slotNames.add(slot.name);

    if (!slot.bone) {
      err('slot/no-bone', `槽位 ${slot.name} 没有 bone`, { kind: 'slot', name: slot.name });
    } else if (!boneNames.has(slot.bone)) {
      err(
        'slot/missing-bone',
        `槽位 ${slot.name} 引用的骨骼 ${slot.bone} 不存在`,
        { kind: 'slot', name: slot.name },
      );
    }
  });

  // --- 皮肤与附件 ---
  const attachmentNames = new Set();
  for (const skin of doc.skins) {
    for (const att of collectAttachments(skin)) {
      attachmentNames.add(att.name);
    }
  }

  // 槽位上的默认附件必须能在某个皮肤里找到
  for (const slot of doc.slots) {
    if (!slot.attachment) continue;
    if (!attachmentNames.has(slot.attachment)) {
      warn(
        'slot/missing-attachment',
        `槽位 ${slot.name} 的附件 ${slot.attachment} 未在任何皮肤中定义`,
        { kind: 'slot', name: slot.name },
      );
    }
  }

  // --- 动画 ---
  for (const anim of doc.animations) {
    for (const boneRef of anim.bones) {
      if (!boneNames.has(boneRef)) {
        err(
          'anim/missing-bone',
          `动画 ${anim.name} 引用了不存在的骨骼 ${boneRef}`,
          { kind: 'animation', name: anim.name },
        );
      }
    }
    for (const slotRef of anim.slots) {
      if (!slotNames.has(slotRef)) {
        err(
          'anim/missing-slot',
          `动画 ${anim.name} 引用了不存在的槽位 ${slotRef}`,
          { kind: 'animation', name: anim.name },
        );
      }
    }
    if (anim.duration === 0 && options.warnEmptyAnimations !== false) {
      warn(
        'anim/empty',
        `动画 ${anim.name} 没有任何关键帧`,
        { kind: 'animation', name: anim.name },
      );
    }
  }

  // --- 图集覆盖（可选，需要传入 atlas 部件清单）---
  if (options.atlasParts) {
    const atlasNames = new Set(options.atlasParts.map((p) => p.name));
    for (const name of attachmentNames) {
      if (!atlasNames.has(name)) {
        warn(
          'atlas/missing-region',
          `附件 ${name} 在图集中没有对应区域`,
          { kind: 'attachment', name },
        );
      }
    }
  }

  return {
    ok: issues.every((i) => i.level !== 'error'),
    issues,
    errors: issues.filter((i) => i.level === 'error'),
    warnings: issues.filter((i) => i.level === 'warning'),
  };
}

/**
 * 枚举皮肤里的所有附件。
 * 附件清单已在 normalizeSkeleton 阶段展平为 items，这里直接复用——
 * 避免两处各自实现一遍三层/两层的结构判别，那种重复迟早会不一致。
 */
function* collectAttachments(skin) {
  if (!skin || !Array.isArray(skin.items)) return;
  for (const item of skin.items) yield item;
}

/** 沿 parent 指针向上走，用染色法找环 */
function findBoneCycles(bones, boneByName) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const cycles = [];
  const seen = new Set();

  for (const bone of bones) {
    if (color.get(bone.name) === BLACK || !boneByName.has(bone.name)) continue;
    const path = [];
    let cur = bone;
    while (cur) {
      const c = color.get(cur.name) ?? WHITE;
      if (c === BLACK) break;
      if (c === GRAY) {
        const start = path.findIndex((p) => p.name === cur.name);
        const cycle = path.slice(start).map((p) => p.name);
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...cycle, cur.name]);
        }
        break;
      }
      color.set(cur.name, GRAY);
      path.push(cur);
      cur = cur.parent ? boneByName.get(cur.parent) : null;
    }
    for (const p of path) color.set(p.name, BLACK);
  }
  return cycles;
}
