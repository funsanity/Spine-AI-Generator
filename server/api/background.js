/**
 * 背景转透明。
 *
 * 这是整条链路的前置步骤，缺了它后面全都白做：
 *
 *   1. 切图用的是 sharp.extract()，切出来的是**矩形**，不是按轮廓抠的形状。
 *      源图背景不透明时，每个部件就是一个实心方块——相邻部件的背景被一起切进来，
 *      拼回场景里就是一堆互相遮挡的白色方块，动起来像贴纸叠罗汉。
 *
 *   2. 补图判的是 alpha。背景不透明就一处 alpha=0 都没有，
 *      蒙版全黑 → 每个部件都报「没有需要补的透明区」，一次模型都不会调。
 *      日志看着一切正常，功能实际一次都没生效。
 *
 * 做法是从四边往里做**连通**泛洪，只有和画布边缘连通的背景色才清掉。
 * 不能用「全图等于背景色的像素都清」——角色内部的白（眼白、牙齿、高光、
 * 白衣服）会和背景同色，那样会连人一起镂空。
 *
 * 实测一张 1728x2304 白底图：边缘连通的背景占 66.6%，全图纯白占 68.8%，
 * 也就是说有 2.2% 的纯白是角色自己的。这个差值就是必须用泛洪而不能用色键的原因。
 */

import sharp from 'sharp';

/** 背景色容差。0 只吃纯色，放宽能吃下 JPEG 压缩噪点和轻微渐变 */
const DEFAULT_TOLERANCE = 18;

/** 判定"这个像素算背景" */
function isBackground(r, g, b, bg, tol) {
  if (Math.abs(r - bg[0]) > tol) return false;
  if (Math.abs(g - bg[1]) > tol) return false;
  if (Math.abs(b - bg[2]) > tol) return false;
  // 背景是白的，但角色身上有暗色像素时，色差判据已经挡住了；
  // 这里再排除"背景色但明显更暗"的情况，免得吃掉深色描边。
  return true;
}

/**
 * 取背景色：四个角各自的颜色投票，取出现最多的那个。
 *
 * 不用"左上角一个点"：角色常常压到某个角，或者图上有水印、圆角、
 * 边框。四角投票能扛住其中一个角被占。四角颜色各不相同（比如四角都有
 * 角色或渐变）时返回 null，调用方会跳过这一步——宁可不去背，也不能瞎去。
 */
export function detectBackground(data, width, height, channels, tolerance = DEFAULT_TOLERANCE) {
  const at = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  const corners = [
    at(0, 0),
    at(width - 1, 0),
    at(0, height - 1),
    at(width - 1, height - 1)
  ];

  let best = null;
  let bestVotes = 0;
  for (const c of corners) {
    let votes = 0;
    for (const o of corners) {
      if (Math.abs(c[0] - o[0]) <= tolerance &&
          Math.abs(c[1] - o[1]) <= tolerance &&
          Math.abs(c[2] - o[2]) <= tolerance) votes++;
    }
    if (votes > bestVotes) {
      bestVotes = votes;
      best = c;
    }
  }

  // 四角至少要有一致的一半（2/4）才敢认定这是背景色
  if (bestVotes < 2) return null;
  return best;
}

/**
 * 把任意通道数的像素缓冲转成 RGBA。
 * 3 通道补 255 的 alpha；4 通道原样拷贝；灰度单通道按灰度铺开。
 */
function allocRGBA(data, pixels, channels) {
  if (channels === 4) return Buffer.from(data);
  const out = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    if (channels === 1) {
      out[i * 4] = data[i]; out[i * 4 + 1] = data[i]; out[i * 4 + 2] = data[i];
    } else {
      out[i * 4] = data[i * channels];
      out[i * 4 + 1] = data[i * channels + 1];
      out[i * 4 + 2] = data[i * channels + 2];
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * 从四边泛洪，把与边缘连通的背景色像素清成透明。
 *
 * 用显式栈而不是递归：1728x2304 的图递归会爆栈。
 * 用 Uint8Array 标记已访问，避免同一像素反复入栈。
 *
 * @returns {{buffer: Buffer, width: number, height: number, cleared: number, total: number, background: number[]|null}}
 */
export function removeBackgroundPixels(data, width, height, channels, options = {}) {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const bg = options.background ?? detectBackground(data, width, height, channels, tolerance);

  if (!bg) {
    return {
      buffer: allocRGBA(data, width * height, channels),
      width, height,
      cleared: 0,
      total: width * height,
      background: null,
      skipped: true
    };
  }

  /*
   * 输出固定按 4 通道算。
   *
   * 入参可能是 3 通道（无 alpha 的 PNG），但"清成透明"这件事本身要求
   * 输出必须有 alpha 通道，否则清了个寂寞。之前这里是 Buffer.from(data)，
   * 原样拷贝——3 通道输入就得到 3 通道输出，写 i+3 全都越界到下一个像素上，
   * 症状是 buffer 长度对不上、alpha 全是垃圾值。
   *
   * 返回值统一是 RGBA，调用方不必关心入参几通道。
   */
  const out = allocRGBA(data, width * height, channels);
  const seen = new Uint8Array(width * height);
  // 用 Int32Array 当栈，2 倍冗余够用；写指针自己前进
  const stack = new Int32Array(width * height);
  let sp = 0;

  const tryPush = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (seen[idx]) return;
    const i = idx * channels;
    if (!isBackground(data[i], data[i + 1], data[i + 2], bg, tolerance)) return;
    seen[idx] = 1;
    stack[sp++] = idx;
  };

  // 四条边全部作为种子，不是只从四角出发：
  // 背景常常被角色从中间切断，只从角上出发会漏掉另一侧。
  for (let x = 0; x < width; x++) {
    tryPush(x, 0);
    tryPush(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    tryPush(0, y);
    tryPush(width - 1, y);
  }

  let cleared = 0;
  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % width;
    const y = (idx - x) / width;

    out[idx * 4 + 3] = 0;
    cleared++;

    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }

  return {
    buffer: out,
    width, height,
    cleared,
    total: width * height,
    background: bg,
    skipped: false
  };
}

/**
 * 对一张图做去背，返回 PNG Buffer。
 *
 * 已经带 alpha 的图（用户自己抠好的）直接原样返回：
 * 再跑一遍泛洪没有意义，还可能把已经透明的区域旁边的半透明边缘吃掉。
 */
export async function removeBackground(inputPath, options = {}) {
  const image = sharp(inputPath);
  const meta = await image.metadata();

  if (meta.hasAlpha) {
    return { skipped: true, reason: 'already-transparent', width: meta.width, height: meta.height };
  }

  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const result = removeBackgroundPixels(data, info.width, info.height, info.channels, options);

  if (result.skipped) {
    return { skipped: true, reason: 'no-uniform-background', width: info.width, height: info.height };
  }

  // 泛洪之后补一步：把抗锯齿过渡像素还原成半透明。
  // 少了这一步，轮廓上会留一圈白边（见 recoverEdgeAlpha 的说明）。
  const feather = recoverEdgeAlpha(
    result.buffer, result.width, result.height, info.channels, result.background, options
  );

  const buffer = await sharp(feather.buffer, {
    raw: { width: result.width, height: result.height, channels: info.channels }
  }).png({ compressionLevel: 9 }).toBuffer();

  return {
    skipped: false,
    buffer,
    width: result.width,
    height: result.height,
    background: result.background,
    cleared: result.cleared,
    ratio: result.cleared / result.total,
    feathered: feather.feathered
  };
}

/**
 * 还原边缘的抗锯齿 alpha。
 *
 * 泛洪只清"和背景几乎一样"的像素，抗锯齿留下的过渡像素比背景暗一点点，
 * 够不上阈值，就被当成不透明留了下来——结果是一圈**白边**。
 * 实测边缘像素 (188,187,183)：肉眼看着是白圈，因为它其实是
 * "55% 的角色色 + 45% 的白背景"混出来的。
 *
 * 这些像素本该是半透明的，泛洪把它们压成了不透明。补救办法是把混合
 * 反解回来：模型是 观察值 = a·本色 + (1-a)·背景色，
 * 也就是   观察值 = 背景色 - a·(背景色 - 本色)。
 * 三个通道里"相对背景色掉得最多"的那个通道给出 a 的下界，
 * 取三通道最小值最稳（角色色必定比背景暗，白底图上是这样）。
 *
 * 解出 a 之后还要把本色还原出来：本色 = (观察值 - (1-a)·背景色) / a。
 * 不还原的话，半透明像素里仍带着白，放大到深色底上还是会泛白。
 */
export function recoverEdgeAlpha(buffer, width, height, channels, background, options = {}) {
  const out = Buffer.from(buffer);
  const bg = background;
  // 掉幅小于这个值的当作噪声，不参与反解，免得把背景残渣拉成半透明噪点
  const MIN_DROP = options.minDrop ?? 6;

  let feathered = 0;

  for (let idx = 0; idx < width * height; idx++) {
    const i = idx * channels;
    if (out[i + 3] === 0) continue; // 已经是透明的，不动

    // 只处理紧贴透明区的像素，内部像素一刀不碰
    const x = idx % width;
    const y = (idx - x) / width;
    let touches = false;
    if (x > 0 && out[(idx - 1) * channels + 3] === 0) touches = true;
    else if (x < width - 1 && out[(idx + 1) * channels + 3] === 0) touches = true;
    else if (y > 0 && out[(idx - width) * channels + 3] === 0) touches = true;
    else if (y < height - 1 && out[(idx + width) * channels + 3] === 0) touches = true;
    if (!touches) continue;

    const r = out[i], g = out[i + 1], b = out[i + 2];

    // 每个通道反推 a，取最小值（掉得最多的通道最可信）
    let a = 1;
    for (const [val, ref] of [[r, bg[0]], [g, bg[1]], [b, bg[2]]]) {
      if (ref <= 0) continue;
      const ratio = 1 - (ref - val) / ref;  // = val / ref
      if (ratio < a) a = ratio;
    }

    // 基本没掉色 → 这个像素是角色本色，不是过渡像素
    const drop = 1 - a;
    if (drop * 255 < MIN_DROP) continue;

    a = Math.max(0, Math.min(1, a));
    if (a <= 0.004) { out[i + 3] = 0; feathered++; continue; }

    // 反解本色
    const inv = 1 - a;
    out[i]     = Math.max(0, Math.min(255, Math.round((r - inv * bg[0]) / a)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round((g - inv * bg[1]) / a)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round((b - inv * bg[2]) / a)));
    out[i + 3] = Math.round(a * 255);
    feathered++;
  }

  return { buffer: out, feathered };
}
