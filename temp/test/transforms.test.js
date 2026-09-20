/**
 * 变换（transforms）+ diff
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkeletonJson } from '../../src/spine/readSkeletonJson.js';
import { validateSkeleton } from '../../src/spine/validate.js';
import { diffSkeleton, matchesExpected } from '../../src/spine/diff.js';
import { renameBone, renameSlot, prefixBones, deleteBone, TRANSFORMS } from '../../src/spine/transforms.js';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

function loadDoc(name) {
  return parseSkeletonJson(readFileSync(join(FIXTURES, name), 'utf-8'));
}

// ─── renameBone ───────────────────────────────────────────────────────────────

test('renameBone: 骨骼自身名字改变', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(doc, 'arm', 'Arm_L');
  const bone = after.bones.find((b) => b.name === 'Arm_L');
  assert.ok(bone, 'Arm_L 骨骼应存在');
  assert.ok(!after.bones.some((b) => b.name === 'arm'), 'arm 旧名不应存在');
});

test('renameBone: 子骨骼的 parent 引用同步更新', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(doc, 'arm', 'Arm_L');
  const hand = after.bones.find((b) => b.name === 'hand');
  assert.equal(hand.parent, 'Arm_L');
});

test('renameBone: 绑定该骨骼的槽位 bone 字段同步更新', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(doc, 'arm', 'Arm_L');
  const slot = after.slots.find((s) => s.name === 'arm_slot');
  assert.equal(slot.bone, 'Arm_L');
});

test('renameBone: 动画 bones 键同步更新', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(doc, 'arm', 'Arm_L');
  const idle = after.animations.find((a) => a.name === 'idle');
  // animations 里的骨骼轨道名反映在 _raw 里
  const rawIdle = after._raw.animations.idle;
  assert.ok('Arm_L' in rawIdle.bones, 'idle 动画应有 Arm_L 轨道');
  assert.ok(!('arm' in rawIdle.bones), 'idle 动画不应有旧 arm 轨道');
});

test('renameBone: IK 约束里的骨骼键同步更新', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(doc, 'arm', 'Arm_L');
  const rawIdle = after._raw.animations.idle;
  // arm_ik/arm 应变成 arm_ik/Arm_L
  assert.ok('arm_ik/Arm_L' in rawIdle.ik, 'IK 键应更新');
  assert.ok(!('arm_ik/arm' in rawIdle.ik), '旧 IK 键不应存在');
});

test('renameBone: validate 通过，无错误无警告', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(doc, 'arm', 'Arm_L');
  const result = validateSkeleton(after);
  const errors = result.issues.filter((i) => i.level === 'error');
  assert.equal(errors.length, 0, `不应有错误: ${JSON.stringify(errors)}`);
  assert.equal(result.ok, true);
});

test('renameBone: 目标名已存在时抛出错误', () => {
  const doc = loadDoc('hero.spine.json');
  assert.throws(() => renameBone(doc, 'arm', 'hand'), /已被占用/);
});

test('renameBone: 源骨骼不存在时抛出错误', () => {
  const doc = loadDoc('hero.spine.json');
  assert.throws(() => renameBone(doc, 'ghost', 'Arm_L'), /不存在/);
});

// ─── renameSlot ───────────────────────────────────────────────────────────────

test('renameSlot: 槽位名改变，validate 通过', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after } = renameSlot(doc, 'arm_slot', 'Arm_Slot');
  assert.ok(after.slots.some((s) => s.name === 'Arm_Slot'), 'Arm_Slot 应存在');
  assert.ok(!after.slots.some((s) => s.name === 'arm_slot'), '旧名不应存在');
  assert.equal(validateSkeleton(after).ok, true);
});

// ─── prefixBones ─────────────────────────────────────────────────────────────

test('prefixBones: 所有骨骼加上前缀，validate 通过', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after, renamed } = prefixBones(doc, 'hero_');
  assert.ok(renamed.length > 0, '应有骨骼被重命名');
  for (const b of after.bones) {
    assert.ok(b.name.startsWith('hero_'), `骨骼 ${b.name} 应以 hero_ 开头`);
  }
  assert.equal(validateSkeleton(after).ok, true);
});

// ─── deleteBone ───────────────────────────────────────────────────────────────

test('deleteBone: 删除叶骨骼，绑定槽位也一并删除', () => {
  const doc = loadDoc('hero.spine.json');
  const { doc: after, removedSlots } = deleteBone(doc, 'hand');
  assert.ok(!after.bones.some((b) => b.name === 'hand'), 'hand 骨骼应不存在');
  assert.ok(removedSlots.includes('hand_slot'), 'hand_slot 应在删除列表');
  assert.ok(!after.slots.some((s) => s.name === 'hand_slot'), 'hand_slot 应从 slots 里删掉');
  assert.equal(validateSkeleton(after).ok, true);
});

test('deleteBone: 有子骨骼时抛出错误', () => {
  const doc = loadDoc('hero.spine.json');
  // torso 有子骨骼 arm
  assert.throws(() => deleteBone(doc, 'torso'), /子骨骼/);
});

// ─── diff ─────────────────────────────────────────────────────────────────────

test('diff: renameBone 后 diff 正确显示 added/removed', () => {
  const before = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(before, 'arm', 'Arm_L');
  const d = diffSkeleton(before, after);
  assert.ok(d.bones.added.includes('Arm_L'), 'bones.added 应含 Arm_L');
  assert.ok(d.bones.removed.includes('arm'), 'bones.removed 应含 arm');
});

test('diff: matchesExpected 用改名后的 diff 验证', () => {
  const before = loadDoc('hero.spine.json');
  const { doc: after } = renameBone(before, 'arm', 'Arm_L');
  const d = diffSkeleton(before, after);
  const check = matchesExpected(d, {
    addedBones: ['Arm_L'],
    removedBones: ['arm'],
  });
  assert.equal(check.ok, true, `matchesExpected 应通过: ${JSON.stringify(check.problems)}`);
});

test('diff: 无变换时 isEmpty 为 true', () => {
  const doc = loadDoc('hero.spine.json');
  const d = diffSkeleton(doc, doc);
  assert.equal(d.isEmpty, true);
});

// ─── TRANSFORMS 注册表 ────────────────────────────────────────────────────────

test('TRANSFORMS 含 rename-bone/rename-slot/prefix-bones/delete-bone', () => {
  for (const key of ['rename-bone', 'rename-slot', 'prefix-bones', 'delete-bone']) {
    assert.ok(key in TRANSFORMS, `TRANSFORMS 缺少 ${key}`);
    assert.equal(typeof TRANSFORMS[key].fn, 'function');
    assert.ok(TRANSFORMS[key].risk, `${key} 缺少 risk`);
  }
});

test('TRANSFORMS: rename-bone/rename-slot/prefix-bones 风险等级为 safe', () => {
  assert.equal(TRANSFORMS['rename-bone'].risk, 'safe');
  assert.equal(TRANSFORMS['rename-slot'].risk, 'safe');
  assert.equal(TRANSFORMS['prefix-bones'].risk, 'safe');
});
