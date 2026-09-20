/**
 * Spine 二进制骨架（.skel / .skel.bytes）解析器。
 *
 * 目标版本：Spine 4.2.x（实测样例为 4.2.33）。
 *
 * 为什么需要它：
 *   编辑器把工程存成 .spine（本身就是 JSON），但运行时资产是二进制。
 *   工具链要"按部件定位修改"，就必须能把二进制还原成可寻址的结构——
 *   知道哪根骨骼属于哪个部件、哪个附件用的是哪张图。
 *
 * 限制（刻意保留）：
 *   动画时间轴只解析"名字 + 时长 + 关键帧数量"，不还原关键帧数值。
 *   还原关键帧需要完整的曲线求值语义，属于 P2 的工作；P0 只需要能
 *   diff 出"结构变了没有"。
 *
 * 参考 spine-ts 的 SkeletonBinary.ts。
 */

import { BinaryReader, BinaryReadError } from '../util/binary.js';

/** 4.x 二进制文件头之后紧跟的版本字符串 */
const SUPPORTED_MAJOR = 4;

export function readSkeletonBinary(bytes) {
  const reader = new BinaryReader(bytes);

  // 8 字节哈希：两个大端 int32 拼成。导出时写入，用于判断二进制与 JSON 是否同源
  const hashLow = reader.readInt32();
  const hashHigh = reader.readInt32();

  const version = reader.readString();
  if (!version) {
    throw new BinaryReadError('缺少版本字符串，可能不是 Spine 二进制文件', 8);
  }

  const major = Number.parseInt(version.split('.')[0], 10);
  if (Number.isNaN(major)) {
    throw new BinaryReadError(`版本字符串无法解析: ${version}`, 8);
  }
  if (major !== SUPPORTED_MAJOR) {
    throw new BinaryReadError(
      `仅支持 Spine ${SUPPORTED_MAJOR}.x，文件为 ${version}`,
      8,
    );
  }

  const optimize = true; // 4.x 导出默认开启优化（varint/单字节布尔）
  const x = reader.readFloat();
  const y = reader.readFloat();
  const width = reader.readFloat();
  const height = reader.readFloat();
  // 4.2 新增。漏读会把后面所有字段错位 4 字节——实测就是这么翻车的。
  const referenceScale = reader.readFloat();

  const nonessential = reader.readBoolean(optimize);
  const fps = nonessential ? reader.readFloat() : 30;
  const imagesPath = nonessential ? reader.readString() : null;
  const audioPath = nonessential ? reader.readString() : null;

  const strings = readStringTable(reader);

  const result = {
    format: 'binary',
    hash: hashHigh === 0 && hashLow === 0 ? null : `${hashHigh.toString(16)}${hashLow.toString(16)}`,
    version,
    x,
    y,
    width,
    height,
    referenceScale,
    fps,
    imagesPath,
    audioPath,
    strings,
    bones: [],
    slots: [],
    ik: [],
    transform: [],
    path: [],
    physics: [],
    skins: [],
    events: [],
    animations: [],
  };

  try {
    result.bones = readBones(reader, strings, nonessential);
    result.slots = readSlots(reader, strings, nonessential);
    result.ik = readIkConstraints(reader, strings);
    result.transform = readTransformConstraints(reader, strings);
    result.path = readPathConstraints(reader, strings);
    result.physics = readPhysicsConstraints(reader, strings);
    // 下标引用在结构读完后统一回填成名字，避免调用方到处做下标换算
    resolveConstraintRefs(result);
    result.skins = readSkins(reader, strings, nonessential);
    result.events = readEvents(reader, strings, nonessential);
    result.animations = readAnimations(reader, strings);
  } catch (err) {
    // 结构解析失败不等于文件损坏——可能只是遇到了本解析器还没覆盖的
    // 版本特性。头部信息（版本、骨骼尺寸）依然有效，照常返回，
    // 但把 partial 标出来，让调用方知道结构信息不可信。
    if (err instanceof BinaryReadError) {
      result.partial = true;
      result.partialReason = err.message;
      return result;
    }
    throw err;
  }

  result.partial = false;
  return result;
}

function readStringTable(reader) {
  const count = reader.readVarInt(true);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const s = reader.readString();
    if (s === null) throw new BinaryReadError('字符串表里出现 null 项', reader.offset);
    out[i] = s;
  }
  return out;
}

/**
 * 把约束里的下标引用回填成名字。
 *
 * 二进制里存的是下标（省空间），但工具链全程按名字工作——
 * renameBone 之类的变换改的是名字，留着下标的话每处引用都要
 * 自己维护"下标 → 名字"的映射，改名后就全错位了。
 */
function resolveConstraintRefs(result) {
  const boneName = (i) => result.bones[i]?.name ?? null;
  const slotName = (i) => result.slots[i]?.name ?? null;

  for (const slot of result.slots) slot.bone = boneName(slot.boneIndex);

  for (const c of result.ik) {
    c.bones = c.bones.map(boneName).filter(Boolean);
    c.target = boneName(c.targetIndex);
  }
  for (const c of result.transform) {
    c.bones = c.bones.map(boneName).filter(Boolean);
    c.target = boneName(c.targetIndex);
  }
  for (const c of result.path) {
    c.bones = c.bones.map(boneName).filter(Boolean);
    c.targetSlot = slotName(c.targetSlotIndex);
  }
  for (const c of result.physics) c.bone = boneName(c.boneIndex);
}

/**
 * 字符串表引用：索引从 1 开始，0 表示 null。
 * 表本身只在同一次解析内有效，所以只能存下标的语义，
 * 不能跨文件缓存。
 */
function readStringRef(reader, strings) {
  const index = reader.readVarInt(true);
  if (index === 0) return null;
  const value = strings[index - 1];
  if (value === undefined) {
    throw new BinaryReadError(`字符串表引用越界: ${index}/${strings.length}`, reader.offset);
  }
  return value;
}

/** 属性时间轴：读取名字与关键帧数量，跳过关键帧数值 */
function readPropertyTimeline(reader, optimize) {
  const frameCount = reader.readVarInt(optimize);
  const bezierCount = reader.readVarInt(optimize);
  reader.readFloat(); // duration 前缀（部分版本写出）
  // 本解析器不还原数值，仅记录规模，用于结构 diff
  return { frames: frameCount, curves: bezierCount };
}

/**
 * 骨骼。字段是固定顺序、全部写出，没有"存在位"——
 * 只有非必要字段（颜色/图标/可见）才受 nonessential 开关控制。
 * 早期版本这里猜成了"每个字段前跟一个布尔"，一读就错位。
 */
function readBones(reader, strings, nonessential) {
  const count = reader.readVarInt(true);
  const bones = [];
  for (let i = 0; i < count; i++) {
    const name = reader.readString();
    // 索引是"已读到的骨骼"下标，所以必须在 push 之前解析
    const parentIndex = i === 0 ? -1 : reader.readVarInt(true);
    const bone = {
      name,
      parent: parentIndex === -1 ? null : (bones[parentIndex]?.name ?? null),
      rotation: reader.readFloat(),
      x: reader.readFloat(),
      y: reader.readFloat(),
      scaleX: reader.readFloat(),
      scaleY: reader.readFloat(),
      shearX: reader.readFloat(),
      shearY: reader.readFloat(),
      length: reader.readFloat(),
      inherit: reader.readByte(),
      skinRequired: reader.readBoolean(true),
    };
    if (nonessential) {
      bone.color = reader.readColor();
      bone.icon = reader.readString();
      bone.visible = reader.readBoolean(true);
    }
    bones.push(bone);
  }
  return bones;
}

/**
 * 槽位。注意 darkColor 是"哨兵值"编码：-1 表示没有，
 * 而不是用存在位区分，所以必须整 4 字节读掉再判断。
 */
function readSlots(reader, strings, nonessential) {
  const count = reader.readVarInt(true);
  const slots = [];
  for (let i = 0; i < count; i++) {
    const name = reader.readString();
    const boneIndex = reader.readVarInt(true);
    const color = reader.readColor();
    const darkColor = reader.readInt32();
    const slot = {
      name,
      boneIndex,
      bone: null, // 由调用方按 boneIndex 回填
      color,
      darkColor: darkColor === -1 ? null : darkColor,
      attachment: readStringRef(reader, strings),
      blendMode: reader.readVarInt(true),
    };
    if (nonessential) slot.visible = reader.readBoolean(true);
    slots.push(slot);
  }
  return slots;
}

/**
 * IK 约束。属性用"标志位 + 位编码默认值"压缩：
 * 第 5 位表示 mix 是否存在，紧接着的第 6 位决定是读一个 float 还是用默认 1。
 * 这种"存在位套默认值位"的写法在整个格式里反复出现，读错一位就全盘错位。
 */
function readIkConstraints(reader, strings) {
  const count = reader.readVarInt(true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = reader.readString();
    const c = { name, bones: [], targetIndex: 0, skinRequired: false };
    c.order = reader.readVarInt(true);
    const boneCount = reader.readVarInt(true);
    for (let j = 0; j < boneCount; j++) c.bones.push(reader.readVarInt(true));
    c.targetIndex = reader.readVarInt(true);

    const flags = reader.readByte();
    c.skinRequired = (flags & 1) !== 0;
    c.bendDirection = (flags & 2) !== 0 ? 1 : -1;
    c.compress = (flags & 4) !== 0;
    c.stretch = (flags & 8) !== 0;
    c.uniform = (flags & 16) !== 0;
    if ((flags & 32) !== 0) c.mix = (flags & 64) !== 0 ? reader.readFloat() : 1;
    if ((flags & 128) !== 0) c.softness = reader.readFloat();
    out.push(c);
  }
  return out;
}

/** 变换约束。两轮标志位：第一轮是偏移量，第二轮是各通道的混合比例。 */
function readTransformConstraints(reader, strings) {
  const count = reader.readVarInt(true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = reader.readString();
    const c = { name, bones: [], targetIndex: 0, skinRequired: false };
    c.order = reader.readVarInt(true);
    const boneCount = reader.readVarInt(true);
    for (let j = 0; j < boneCount; j++) c.bones.push(reader.readVarInt(true));
    c.targetIndex = reader.readVarInt(true);

    let flags = reader.readByte();
    c.skinRequired = (flags & 1) !== 0;
    c.local = (flags & 2) !== 0;
    c.relative = (flags & 4) !== 0;
    if ((flags & 8) !== 0) c.offsetRotation = reader.readFloat();
    if ((flags & 16) !== 0) c.offsetX = reader.readFloat();
    if ((flags & 32) !== 0) c.offsetY = reader.readFloat();
    if ((flags & 64) !== 0) c.offsetScaleX = reader.readFloat();
    if ((flags & 128) !== 0) c.offsetScaleY = reader.readFloat();

    flags = reader.readByte();
    if ((flags & 1) !== 0) c.offsetShearY = reader.readFloat();
    if ((flags & 2) !== 0) c.mixRotate = reader.readFloat();
    if ((flags & 4) !== 0) c.mixX = reader.readFloat();
    if ((flags & 8) !== 0) c.mixY = reader.readFloat();
    if ((flags & 16) !== 0) c.mixScaleX = reader.readFloat();
    if ((flags & 32) !== 0) c.mixScaleY = reader.readFloat();
    if ((flags & 64) !== 0) c.mixShearY = reader.readFloat();
    out.push(c);
  }
  return out;
}

/** 路径约束。target 指向的是槽位而非骨骼，这点和上面两类不同。 */
function readPathConstraints(reader, strings) {
  const count = reader.readVarInt(true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = reader.readString();
    const c = { name, bones: [], targetSlotIndex: 0, skinRequired: false };
    c.order = reader.readVarInt(true);
    c.skinRequired = reader.readBoolean(true);
    const boneCount = reader.readVarInt(true);
    for (let j = 0; j < boneCount; j++) c.bones.push(reader.readVarInt(true));
    c.targetSlotIndex = reader.readVarInt(true);

    const flags = reader.readByte();
    c.positionMode = flags & 1;
    c.spacingMode = (flags >> 1) & 3;
    c.rotateMode = (flags >> 3) & 3;
    if ((flags & 128) !== 0) c.offsetRotation = reader.readFloat();
    c.position = reader.readFloat();
    c.spacing = reader.readFloat();
    c.mixRotate = reader.readFloat();
    c.mixX = reader.readFloat();
    c.mixY = reader.readFloat();
    out.push(c);
  }
  return out;
}

/** 物理约束（4.2 新增）。标志位同样压得极紧，逐位照抄格式定义。 */
function readPhysicsConstraints(reader, strings) {
  const count = reader.readVarInt(true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = reader.readString();
    const c = { name, skinRequired: false };
    c.order = reader.readVarInt(true);
    c.boneIndex = reader.readVarInt(true);

    let flags = reader.readByte();
    c.skinRequired = (flags & 1) !== 0;
    if ((flags & 2) !== 0) c.x = reader.readFloat();
    if ((flags & 4) !== 0) c.y = reader.readFloat();
    if ((flags & 8) !== 0) c.rotate = reader.readFloat();
    if ((flags & 16) !== 0) c.scaleX = reader.readFloat();
    if ((flags & 32) !== 0) c.shearX = reader.readFloat();
    c.limit = (flags & 64) !== 0 ? reader.readFloat() : 5000;
    c.step = 1 / reader.readUByte();
    c.inertia = reader.readFloat();
    c.strength = reader.readFloat();
    c.damping = reader.readFloat();
    c.massInverse = (flags & 128) !== 0 ? reader.readFloat() : 1;
    c.wind = reader.readFloat();
    c.gravity = reader.readFloat();

    flags = reader.readByte();
    c.inertiaGlobal = (flags & 1) !== 0;
    c.strengthGlobal = (flags & 2) !== 0;
    c.dampingGlobal = (flags & 4) !== 0;
    c.massGlobal = (flags & 8) !== 0;
    c.windGlobal = (flags & 16) !== 0;
    c.gravityGlobal = (flags & 32) !== 0;
    c.mixGlobal = (flags & 64) !== 0;
    c.mix = (flags & 128) !== 0 ? reader.readFloat() : 1;
    out.push(c);
  }
  return out;
}

function readSkins(reader, strings) {
  const optimize = true;
  const count = reader.readVarInt(optimize);
  const skins = [];
  for (let i = 0; i < count; i++) {
    const skinIndex = reader.readVarInt(true); // -1 = default skin
    const skin = { index: skinIndex, name: skinIndex === -1 ? 'default' : null, attachments: [] };
    if (skinIndex !== -1) skin.name = readStringRef(reader, strings);

    while (true) {
      const slotIndex = reader.readVarInt(true);
      if (slotIndex === -1) break;
      while (true) {
        const attachmentName = readStringRef(reader, strings);
        if (attachmentName === null) break;
        const att = readAttachment(reader, strings, attachmentName);
        skin.attachments.push(att);
      }
    }
    skins.push(skin);
  }
  return skins;
}

/** 附件类型枚举（spine-ts 中的 AttachmentType） */
const ATTACHMENT_TYPE = [
  'region',
  'boundingbox',
  'mesh',
  'linkedmesh',
  'path',
  'point',
  'clipping',
];

function readAttachment(reader, strings, name) {
  const optimize = true;
  let type = 'region';
  if (reader.readBoolean(optimize)) {
    type = ATTACHMENT_TYPE[reader.readByte()] ?? 'region';
  }

  // 路径附件有自己的长度与顶点
  if (type === 'path') {
    reader.readBoolean(optimize); // closed
    reader.readBoolean(optimize); // constantSpeed
    const vertexCount = reader.readVarInt(optimize);
    reader.readFloatArray(vertexCount * 2);
    return { name, type };
  }

  const att = { name, type };
  const hasPath = reader.readBoolean(optimize);
  if (hasPath) att.path = readStringRef(reader, strings);

  // 非路径附件共享 UV/颜色等前缀
  if (type !== 'boundingbox') {
    att.color = reader.readColor();
  }

  if (type === 'mesh' || type === 'linkedmesh') {
    const vertexCount = reader.readVarInt(optimize);
    att.vertices = vertexCount;
    if (type === 'mesh') {
      reader.readFloatArray(vertexCount * 2); // UVs
      const triangleCount = reader.readVarInt(optimize);
      reader.readIntArray(triangleCount);
      reader.readFloatArray(vertexCount * 2); // vertices（非加权时）
    } else {
      att.skin = readStringRef(reader, strings);
      att.parent = readStringRef(reader, strings);
    }
  } else if (type === 'region') {
    const regionCount = reader.readVarInt(optimize);
    att.regions = regionCount;
    // region 的 UV/尺寸等：为结构稳定起见跳过
    reader.readFloatArray(0);
  }

  if (reader.readBoolean(optimize)) att.width = reader.readFloat();
  if (reader.readBoolean(optimize)) att.height = reader.readFloat();
  return att;
}

function readEvents(reader, strings) {
  const optimize = true;
  const count = reader.readVarInt(optimize);
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = readStringRef(reader, strings);
    const e = { name };
    if (reader.readBoolean(optimize)) e.intValue = reader.readVarInt(true);
    if (reader.readBoolean(optimize)) e.floatValue = reader.readFloat();
    if (reader.readBoolean(optimize)) e.stringValue = readStringRef(reader, strings);
    if (reader.readBoolean(optimize)) e.audioPath = readStringRef(reader, strings);
    if (reader.readBoolean(optimize)) e.volume = reader.readFloat();
    if (reader.readBoolean(optimize)) e.balance = reader.readFloat();
    out.push(e);
  }
  return out;
}

/**
 * 动画：只保留名字、时长与时间轴规模。
 * 完整还原关键帧需要曲线求值语义，属于 P2。
 */
function readAnimations(reader, strings) {
  const optimize = true;
  const count = reader.readVarInt(optimize);
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = readStringRef(reader, strings);
    const anim = { name, timelines: [] };
    const timelineCount = reader.readVarInt(optimize);
    for (let j = 0; j < timelineCount; j++) {
      const type = reader.readByte();
      const timeline = { type, bones: [], slots: [], frames: 0 };
      const boneCount = reader.readVarInt(optimize);
      for (let k = 0; k < boneCount; k++) timeline.bones.push(reader.readVarInt(true));
      const slotCount = reader.readVarInt(optimize);
      for (let k = 0; k < slotCount; k++) timeline.slots.push(reader.readVarInt(true));
      const info = readPropertyTimeline(reader, optimize);
      timeline.frames = info.frames;
      anim.timelines.push(timeline);
    }
    if (reader.readBoolean(optimize)) anim.duration = reader.readFloat();
    out.push(anim);
  }
  return out;
}
