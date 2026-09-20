/**
 * Spine JSON 骨架解析与写回。
 *
 * Spine 的 JSON 导出有三种形态，本模块都接受：
 *   1. 纯骨架数据         { skeleton, bones, slots, skins, animations }
 *   2. 带 hash 的导出     同 1，但含 skeleton.hash
 *   3. .spine 工程文件    同 1，但含编辑器附加字段（如 editorSettings）
 *
 * 与二进制解析不同，JSON 是自描述的，字段缺失即"用默认值"。
 * 所以这里不做严格校验，只做归一化——真正的校验交给 validate.js。
 */

export class SpineJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpineJsonError';
  }
}

export function parseSkeletonJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SpineJsonError(`JSON 解析失败: ${err.message}`);
  }
  return normalizeSkeleton(raw);
}

/**
 * 把任意形态的 JSON 归一化成统一文档模型。
 * 归一化后的结构是工具内部唯一的"骨架真相"，二进制也映射到这个形状。
 */
export function normalizeSkeleton(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new SpineJsonError('骨架根节点必须是对象');
  }

  const skeleton = raw.skeleton ?? {};
  const doc = {
    format: 'json',
    version: skeleton.spine ?? raw.spine ?? null,
    hash: skeleton.hash ?? null,
    x: num(skeleton.x, 0),
    y: num(skeleton.y, 0),
    width: num(skeleton.width, 0),
    height: num(skeleton.height, 0),
    fps: num(skeleton.fps, 30),
    imagesPath: skeleton.images ?? null,
    audioPath: skeleton.audio ?? null,
    bones: [],
    slots: [],
    skins: [],
    events: [],
    animations: [],
    // 保留原始对象，写回时在此基础上改，避免丢失本工具不认识的字段
    _raw: raw,
  };

  doc.bones = (raw.bones ?? []).map((b, i) => ({
    index: i,
    name: b.name,
    parent: b.parent ?? null,
    length: b.length,
    x: b.x,
    y: b.y,
    rotation: b.rotation,
    scaleX: b.scaleX,
    scaleY: b.scaleY,
    shearX: b.shearX,
    shearY: b.shearY,
    transform: b.transform ?? 'normal',
    skin: b.skin ?? null,
  }));

  doc.slots = (raw.slots ?? []).map((s, i) => ({
    index: i,
    name: s.name,
    bone: s.bone,
    attachment: s.attachment ?? null,
    color: s.color ?? null,
    blend: s.blend ?? null,
  }));

  doc.skins = normalizeSkins(raw.skins);

  doc.events = Object.entries(raw.events ?? {}).map(([name, e]) => ({
    name,
    int: e.int,
    float: e.float,
    string: e.string,
    audio: e.audio,
  }));

  doc.animations = Object.entries(raw.animations ?? {}).map(([name, a]) => ({
    name,
    duration: computeDuration(a),
    slots: Object.keys(a.slots ?? {}),
    bones: Object.keys(a.bones ?? {}),
    hasDeform: Object.keys(a.deform ?? {}).length > 0,
    hasDrawOrder: Array.isArray(a.drawOrder) ? a.drawOrder.length : 0,
    hasIk: Object.keys(a.ik ?? {}).length > 0,
    hasTransform: Object.keys(a.transform ?? {}).length > 0,
    hasPath: Object.keys(a.path ?? {}).length > 0,
    hasEvents: Array.isArray(a.events) ? a.events.length : 0,
  }));

  return doc;
}

function normalizeSkins(rawSkins) {
  // skins 在 4.x 是数组；3.8 及更早是对象。两种都接受。
  const out = [];
  if (Array.isArray(rawSkins)) {
    for (const s of rawSkins) {
      out.push(makeSkin(s.name ?? 'default', s.attachments));
    }
  } else if (rawSkins && typeof rawSkins === 'object') {
    for (const [name, s] of Object.entries(rawSkins)) {
      out.push(makeSkin(name, s));
    }
  }
  return out;
}

/**
 * 皮肤归一化。
 *
 * 附件清单必须保留下来，不能只留个数：校验需要知道"槽位引用的附件
 * 到底存不存在"，拆件工具也需要按附件名定位到具体部件。
 * 但完整的附件数据可能很大（网格顶点），所以清单只存名字与槽位，
 * 原始数据留在 _raw 里按需取。
 */
function makeSkin(name, attachments) {
  const items = [];
  if (attachments && typeof attachments === 'object') {
    for (const [key, value] of Object.entries(attachments)) {
      if (!value || typeof value !== 'object') continue;
      const inner = Object.entries(value);
      const isThreeLevel =
        inner.length > 0 && inner.every(([, v]) => v && typeof v === 'object');
      if (isThreeLevel) {
        for (const [attachmentName, att] of inner) {
          items.push({ name: attachmentName, slot: key, attachment: att });
        }
      } else {
        items.push({ name: key, slot: null, attachment: value });
      }
    }
  }
  return { name, attachments: items.length, items };
}

/**
 * 动画时长 = 所有时间轴里最后一个关键帧时间。
 * drawOrder / events 也用同样的取法。
 */
function computeDuration(anim) {
  let max = 0;
  const consider = (keys) => {
    if (!Array.isArray(keys)) return;
    for (const k of keys) {
      if (typeof k === 'number' && k > max) max = k;
      else if (k && typeof k === 'object' && typeof k.time === 'number' && k.time > max) {
        max = k.time;
      }
    }
  };

  for (const group of ['bones', 'slots', 'ik', 'transform', 'path', 'deform']) {
    for (const tracks of Object.values(anim[group] ?? {})) {
      if (!tracks || typeof tracks !== 'object') continue;
      for (const keys of Object.values(tracks)) consider(keys);
    }
  }
  consider(anim.drawOrder);
  if (Array.isArray(anim.events)) consider(anim.events.map((e) => e.time));
  return max;
}

function num(v, fallback) {
  return typeof v === 'number' ? v : fallback;
}
