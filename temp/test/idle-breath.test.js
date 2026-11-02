/**
 * 站立呼吸 idle 的回归测试。
 *
 * 用户报过两件事：
 *   1.「生成后的脚看着在摆动」：旧 idle 让 root 整体上下浮动，大腿、小腿也在转。
 *   2.「动起来部件之间有裂痕」：上身平移、腿反向平移的写法里，接缝两侧的部件
 *      各按自己的形状算权重，位移对不上，膝盖、裙摆下沿张开 4~6px。
 * 现在的 idle 是 root 以鞋底为锚的纵向缩放：所有部件同一个仿射变换，接缝不可能张开。
 * 这里按预览渲染器（web/renderer.js 的 composeBone / drawMesh）同一套矩阵公式
 * 逐帧算骨骼世界变换和蒙皮顶点，把「鞋底不动、部件间无相对位移、头顶明显起伏」
 * 钉成数值，而不是看关键帧长什么样。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSkeleton, generateAnimations } from '../../server/api/generator.js';

/** kkk.png（1024x1536）的部件表，取自 temp/repro/analysis.json */
function kkkParts() {
  const p = (name, parent, depth, x, y, width, height, px, py) =>
    ({ name, parent, depth, bbox: { x, y, width, height }, pivot: { x: px, y: py } });
  return [
    p('body', null, 0, 358.4, 245.76, 348.16, 522.24, 174.08, 428.24),
    p('skirt', 'body', 1, 378.88, 599.04, 296.96, 291.84, 148.48, 14.59),
    p('cape', 'body', 2, 281.6, 238.08, 353.28, 422.4, 176.64, 29.57),
    p('head', 'body', 3, 419.84, 61.44, 209.92, 253.44, 104.96, 230.63),
    p('hair', 'head', 4, 389.12, 15.36, 271.36, 222.72, 135.68, 189.31),
    p('upper_arm_l', 'body', 5, 276.48, 284.16, 158.72, 284.16, 138.09, 17.05),
    p('forearm_hand_l', 'upper_arm_l', 6, 158.72, 499.2, 174.08, 307.2, 147.97, 24.58),
    p('upper_arm_r', 'body', 5, 624.64, 284.16, 143.36, 284.16, 20.07, 17.05),
    p('forearm_hand_r', 'upper_arm_r', 6, 732.16, 499.2, 163.84, 314.88, 16.38, 31.49),
    p('thigh_l', 'body', 5, 378.88, 821.76, 128, 245.76, 71.68, 12.29),
    p('shin_boot_l', 'thigh_l', 6, 204.8, 998.4, 286.72, 499.2, 229.38, 19.97),
    p('thigh_r', 'body', 5, 537.6, 821.76, 138.24, 245.76, 66.36, 12.29),
    p('shin_boot_r', 'thigh_r', 6, 619.52, 998.4, 220.16, 499.2, 35.23, 19.97)
  ];
}

const build = (parts, version = '3.8') => {
  const sk = generateSkeleton({ parts }, version, { imageSize: { width: 1024, height: 1536 }, density: 8 });
  return generateAnimations(sk);
};

/** 线性插值采样，和 SpinePreview.sample 一致 */
function sample(keys, field, time, dflt = 0) {
  if (!keys?.length) return dflt;
  const v = (k) => k[field] ?? dflt;
  if (time <= keys[0].time) return v(keys[0]);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      return v(a) + (v(b) - v(a)) * (span > 0 ? (time - a.time) / span : 0);
    }
  }
  return v(keys[keys.length - 1]);
}

/** 某一时刻每根骨骼的世界矩阵，照抄 renderer 的 composeBone（Spine 默认继承） */
function worldAt(sk, time) {
  const tracks = sk.animations?.idle?.bones ?? {};
  const world = new Map();
  for (const bone of sk.bones) {
    const t = tracks[bone.name] ?? {};
    const lx = (bone.x ?? 0) + sample(t.translate, 'x', time);
    const ly = (bone.y ?? 0) + sample(t.translate, 'y', time);
    const deg = (bone.rotation ?? 0) + (sample(t.rotate, 'angle', time) || sample(t.rotate, 'value', time));
    const sx = (bone.scaleX ?? 1) * sample(t.scale, 'x', time, 1);
    const sy = (bone.scaleY ?? 1) * sample(t.scale, 'y', time, 1);
    const r = (deg * Math.PI) / 180;
    const la = Math.cos(r) * sx, lb = -Math.sin(r) * sy, lc = Math.sin(r) * sx, ld = Math.cos(r) * sy;
    const p = bone.parent ? world.get(bone.parent) : { x: 0, y: 0, a: 1, b: 0, c: 0, d: 1 };
    world.set(bone.name, {
      x: p.x + p.a * lx + p.b * ly,
      y: p.y + p.c * lx + p.d * ly,
      a: p.a * la + p.b * lc, b: p.a * lb + p.b * ld,
      c: p.c * la + p.d * lc, d: p.c * lb + p.d * ld,
      deg: (Math.atan2(p.c * la + p.d * lc, p.a * la + p.b * lc) * 180) / Math.PI
    });
  }
  return world;
}

const restOf = (sk) => worldAt({ ...sk, animations: {} }, 0);

/** 附件顶点在某一时刻的世界坐标：mesh 照 renderer.drawMesh 加权蒙皮，region 取四个角 */
function verticesAt(sk, name, rest, cur) {
  const att = sk.skins[0].attachments[`${name}_slot`][name];
  const out = [];
  if (att.type !== 'mesh') {
    const w = cur.get(name);
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const ox = att.x + (dx * att.width) / 2;
      const oy = att.y + (dy * att.height) / 2;
      out.push([w.x + w.a * ox + w.b * oy, w.y + w.c * ox + w.d * oy]);
    }
    return out;
  }
  const slot = rest.get(name);
  for (let v = 0; v < att.vertices.length / 2; v++) {
    const vx = att.vertices[v * 2] + att.x;
    const vy = att.vertices[v * 2 + 1] + att.y;
    const rx = slot.x + slot.a * vx + slot.b * vy;
    const ry = slot.y + slot.c * vx + slot.d * vy;
    let wx = 0;
    let wy = 0;
    att.bones[v].forEach((bn, i) => {
      const w = att.weights[v][i];
      if (!w) return;
      const r0 = rest.get(bn);
      const c = cur.get(bn);
      const det = r0.a * r0.d - r0.b * r0.c;
      const dx = rx - r0.x;
      const dy = ry - r0.y;
      const bx = (r0.d * dx - r0.b * dy) / det;
      const by = (-r0.c * dx + r0.a * dy) / det;
      wx += w * (c.x + c.a * bx + c.b * by);
      wy += w * (c.y + c.c * bx + c.d * by);
    });
    out.push([wx, wy]);
  }
  return out;
}

const TIMES = Array.from({ length: 121 }, (_, i) => (i / 120) * 3);
const partNames = (sk) => sk.slots.map((s) => s.bone);

/** 角色最低点（鞋底）的 Spine y */
function groundOf(sk) {
  const rest = restOf(sk);
  return Math.min(...partNames(sk).flatMap((n) => verticesAt(sk, n, rest, rest).map(([, y]) => y)));
}

/** 头和挂在头下面的部件：允许自己晃，其余部件必须严格跟整体变换走 */
function headTree(sk) {
  const set = new Set(['head']);
  for (const b of sk.bones) if (set.has(b.parent)) set.add(b.name);
  return set;
}

test('站立：鞋底的顶点整段动画都不动', () => {
  const sk = build(kkkParts());
  const rest = restOf(sk);
  const ground = groundOf(sk);
  for (const name of ['shin_boot_l', 'shin_boot_r']) {
    const base = verticesAt(sk, name, rest, rest);
    for (const t of TIMES) {
      verticesAt(sk, name, rest, worldAt(sk, t)).forEach(([x, y], i) => {
        if (base[i][1] > ground + 1) return;
        const d = Math.hypot(x - base[i][0], y - base[i][1]);
        assert.ok(d < 0.01, `${name} 鞋底顶点 ${i} 在 t=${t.toFixed(2)} 漂了 ${d.toFixed(3)}px`);
      });
    }
  }
});

test('不裂：除了头，所有部件的每个顶点都跟同一个整体变换走（接缝两侧零相对位移）', () => {
  const sk = build(kkkParts());
  const rest = restOf(sk);
  const ground = groundOf(sk);
  const skipped = headTree(sk);
  let checked = 0;
  for (const t of TIMES) {
    const cur = worldAt(sk, t);
    // 整体变换 = root 当前矩阵 × root 静止矩阵的逆（root 自己可能不在原点）
    const r0 = rest.get('root');
    const r1 = cur.get('root');
    const sy = r1.d / r0.d;
    const root = { x: r1.x - r0.x, y: r1.y - r0.y * sy, a: 1, b: 0, c: 0, d: sy };
    for (const name of partNames(sk)) {
      if (skipped.has(name)) continue;
      const base = verticesAt(sk, name, rest, rest);
      verticesAt(sk, name, rest, cur).forEach(([x, y], i) => {
        const ex = root.x + root.a * base[i][0] + root.b * base[i][1];
        const ey = root.y + root.c * base[i][0] + root.d * base[i][1];
        assert.ok(Math.hypot(x - ex, y - ey) < 0.01,
          `${name} 顶点 ${i} 在 t=${t.toFixed(2)} 偏离整体变换 ${Math.hypot(x - ex, y - ey).toFixed(3)}px，接缝会张开`);
        checked++;
      });
    }
    // 整体变换以地面为锚
    assert.ok(Math.abs(root.y + root.d * ground - ground) < 0.01, `t=${t.toFixed(2)} 地面线被抬起来了（关键帧取整只该有千分之一像素）`);
  }
  assert.ok(checked > 1000, '没测到多少顶点');
});

test('呼吸：头顶起伏要明显（≥ 角色高度的 1%），又不能大到像在蹦', () => {
  const sk = build(kkkParts());
  const rest = restOf(sk);
  // 头发顶点里最高的那个
  const tops = verticesAt(sk, 'hair', rest, rest);
  const iTop = tops.reduce((m, p, i) => (p[1] > tops[m][1] ? i : m), 0);
  const ys = TIMES.map((t) => verticesAt(sk, 'hair', rest, worldAt(sk, t))[iTop][1]);
  const swing = Math.max(...ys) - Math.min(...ys);
  // 角色从头发顶（y=15）到靴底（y=1497）约 1482px
  assert.ok(swing >= 14.8, `头顶只起伏了 ${swing.toFixed(1)}px，看不出在呼吸`);
  assert.ok(swing <= 28, `头顶起伏 ${swing.toFixed(1)}px，太大像在蹦`);
});

test('呼吸：t=0 是静止姿势；顶层部件、手臂、裙摆、腿都不转，只有头轻轻晃', () => {
  const sk = build(kkkParts());
  const tracks = sk.animations.idle.bones;
  const rest = restOf(sk);
  const t0 = worldAt(sk, 0);
  const swaying = headTree(sk);
  for (const b of sk.bones) {
    if (swaying.has(b.name)) continue; // 头的摆动相位提前了一点，t=0 不在 0°
    const a = rest.get(b.name);
    const c = t0.get(b.name);
    assert.ok(Math.hypot(a.x - c.x, a.y - c.y) < 1e-9 && Math.abs(a.d - c.d) < 1e-9, `${b.name} 在 t=0 不在静止姿势`);
  }
  for (const name of ['body', 'upper_arm_l', 'upper_arm_r', 'forearm_hand_l', 'forearm_hand_r',
    'skirt', 'cape', 'thigh_l', 'thigh_r', 'shin_boot_l', 'shin_boot_r', 'hair']) {
    assert.ok(!tracks[name]?.rotate, `${name} 不该自己转`);
  }
  assert.ok(tracks.head?.rotate?.length, 'head 应该有轻微摆动');
  assert.ok(Math.max(...tracks.head.rotate.map((k) => Math.abs(k.angle))) <= 1, '头晃得太大，脖子会露缝');
});

/*
 * 2026-11-02 实测 kkk（SAM 3 那次）：AI 把披风的 pivot 标在两肩正中，披风就过了
 * 「居中、在腿上方、挂在顶层下」这三条，被当成头一样晃（±0.35°）。
 * 披风侧边一路贴着上衣，上衣侧边又压在披风内衬前面——一层排序表达不了，
 * 一转就在上衣侧边裂出一条 60px 长的缝（idle 内部缝 332px）。
 * 头能晃是因为它整个伸在躯干上方，接缝只有脖子那一小段。
 */
test('呼吸：居中的披风也不转——只有伸出父部件上方的（头）才晃', () => {
  const parts = kkkParts().map((p) => (p.name === 'cape'
    ? { ...p, bbox: { x: 358.4, y: 238.08, width: 348.16, height: 422.4 }, pivot: { x: 174.08, y: 29.57 } }
    : p));
  const tracks = build(parts).animations.idle.bones;
  assert.ok(!tracks.cape?.rotate, '居中披风不该自己转');
  assert.ok(tracks.head?.rotate?.length, 'head 仍然要晃');
});

test('循环：每条轨道首尾关键帧相同，回到开头不跳', () => {
  const sk = build(kkkParts(), '4.2');
  for (const [bone, track] of Object.entries(sk.animations.idle.bones)) {
    for (const [kind, keys] of Object.entries(track)) {
      const a = keys[0];
      const b = keys[keys.length - 1];
      assert.equal(b.time, 3, `${bone}.${kind} 没铺满一个周期`);
      for (const f of ['x', 'y', 'value']) {
        if (f in a) assert.ok(Math.abs(a[f] - b[f]) < 1e-9, `${bone}.${kind}.${f} 首尾不接`);
      }
    }
  }
});

test('名字认不出腿时，贴地的下半身部件也不转，鞋底照样不动', () => {
  const parts = kkkParts().map((p) => ({
    ...p,
    name: p.name.replace('thigh', 'seg_a').replace('shin_boot', 'seg_b'),
    parent: p.parent?.replace('thigh', 'seg_a') ?? null
  }));
  const sk = build(parts);
  const tracks = sk.animations.idle.bones;
  const rest = restOf(sk);
  const ground = groundOf(sk);
  for (const name of ['seg_a_l', 'seg_a_r', 'seg_b_l', 'seg_b_r']) {
    assert.ok(!tracks[name]?.rotate, `${name} 不该转`);
  }
  for (const name of ['seg_b_l', 'seg_b_r']) {
    const base = verticesAt(sk, name, rest, rest);
    const now = verticesAt(sk, name, rest, worldAt(sk, 1.5));
    now.forEach(([x, y], i) => {
      if (base[i][1] > ground + 1) return;
      assert.ok(Math.hypot(x - base[i][0], y - base[i][1]) < 0.01, `${name} 鞋底漂了`);
    });
  }
});
