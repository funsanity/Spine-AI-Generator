/**
 * 动作提示词 → Spine 关键帧（用户 2026-11-03：「提示词我已经写到模版上，没有按提示词来处理」）。
 *
 * 之前动画写死成 idle 呼吸，提示词只进拆件。现在动作描述单独交给 AI 出时间轴，
 * 这里钉住的是代码那一半：AI 按图片坐标（y 向下、顺时针为正）写的关键帧，
 * 换成 Spine 坐标（y 向上、逆时针为正）、缓动烘成线性关键帧、透明度写成槽位颜色，
 * 以及 AI 写错时（部件名不存在、角色类做相对位移）怎么兜住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSkeleton, generateAnimations } from '../../server/api/generator.js';
import {
  bakeMotion, applyMotion, parseMotionJson, buildMotionPrompt, summarizeParts
} from '../../server/api/motion.js';
import { buildExportSkeleton } from '../../server/api/targets.js';
import { parseCategory } from '../../server/ai/claude.js';

/** complete_ani 那张结算图的部件（取自实测 response.json，简化过） */
function uiParts() {
  const p = (name, parent, x, y, width, height, px, py) =>
    ({ name, parent, bbox: { x, y, width, height }, pivot: { x: px, y: py } });
  return [
    p('banner', null, 44, 408, 2634, 410, 1316, 200),
    p('cushion', 'banner', 1088, 308, 557, 138, 279, 137),
    p('crown', 'cushion', 1165, 41, 402, 327, 202, 320),
    p('left_horn', 'banner', 661, 27, 420, 373, 21, 309),
    p('text_complete', 'banner', 900, 600, 900, 200, 450, 100)
  ];
}
const IMG = { width: 2720, height: 832 };
const build = (version = '4.2') => {
  const sk = generateSkeleton({ parts: uiParts() }, version, { imageSize: IMG, density: 8 });
  generateAnimations(sk);
  return sk;
};
const at = (keys, t) => keys.find((k) => Math.abs(k.time - t) < 1e-6);

test('translate：图片里往上（y 负）换成 Spine 的 y 正', () => {
  const sk = build();
  const { animation } = bakeMotion({
    name: 'enter', duration: 1,
    tracks: [{ part: 'crown', translate: [{ t: 0, x: 10, y: -300 }, { t: 0.5, x: 0, y: 0 }] }]
  }, sk);
  const keys = animation.bones.crown.translate;
  assert.deepEqual([at(keys, 0).x, at(keys, 0).y], [10, 300]);
  assert.deepEqual([at(keys, 0.5).x, at(keys, 0.5).y], [0, 0]);
});

test('rotate：顺时针为正换成 Spine 的逆时针为正；键名跟版本走', () => {
  const m = { duration: 1, tracks: [{ part: 'crown', rotate: [{ t: 0, deg: 6 }, { t: 1, deg: 0 }] }] };
  assert.equal(at(bakeMotion(m, build('4.2')).animation.bones.crown.rotate, 0).value, -6);
  assert.equal(at(bakeMotion(m, build('3.8')).animation.bones.crown.rotate, 0).angle, -6);
});

test('alpha 写成槽位颜色：4.x 用 rgba，3.8 用 color', () => {
  const m = { duration: 1, tracks: [{ part: 'crown', alpha: [{ t: 0, a: 0 }, { t: 0.2, a: 1 }] }] };
  const a42 = bakeMotion(m, build('4.2')).animation;
  // 第三帧是补齐到 duration=1 的保持帧
  assert.deepEqual(a42.slots.crown_slot.rgba.map((k) => k.color), ['ffffff00', 'ffffffff', 'ffffffff']);
  const a38 = bakeMotion(m, build('3.8')).animation;
  assert.deepEqual(a38.slots.crown_slot.color.map((k) => k.color), ['ffffff00', 'ffffffff', 'ffffffff']);
});

test('缓动烘成线性关键帧：out 先快后慢，linear 不加帧', () => {
  const sk = build();
  const { animation } = bakeMotion({
    duration: 1,
    tracks: [
      { part: 'crown', translate: [{ t: 0, y: -100, ease: 'out' }, { t: 1, y: 0 }] },
      { part: 'cushion', translate: [{ t: 0, y: -100 }, { t: 1, y: 0 }] }
    ]
  }, sk);
  const eased = animation.bones.crown.translate;
  assert.ok(eased.length > 10, `out 段应插值出中间帧，实际 ${eased.length}`);
  const mid = eased.find((k) => Math.abs(k.time - 0.5) < 0.02);
  // out = 1-(1-u)²，u=0.5 时走完 75%：剩 25px
  assert.ok(Math.abs(mid.y - 25) < 3, `out 中点应约 25，实际 ${mid.y}`);
  for (let i = 1; i < eased.length; i++) assert.ok(eased[i].time > eased[i - 1].time);
  assert.equal(animation.bones.cushion.translate.length, 2);
});

test('step：保持到下一帧再跳', () => {
  const { animation } = bakeMotion({
    duration: 1, tracks: [{ part: 'crown', alpha: [{ t: 0, a: 0, ease: 'step' }, { t: 0.5, a: 1 }] }]
  }, build());
  const keys = animation.slots.crown_slot.rgba;
  const before = keys.filter((k) => k.time < 0.5);
  assert.ok(before.every((k) => k.color === 'ffffff00'), JSON.stringify(keys));
  assert.equal(at(keys, 0.5).color, 'ffffffff');
});

test('动画时长补齐到 duration：最后一帧之后也要停在那里', () => {
  const { animation } = bakeMotion({
    duration: 3.3, tracks: [{ part: 'crown', translate: [{ t: 0, y: -100 }, { t: 0.5, y: 0 }] }]
  }, build());
  const last = Math.max(...Object.values(animation.bones).flatMap((tr) => Object.values(tr).flat()).map((k) => k.time));
  assert.equal(last, 3.3);
});

test('部件名对不上的轨道丢掉并给出警告，不抛错', () => {
  const r = bakeMotion({
    duration: 1, tracks: [{ part: 'confetti', translate: [{ t: 0, y: 0 }] }, { part: 'crown', alpha: [{ t: 0, a: 1 }] }]
  }, build());
  assert.equal(r.animation.bones.confetti, undefined);
  assert.ok(r.warnings.some((w) => /confetti/.test(w)));
  assert.ok(r.animation.slots.crown_slot);
});

test('AI 跳过的项原样带出来；名字 idle 会和呼吸撞，改名', () => {
  const r = bakeMotion({
    name: 'idle', duration: 1, tracks: [],
    skipped: [{ what: '彩纸', reason: '图中没有彩纸部件' }]
  }, build());
  assert.notEqual(r.name, 'idle');
  assert.deepEqual(r.skipped, [{ what: '彩纸', reason: '图中没有彩纸部件' }]);
});

test('越界值夹住：负时间归 0、透明度夹到 0~1；关键帧晚于 duration 时按关键帧延长，不截掉结尾', () => {
  const r = bakeMotion({
    duration: 1, tracks: [{ part: 'crown', alpha: [{ t: -1, a: 3 }, { t: 1.2, a: -2 }] }]
  }, build());
  const keys = r.animation.slots.crown_slot.rgba;
  assert.equal(r.duration, 1.2);
  assert.deepEqual(keys.map((k) => k.time), [0, 1.2]);
  assert.deepEqual(keys.map((k) => k.color), ['ffffffff', 'ffffff00']);
});

test('角色类：子部件不许相对位移/缩放（接缝会裂），转角夹到 ±10°', () => {
  const sk = build();
  const r = bakeMotion({
    duration: 1,
    tracks: [
      { part: 'banner', translate: [{ t: 0, y: -50 }, { t: 1, y: 0 }] },
      { part: 'crown', translate: [{ t: 0, y: -50 }, { t: 1, y: 0 }], rotate: [{ t: 0, deg: 40 }, { t: 1, deg: 0 }] }
    ]
  }, sk, { category: 'character' });
  assert.ok(r.animation.bones.banner.translate, '顶层部件可以整体位移');
  assert.equal(r.animation.bones.crown.translate, undefined);
  assert.equal(at(r.animation.bones.crown.rotate, 0).value, -10);
  assert.ok(r.warnings.some((w) => /crown/.test(w)));
});

test('applyMotion：新动作排在最前（预览默认播它），idle 保留', () => {
  const sk = build();
  const r = bakeMotion({ name: 'enter', duration: 1, tracks: [{ part: 'crown', alpha: [{ t: 0, a: 1 }] }] }, sk);
  applyMotion(sk, r);
  assert.deepEqual(Object.keys(sk.animations), ['enter', 'idle']);
});

test('导出：槽位颜色轨道跟着导出，键名按目标版本换', () => {
  const sk = build('4.2');
  applyMotion(sk, bakeMotion({ name: 'enter', duration: 1, tracks: [{ part: 'crown', alpha: [{ t: 0, a: 0 }, { t: 1, a: 1 }] }] }, sk));
  const cocos38 = buildExportSkeleton(sk, 'cocos-3.8').json;
  assert.deepEqual(cocos38.animations.enter.slots.crown_slot.color.map((k) => k.color), ['ffffff00', 'ffffffff']);
  const unity = buildExportSkeleton(sk, 'unity').json;
  assert.ok(unity.animations.enter.slots.crown_slot.rgba);
});

test('parseMotionJson 容忍代码块包裹和前后解释文字', () => {
  const m = parseMotionJson('好的：\n```json\n{"name":"enter","duration":2,"tracks":[]}\n```\n以上');
  assert.equal(m.duration, 2);
});

test('提示词里有部件名、父子、绝对轴心和用户原话', () => {
  const parts = summarizeParts(uiParts());
  const text = buildMotionPrompt({ parts, imageSize: IMG, motionPrompt: '皇冠从上方掉落' });
  assert.match(text, /crown/);
  assert.match(text, /cushion/);
  assert.match(text, /1367,361/); // crown 轴心 = bbox 左上 + pivot
  assert.match(text, /皇冠从上方掉落/);
});

test('summarizeParts 去掉底板这类内部部件', () => {
  const parts = summarizeParts([...uiParts(), { name: '_base_plate', parent: null, bbox: { x: 0, y: 0, width: 1, height: 1 }, pivot: { x: 0, y: 0 } }]);
  assert.ok(!parts.some((p) => p.name.startsWith('_')));
});

test('分类结果认得 ui，认不出时回到角色类', () => {
  assert.equal(parseCategory('ui'), 'ui');
  assert.equal(parseCategory('类别：UI'), 'ui');
  assert.equal(parseCategory('effect'), 'effect');
  assert.equal(parseCategory('不知道'), 'character');
});

test('用户填的动作名优先于 AI 起的名字，大小写原样保留', () => {
  const r = bakeMotion({ name: 'enter', duration: 1, tracks: [] }, build(), { name: 'Win_Enter' });
  assert.equal(r.name, 'Win_Enter');
});

test('用户把动作命名为 idle：替换掉呼吸 idle，只剩一个动画', () => {
  const sk = build();
  const r = bakeMotion({ name: 'enter', duration: 1, tracks: [{ part: 'crown', alpha: [{ t: 0, a: 1 }] }] }, sk, { name: 'idle' });
  assert.equal(r.name, 'idle');
  applyMotion(sk, r);
  assert.deepEqual(Object.keys(sk.animations), ['idle']);
  assert.ok(sk.animations.idle.slots.crown_slot, '应是提示词动作，不是呼吸');
});

test('动作名里的非法字符换成下划线；只填了空白就用 AI 起的名字', () => {
  assert.equal(bakeMotion({ name: 'enter', duration: 1, tracks: [] }, build(), { name: 'win 动画!' }).name, 'win____');
  assert.equal(bakeMotion({ name: 'enter', duration: 1, tracks: [] }, build(), { name: '  ' }).name, 'enter');
});

test('合并后的提示词：告诉模型里面可能混着拆件说明，没有动作描述时输出 none', () => {
  const text = buildMotionPrompt({ parts: summarizeParts(uiParts()), imageSize: IMG, motionPrompt: '横幅是根部件' });
  assert.match(text, /拆件/);
  assert.match(text, /"none":\s*true/);
});

test('模型判断没有动作描述（none）：不产出动画，交给调用方保留 idle', () => {
  const r = bakeMotion({ none: true, tracks: [] }, build());
  assert.equal(r.none, true);
  assert.equal(r.animation, null);
});

/*
 * 2026-11-03 结算图：号角从画面外斜着飞进来，位移和旋转同一段减速，角度拖到最后才转正，
 * 用户看着「歪着进来、最后才变正」；盖章字 1.5 倍半透明停太久糊成一团；结尾只剩一个垫子。
 * 规则里没讲怎么动才自然，模型就照字面写。非角色类补上 UI 动效的手法。
 */
test('非角色类的动作规则：入场以缩放淡入为主、旋转先于位移归位、淡入要快、结尾不留孤件', () => {
  const text = buildMotionPrompt({ parts: summarizeParts(uiParts()), imageSize: IMG, motionPrompt: '号角滑入', category: 'ui' });
  assert.match(text, /旋转.*先/);
  assert.match(text, /0\.1\s*秒/);
  assert.match(text, /缩放/);
  assert.match(text, /只剩/);
  const ch = buildMotionPrompt({ parts: summarizeParts(uiParts()), imageSize: IMG, motionPrompt: '挥手', category: 'character' });
  assert.doesNotMatch(ch, /旋转.*先/, '角色类沿用原规则');
});

/*
 * 2026-11-03 结算图：子部件的网格一半绑在父骨骼（横幅）上——那是给人物关节藏接缝用的。
 * 「Complete」从 1.3 倍缩回来、号角斜着滑进来时，绑在横幅上的那半不跟着动，整张字/号角被扯变形。
 * UI 元素各自独立，只跟自己的骨骼走。
 */
test('非角色类不做蒙皮：子部件是整张贴图（region），只跟自己的骨骼走', () => {
  const sk = generateSkeleton({ parts: uiParts() }, '4.2', { imageSize: IMG, density: 8, skin: false });
  const skin = sk.skins[0]?.attachments ?? sk.skins.default;
  for (const [slot, atts] of Object.entries(skin)) {
    for (const a of Object.values(atts)) assert.notEqual(a.type, 'mesh', `${slot} 不该是蒙皮网格`);
  }
  const skinned = generateSkeleton({ parts: uiParts() }, '4.2', { imageSize: IMG, density: 8 });
  const s2 = skinned.skins[0]?.attachments ?? skinned.skins.default;
  assert.ok(Object.values(s2).some((atts) => Object.values(atts).some((a) => a.type === 'mesh')), '默认（角色）照旧蒙皮');
});
