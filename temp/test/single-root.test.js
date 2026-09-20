/**
 * 骨架必须只有一根无父骨骼。
 *
 * Spine 编辑器导入 .spine 时对此是**硬性要求**：多一根就整份拒绝，
 *   [error] Skeleton cannot have multiple root bones: body
 *   ERROR: Unable to import skeleton.
 * 而运行时（Cocos/Unity 加载 .json）不校验这条，所以三件套看着好好的，
 * 只有「导不出 .spine」这一个症状——很容易被当成 Spine CLI 的问题去查。
 *
 * 多根是怎么来的：AI 部件表里顶层部件本来就可能不止一个（角色 body 是一个，
 * 补洞用的 _base_plate 底板是另一个，两者谁也不该是谁的子级）。
 * 所以不能靠「约束部件表只能有一个顶层」来解决，得在骨架里加一根
 * 合成的 root 骨骼，把所有顶层部件挂上去。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSkeleton, generateAnimations } from '../../server/api/generator.js';
import { buildExportSkeleton, restWorldBones } from '../../server/api/targets.js';

/** 两个顶层部件：角色主体 + 底板。这正是实际导出时报错的那份结构 */
function multiRootParts() {
  return [
    { name: '_base_plate', parent: null, depth: 0, bbox: { x: 0, y: 0, width: 298, height: 838 }, pivot: { x: 149, y: 419 } },
    { name: 'body', parent: null, depth: 1, bbox: { x: 60, y: 140, width: 170, height: 620 }, pivot: { x: 85, y: 10 } },
    { name: 'head', parent: 'body', depth: 2, bbox: { x: 80, y: 0, width: 150, height: 245 }, pivot: { x: 75, y: 240 } },
    { name: 'glasses', parent: 'head', depth: 3, bbox: { x: 85, y: 80, width: 130, height: 100 }, pivot: { x: 65, y: 50 } }
  ];
}

const build = (parts) => generateSkeleton({ parts }, '3.8',
  { imageSize: { width: 298, height: 838 }, density: 8 });

const rootsOf = (bones) => bones.filter((b) => !b.parent).map((b) => b.name);

test('预览骨架：多个顶层部件也只留一根无父骨骼', () => {
  const sk = build(multiRootParts());
  assert.deepEqual(rootsOf(sk.bones), ['root'],
    `无父骨骼只能有一根，实际 ${rootsOf(sk.bones).join(' / ')}`);
});

test('root 骨骼排在最前、位于原点，且不占槽位', () => {
  const sk = build(multiRootParts());
  assert.equal(sk.bones[0].name, 'root', 'root 必须是 bones[0]，父骨骼要在子骨骼之前');
  assert.equal(sk.bones[0].x ?? 0, 0);
  assert.equal(sk.bones[0].y ?? 0, 0);
  assert.ok(!sk.slots.some((s) => s.bone === 'root'), 'root 是纯变换骨骼，不该挂附件');
});

test('顶层部件挂到 root 上，世界位置一个像素都不动', () => {
  const parts = multiRootParts();
  const withRoot = build(parts);

  // 参照：把同一份部件单独当单根骨架算出来的绝对锚点
  const solo = build([parts[1], parts[2], parts[3]]);
  const soloWorld = restWorldBones(solo.bones);
  const world = restWorldBones(withRoot.bones);

  for (const name of ['body', 'head', 'glasses']) {
    assert.equal(world.get(name).x, soloWorld.get(name).x, `${name} 的世界 X 变了`);
    assert.equal(world.get(name).y, soloWorld.get(name).y, `${name} 的世界 Y 变了`);
  }
  // 除了 root 自己，每根骨骼都得有父级
  for (const b of withRoot.bones) {
    if (b.name === 'root') continue;
    assert.ok(b.parent, `${b.name} 仍然没有父骨骼`);
  }
});

test('导出骨架（buildExportSkeleton）同样只有一根无父骨骼', () => {
  const sk = build(multiRootParts());
  generateAnimations(sk);
  const { json } = buildExportSkeleton(sk, 'cocos-3.8');
  assert.deepEqual(rootsOf(json.bones), ['root'],
    `导出这一步不能把 root 丢掉，实际 ${rootsOf(json.bones).join(' / ')}`);
  assert.equal(json.bones[0].name, 'root');
});

test('部件自己叫 root 时不自指，也仍是单根', () => {
  const sk = build([
    { name: 'root', parent: null, depth: 0, bbox: { x: 0, y: 0, width: 100, height: 100 }, pivot: { x: 50, y: 50 } },
    { name: 'arm', parent: 'root', depth: 1, bbox: { x: 20, y: 20, width: 40, height: 60 }, pivot: { x: 20, y: 10 } }
  ]);
  assert.equal(rootsOf(sk.bones).length, 1, `无父骨骼只能有一根，实际 ${rootsOf(sk.bones).join(' / ')}`);
  for (const b of sk.bones) {
    assert.notEqual(b.parent, b.name, `${b.name} 把自己当了父骨骼`);
  }
  // 部件表里那个 root 仍然要有自己的槽位，名字不能被合成骨骼顶掉
  assert.ok(sk.slots.some((s) => s.bone === 'root'), '部件 root 的槽位丢了');
});

test('动画：顶层部件不被单独旋转（转它等于转整个角色/底板，接缝会露）', () => {
  const sk = build(multiRootParts());
  generateAnimations(sk);
  const idle = sk.animations.idle.bones;
  assert.ok(idle.root?.translate, 'idle 的整体起伏应该落在 root 上');
  assert.ok(!idle._base_plate, '底板不该自己转');
  assert.ok(!idle.body, '顶层部件不该自己转');
  assert.ok(idle.head?.rotate, '真正的子部件还是要动');
});

test('动画：只产出 idle，不产出 wave', () => {
  const sk = build(multiRootParts());
  generateAnimations(sk);
  assert.deepEqual(Object.keys(sk.animations), ['idle'],
    `只该有 idle，实际 ${Object.keys(sk.animations).join(' / ')}`);
});
