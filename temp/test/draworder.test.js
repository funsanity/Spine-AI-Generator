/**
 * 绘制顺序（槽位顺序）的测试。
 *
 * 这里守的是「骨骼要拓扑序、槽位要 depth 序」这两件**不同**的事。
 * 原来两者共用同一个顺序，于是 depth 小的部件会画在 depth 大的部件之上。
 *
 * 后果不是「层级看着怪」，是默认姿势就画错了：部件切图里那些被前方部件
 * 挖掉、再由补图按推断填回来的区域，会盖住后面部件真正可见的内容。
 * 实测那张角色图：默认姿势合成后颜色偏差 >40 的像素 23029px，其中
 * 22981px（99.8%）都是 right_arm_scissors（depth 1，却排在 depth 2 的
 * 围裙、depth 3 的眼镜之后绘制）补出来的内容盖在真内容上。
 * 按 depth 排之后降到 48px（0.03%）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSkeleton } from '../../server/api/generator.js';

/** depth 故意和拓扑序冲突：手臂是 depth 1，却在 depth 2/3 的部件之后被访问到 */
function fixture() {
  return [
    { name: 'body', parent: null, depth: 0, bbox: { x: 60, y: 140, width: 170, height: 620 }, pivot: { x: 85, y: 10 } },
    { name: 'skirt', parent: 'body', depth: 1, bbox: { x: 65, y: 600, width: 160, height: 200 }, pivot: { x: 80, y: 10 } },
    { name: 'apron', parent: 'skirt', depth: 2, bbox: { x: 70, y: 220, width: 150, height: 400 }, pivot: { x: 75, y: 10 } },
    { name: 'head', parent: 'body', depth: 1, bbox: { x: 80, y: 0, width: 150, height: 245 }, pivot: { x: 75, y: 240 } },
    { name: 'glasses', parent: 'head', depth: 3, bbox: { x: 85, y: 80, width: 130, height: 100 }, pivot: { x: 65, y: 50 } },
    { name: 'left_arm', parent: 'body', depth: 1, bbox: { x: 150, y: 240, width: 90, height: 300 }, pivot: { x: 45, y: 10 } }
  ];
}

const build = (parts) => generateSkeleton({ parts }, '3.8',
  { imageSize: { width: 298, height: 838 }, density: 8 });

const slotNames = (sk) => sk.slots.map((s) => s.name.replace(/_slot$/, ''));

test('槽位按 depth 升序：depth 小的先画，压在后面', () => {
  const parts = fixture();
  const sk = build(parts);
  const depth = new Map(parts.map((p) => [p.name, p.depth]));

  const seq = slotNames(sk).map((n) => depth.get(n));
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] >= seq[i - 1],
      `槽位顺序就是绘制顺序，必须 depth 不降。实际 ${slotNames(sk).join(' → ')}`);
  }

  // 具体到出过问题的那一对��手臂（1）必须画在围裙（2）和眼镜（3）之前
  const order = slotNames(sk);
  assert.ok(order.indexOf('left_arm') < order.indexOf('apron'),
    'depth 1 的手臂不能画在 depth 2 的围裙之上');
  assert.ok(order.indexOf('left_arm') < order.indexOf('glasses'),
    'depth 1 的手臂不能画在 depth 3 的眼镜之上');
});

test('骨骼仍是拓扑序：父骨骼一定在子骨骼之前', () => {
  const sk = build(fixture());
  const at = new Map(sk.bones.map((b, i) => [b.name, i]));
  for (const b of sk.bones) {
    if (!b.parent) continue;
    assert.ok(at.get(b.parent) < at.get(b.name),
      `${b.parent} 必须排在 ${b.name} 之前，否则子骨骼算不出相对偏移`);
  }
});

test('depth 相同时保持拓扑序，父在子前', () => {
  const parts = [
    { name: 'body', parent: null, depth: 0, bbox: { x: 0, y: 0, width: 10, height: 10 }, pivot: { x: 5, y: 5 } },
    // 三个同 depth 的部件，其中 c 是 b 的子级
    { name: 'b', parent: 'body', depth: 1, bbox: { x: 0, y: 0, width: 10, height: 10 }, pivot: { x: 5, y: 5 } },
    { name: 'c', parent: 'b', depth: 1, bbox: { x: 0, y: 0, width: 10, height: 10 }, pivot: { x: 5, y: 5 } },
    { name: 'd', parent: 'body', depth: 1, bbox: { x: 0, y: 0, width: 10, height: 10 }, pivot: { x: 5, y: 5 } }
  ];
  const order = slotNames(build(parts));
  assert.ok(order.indexOf('b') < order.indexOf('c'),
    'depth 打平时按拓扑序，父部件仍该先画');
});

test('底板 depth -1，排在所有部件最前面（画在最底层）', () => {
  const parts = [
    { name: '_base_plate', parent: null, depth: -1, bbox: { x: 0, y: 0, width: 298, height: 838 }, pivot: { x: 149, y: 419 } },
    ...fixture()
  ];
  const order = slotNames(build(parts));
  assert.equal(order[0], '_base_plate',
    '底板必须第一个画，否则它会盖住部件');
});

test('缺 depth 字段当 0，不排到底板前面去', () => {
  const parts = [
    { name: '_base_plate', parent: null, depth: -1, bbox: { x: 0, y: 0, width: 20, height: 20 }, pivot: { x: 10, y: 10 } },
    { name: 'nodepth', parent: null, bbox: { x: 0, y: 0, width: 10, height: 10 }, pivot: { x: 5, y: 5 } }
  ];
  const order = slotNames(build(parts));
  assert.deepEqual(order, ['_base_plate', 'nodepth'],
    'depth 缺失按 0 处理，仍在底板之后');
});
