/**
 * 导出目标（编辑器/引擎）适配。
 *
 * 为什么需要这一层：
 *   预览用的骨架结构是「便于渲染」的形状——权重放在 bones/weights 两个
 *   平行数组里，取值直观。但 Spine JSON 规范不是这么存的：
 *
 *     无权重网格  vertices = [x0,y0,x1,y1,...]              长度 == uvs.length
 *     加权网格    vertices = [n, bi,x,y,w, bi,x,y,w, ...]   长度 != uvs.length
 *
 *   运行时就是靠「vertices.length 是否等于 uvs.length」来区分这两种的。
 *   直接把预览结构写出去，长度恰好相等，于是运行时判定成无权重网格，
 *   bones/weights 两个数组根本不会被读——预览里蒙皮好好的，导进
 *   Cocos 就变回硬拼接。这一层负责把它翻译成规范形状。
 *
 * 加权网格的顶点坐标是「骨骼空间」的：
 *   同一个顶点，在每根影响它的骨骼下各存一份局部坐标。
 *   我们生成的骨架静止旋转全为 0，所以骨骼空间就是「世界坐标 − 骨骼世界位置」，
 *   纯平移，不需要转旋转矩阵。
 *
 * 还有一点容易踩：加权网格不吃 attachment 的 x/y 偏移。
 *   偏移只对无权重网格生效，所以转换时要先把偏移合进顶点，再减骨骼位置。
 */

/**
 * 目标表。
 *
 * skinsShape / rotateKey 是 3.8 与 4.x 的两处硬差异：
 *   3.8   skins 是对象 { default: { slot: { att: {...} } } }，旋转关键帧用 angle
 *   4.x   skins 是数组 [{ name, attachments }]，旋转关键帧用 value
 * 写错任意一处，运行时是静默失败（骨架加载出来但没附件 / 动画不转）。
 */
export const EXPORT_TARGETS = {
  'cocos-3.8': {
    label: 'Cocos Creator 3.8.x',
    spineHeader: '3.8.75',
    atlasVersion: '3.8',
    skinsShape: 'object',
    rotateKey: 'angle',
    note: 'Cocos Creator 3.8.x 内置 Spine 3.8 运行时，导入需 .json + .atlas + .png 三件同名同目录'
  },
  /*
   * Unity 走 4.2 而不是 3.8。
   *
   * Unity 没有内置 Spine 运行时，用的是官方 spine-unity 包，而它跟随
   * Spine 编辑器版本走，现在维护的是 4.x 线。发一份 3.8 的骨架过去，
   * spine-unity 要额外开兼容开关才读得进去；4.2 是它默认就吃下的版本，
   * 也是 Cocos Creator 3.8.6+ 能切过去的那一档，两边都能用。
   */
  'unity': {
    label: 'Unity (spine-unity)',
    spineHeader: '4.2.10',
    atlasVersion: '4.2',
    skinsShape: 'array',
    rotateKey: 'value',
    note: 'spine-unity 包导入：把三件套一起拖进 Assets 下的同名文件夹，Unity 会自动生成 _SkeletonData 资产'
  },
  'spine-4.0': {
    label: 'Spine 编辑器 4.0',
    spineHeader: '4.0.64',
    atlasVersion: '4.0',
    skinsShape: 'array',
    rotateKey: 'value',
    note: '用 Spine 编辑器打开可继续手工调整'
  },
  'spine-4.1': {
    label: 'Spine 编辑器 4.1',
    spineHeader: '4.1.23',
    atlasVersion: '4.1',
    skinsShape: 'array',
    rotateKey: 'value',
    note: '用 Spine 编辑器打开可继续手工调整'
  },
  'spine-4.2': {
    label: 'Spine 编辑器 4.2',
    spineHeader: '4.2.10',
    atlasVersion: '4.2',
    skinsShape: 'array',
    rotateKey: 'value',
    note: 'Cocos Creator 3.8.4+ 也可用 Spine 4.2 运行时'
  }
};

export const DEFAULT_TARGET = 'cocos-3.8';

/** 取目标配置，未知目标回退到默认并说明 */
export function resolveTarget(key) {
  const id = key && EXPORT_TARGETS[key] ? key : DEFAULT_TARGET;
  return { id, ...EXPORT_TARGETS[id] };
}

/**
 * 计算每根骨骼在静止姿势下的世界位置。
 * 生成的骨架旋转全为 0，所以父子累加就是纯加法。
 * @returns {Map<string,{x:number,y:number,index:number}>}
 */
export function restWorldBones(bones) {
  const byName = new Map(bones.map((b, i) => [b.name, { bone: b, index: i }]));
  const world = new Map();

  const resolve = (name, guard = 0) => {
    if (world.has(name)) return world.get(name);
    const entry = byName.get(name);
    if (!entry || guard > bones.length) return { x: 0, y: 0, index: 0 };

    const { bone, index } = entry;
    const parent = bone.parent ? resolve(bone.parent, guard + 1) : { x: 0, y: 0 };
    const w = { x: parent.x + (bone.x ?? 0), y: parent.y + (bone.y ?? 0), index };
    world.set(name, w);
    return w;
  };

  for (const b of bones) resolve(b.name);
  return world;
}

/**
 * 把预览用的 mesh 附件转成 Spine JSON 规范的加权网格。
 *
 * @param {object} att - 预览结构的 mesh 附件（含 bones/weights 平行数组）
 * @param {Map} world - restWorldBones 的结果
 * @param {{x:number,y:number}} slotBone - 附件所属槽位骨骼的静止世界位置
 * @returns {object} 规范形状的附件（vertices 内联权重，无 bones/weights 字段）
 */
function toSpineMesh(att, world, slotBone) {
  const offX = att.x ?? 0;
  const offY = att.y ?? 0;
  const count = att.uvs.length / 2;

  const vertices = [];

  for (let v = 0; v < count; v++) {
    // 顶点的世界坐标（Spine 坐标系，原点居中、Y 向上）。
    //
    // 预览结构里 vertices + 附件偏移 得到的是「相对自身骨骼原点」的坐标，
    // 不是世界坐标——运行时正是再叠上骨骼世界变换才落到画面上的。
    // 这里静止旋转为 0，所以加上骨骼静止世界位置即可。
    const wx = slotBone.x + att.vertices[v * 2] + offX;
    const wy = slotBone.y + att.vertices[v * 2 + 1] + offY;

    const names = att.bones?.[v] ?? [];
    const ws = att.weights?.[v] ?? [];

    // 只保留权重非 0 的影响；补位的 0 权重写进 JSON 会让运行时白算一遍
    const live = [];
    for (let i = 0; i < names.length; i++) {
      const w = ws[i];
      if (!w) continue;
      const bw = world.get(names[i]);
      if (!bw) continue;
      live.push({ index: bw.index, x: wx - bw.x, y: wy - bw.y, weight: w });
    }

    if (!live.length) {
      // 没有任何有效权重，退化成绑在第一根骨骼上，避免顶点塌到原点
      const first = world.values().next().value ?? { x: 0, y: 0, index: 0 };
      live.push({ index: first.index, x: wx - first.x, y: wy - first.y, weight: 1 });
    }

    vertices.push(live.length);
    for (const inf of live) {
      vertices.push(inf.index, +inf.x.toFixed(2), +inf.y.toFixed(2), +inf.weight.toFixed(4));
    }
  }

  const out = {
    type: 'mesh',
    uvs: att.uvs,
    triangles: att.triangles,
    vertices,
    hull: att.hull ?? 0,
    width: att.width,
    height: att.height
  };
  if (att.path) out.path = stripPng(att.path);
  return out;
}

/** atlas 区域名不带扩展名，附件 path 要跟着去掉 */
function stripPng(path) {
  return String(path).replace(/\.png$/i, '');
}

/** region 附件按目标格式原样搬运，只规整 path */
function toSpineRegion(att) {
  const out = { ...att };
  delete out.name;
  if (out.path) out.path = stripPng(out.path);
  return out;
}

/**
 * 动画关键帧转换。
 *
 * 两处必须改：
 *   1. 旋转关键帧的值字段：3.8 叫 angle，4.x 叫 value
 *   2. curve: 'smooth' 不是合法取值——Spine 只认 'stepped' 或贝塞尔控制点。
 *      写进去的后果是运行时解析报错或整条曲线被丢掉。
 *      这里直接去掉 curve 走线性：生成的动画幅度都在 6px / 5° 以内，
 *      线性和缓入缓出肉眼分不出，但能保证一定加载得上。
 *      浏览器预览仍然读 'smooth' 做平滑，两边互不影响。
 */
function convertAnimations(animations, rotateKey) {
  const out = {};

  for (const [animName, anim] of Object.entries(animations ?? {})) {
    const bones = {};

    for (const [boneName, track] of Object.entries(anim.bones ?? {})) {
      const converted = {};

      if (track.rotate?.length) {
        converted.rotate = track.rotate.map((k) => {
          const value = k.value ?? k.angle ?? 0;
          return { time: +(k.time ?? 0).toFixed(4), [rotateKey]: +value.toFixed(3) };
        });
      }

      if (track.translate?.length) {
        converted.translate = track.translate.map((k) => ({
          time: +(k.time ?? 0).toFixed(4),
          x: +(k.x ?? 0).toFixed(3),
          y: +(k.y ?? 0).toFixed(3)
        }));
      }

      if (track.scale?.length) {
        converted.scale = track.scale.map((k) => ({
          time: +(k.time ?? 0).toFixed(4),
          x: +(k.x ?? 1).toFixed(4),
          y: +(k.y ?? 1).toFixed(4)
        }));
      }

      if (Object.keys(converted).length) bones[boneName] = converted;
    }

    out[animName] = { bones };
  }

  return out;
}

/**
 * 按目标构建可直接落盘的 Spine JSON。
 *
 * 不改动传入的骨架——预览还在用它，原地改会让画面跟着变。
 *
 * @param {object} skeleton - 预览用骨架（generateSkeleton 的产物）
 * @param {string} targetKey - EXPORT_TARGETS 的键
 * @returns {{ json: object, target: object }}
 */
export function buildExportSkeleton(skeleton, targetKey) {
  const target = resolveTarget(targetKey);
  const bones = skeleton.bones ?? [];
  const world = restWorldBones(bones);

  // 预览结构的 skins 已是 4.x 数组形状，这里按目标决定落盘形状
  const srcSkins = Array.isArray(skeleton.skins)
    ? skeleton.skins
    : Object.entries(skeleton.skins ?? {}).map(([name, s]) => ({
        name,
        attachments: s.attachments ?? s
      }));

  let meshCount = 0;
  let weightedCount = 0;

  // 槽位 → 骨骼名，网格顶点要靠它找到自身骨骼的静止世界位置
  const slotBone = new Map((skeleton.slots ?? []).map((s) => [s.name, s.bone]));

  const convertSkin = (skin) => {
    const slots = {};
    for (const [slotName, atts] of Object.entries(skin.attachments ?? {})) {
      const converted = {};
      const own = world.get(slotBone.get(slotName)) ?? { x: 0, y: 0 };
      for (const [attName, att] of Object.entries(atts)) {
        if (att.type === 'mesh') {
          meshCount++;
          if (att.bones?.length) weightedCount++;
          converted[attName] = toSpineMesh(att, world, own);
        } else {
          converted[attName] = toSpineRegion(att);
        }
      }
      slots[slotName] = converted;
    }
    return slots;
  };

  const skins =
    target.skinsShape === 'object'
      ? Object.fromEntries(srcSkins.map((s) => [s.name, convertSkin(s)]))
      : srcSkins.map((s) => ({ name: s.name, attachments: convertSkin(s) }));

  const json = {
    skeleton: {
      hash: skeleton.skeleton?.hash ?? '',
      spine: target.spineHeader,
      images: './images/',
      audio: ''
    },
    bones: bones.map((b) => {
      const out = { name: b.name };
      if (b.parent) out.parent = b.parent;
      if (b.x) out.x = +b.x.toFixed(2);
      if (b.y) out.y = +b.y.toFixed(2);
      if (b.rotation) out.rotation = +b.rotation.toFixed(2);
      return out;
    }),
    slots: (skeleton.slots ?? []).map((s) => ({
      name: s.name,
      bone: s.bone,
      attachment: s.attachment
    })),
    skins,
    animations: convertAnimations(skeleton.animations, target.rotateKey)
  };

  return { json, target, stats: { meshCount, weightedCount } };
}
