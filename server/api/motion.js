/**
 * 动作提示词 → Spine 动画。
 *
 * 分两半：
 *   - AI 那一半：看部件表和用户的动作描述，写一条时间轴（JSON）。坐标按图片习惯写
 *     （x 向右、y 向下、顺时针为正），这是模型最不容易搞反的写法；
 *   - 代码这一半（bakeMotion）：校验、夹值、换成 Spine 坐标（y 向上、逆时针为正），
 *     缓动烘成密集的线性关键帧，透明度写成槽位颜色轨道。
 *
 * 缓动不写 curve 而是烘成关键帧，和 idle 的做法一致：targets.js 导出时会把 curve 去掉
 * （3.8 和 4.x 的贝塞尔写法不同），预览渲染器也只做线性插值，烘出来三边都一样。
 */
import Anthropic from '@anthropic-ai/sdk';
import { createWithRetry, responseText, DEFAULT_MODEL } from '../ai/claude.js';

/** 缓动烘焙的采样率。30fps 下 0.3 秒的弹跳有 9 帧，肉眼看不出折线 */
const BAKE_FPS = 30;
/** 动画最长 30 秒，再长基本是模型把毫秒当成了秒 */
const MAX_DURATION = 30;
/** 角色类子部件转角上限：再大接缝就张开（见 generator.js idle 的说明） */
const CHARACTER_MAX_DEG = 10;

const EASES = {
  linear: (u) => u,
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  inOut: (u) => (1 - Math.cos(Math.PI * u)) / 2,
  // 过冲回弹：先冲过头约 10% 再落回
  back: (u) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
  }
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round = (v, n) => +v.toFixed(n);

/**
 * 部件表摘要：名字、父部件、外框、轴心（都换成图片绝对像素）。
 * 底板这类以 _ 开头的内部部件不给 AI 看，它不该被单独动。
 */
export function summarizeParts(parts) {
  return (parts ?? [])
    .filter((p) => p?.name && !p.name.startsWith('_'))
    .map((p) => ({
      name: p.name,
      parent: p.parent ?? null,
      bbox: {
        x: Math.round(p.bbox.x), y: Math.round(p.bbox.y),
        width: Math.round(p.bbox.width), height: Math.round(p.bbox.height)
      },
      pivot: {
        x: Math.round(p.bbox.x + (p.pivot?.x ?? p.bbox.width / 2)),
        y: Math.round(p.bbox.y + (p.pivot?.y ?? p.bbox.height / 2))
      }
    }));
}

export function buildMotionPrompt({ parts, imageSize, motionPrompt, category }) {
  const lines = parts.map((p) =>
    `- ${p.name}  父:${p.parent ?? '无'}  框:${p.bbox.x},${p.bbox.y} ${p.bbox.width}×${p.bbox.height}  轴心:${p.pivot.x},${p.pivot.y}`);
  const characterRule = category === 'character'
    ? '\n7. 这是角色：部件之间是拼接的，子部件相对父部件只能小角度转动（±10° 以内），不要写位移和缩放，否则接缝会裂开。整体位移/缩放写在最顶层部件上。'
    : `
7. 这是界面/特效类素材，动作要干净利落、符合镜头感：
   · 入场以「缩放 + 淡入」为主（例如 0.6→1.08→1 或 1.3→0.95→1），位移距离不超过部件自身尺寸的一半；不要从画面外长距离飞进来。
   · 同时有旋转和位移时，旋转先归位：在位移完成之前（前 60% 的时间内）转到最终角度，可以用 back 稍微冲过头，不要让角度一路拖到最后才转正。
   · 透明度从 0 到 1 要在 0.1 秒内完成，避免长时间半透明叠在别的部件上发糊；缩放/位移可以继续回弹。
   · 每一段收尾用 out 或 back 缓动，不要 linear；镜像对称的部件数值镜像、时间一致。
   · 部件全部到位后，安排轻微的持续动作（小幅呼吸缩放、±2°~3° 摇摆）保持画面有生气，直到动画结束。
   · 结尾不要只剩个别部件：除非描述明确要求全部消失，否则保持完整画面；描述里要淡出的就一起淡出，不要漏下某一件孤零零留在画面上。`;
  return `你是 Spine 骨骼动画师。下面是一张图拆出的部件，坐标是图片像素（原点在左上角，x 向右、y 向下），画布 ${imageSize.width}×${imageSize.height}。
请按用户提示词里的动作描述写出关键帧时间轴，只输出 JSON，不要解释。
用户提示词是拆件说明和动作描述写在一起的：拆件说明（哪些是部件、谁挂在谁上面）已经用过了，这里只看讲怎么动的部分。
如果整段里没有任何关于动作的描述（时间、入场、弹跳、淡入淡出、旋转、移动之类），只输出 {"none": true}，不要自己编动作。

部件（名字 / 父部件 / 外框 x,y 宽×高 / 轴心）：
${lines.join('\n')}

规则：
1. 只能用上面列出的部件名。描述里提到、但没有对应部件的东西（例如彩纸、光芒、粒子），不要编造，写进 skipped 并说明原因。
2. 所有数值都是相对静止姿势（也就是这张图本身的样子）：
   translate 是像素偏移（x 向右为正，y 向下为正）；rotate 是角度，顺时针为正，绕轴心转；
   scale 是倍数，1 为原大小，绕轴心缩放；alpha 是不透明度，0 透明、1 不透明。
3. 子部件会跟着父部件一起位移、旋转、缩放；alpha 不继承——父部件淡出时，子部件要各自写淡出。
4. 一个通道写了就从它的第一个关键帧开始生效。要从画面外或透明状态进入，t=0 就写好起始值。
5. ease 表示从这个关键帧到下一个关键帧的缓动：linear、in（加速）、out（减速）、inOut、back（冲过头再回弹）、step（保持不变，到下一帧再跳）。不写就是 linear。
6. 时间单位是秒，不能超过 duration。动画结束时各部件应回到描述里要求的最终状态。${characterRule}

输出格式：
{"name":"enter","duration":3.3,"loop":false,
 "tracks":[{"part":"部件名",
   "translate":[{"t":0,"x":0,"y":-300,"ease":"in"},{"t":0.4,"x":0,"y":0}],
   "rotate":[{"t":0,"deg":0}],
   "scale":[{"t":0,"x":1.5,"y":1.5,"ease":"out"},{"t":0.2,"x":1,"y":1}],
   "alpha":[{"t":0,"a":0},{"t":0.2,"a":1}]}],
 "skipped":[{"what":"彩纸","reason":"图中没有彩纸部件"}]}
name 用英文小写（如 enter、win、appear），不要用 idle。没用到的通道省略。

用户提示词：
${motionPrompt}`;
}

/** 从模型输出里取 JSON：容忍 ```json 包裹和前后的解释文字 */
export function parseMotionJson(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('动作时间轴里没有 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * 一个通道的关键帧：排序、夹时间、同一时刻只留最后一个，再按 ease 烘焙。
 * read(key) 返回数值数组（translate 是 [x,y]，alpha 是 [a]），write(time, vals) 产出 Spine 关键帧。
 */
function bakeChannel(rawKeys, duration, read, write) {
  const keys = (Array.isArray(rawKeys) ? rawKeys : [])
    .filter((k) => k && typeof k === 'object')
    .map((k) => ({ t: clamp(num(k.t ?? k.time, 0), 0, duration), ease: k.ease, vals: read(k) }))
    .sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const k of keys) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1].t - k.t) < 1e-6) dedup[dedup.length - 1] = k;
    else dedup.push(k);
  }
  const out = [];
  for (let i = 0; i < dedup.length; i++) {
    const a = dedup[i], b = dedup[i + 1];
    out.push(write(round(a.t, 4), a.vals));
    if (!b) break;
    if (a.ease === 'step') {
      // 保持到下一帧前一瞬。不写 curve: 'stepped'，导出时 curve 会被去掉
      const hold = b.t - 1 / (BAKE_FPS * 10);
      if (hold > a.t) out.push(write(round(hold, 4), a.vals));
      continue;
    }
    const fn = EASES[a.ease];
    if (!fn || fn === EASES.linear) continue;
    const span = b.t - a.t;
    const steps = Math.floor(span * BAKE_FPS);
    for (let s = 1; s < steps; s++) {
      const u = s / steps;
      const e = fn(u);
      out.push(write(round(a.t + span * u, 4), a.vals.map((v, j) => v + (b.vals[j] - v) * e)));
    }
  }
  return out;
}

const alphaHex = (a) => 'ffffff' + Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');

/**
 * AI 给的时间轴 → Spine 动画对象。
 *
 * @param {object} motion   - parseMotionJson 的结果
 * @param {object} skeleton - generateSkeleton 产出的骨架（取版本、骨骼和槽位）
 * @param {object} [opts]   - { category, imageSize, name }（name：用户指定的动作名）
 * @returns {{ name, duration, animation, warnings: string[], skipped: object[], none?: true }}
 *   none：模型判断提示词里没有动作描述，animation 为 null
 */
export function bakeMotion(motion, skeleton, opts = {}) {
  // 模型判断提示词里没写动作：不出动画，调用方保留 idle 呼吸
  if (motion?.none === true) return { none: true, name: null, duration: 0, animation: null, warnings: [], skipped: [] };
  const warnings = [];
  const duration = clamp(num(motion?.duration, 0) || 0, 0, MAX_DURATION);
  const spine = skeleton.skeleton?.spine ?? '4.0';
  const legacy = spine.startsWith('3.');
  const rotKey = legacy ? 'angle' : 'value';
  const colorKey = legacy ? 'color' : 'rgba';

  const bones = new Map((skeleton.bones ?? []).map((b) => [b.name, b]));
  const root = (skeleton.bones ?? []).find((b) => !b.parent);
  const slotOf = new Map((skeleton.slots ?? []).map((s) => [s.bone, s.name]));
  // 位移上限：画面最长边的 4 倍，超过多半是单位写错了
  const size = opts.imageSize ? Math.max(opts.imageSize.width, opts.imageSize.height) : 4096;
  const maxMove = size * 4;
  const character = opts.category === 'character';

  // 时长：AI 说的和关键帧里最晚的取大，保证最后一帧不被截掉
  let end = duration;
  for (const tr of motion?.tracks ?? []) {
    for (const ch of ['translate', 'rotate', 'scale', 'alpha']) {
      for (const k of Array.isArray(tr?.[ch]) ? tr[ch] : []) end = Math.max(end, num(k?.t ?? k?.time, 0));
    }
  }
  end = clamp(end, 0, MAX_DURATION) || 1;

  const animation = { bones: {}, slots: {} };
  for (const tr of motion?.tracks ?? []) {
    const name = tr?.part;
    const bone = bones.get(name);
    if (!bone || bone === root || name?.startsWith('_')) {
      warnings.push(`没有叫 ${name} 的部件，这条轨道已忽略`);
      continue;
    }
    // 角色类：部件是拼接的，子部件只要和父部件有相对位移/缩放，接缝就张开
    const child = character && bone.parent !== root?.name;
    const out = {};

    if (tr.translate?.length) {
      if (child) warnings.push(`${name} 是角色的子部件，相对位移会让接缝裂开，已去掉位移`);
      else out.translate = bakeChannel(tr.translate, end,
        (k) => [clamp(num(k.x, 0), -maxMove, maxMove), clamp(num(k.y, 0), -maxMove, maxMove)],
        (time, [x, y]) => ({ time, x: round(x, 2), y: round(-y, 2) }));
    }
    if (tr.rotate?.length) {
      const lim = child ? CHARACTER_MAX_DEG : 1080;
      if (child && tr.rotate.some((k) => Math.abs(num(k?.deg, 0)) > lim)) {
        warnings.push(`${name} 是角色的子部件，转角夹到 ±${lim}°，再大接缝会裂开`);
      }
      out.rotate = bakeChannel(tr.rotate, end,
        (k) => [clamp(num(k.deg ?? k.value ?? k.angle, 0), -lim, lim)],
        // 图片里顺时针为正，Spine 里逆时针为正
        (time, [d]) => ({ time, [rotKey]: round(-d, 3) || 0 }));
    }
    if (tr.scale?.length) {
      if (child) warnings.push(`${name} 是角色的子部件，相对缩放会让接缝裂开，已去掉缩放`);
      else out.scale = bakeChannel(tr.scale, end,
        (k) => {
          const s = num(k.s, 1);
          return [clamp(num(k.x, s), -10, 10), clamp(num(k.y, s), -10, 10)];
        },
        (time, [x, y]) => ({ time, x: round(x, 4), y: round(y, 4) }));
    }
    for (const ch of Object.keys(out)) if (!out[ch].length) delete out[ch];
    if (Object.keys(out).length) animation.bones[name] = out;

    if (tr.alpha?.length) {
      const slot = slotOf.get(name);
      const keys = bakeChannel(tr.alpha, end, (k) => [clamp(num(k.a ?? k.alpha, 1), 0, 1)],
        (time, [a]) => ({ time, color: alphaHex(a) }));
      if (slot && keys.length) animation.slots[slot] = { [colorKey]: keys };
    }
  }

  // 补齐时长：所有轨道都停在 end 之前时，动画会被运行时当成更短
  let last = 0, lastKeys = null;
  const scan = (tracks) => {
    for (const tr of Object.values(tracks)) for (const keys of Object.values(tr)) {
      const t = keys[keys.length - 1]?.time ?? 0;
      if (t >= last) { last = t; lastKeys = keys; }
    }
  };
  scan(animation.bones);
  scan(animation.slots);
  if (lastKeys && last < end) lastKeys.push({ ...lastKeys[lastKeys.length - 1], time: round(end, 4) });

  /*
   * 动作名：界面上用户填的优先（大小写原样，Spine 和引擎按名字调动画，改了大小写对不上）。
   * 用户填 idle 就是要拿它当待机动作，直接替换呼吸；AI 自己起名叫 idle 则改掉，免得把呼吸冲了。
   */
  const userName = String(opts.name ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
  let animName = userName && !/^_+$/.test(userName) ? userName : '';
  if (!animName) {
    animName = String(motion?.name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
    if (!animName || animName === 'idle' || /^_+$/.test(animName)) animName = 'motion';
  }

  const skipped = (Array.isArray(motion?.skipped) ? motion.skipped : [])
    .filter((s) => s && (s.what || s.reason))
    .map((s) => ({ what: String(s.what ?? ''), reason: String(s.reason ?? '') }));

  return { name: animName, duration: end, animation, warnings, skipped };
}

/** 把烘好的动作放进骨架，排在最前面：预览默认播第一个动画 */
export function applyMotion(skeleton, baked) {
  const rest = { ...(skeleton.animations ?? {}) };
  delete rest[baked.name];
  skeleton.animations = { [baked.name]: baked.animation, ...rest };
  return skeleton;
}

/**
 * 调 AI 写时间轴，再烘焙。只发文字（部件表 + 描述），不发图：
 * 部件已经有名字和位置，再发一次图只是多花 token。
 *
 * @param {object} args - { parts, imageSize, motionPrompt, category, skeleton, name, apiKey, baseURL, model }
 */
export async function generateMotion(args) {
  const { imageSize, motionPrompt, category, skeleton, name } = args;
  const parts = summarizeParts(args.parts);
  const client = args.client ?? new Anthropic({ apiKey: args.apiKey, baseURL: args.baseURL || undefined });
  const request = {
    model: args.model || DEFAULT_MODEL,
    max_tokens: 8192,
    messages: [{ role: 'user', content: buildMotionPrompt({ parts, imageSize, motionPrompt, category }) }]
  };
  let response = await createWithRetry(client, request);
  // 关键帧多的时候会被截断，截断是成功响应，只能看 stop_reason
  if (response.stop_reason === 'max_tokens') {
    response = await createWithRetry(client, { ...request, max_tokens: 32768 });
  }
  const motion = parseMotionJson(responseText(response));
  return bakeMotion(motion, skeleton, { category, imageSize, name });
}
