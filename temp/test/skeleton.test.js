/**
 * JSON 骨架解析 + 校验
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkeletonJson, normalizeSkeleton } from '../../src/spine/readSkeletonJson.js';
import { validateSkeleton } from '../../src/spine/validate.js';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

function loadJson(name) {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

function loadDoc(name) {
  return parseSkeletonJson(loadJson(name));
}

// ─── 解析：hero.spine.json ────────────────────────────────────────────────────

test('hero: 解析出 4 根骨骼，名称和父子关系正确', () => {
  const doc = loadDoc('hero.spine.json');
  assert.equal(doc.bones.length, 4);
  const names = doc.bones.map((b) => b.name);
  assert.deepEqual(names, ['root', 'torso', 'arm', 'hand']);
  assert.equal(doc.bones[0].parent, null);
  assert.equal(doc.bones[1].parent, 'root');
  assert.equal(doc.bones[2].parent, 'torso');
  assert.equal(doc.bones[3].parent, 'arm');
});

test('hero: 解析出 3 个槽位，bone 字段正确', () => {
  const doc = loadDoc('hero.spine.json');
  assert.equal(doc.slots.length, 3);
  const byName = new Map(doc.slots.map((s) => [s.name, s]));
  assert.equal(byName.get('torso_slot').bone, 'torso');
  assert.equal(byName.get('arm_slot').bone, 'arm');
  assert.equal(byName.get('hand_slot').bone, 'hand');
});

test('hero: default 皮肤有 3 个附件，名称正确', () => {
  const doc = loadDoc('hero.spine.json');
  const skin = doc.skins.find((s) => s.name === 'default');
  assert.ok(skin, 'default 皮肤必须存在');
  assert.equal(skin.attachments, 3);
  const attNames = skin.items.map((i) => i.name);
  assert.ok(attNames.includes('torso_img'), '应包含 torso_img');
  assert.ok(attNames.includes('arm_img'), '应包含 arm_img');
  assert.ok(attNames.includes('hand_img'), '应包含 hand_img');
});

test('hero: 有 2 个动画 idle/wave', () => {
  const doc = loadDoc('hero.spine.json');
  const names = doc.animations.map((a) => a.name);
  assert.ok(names.includes('idle'));
  assert.ok(names.includes('wave'));
});

test('hero: 有 1 个 IK 约束 arm_ik（存储在 _raw.ik）', () => {
  const doc = loadDoc('hero.spine.json');
  const ik = doc._raw.ik ?? [];
  assert.equal(ik.length, 1);
  assert.equal(ik[0].name, 'arm_ik');
  assert.deepEqual(ik[0].bones, ['arm', 'hand']);
  assert.equal(ik[0].target, 'arm');
});

// ─── 校验：hero.spine.json（合法骨架） ────────────────────────────────────────

test('hero: validate 通过，零错误零警告', () => {
  const doc = loadDoc('hero.spine.json');
  const result = validateSkeleton(doc);
  const errors = result.issues.filter((i) => i.level === 'error');
  const warnings = result.issues.filter((i) => i.level === 'warning');
  assert.equal(errors.length, 0, `不应有错误，实际: ${JSON.stringify(errors)}`);
  assert.equal(warnings.length, 0, `不应有警告，实际: ${JSON.stringify(warnings)}`);
  assert.equal(result.ok, true);
});

// ─── 校验：broken.spine.json（蓄意损坏） ─────────────────────────────────────

test('broken: validate 报告 bone/missing-parent', () => {
  const doc = loadDoc('broken.spine.json');
  const result = validateSkeleton(doc);
  const codes = result.issues.map((i) => i.code);
  assert.ok(
    codes.includes('bone/missing-parent'),
    `应含 bone/missing-parent，实际 codes: ${codes.join(', ')}`,
  );
});

test('broken: validate 报告 slot/missing-bone', () => {
  const doc = loadDoc('broken.spine.json');
  const result = validateSkeleton(doc);
  const codes = result.issues.map((i) => i.code);
  assert.ok(
    codes.includes('slot/missing-bone'),
    `应含 slot/missing-bone，实际 codes: ${codes.join(', ')}`,
  );
});

test('broken: validate 报告 anim/missing-bone', () => {
  const doc = loadDoc('broken.spine.json');
  const result = validateSkeleton(doc);
  const codes = result.issues.map((i) => i.code);
  assert.ok(
    codes.includes('anim/missing-bone'),
    `应含 anim/missing-bone，实际 codes: ${codes.join(', ')}`,
  );
});

test('broken: validate 至少有 3 个 error，ok 为 false', () => {
  const doc = loadDoc('broken.spine.json');
  const result = validateSkeleton(doc);
  const errors = result.issues.filter((i) => i.level === 'error');
  assert.ok(errors.length >= 3, `应有 ≥3 个错误，实际: ${errors.length}`);
  assert.equal(result.ok, false);
});

test('broken: s2 的 ghost_img 附件未注册，产生 warning 或 error', () => {
  const doc = loadDoc('broken.spine.json');
  const result = validateSkeleton(doc);
  // ghost_img 在 default 皮肤里不存在，slot 的默认附件引用了它
  const attIssue = result.issues.find(
    (i) => i.code === 'slot/missing-attachment' || i.code === 'atlas/missing-region',
  );
  assert.ok(attIssue, '应有 ghost_img 附件缺失的问题');
});

// ─── normalizeSkeleton 幂等 ───────────────────────────────────────────────────

test('normalizeSkeleton 对同一 _raw 调用两次结果相同', () => {
  const doc = loadDoc('hero.spine.json');
  const doc2 = normalizeSkeleton(doc._raw);
  assert.equal(doc2.bones.length, doc.bones.length);
  assert.equal(doc2.slots.length, doc.slots.length);
  assert.equal(doc2.skins.length, doc.skins.length);
  assert.equal(doc2.animations.length, doc.animations.length);
});
