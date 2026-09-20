/**
 * 骨架结构 diff。
 *
 * 往返闭环的核心判据：导出 → 变换 → 回导 → 再导出，
 * 两次导出之间的差异必须完全等于"我们主动做的变换"。
 * 任何多余差异都意味着数据在往返中丢了或被改了。
 *
 * 有意只比对结构（有什么、叫什么、谁引用谁），不比对关键帧数值——
 * Spine 在导入时会重新采样曲线，数值层面必然有微小漂移，
 * 逐位比对只会产生噪音。
 */

export function diffSkeleton(before, after) {
  const result = {
    bones: diffNamed(before.bones, after.bones),
    slots: diffNamed(before.slots, after.slots),
    skins: diffNamed(before.skins, after.skins),
    animations: diffNamed(before.animations, after.animations),
    events: diffNamed(before.events, after.events),
  };

  // 骨骼的父子关系变化单独列出：改名不算变，改结构才算
  result.reparented = [];
  const afterBones = new Map(after.bones.map((b) => [b.name, b]));
  for (const b of before.bones) {
    const a = afterBones.get(b.name);
    if (a && (a.parent ?? null) !== (b.parent ?? null)) {
      result.reparented.push({ name: b.name, from: b.parent ?? null, to: a.parent ?? null });
    }
  }

  result.isEmpty = isDiffEmpty(result);
  return result;
}

function diffNamed(beforeList, afterList) {
  const beforeNames = new Set(beforeList.map((x) => x.name));
  const afterNames = new Set(afterList.map((x) => x.name));
  return {
    added: [...afterNames].filter((n) => !beforeNames.has(n)),
    removed: [...beforeNames].filter((n) => !afterNames.has(n)),
    // 同名但数量不同，说明有重复名——通常是改名操作的副作用
    countBefore: beforeList.length,
    countAfter: afterList.length,
  };
}

function isDiffEmpty(d) {
  if (d.reparented.length > 0) return false;
  for (const group of [d.bones, d.slots, d.skins, d.animations, d.events]) {
    if (group.added.length || group.removed.length) return false;
  }
  return true;
}

/**
 * 把 diff 渲染成人类可读的文本，给 CLI 直接输出。
 */
export function formatDiff(diff) {
  const lines = [];

  const section = (title, group) => {
    if (!group.added.length && !group.removed.length) return;
    lines.push(`  ${title}:`);
    for (const n of group.added) lines.push(`    + ${n}`);
    for (const n of group.removed) lines.push(`    - ${n}`);
  };

  section('骨骼', diff.bones);
  section('槽位', diff.slots);
  section('皮肤', diff.skins);
  section('动画', diff.animations);
  section('事件', diff.events);

  if (diff.reparented.length) {
    lines.push('  父子关系变更:');
    for (const r of diff.reparented) {
      lines.push(`    ~ ${r.name}: ${r.from ?? '(无)'} → ${r.to ?? '(无)'}`);
    }
  }

  if (!lines.length) lines.push('  (无差异)');
  return lines.join('\n');
}

/**
 * 判断实际差异是否在预期范围内。
 * expected 形如 { addedBones: ['x'], removedBones: ['y'] }，
 * 用于给往返测试做断言——不是"有没有差异"，而是"差异对不对"。
 */
export function matchesExpected(diff, expected = {}) {
  const problems = [];

  const check = (label, actual, want) => {
    if (!want) return;
    const actualSet = new Set(actual);
    for (const item of want) {
      if (!actualSet.has(item)) problems.push(`${label} 缺少预期的 ${item}`);
    }
    for (const item of actual) {
      if (!want.includes(item)) problems.push(`${label} 出现未预期的 ${item}`);
    }
  };

  check('新增骨骼', diff.bones.added, expected.addedBones);
  check('删除骨骼', diff.bones.removed, expected.removedBones);
  check('新增槽位', diff.slots.added, expected.addedSlots);
  check('删除槽位', diff.slots.removed, expected.removedSlots);
  check('新增动画', diff.animations.added, expected.addedAnimations);
  check('删除动画', diff.animations.removed, expected.removedAnimations);

  return { ok: problems.length === 0, problems };
}
