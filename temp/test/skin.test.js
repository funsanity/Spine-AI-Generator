/**
 * 蒙皮网格与导出转换的回归测试。
 *
 * 这两处的错都是「静默」的——骨架照样加载、动画照样播，只是形变不对
 * 或者权重根本没被读。所以用数值断言把约定钉死：
 *   1. 顶点空间原点必须落在骨骼原点（pivot 处），静止姿势能精确还原原 bbox
 *   2. 导出的加权网格 vertices.length 必须不等于 uvs.length，
 *      运行时正是靠这个长度差判定「这是加权网格」的
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSkinnedMesh } from '../../server/api/mesh.js';
import { generateSkeleton, generateAnimations } from '../../server/api/generator.js';
import { buildExportSkeleton, restWorldBones } from '../../server/api/targets.js';

const W = 600;
const H = 500;

// pivot 故意取非中心：中心 pivot 下 -pivot.x 恰好等于 -w/2，
// 两种偏移约定的结果一样，测不出区别。
const PARTS = [
  { name: 'body', parent: null, bbox: { x: 100, y: 100, width: 400, height: 300 }, pivot: { x: 200, y: 150 } },
  { name: 'lens', parent: 'body', bbox: { x: 200, y: 200, width: 200, height: 200 }, pivot: { x: 40, y: 70 } }
];

const analysis = { parts: PARTS };

/** 像素坐标 → Spine 坐标（原点居中、Y 向上） */
const toSpine = (px, py) => ({ x: px - W / 2, y: H / 2 - py });

function meshOf(skeleton, partName) {
  const skins = Array.isArray(skeleton.skins) ? skeleton.skins : [{ attachments: skeleton.skins.default }];
  return skins[0].attachments[`${partName}_slot`][partName];
}

test('buildSkinnedMesh: offset 等于 (-pivot.x, +pivot.y)', () => {
  const part = PARTS[1];
  const mesh = buildSkinnedMesh(part, PARTS[0], { density: 8 });

  assert.equal(mesh.offset.x, -part.pivot.x);
  assert.equal(mesh.offset.y, part.pivot.y);
});

test('buildSkinnedMesh: uvs 与顶点一一对应，hull 是外轮廓顶点数', () => {
  const mesh = buildSkinnedMesh(PARTS[1], PARTS[0], { density: 8 });

  assert.equal(mesh.uvs.length, mesh.vertices.length);
  assert.equal(mesh.weights.length, mesh.vertices.length / 2);
  assert.ok(mesh.hull > 0 && mesh.hull <= mesh.vertices.length / 2);
  // triangles 是索引三元组
  assert.equal(mesh.triangles.length % 3, 0);
  for (const i of mesh.triangles) {
    assert.ok(i >= 0 && i < mesh.vertices.length / 2, `三角形索引 ${i} 越界`);
  }
});

test('buildSkinnedMesh: 每个顶点权重之和为 1', () => {
  const mesh = buildSkinnedMesh(PARTS[1], PARTS[0], { density: 8 });

  for (const influences of mesh.weights) {
    const sum = influences.reduce((s, inf) => s + inf.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-3, `权重和 ${sum} 偏离 1`);
  }
});

test('静止姿势：顶点 + 附件偏移 + 骨骼世界位置 精确还原原 bbox', () => {
  const skeleton = generateSkeleton(analysis, '4.0', { imageSize: { width: W, height: H }, density: 8 });
  const world = restWorldBones(skeleton.bones);
  const att = meshOf(skeleton, 'lens');

  assert.equal(att.type, 'mesh');

  const bone = world.get('lens');
  const xs = [];
  const ys = [];
  for (let v = 0; v < att.vertices.length / 2; v++) {
    xs.push(bone.x + att.vertices[v * 2] + att.x);
    ys.push(bone.y + att.vertices[v * 2 + 1] + att.y);
  }

  const bb = PARTS[1].bbox;
  const topLeft = toSpine(bb.x, bb.y);
  const bottomRight = toSpine(bb.x + bb.width, bb.y + bb.height);

  assert.ok(Math.abs(Math.min(...xs) - topLeft.x) < 0.05, `左边缘 ${Math.min(...xs)} != ${topLeft.x}`);
  assert.ok(Math.abs(Math.max(...xs) - bottomRight.x) < 0.05, `右边缘 ${Math.max(...xs)} != ${bottomRight.x}`);
  assert.ok(Math.abs(Math.max(...ys) - topLeft.y) < 0.05, `上边缘 ${Math.max(...ys)} != ${topLeft.y}`);
  assert.ok(Math.abs(Math.min(...ys) - bottomRight.y) < 0.05, `下边缘 ${Math.min(...ys)} != ${bottomRight.y}`);
});

test('generateSkeleton: 有父级的部件才蒙皮，根部件保持 region', () => {
  const skeleton = generateSkeleton(analysis, '4.0', { imageSize: { width: W, height: H }, density: 8 });

  assert.equal(meshOf(skeleton, 'body').type, 'region');
  assert.equal(meshOf(skeleton, 'lens').type, 'mesh');
  assert.equal(skeleton.stats.skinnedParts, 1);
  assert.equal(skeleton.stats.regionParts, 1);
});

test('generateSkeleton: 子骨骼坐标是相对父骨骼的偏移', () => {
  const skeleton = generateSkeleton(analysis, '4.0', { imageSize: { width: W, height: H }, density: 8 });

  const body = skeleton.bones.find((b) => b.name === 'body');
  const lens = skeleton.bones.find((b) => b.name === 'lens');

  const bodyAnchor = toSpine(100 + 200, 100 + 150);
  const lensAnchor = toSpine(200 + 40, 200 + 70);

  assert.ok(Math.abs(body.x - bodyAnchor.x) < 1e-6);
  assert.ok(Math.abs(body.y - bodyAnchor.y) < 1e-6);
  assert.equal(lens.parent, 'body');
  assert.ok(Math.abs(lens.x - (lensAnchor.x - bodyAnchor.x)) < 1e-6);
  assert.ok(Math.abs(lens.y - (lensAnchor.y - bodyAnchor.y)) < 1e-6);
});

test('导出 cocos-3.8：skins 是对象形状，旋转键名是 angle', () => {
  const skeleton = generateSkeleton(analysis, '3.8', { imageSize: { width: W, height: H }, density: 8 });
  generateAnimations(skeleton);

  const { json, target, stats } = buildExportSkeleton(skeleton, 'cocos-3.8');

  assert.equal(target.id, 'cocos-3.8');
  assert.equal(json.skeleton.spine, '3.8.75');
  // 3.8 的 skins 是对象，不是数组——写成数组运行时读不到任何附件
  assert.ok(!Array.isArray(json.skins));
  assert.ok(json.skins.default);
  assert.equal(stats.meshCount, 1);
  assert.equal(stats.weightedCount, 1);

  const rotKeys = Object.values(json.animations.idle.bones)
    .filter((t) => t.rotate)
    .flatMap((t) => t.rotate);
  assert.ok(rotKeys.length > 0, 'idle 应含旋转关键帧');
  for (const k of rotKeys) {
    assert.ok('angle' in k, '3.8 旋转关键帧必须用 angle');
    assert.ok(!('value' in k));
  }
});

test('导出 spine-4.0：skins 是数组形状，旋转键名是 value', () => {
  const skeleton = generateSkeleton(analysis, '4.0', { imageSize: { width: W, height: H }, density: 8 });
  generateAnimations(skeleton);

  const { json } = buildExportSkeleton(skeleton, 'spine-4.0');

  assert.ok(Array.isArray(json.skins));
  assert.equal(json.skins[0].name, 'default');

  const rotKeys = Object.values(json.animations.idle.bones)
    .filter((t) => t.rotate)
    .flatMap((t) => t.rotate);
  for (const k of rotKeys) {
    assert.ok('value' in k, '4.x 旋转关键帧必须用 value');
  }
});

test('导出的加权网格 vertices.length 必须不等于 uvs.length', () => {
  const skeleton = generateSkeleton(analysis, '3.8', { imageSize: { width: W, height: H }, density: 8 });
  const { json } = buildExportSkeleton(skeleton, 'cocos-3.8');

  const att = json.skins.default.lens_slot.lens;

  // 运行时就是靠这个长度差区分加权 / 无权重网格。
  // 相等会被判成无权重网格，权重直接不读——蒙皮等于没做。
  assert.notEqual(att.vertices.length, att.uvs.length);
  // 加权网格不吃 x/y 偏移，偏移必须已经合进顶点
  assert.ok(!('x' in att));
  assert.ok(!('y' in att));
  // path 不带扩展名，atlas 区域名也不带
  assert.equal(att.path, 'lens');
});

test('导出的加权网格能解回原 bbox（权重加权还原）', () => {
  const skeleton = generateSkeleton(analysis, '3.8', { imageSize: { width: W, height: H }, density: 8 });
  const { json } = buildExportSkeleton(skeleton, 'cocos-3.8');

  const world = restWorldBones(skeleton.bones);
  const boneWorld = skeleton.bones.map((b) => world.get(b.name));
  const att = json.skins.default.lens_slot.lens;

  // 按 Spine 规范解码：[n, boneIndex,x,y,w, boneIndex,x,y,w, ...]
  const xs = [];
  const ys = [];
  let i = 0;
  while (i < att.vertices.length) {
    const n = att.vertices[i++];
    let wx = 0;
    let wy = 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const bi = att.vertices[i++];
      const vx = att.vertices[i++];
      const vy = att.vertices[i++];
      const w = att.vertices[i++];
      const bw = boneWorld[bi];
      wx += (bw.x + vx) * w;
      wy += (bw.y + vy) * w;
      sum += w;
    }
    assert.ok(Math.abs(sum - 1) < 1e-3, `权重和 ${sum} 偏离 1`);
    xs.push(wx);
    ys.push(wy);
  }

  assert.equal(xs.length, att.uvs.length / 2);

  const bb = PARTS[1].bbox;
  const topLeft = toSpine(bb.x, bb.y);
  const bottomRight = toSpine(bb.x + bb.width, bb.y + bb.height);

  assert.ok(Math.abs(Math.min(...xs) - topLeft.x) < 0.5, `左边缘 ${Math.min(...xs)} != ${topLeft.x}`);
  assert.ok(Math.abs(Math.max(...xs) - bottomRight.x) < 0.5, `右边缘 ${Math.max(...xs)} != ${bottomRight.x}`);
  assert.ok(Math.abs(Math.max(...ys) - topLeft.y) < 0.5, `上边缘 ${Math.max(...ys)} != ${topLeft.y}`);
  assert.ok(Math.abs(Math.min(...ys) - bottomRight.y) < 0.5, `下边缘 ${Math.min(...ys)} != ${bottomRight.y}`);
});

/*
 * Unity 目标。
 *
 * Unity 没有内置 Spine 运行时，用的是官方 spine-unity 包，它跟随编辑器版本
 * 走 4.x 线。所以 Unity 档不能复用 Cocos 那套 3.8 参数——3.8 的 skins 是对象、
 * 旋转关键帧写 angle，4.x 是数组、写 value。抄错任意一处都是静默失败：
 * 骨架能加载但没附件，或者动画不转。
 */
test('unity 目标走 4.x 形状：skins 是数组、旋转写 value', () => {
  const skeleton = generateSkeleton(analysis, '4.2', { imageSize: { width: W, height: H }, density: 6 });
  generateAnimations(skeleton);   // 原地写 skeleton.animations

  const { json, target } = buildExportSkeleton(skeleton, 'unity');

  assert.equal(target.id, 'unity');
  assert.ok(Array.isArray(json.skins), 'unity 是 4.x 线，skins 必须是数组');
  assert.equal(json.skeleton.spine, '4.2.10', 'spine-unity 默认吃 4.2');

  // 旋转关键帧的字段名：4.x 是 value，3.8 是 angle
  const tracks = Object.values(json.animations)
    .flatMap((a) => Object.values(a.bones ?? {}))
    .filter((t) => t.rotate?.length);
  assert.ok(tracks.length, '没有旋转关键帧，这条测不到东西');
  for (const t of tracks) {
    for (const k of t.rotate) {
      assert.ok('value' in k, `4.x 的旋转关键帧字段应是 value，实际拿到 ${JSON.stringify(k)}`);
      assert.ok(!('angle' in k), 'angle 是 3.8 的写法，混进 4.x 里运行时读不到旋转');
    }
  }
});

test('同一份骨架导给 cocos 和 unity，形状必须不同', () => {
  const skeleton = generateSkeleton(analysis, '4.2', { imageSize: { width: W, height: H }, density: 6 });

  const cocos = buildExportSkeleton(skeleton, 'cocos-3.8').json;
  const unity = buildExportSkeleton(skeleton, 'unity').json;

  assert.ok(!Array.isArray(cocos.skins), 'cocos-3.8 的 skins 是对象');
  assert.ok(Array.isArray(unity.skins), 'unity 的 skins 是数组');
  assert.notEqual(cocos.skeleton.spine, unity.skeleton.spine);

  // 两边的网格数据本身应该一致：差别只在容器形状和版本号上
  const cocosMesh = cocos.skins.default.lens_slot.lens;
  const unityMesh = unity.skins.find((s) => s.name === 'default').attachments.lens_slot.lens;
  assert.deepEqual(cocosMesh.vertices, unityMesh.vertices, '同一份骨架的顶点不该因目标而变');
  assert.deepEqual(cocosMesh.triangles, unityMesh.triangles);
});

/*
 * 剖分质量：退化三角、重叠、覆盖、绕向。
 *
 * 这一组盯的是同一个历史问题——曾经的扇形剖分把所有点按质心角度排序，
 * 再拿 order[0] 连每一对相邻点。内部栅格点会和边界点落在同一条射线上，
 * 于是既出零面积三角，扇形之间又互相叠。实测 head 部件 density 8：
 * 16 个三角里 9 个的重心落在别的三角内部，面积之和是凸包的 1.38 倍。
 * Spine 导入时报 "Fixed mesh (invalid triangles)" 然后自己改掉——
 * 但那是 Spine 好心，Cocos / Unity 的运行时不保证也这么做；
 * 而且重叠区域的顶点会被加权变换算两遍，接缝处的形变量凭空翻倍。
 *
 * 零面积的判据必须用叉积，不能查"索引有没有重复"：三点共线但索引互不
 * 相同才是真实来源，只查重复索引一个都抓不到。
 */
const zeroAreaCount = (mesh) => {
  let n = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [i1, i2, i3] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
    const x1 = mesh.vertices[i1 * 2], y1 = mesh.vertices[i1 * 2 + 1];
    const x2 = mesh.vertices[i2 * 2], y2 = mesh.vertices[i2 * 2 + 1];
    const x3 = mesh.vertices[i3 * 2], y3 = mesh.vertices[i3 * 2 + 1];
    if (Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) < 1e-6) n++;
  }
  return n;
};

test('buildSkinnedMesh: 各密度下都不产出零面积三角', () => {
  // 真实一点的部件尺寸：不整齐、pivot 不居中。整齐的方块反而不容易踩到共线
  const body = { name: 'body', parent: null, bbox: { x: 61, y: 214, width: 176, height: 331 }, pivot: { x: 88, y: 20 } };
  const cases = [
    { name: 'head',  parent: 'body', bbox: { x: 79, y: 34,  width: 143, height: 187 }, pivot: { x: 71, y: 170 } },
    { name: 'arm',   parent: 'body', bbox: { x: 27, y: 246, width: 74,  height: 163 }, pivot: { x: 55, y: 18 } },
    { name: 'skirt', parent: 'body', bbox: { x: 52, y: 441, width: 195, height: 148 }, pivot: { x: 97, y: 12 } }
  ];

  for (const density of [3, 4, 6, 8, 12, 16, 24]) {
    for (const part of cases) {
      const mesh = buildSkinnedMesh(part, body, { density });
      assert.equal(zeroAreaCount(mesh), 0,
        `density ${density} 的 ${part.name} 出了零面积三角——Spine 会报 invalid triangles，别的运行时可能直接画坏`);
      // 丢掉退化片之后仍要有可画的面
      assert.ok(mesh.triangles.length >= 3, `density ${density} 的 ${part.name} 一个三角都不剩了`);
      assert.equal(mesh.triangles.length % 3, 0, '三角索引数必须是 3 的倍数');
    }
  }
});

test('导出后的网格也没有零面积三角（加权坐标下复核）', () => {
  const skeleton = generateSkeleton(analysis, '3.8', { imageSize: { width: W, height: H }, density: 8 });
  const { json } = buildExportSkeleton(skeleton, 'cocos-3.8');

  for (const [slot, atts] of Object.entries(json.skins.default)) {
    for (const [nm, m] of Object.entries(atts)) {
      if (m.type !== 'mesh') continue;
      // 加权网格的 vertices 是 [n, (bone,x,y,w)*n, ...]，先按权重解回世界坐标
      const pts = [];
      let i = 0;
      while (i < m.vertices.length) {
        const c = m.vertices[i++];
        let x = 0, y = 0;
        for (let k = 0; k < c; k++) {
          const bx = m.vertices[i + 1], by = m.vertices[i + 2], w = m.vertices[i + 3];
          i += 4; x += bx * w; y += by * w;
        }
        pts.push([x, y]);
      }
      for (let t = 0; t < m.triangles.length; t += 3) {
        const [[x1, y1], [x2, y2], [x3, y3]] =
          [pts[m.triangles[t]], pts[m.triangles[t + 1]], pts[m.triangles[t + 2]]];
        assert.ok(Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) > 1e-6,
          `${slot}/${nm} 的第 ${t / 3} 个三角在加权坐标下面积为 0`);
      }
    }
  }
});

/* 一个三角的两倍有向面积（顶点空间，Y 向上） */
const cross2 = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);

/** 取第 k 个三角的三个顶点（顶点空间坐标） */
const triOf = (mesh, k) => [0, 1, 2].map((n) => {
  const i = mesh.triangles[k * 3 + n];
  return { x: mesh.vertices[i * 2], y: mesh.vertices[i * 2 + 1] };
});

/** 点在三角内（含边上）：三条边的叉积不能一正一负 */
const pointInTri = (p, [a, b, c]) => {
  const d = [cross2(a, b, p), cross2(b, c, p), cross2(c, a, p)];
  return !(d.some((v) => v < -1e-9) && d.some((v) => v > 1e-9));
};

/*
 * 剖分用的部件样本：尺寸不整齐、pivot 不居中，另外带一条极扁的，
 * 因为 sampleOutline 按边长分配点数，w≫h 时短边只剩 1 个点——
 * 环带缝合最容易在这种退化环上出岔子。
 */
const TRI_BODY = { name: 'body', parent: null, bbox: { x: 61, y: 214, width: 176, height: 331 }, pivot: { x: 88, y: 20 } };
const TRI_CASES = [
  { name: 'head',  parent: 'body', bbox: { x: 79, y: 34,  width: 143, height: 187 }, pivot: { x: 71, y: 170 } },
  { name: 'arm',   parent: 'body', bbox: { x: 27, y: 246, width: 74,  height: 163 }, pivot: { x: 55, y: 18 } },
  { name: 'skirt', parent: 'body', bbox: { x: 52, y: 441, width: 195, height: 148 }, pivot: { x: 97, y: 12 } },
  { name: 'belt',  parent: 'body', bbox: { x: 10, y: 300, width: 300, height: 11 },  pivot: { x: 150, y: 5 } }
];
const TRI_DENSITIES = [3, 4, 6, 8, 12, 16, 24];

test('三角互不重叠：没有一个三角的重心落在别的三角内部', () => {
  for (const density of TRI_DENSITIES) {
    for (const part of TRI_CASES) {
      const mesh = buildSkinnedMesh(part, TRI_BODY, { density });
      const n = mesh.triangles.length / 3;
      const tris = Array.from({ length: n }, (_, k) => triOf(mesh, k));
      for (let k = 0; k < n; k++) {
        const [a, b, c] = tris[k];
        const g = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
        for (let j = 0; j < n; j++) {
          if (j === k) continue;
          assert.ok(!pointInTri(g, tris[j]),
            `density ${density} 的 ${part.name}：第 ${k} 个三角的重心落在第 ${j} 个里，两片叠上了`);
        }
      }
    }
  }
});

test('三角正好铺满 bbox：面积之和等于 w×h，不多不少', () => {
  // 重叠会让比值 > 1，漏洞会让它 < 1。两头都卡住，这一条就等价于"精确剖分"。
  for (const density of TRI_DENSITIES) {
    for (const part of TRI_CASES) {
      const mesh = buildSkinnedMesh(part, TRI_BODY, { density });
      let sum = 0;
      for (let k = 0; k < mesh.triangles.length / 3; k++) {
        sum += Math.abs(cross2(...triOf(mesh, k))) / 2;
      }
      const boxArea = part.bbox.width * part.bbox.height;
      assert.ok(Math.abs(sum / boxArea - 1) < 1e-9,
        `density ${density} 的 ${part.name}：面积之和 ${sum} vs bbox ${boxArea}（比值 ${sum / boxArea}）`);
    }
  }
});

test('所有三角在顶点空间里都是逆时针', () => {
  // 顶点存的是 -p.y，比采样点空间多一次 Y 取负，叉积符号整体翻转。
  // 判反了不报错，只是整片网格背朝外，开了背面剔除的运行时会整块不见。
  for (const density of TRI_DENSITIES) {
    for (const part of TRI_CASES) {
      const mesh = buildSkinnedMesh(part, TRI_BODY, { density });
      for (let k = 0; k < mesh.triangles.length / 3; k++) {
        assert.ok(cross2(...triOf(mesh, k)) > 0,
          `density ${density} 的 ${part.name}：第 ${k} 个三角是顺时针`);
      }
    }
  }
});

test('外轮廓顶点仍排在点集最前面（hull 语义）', () => {
  // triangulate 现在按下标区分边界点与栅格点，hull 排在前面不再只是约定，
  // 排错了剖分本身就会串位。
  for (const density of TRI_DENSITIES) {
    const mesh = buildSkinnedMesh(TRI_CASES[0], TRI_BODY, { density });
    const { width: w, height: h } = TRI_CASES[0].bbox;
    for (let i = 0; i < mesh.hull; i++) {
      const x = mesh.vertices[i * 2];
      const y = -mesh.vertices[i * 2 + 1];
      const onEdge = Math.abs(x) < 1e-9 || Math.abs(x - w) < 1e-9 ||
                     Math.abs(y) < 1e-9 || Math.abs(y - h) < 1e-9;
      assert.ok(onEdge, `density ${density}：hull 里的第 ${i} 个点 (${x}, ${y}) 不在 bbox 边界上`);
    }
    // hull 之后的点必须全在内部
    for (let i = mesh.hull; i < mesh.vertices.length / 2; i++) {
      const x = mesh.vertices[i * 2];
      const y = -mesh.vertices[i * 2 + 1];
      assert.ok(x > 1e-9 && x < w - 1e-9 && y > 1e-9 && y < h - 1e-9,
        `density ${density}：hull 之后的第 ${i} 个点 (${x}, ${y}) 跑到边界上了`);
    }
  }
});
