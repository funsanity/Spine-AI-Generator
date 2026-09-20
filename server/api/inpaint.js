/**
 * 部件补图。
 *
 * 硬切部件会留下两处"缺内容"，alpha 扩散只能把已有颜色往外推，补不出新东西：
 *
 *   1. 部件自己缺内容。头发按 bbox 切出来，发梢之外的透明区本来是别人的
 *      （额头、衣服、背景），转动时那一片是空心的。
 *   2. 原图缺内容。头发整块被切走之后，剩下的身体上留着一个洞——
 *      头发单独动的时候，底下得是个完整的光头，而不是一块缺口。
 *
 * 两处都用同一个办法解决：把"要补的区域"做成蒙版，交给图像模型的编辑接口
 * （/v1/images/edits，multipart，支持 mask）重新画一遍，只取蒙版内的像素
 * 贴回来。蒙版外的像素一个都不动，所以几何、配色、笔触全部保持原样。
 *
 * 关键约束：补图不改变 bbox。骨骼位置是按 bbox 算出来的，bbox 一变骨头就全偏，
 * 所以补出来的是"同样尺寸、透明区被填上内容"的图。
 */

import sharp from 'sharp';
import { readFile, writeFile } from 'fs/promises';
import FormData from 'form-data';
import { bleedAlpha } from './cutter.js';

/** 低于此 alpha 视为"缺内容"，要交给模型补 */
const ALPHA_CUTOFF = 8;

/** 送进模型前把图缩到这个长边。
 *  编辑接口的计费按图像 token 走，原图尺寸往往一两千像素，
 *  补出来的内容又会缩回原尺寸，缩放损失看不出来，费用却差好几倍。 */
const MAX_EDGE = 1024;

/** 单次调用超时。图像编辑比文本慢得多，给足 */
const TIMEOUT_MS = 180000;

/** 补砸的洞往外找参照色的上限。放到模块作用域是为了让测试读到同一份数字，
 *  而不是在测试里另抄一个 12 —— 抄出来的上限改不动线上行为。 */
const RING_MAX = 12;
/** 一圈上至少要有这么多真实像素才认它当参照，避免孤零零一两个抗锯齿点定调 */
const RING_MIN_N = 8;

/**
 * 标出「连到图边的透明区」——也就是部件外面的留白，而不是它身上的洞。
 *
 * 从四条边往里泛洪，只走透明像素。走得到的是外部留白（bbox 的 padding、
 * 肩膀两侧的空白）；走不到的是被内容围住的**内部孔洞**（部件接缝处的缝隙、
 * 被邻件挡掉的那一小块）。
 *
 * 这个区分是补图能不能不糊白边的关键，取代了原先「距轮廓 ≤N 像素就放行」
 * 的判据。那个判据看着合理，实测会在每个部件上糊出一圈白边：
 *
 *   切图的 padding 里本来就躺着**邻件**的不透明像素（实测边框像素有
 *   30~70% 是不透明的）。距离是从"任何不透明像素"算的，于是从邻件那几个
 *   像素往外推 4px 就够到图边，模型在 padding 里瞎猜出来的浅色被放行成
 *   不透明——白圈就是这么来的。A/B 实测：10 个部件里 9 个白边从 0 涨到
 *   最多 121px。
 *
 * 换成泛洪之后，padding 无论里面有没有邻件像素都连着图边，一律保持透明，
 * 只吃 RGB 扩散（拉伸取色照样有料）；真正该补的内部孔洞照常填实。
 *
 * @returns {Uint8Array} 1 = 外部留白，0 = 内容或内部孔洞
 */
function markExteriorGap(data, width, height) {
  const exterior = new Uint8Array(width * height);
  const transparent = (i) => data[i * 4 + 3] < ALPHA_CUTOFF;

  // 显式栈，别用递归——几百万像素的部件会爆栈
  const stack = [];
  const push = (x, y) => {
    const i = y * width + x;
    if (exterior[i] || !transparent(i)) return;
    exterior[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  return exterior;
}

/**
 * 复核每个内部孔洞的补图结果，判定哪些该退回"四周均色"。
 *
 * 做法：把「蒙版内 ∩ 非外部留白」的像素按 4 邻域分成连通块，对每块统计
 *   - 模型填出来的像素里，近白中性灰占多少（whiteFrac）
 *   - 紧贴这块的真实内容（原图不透明像素）的均色（ring）
 * 整块几乎都白、而四周内容本身不白，就判模型补失败，整块改用 ring 色。
 *
 * @param {Uint8Array|null} [depthGuard] - 1 = 这个像素已被深度擦除挖走，
 *   不许当参照色来源。底板补图时传进来：洞底下的内容本该由**更靠后**的层
 *   决定，拿一张被挖过的图去取样会把别层的颜色带进来（用户的"分层"要求）。
 *   不传则退回只看 alpha 的老行为。
 * @returns {Array<[number,number,number]|null>} 下标同像素；非 null 表示该用这个色
 */
function resolveHoleFillsWithCount(baseData, filledData, maskData, exterior, width, height, depthGuard = null) {
  const fallback = resolveHoleFills(baseData, filledData, maskData, exterior, width, height, depthGuard);
  const count = fallback.filter(v => v !== null).length;
  return { fallback, count };
}

function resolveHoleFills(baseData, filledData, maskData, exterior, width, height, depthGuard = null) {
  const fallback = new Array(width * height).fill(null);
  const seen = new Uint8Array(width * height);
  const isHole = (i) => maskData[i] > 127 && !exterior[i];

  /*
   * 一个像素能不能当参照色来源。两道门：
   *
   *   ① 它必须真的有不透明内容（alpha >= cutoff）。这条天然排除了
   *      "已经被切出去的像素"——它们在底板上 alpha=0，取不到。
   *      这就是用户担心的第 2 点，代码层面本来就不会引到已切割区域。
   *
   *   ② 它不能在 depthGuard 里（被深度擦除挖走的位置）。第 ① 条已经
   *      挡住了大部分，但 erased 区在补图**之后**会被填成不透明，
   *      如果重跑同一个洞的复核，那些新填的内容就可能被当成"真实内容"
   *      反过来定调。depthGuard 把这条也堵上。
   */
  const canReference = (i) => {
    if (baseData[i * 4 + 3] < ALPHA_CUTOFF) return false;
    if (depthGuard && depthGuard[i]) return false;
    return true;
  };

  /**
   * 洞的参照色：先看紧邻，紧邻没有就一圈圈往外扩。
   *
   * 原来只认"紧贴洞边界的真实内容"，找不到就 ringN=0 直接放弃、留模型的
   * 原样。这条退路是错的——模型往洞里画白的时候，正需要有人兜底。
   *
   * 实测 skirt：它那一整片 8782px 是**一个**连通的洞，边界上只有一角
   * 85px 贴到真实内容，其余边界外就是透明，于是大半个洞 ringN=0，
   * 守卫直接跳过，模型画的一片近白（255,254,254）原样落到切图里。
   * 源图那里是暗紫 rgb(110,100,116)。
   *
   * 往外扩到 2~8 环就能找到深紫（实测扩 2 环 196px 参照 rgb(7,3,11)、
   * 扩 4 环 2478px 参照 rgb(28,22,31)、扩 8 环 14198px 参照 rgb(40,30,43)），
   * 拿它兜底远好过留一片白。
   *
   * 上限 RING_MAX 见模块顶部：成本是 O(洞像素 × 环宽)，再大不划算；
   * 而到上限还找不到参照，说明这个洞大得离谱，那种情况本来也不该由
   * 这条兜底管——那就继续留模型的输出，不猜。
   */
  function ringColor(cells) {
    for (let k = 1; k <= RING_MAX; k++) {
      let rr = 0, gg = 0, bb = 0, n = 0;
      for (const i of cells) {
        const x = i % width;
        const y = (i / width) | 0;
        // 只取第 k 圈（切比雪夫距离），一圈不够再往外
        for (let dy = -k; dy <= k; dy++) {
          for (let dx = -k; dx <= k; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const j = ny * width + nx;
            if (isHole(j)) continue;
            if (!canReference(j)) continue;
            rr += baseData[j * 4]; gg += baseData[j * 4 + 1]; bb += baseData[j * 4 + 2];
            n++;
          }
        }
      }
      if (n >= RING_MIN_N) {
        return { ring: [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)], n, k };
      }
    }
    return null;
  }

  /*
   * 近白中性灰：各通道 ≥215 且通道差 ≤12（比棋盘格判据松一点，
   * 模型画的伪透明常带一点脏）。
   *
   * 门槛原来是 225，实测漏掉一排"脏白"：底板 erased 区里有 307px
   * rgb(220~225) 的浅灰，源图那里是暗色 (lum 64-67)。
   * 它们卡在 225 下面一两个色阶，守卫没抓到，在深色袖子上就是一排白点
   * （output/_visual_e2e/zoom_right_arm_edge_base.png 能看到）。
   *
   * 降到 215 复核过：新抓的 307px **全部**落在 erased 区、且源图对应位置
   * 全部是暗色 (lum≤80)，没有一个是源图本身就有的浅色内容——不会误伤。
   */
  const nearWhite = (d, i) => {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    return Math.min(r, g, b) >= 215 && Math.max(r, g, b) - Math.min(r, g, b) <= 12;
  };

  /*
   * 近黑：三通道均 ≤25。
   *
   * 模型在深度擦除区有时会补成黑色（实测底板 6044px 黑、源图那里是中灰），
   * 而老守卫只抓近白，黑块就漏了。加一条：四周是亮色、洞里却黑，同样算补砸。
   */
  const nearBlack = (d, i) => {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    return Math.max(r, g, b) <= 25;
  };

  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !isHole(start)) continue;

    const cells = [];
    const stack = [start];
    seen[start] = 1;
    let whiteN = 0, blackN = 0;
    let rr = 0, gg = 0, bb = 0, ringN = 0;

    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      if (nearWhite(filledData, i)) whiteN++;
      if (nearBlack(filledData, i)) blackN++;

      const x = i % width;
      const y = (i / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const k = ny * width + nx;
        if (isHole(k)) {
          if (!seen[k]) { seen[k] = 1; stack.push(k); }
        } else if (canReference(k)) {
          // 紧贴孔洞的真实内容，用来算均色
          rr += baseData[k * 4]; gg += baseData[k * 4 + 1]; bb += baseData[k * 4 + 2];
          ringN++;
        }
      }
    }

    /*
     * 参照色：紧邻的真实内容优先；没有就往远处扩（见 ringColor）。
     * 都找不到才真放弃——那种情况多半是整块都是洞，没有可信的参照。
     */
    let ring;
    if (ringN) {
      ring = [Math.round(rr / ringN), Math.round(gg / ringN), Math.round(bb / ringN)];
    } else {
      const far = ringColor(cells);
      if (!far) continue;   // 真的找不到参照，不敢改，留模型的
      ring = far.ring;
    }
    // 门槛跟 nearWhite 保持一致：参照色本身在 215~225 之间时，
    // 若这里还用 225 判「四周本来就白」，就会放行该纠的脏白块。
    const ringIsWhite = Math.min(...ring) >= 215 && Math.max(...ring) - Math.min(...ring) <= 12;
    const ringIsDark = Math.max(...ring) <= 40;  // 参照色本身很暗

    /*
     * 四周是深色内容时，洞里就不该出现近白中性灰。两层处理：
     *
     *   ① 逐像素：凡是近白中性灰，一律换成四周均色。
     *      只卡"整块比例"会漏长尾——模型每次输出都不一样，实测同一个洞
     *      两次跑出来 whiteFrac 0.00 和 0.15，后者漏了 127px 白点。
     *
     *   ② 整块比例过 0.25 时，整块都换成均色。
     *      大片补砸的情况下只挑白像素替换会留下斑驳的边，不如整块铺平。
     *
     * ringIsWhite 把"四周本来就白"的情形（眼白、剪刀金属高光）整个挡在
     * 外面，所以这里敢下手。
     *
     * 对称处理黑块：四周是亮色内容时，洞里不该出现黑。实测底板 6044px
     * 源图中灰 (lum 60-80) → 补图黑 (rgb 0-19)，就是模型在 erased 区补砸了。
     */
    if (ringIsWhite) continue;  // 四周本来就白，近白填充是对的
    if (ringIsDark) {
      // 四周本来就暗（max ≤ 40）。两种情况：
      //   ① ring 本身近黑（max ≤ 25）：近黑填充是对的，只纠近白。
      //   ② ring 中暗（26-40）：填色比参照色更暗就是补砸，近黑也该纠正。
      const ringIsNearBlack = Math.max(...ring) <= 25;
      const badN = whiteN + (ringIsNearBlack ? 0 : blackN);
      if (badN / cells.length > 0.25) {
        for (const i of cells) fallback[i] = ring;
      } else {
        for (const i of cells) {
          if (nearWhite(filledData, i) || (!ringIsNearBlack && nearBlack(filledData, i))) fallback[i] = ring;
        }
      }
      continue;
    }

    /*
     * 四周是中间亮度：近白和近黑都该退回均色。
     * 实测 ring lum 60-80（中灰偏暗）、模型填成 rgb(0-19)，两者差 40+。
     */
    const badN = whiteN + blackN;
    if (badN / cells.length > 0.25) {
      for (const i of cells) fallback[i] = ring;
    } else {
      for (const i of cells) {
        if (nearWhite(filledData, i) || nearBlack(filledData, i)) fallback[i] = ring;
      }
    }
  }

  return fallback;
}

/**
 * 建蒙版：把 alpha 低于阈值的地方涂白，其余涂黑。
 * 白 = 要重画；黑 = 必须原样保留。
 *
 * 判的是"透明"而不是 bbox——bbox 里的不透明内容必须留黑，
 * 否则模型会把原内容也重画一遍，笔触和配色就跟原图对不上了。
 *
 * 返回的是**单通道**灰度 PNG，字节数 == 像素数。
 * 这点很要紧：sharp 会把单通道图编码成 3 通道的 sRGB PNG，
 * 再按"1 像素 1 字节"去读就会整体错位——蒙版区域被斜着切成三分之一样子，
 * 合成出来的位置完全对不上。所以读回来时统一 extractChannel 压回 1 通道。
 */
export async function buildMaskFromAlpha(pngPath, { width, height } = {}) {
  const { data, info } = await sharp(pngPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = width ?? info.width;
  const h = height ?? info.height;
  const mask = Buffer.alloc(w * h);

  for (let i = 0; i < w * h; i++) {
    mask[i] = data[i * 4 + 3] < ALPHA_CUTOFF ? 255 : 0;
  }

  return sharp(mask, { raw: { width: w, height: h, channels: 1 } })
    .png({ palette: false })
    .toBuffer();
}

/**
 * 把蒙版读成"1 像素 1 字节"。
 *
 * sharp 编码灰度 PNG 时会塞进 3 个通道，这里统一压回单通道再读，
 * 免得每个调用点各判一次通道数——那种分支迟早有一处漏判。
 */
export async function readMask(maskBuf) {
  const { data, info } = await sharp(maskBuf)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 1) throw new Error(`蒙版通道数异常: ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

/** 统计蒙版里要补的像素占比。占比太小说明没洞可补，不值得调一次模型 */
export async function maskCoverage(maskBuffer) {
  const { data, width, height } = await readMask(maskBuffer);
  let white = 0;
  for (let i = 0; i < width * height; i++) if (data[i] > 127) white++;
  return white / (width * height);
}

/**
 * 调一次图像编辑接口。
 *
 * 用 multipart 而不是 JSON：只有 multipart 能直接传本地文件，
 * 走 URL 的形式要求图片先传到公网，本地工具没这个条件。
 *
 * @returns {Promise<Buffer>} 模型返回的图片（PNG）
 */
export async function editImage({ apiKey, baseURL, model, imageBuf, maskBuf, prompt, size }) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('image', imageBuf, { filename: 'image.png', contentType: 'image/png' });
  form.append('mask', maskBuf, { filename: 'mask.png', contentType: 'image/png' });
  if (size) form.append('size', size);

  /*
   * 用 http/https 原生请求发这个 multipart，而不是 fetch。
   *
   * form-data 是流式的：getHeaders() 给出的 Content-Length 只有真正把流
   * pipe 出去才对得上。经 undici 的 fetch 转发时，流式 body 的长度与会话
   * 管理容易对不上，服务端会直接回报 "Unexpected end of form"。
   * 原生请求是纯 pipe，长度天然一致。
   */
  const res = await postMultipart(
    `${baseURL.replace(/\/+$/, '')}/v1/images/edits`,
    form,
    { Authorization: `Bearer ${apiKey}` },
    TIMEOUT_MS
  );

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 错误响应可能不是 JSON */ }

  /*
   * 报错必须带状态码 + 完整响应体。
   *
   * 之前只取 body.error.message，拿不到就退回 text.slice(0, 200)。
   * 中转站的 400 常常返回一段没有 error.message 的结构（或纯文本），
   * 结果日志里只剩下 "Bad request" 四个字——既没有状态码，
   * 也看不到服务端到底在抱怨哪个字段，排查时等于没有信息。
   */
  if (!res.ok) {
    const detail = body?.error?.message
      || body?.message
      || (text.trim() ? text.trim() : '(空响应体)');
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const first = (body?.data ?? [])[0];
  if (!first) throw new Error('返回体里没有图片');

  if (first.b64_json) return Buffer.from(first.b64_json, 'base64');

  if (first.url) {
    const img = await fetch(first.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!img.ok) throw new Error(`下载结果图失败: HTTP ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  }

  throw new Error('返回体里没有可用的图片字段');
}

/**
 * 补一个部件：把切出来的图里的透明区画上内容。
 *
 * 结果尺寸和原图完全一致——模型输出的分辨率未必对得上，
 * 所以按原尺寸缩回去，再只把蒙版内的像素盖上去。
 */
export async function inpaintPart(pngPath, { apiKey, baseURL, model, partName, occlusionEdges, size, maxQualityAttempts = 2 }) {
  const original = await sharp(pngPath).ensureAlpha();
  const meta = await original.metadata();
  const { width, height } = meta;

  const maskBuf = await buildMaskFromAlpha(pngPath, { width, height });

  /*
   * 深度擦除掩码（cutter 写的 .erased.png）。
   *
   * 补图靠「透明区连不连到图边」区分"部件外的 padding"（保持透明）
   * 和"部件身上的洞"（填实）。深度擦除造出了第三种东西：被前方部件
   * 挖掉的一大片，它按定义连到图边，却正是最该填的地方。
   * 不读这张掩码，补图会把模型补出来的内容整片丢掉——
   * 实测 basket_back 报"补了 99%"，落盘却只有 0.8% 不透明。
   *
   * 它在两处用到：给模型的输入图上盖检查板（告诉他这里要补形状），
   * 以及下面算 exterior 时豁免这些像素。
   */
  const erasedPath = pngPath.replace(/\.png$/, '.erased.png');
  const erasedExists = await sharp(erasedPath).metadata().then(() => true, () => false);
  let erased = null;
  /*
   * 真值：被擦那片在源图里原样的 RGB（cutter 顺手写进了 .erased.png 的像素）。
   *
   * 有真值就直接贴回去，不让模型补。为什么：被前方部件盖住的那片，模型
   * 看不到下面是什么，只能照着画面里还看得见的东西推——推出来就是遮挡者
   * 的一份复制品。实测 body 在裙摆底下补出 [119,113,129]，源图那格是
   * [108,96,118]（裙摆的紫灰）；head 在镜片底下补出 [246,183,157]，
   * 源图那格是 [225,173,159]。static 图看不出来（那片被盖着），两片按
   * 不同骨头转起来就是一层错色的重影——用户报的"断裂滑动"就是这个。
   *
   * 源图那个像素不是猜的，它就是当时真正显示的颜色；用户要的
   * 「完整 Object RGBA」要的正是这一份。
   *
   * 判据：alpha=255（在擦除掩码里）且 RGB 非全零（cutter 没真值时留 0）。
   */
  let truth = null;          // Uint8Array(w*h*3)，源图在那里的原样 RGB；null = 没真值
  if (erasedExists) {
    const eb = await sharp(erasedPath).ensureAlpha().raw().toBuffer();
    erased = new Uint8Array(width * height);
    truth = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      if (eb[i * 4 + 3] <= 127) continue;               // 不在擦除掩码里
      erased[i] = 1;
      truth[i * 3] = eb[i * 4];
      truth[i * 3 + 1] = eb[i * 4 + 1];
      truth[i * 3 + 2] = eb[i * 4 + 2];
    }
    if (!erased.some(Boolean)) truth = null;
  }

  /*
   * 前方轮廓掩码（cutter 写的 .front.png）。
   *
   * 擦除区里有一部分是**被前方部件整个盖住的**——补图看不到下面是什么，
   * 只有猜。实测它就照着画面里还看得见的东西画：围裙压在裙子上，裙子的
   * 擦除区里补出来的全是围裙的紫灰（平均比源图暗 27 个色阶，只有 4.3%
   * 的像素和源图接近），成了围裙的一份重影。那片 alpha 是 0、预览里看不见，
   * 但两片按不同骨头转起来就露馅了。
   *
   * 所以这片像素：内容照补（模型总得画点什么），但 alpha 一律留 0。
   * 它被盖住的时候看不见，转开时露出的也是干净的透明，而不是一层重影。
   * 和"部件自己身上的洞"区分开——那种洞有真值（周围的接缝），该填实。
   */
  const frontPath = pngPath.replace(/\.png$/, '.front.png');
  const frontExists = await sharp(frontPath).metadata().then(() => true, () => false);
  let front = null;
  if (frontExists) {
    const fb = await sharp(frontPath).ensureAlpha().raw().toBuffer();
    front = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      front[i] = fb[i * 4] > 127 ? 1 : 0;
    }
  }

  // 没有透明区就没什么可补的，白白调一次模型
  const coverage = await maskCoverage(maskBuf);
  if (coverage < 0.005) {
    return { skipped: true, reason: '没有需要补的透明区', coverage };
  }

  // 送模型前缩到 MAX_EDGE 以内，补完再缩回来
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const workW = Math.max(16, Math.round(width * scale));
  const workH = Math.max(16, Math.round(height * scale));

  // 编辑接口要求尺寸是 16 的倍数
  const reqW = Math.round(workW / 16) * 16;
  const reqH = Math.round(workH / 16) * 16;

  /*
   * size 传 "auto"，不要把算出来的尺寸传过去。
   *
   * 实测中转站的图像编辑接口**只认它白名单里的 size 值**，传自定义尺寸
   * 一律 400（错误码 RJ_BAD_REQUEST，响应体里只有 "Bad request" 一句话，
   * 看不出是哪个字段有问题）。而 400 是<b>瞬时</b>返回的（0.3~6 秒），
   * 形状上看像限流，很容易误判成"重试就好"——实际上重试 3 次全败。
   *
   * 之前那批"部分成功"是巧合：只有长边正好落在 1024、算出来的 size 恰好
   * 合法的那几个部件能过。所以规律的边界看着毫无道理
   * （832x800 过、900x900 挂），因为真正的判据根本不是图片尺寸。
   *
   * 传 "auto" 之后所有尺寸都通过（含 144x192 这种小图），
   * 模型自己选分辨率，返回的图按原尺寸缩回去即可——本来就有这一步。
   */
  const apiSize = 'auto';

  /*
   * 送进模型的那份图先摊平到"边缘色"上。
   *
   * 模型收到的 PNG 是带 alpha 的，但它内部是 3 通道（返回体就是
   * channels=3 hasAlpha=false），透明区会被按惯例摊成黑色。
   * 于是模型看到的不是"这里缺内容"，而是"这里本来就有一块黑"——
   * 补出来的就是黑框，用户看到的就是整张图糊着黑块。
   *
   * 摊平到扩散过的边缘色上，模型才会把它当成"需要接着画的区域"，
   * 补出来的颜色也才和周围接得上。
   */
  /*
   * 摊平到扩散过的边缘色上。
   *
   * 模型收到的 PNG 是带 alpha 的，但它内部是 3 通道（返回体就是
   * channels=3 hasAlpha=false），透明区会被按惯例摊成黑色。
   * 于是模型看到的不是"这里缺内容"，而是"这里本来就有一块黑"——
   * 补出来的就是黑框，用户看到的就是整张图糊着黑块。
   *
   * 摊平到扩散过的边缘色上，模型才会把它当成"需要接着画的区域"，
   * 补出来的颜色也才和周围接得上。
   *
   * 但**深度擦除出来的区域**不能这样处理：它紧邻的"边缘色"就是前方
   * 部件的颜色（篮筐的棕、前圈的黄），扩散几轮之后整片擦除区被染成
   * 那个颜色，模型看图就以为"这里本来就有内容"，于是不补形状、
   * 只顺着涂一片同色。实测 basket_back 补成一片棕、tomato 补成一片红褐。
   *
   * 所以擦除区要单独盖一层显眼的检查板：模型才认得出"这里是空的、
   * 要按旁边的轮廓补出形状"。图案用中性灰白，不干扰它对配色的判断。
   */
  const erasedForApi = erased
    ? await sharp(Buffer.from((() => {
        const b = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const v = erased[i] ? 255 : 0;
          b[i * 4] = v; b[i * 4 + 1] = v; b[i * 4 + 2] = v; b[i * 4 + 3] = 255;
        }
        return b;
      })()), { raw: { width, height, channels: 4 } })
        .resize(reqW, reqH, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })
    : null;

  /*
   * 前方轮廓掩码也按同一比例缩到送模型的尺寸。
   *
   * 缩放在这里做一次而不是每帧重算：它是常量，循环里每轮都用同一份输入
   * （见下面"每轮拿到的都是同一份干净输入"那段）。
   */
  const frontForApiMasked = front
    ? await sharp(Buffer.from((() => {
        const b = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const v = front[i] ? 255 : 0;
          b[i * 4] = v; b[i * 4 + 1] = v; b[i * 4 + 2] = v; b[i * 4 + 3] = 255;
        }
        return b;
      })()), { raw: { width, height, channels: 4 } })
        .resize(reqW, reqH, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data }) => {
          const m = new Uint8Array(reqW * reqH);
          for (let i = 0; i < reqW * reqH; i++) m[i] = data[i * 4] > 127 ? 1 : 0;
          return m;
        })
    : null;

  const imgForApi = await sharp(pngPath)
    .ensureAlpha()
    .resize(reqW, reqH, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      const flat = Buffer.alloc(info.width * info.height * 4);
      for (let i = 0; i < info.width * info.height; i++) {
        flat[i * 4] = data[i * 4];
        flat[i * 4 + 1] = data[i * 4 + 1];
        flat[i * 4 + 2] = data[i * 4 + 2];
        flat[i * 4 + 3] = 255;
      }
      // 借用切图那套 alpha 扩散：把不透明像素的颜色推进透明区，
      // 透明区就有了"周围的颜色"而不是黑
      const spread = bleedAlpha(flat, info.width, info.height, 8);

      /*
       * 擦除区覆盖成醒目的"缺失"纹理。
       *
       * 光靠"这里是透明"模型分辨不出该补什么——它看到的是一张 RGB 图，
       * 透明区在哪它只能从颜色推断。盖上图案之后意图才明确。
       *
       * 图案试过中性灰棋盘，不够——模型把灰白当成了"内容的一部分"，
       * 顺着涂了一片同色（实测 tomato 底部补成暗红块、西瓜补成棕块）。
       * 换成**洋红斜纹**：这个颜色在自然图里不可能出现，模型不会把它
       * 误认成内容，只能当作"这里的形状要靠我推出来"的信号。
       *
       * 斜纹而不是方格：斜线本身带方向感，比方格更像"占位符"。
       * 条纹宽度 10px（按缩放后的尺寸算），太细会糊成一片纯洋红。
       */
      if (erasedForApi) {
        const { data: em, info: ei } = erasedForApi;
        const STRIPE = 10;
        for (let y = 0; y < info.height; y++) {
          for (let x = 0; x < info.width; x++) {
            const i = y * info.width + x;
            // 掩码经过缩放，边缘会有灰值；>127 当擦除区
            if (em[i * 4] <= 127) continue;

            // front 区已经在掩码里挖掉了，这里也不用盖占位符
            if (frontForApiMasked && frontForApiMasked[i]) continue;
            const on = (((x + y) / STRIPE) | 0) % 2 === 0;
            if (on) {
              spread[i * 4] = 255;
              spread[i * 4 + 1] = 0;
              spread[i * 4 + 2] = 255;
            } else {
              spread[i * 4] = 255;
              spread[i * 4 + 1] = 255;
              spread[i * 4 + 2] = 255;
            }
          }
        }
        void ei;
      }

      return sharp(spread, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer();
    });

  /*
   * 送模型的掩码里，把"没真值"的那片挖掉。
   *
   * front 区是被前方部件整个盖住、源图那里本来就空的地方。补图在那儿
   * 没有真值可参考，只能照着画面里还看得见的东西推——围裙压在裙子上，
   * 它就把裙子那片照样画了一遍（实测平均比源图暗 27 个色阶，只有 4.3%
   * 的像素和源图接近）。那块虽然会被压成 alpha=0，可一转动就露出
   * 一层重影，用户看到的"断裂滑动"就是这么来的。
   *
   * 与其让模型去画、再把它压透明（白花一次推理、还留下重影的隐患），
   * 不如根本不让它补：掩码里去掉这片，模型只补**有真值**的部分。
   * 落盘时那片保持透明，被盖住的时候看不见，转开时是干净的透明。
   */
  const maskForApi = await sharp(maskBuf)
    .resize(reqW, reqH, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(async ({ data, info }) => {
      if (!front) {
        return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
          .png().toBuffer();
      }
      const m = Buffer.from(data);
      const ch = info.channels;
      for (let i = 0; i < info.width * info.height; i++) {
        // front 是原尺寸的，按同一比例取样（缩放前就是二值图，取样够用）
        const sx = Math.min(width - 1, Math.round((i % info.width) * width / info.width));
        const sy = Math.min(height - 1, Math.round(((i / info.width) | 0) * height / info.height));
        if (!front[sy * width + sx]) continue;
        for (let c = 0; c < ch; c++) m[i * ch + c] = 0;
      }
      return sharp(m, { raw: { width: info.width, height: info.height, channels: ch } })
        .png().toBuffer();
    });

  /*
   * 生成补图 prompt。
   *
   * 有 occlusion_edges 时，告诉模型"这些边是被其他部件遮挡的，需要补全延伸进来"。
   * 比"fill in the transparent areas"更精确：模型知道哪个方向有遮挡、该往哪边推断，
   * 不会把被遮挡的轮廓边当作真正的轮廓边来绘制轮廓线。
   *
   * 深度擦除的部件额外说明一次：checkerboard 那块的形状必须由模型自己
   * 顺着轮廓补出来（西瓜要补成整片瓜、篮子要补成完整的圈），
   * 不能简单涂成一种颜色。不说这句，模型倾向直接填一片同色。
   */
  const edges = Array.isArray(occlusionEdges) && occlusionEdges.length ? occlusionEdges : [];

  const occlusionHint = edges.length
    ? `The ${edges.join(' and ')} side(s) of this sprite are occluded by other parts — ` +
      `extend the shape and texture naturally into those directions as if the occlusion were removed. `
    : '';

  const erasedHint = erased
    ? 'The magenta/white striped areas are NOT part of the artwork — they are placeholder markers ' +
      'showing where this object was covered by parts in front of it and is now missing. ' +
      'Replace every striped pixel with the object\'s own content: continue its silhouette, ' +
      'outline and internal texture across the gap so the shape closes naturally. ' +
      'A round object must stay round, a woven basket must keep its weave. ' +
      'Do not leave any magenta, and do not simply flood the area with one flat color. '
    : '';

  const prompt = [
    `This is a single 2D game sprite of "${partName}", cut out on a transparent background.`,
    occlusionHint,
    erasedHint,
    'Fill in the transparent areas by continuing the visible content:',
    'extend the shape, strands, textures, and colors that are already present at the borders.',
    'Match the existing art style, line weight, color palette, and outline thickness exactly.',
    'Keep every visible pixel unchanged. Do not add a background, shadow, or border.',
    'Do not shift, rotate, or resize the artwork.'
  ].filter(Boolean).join(' ');

  /*
   * 质量重试（用户明确要的「模型审核，不合格再补一次」）。
   *
   * 「合格」的判据用现成的孔洞守卫，不另外调一次模型去问「这张行不行」：
   * resolveHoleFills 已经逐个连通块复核过模型补出来的东西，凡是判定补砸、
   * 被换成四周均色的像素都记在 guardedCount 里。它就是最直接的质量分——
   * 守卫救回来的越多，说明模型这一轮画得越离谱（补成一片白、一片黑）。
   *
   * 再花一次图像调用去让模型自评没有意义：它对「我刚画的是不是伪透明棋盘格」
   * 恰恰是最不敏感的，而守卫是按像素量出来的事实。
   *
   * 每轮都从**原始切图**重新补：pngPath 在循环里只读不写（唯一那次落盘挪到
   * 循环外了），所以 base/maskBuf/imgForApi 每轮拿到的都是同一份干净输入，
   * 不会出现「在上一轮补砸的结果上接着补」。
   *
   * 留最好的那一轮，不是留最后一轮——模型每次画的不一样，第 2 轮可能更差。
   */
  const GUARD_OK_FRAC = 0.02;

  let bestFinalBuf = null;
  let bestFrac = Infinity;
  let bestGuarded = 0;
  let bestPainted = 0;
  let bestChk = 0;
  let bestAttempt = 0;
  let lastQualErr = null;
  const qMax = Math.max(1, Math.min(5, Math.round(maxQualityAttempts) || 2));

  for (let qAttempt = 1; qAttempt <= qMax; qAttempt++) {
    /*
     * 失败重试。
     *
     * 中转站在连续调用图像接口时很容易甩回 400/429/5xx：失败请求常常在
     * 1 秒内就返回（根本没轮到模型），而成功的要 25~35 秒。这种"瞬时的、快
     * 速的拒绝"重试一次往往就过了，而一次补图失败意味着这个部件的接缝要一直
     * 露到重跑整条流程为止——重跑一次要 5 分钟，退避几秒重试明显划算。
     *
     * 只重试"看起来是临时故障"的状态码；401/403（key 不对）不重试，
     * 重试一百次也不会变对。
     */
    const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
    const MAX_ATTEMPTS = 3;

    let edited;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        edited = await editImage({
          apiKey, baseURL, model,
          imageBuf: imgForApi,
          maskBuf: maskForApi,
          prompt,
          size: apiSize
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // 没拿到状态码说明是网络层错误（超时、连接被断），同样值得重试
        const retriable = err.status === undefined || RETRY_STATUS.has(err.status);
        if (!retriable || attempt === MAX_ATTEMPTS) break;

        // 2s → 6s 退避，给中转站一点喘息时间
        const wait = attempt * 2000 * attempt;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (lastErr) {
      lastErr.message = `${lastErr.message}（已重试 ${MAX_ATTEMPTS} 次）`;
      // 接口这一轮彻底没通：记下来，把机会让给下一次质量重试。
      // 一次都没成过的话，循环结束后再抛。
      lastQualErr = lastErr;
      continue;
    }

    // 模型输出可能是任意尺寸，缩回部件原尺寸再合成
    const filled = await sharp(edited)
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    /*
     * 补出来的内容只用来填"洞"，不能动轮廓。
     *
     * 这里曾经把蒙版内所有像素的 alpha 直接写成 255，结果是每个部件都变成一张
     * 实心矩形：切图时为了给关节留拉伸余量，bbox 四边各外扩了几个像素，
     * 那片 padding 在蒙版里同样是"透明"、同样被写成了不透明。轮廓一没，
     * 预览里部件就互相糊成一片黑框，锯齿边缘全冒出来了。
     *
     * 正确的做法是分开两件事：
     *   - RGB：蒙版内的像素用模型补出来的颜色（连 padding 一起补，
     *     这样网格拉伸时取到的是内容而不是透明黑，接缝处不会泛暗边）
     *   - alpha：沿用原图的 alpha。轮廓的形状是切图决定的，补图只负责填内容，
     *     没有资格改形状。
     * 洞的 alpha 本来就是 0，保留 0 也不影响——网格盖上去时由网格顶点决定可见范围。
     */
    let filledData = filled.data;
    let chkCleared = 0;
    if (filled.info.channels === 3) {
      // 中转站返回 3 通道，模型把"透明"画成了 RGB 纹理（棋盘格）
      const rgba = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = filledData[i * 3];
        rgba[i * 4 + 1] = filledData[i * 3 + 1];
        rgba[i * 4 + 2] = filledData[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      const chk = removeCheckerboard(rgba, width, height, 4);
      filledData = chk.buffer;
      chkCleared = chk.cleared;
    }

    const base = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // 用原尺寸的蒙版来判合成范围：送模型的那份缩过，不能拿来当掩码
    const maskRaw = await readMask(maskBuf);
    if (maskRaw.width !== width || maskRaw.height !== height) {
      throw new Error(`蒙版尺寸 ${maskRaw.width}x${maskRaw.height} 与部件 ${width}x${height} 不一致`);
    }

    /*
     * 算出"可以变成不透明"的范围：只有**内部孔洞**能放行。
     *
     *   ① 内部孔洞（被内容围住、连不到图边）——部件接缝处的缝隙、被邻件
     *      挡掉的那一块。这些填实，缺口才补得上。
     *
     *   ② 外部留白（连到图边的透明区，含 bbox 外扩的 padding）——保持透明。
     *      它只吃下面那轮 RGB 扩散，网格拉伸时照样取得到颜色，
     *      但不会在轮廓外多出一圈不透明像素。
     *
     * 不能放行整个蒙版：肩膀、裙摆这类部件 bbox 边缘离轮廓有几十像素，
     * 全放行等于把部件变成实心矩形，预览里互相糊成黑框——pipeline 测试的
     * opaqueRatio 和 area-growth 两道门专门捉这个回归。
     *
     * 深度擦除引入第三种区域：被前方部件挖掉的一大片。它按定义连到图边，
     * 却正是该填的地方。上面读到的 erased 掩码在这里豁免它们。
     */
    const exterior = markExteriorGap(base.data, width, height);
    if (erased) {
      for (let i = 0; i < width * height; i++) {
        if (erased[i]) exterior[i] = 0;  // 擦除区不当外部留白，允许填实
      }
    }

    /*
     * 逐个内部孔洞复核模型补出来的东西，补砸了就退回四周的均色。
     *
     * 模型经常往孔洞里画一片近白中性灰（中转站的"伪透明"棋盘格就是这个色），
     * 填成不透明之后，预览里手臂和围裙之间会多出两块白楔子——实测 body 造了
     * 1952px、apron 1239px，而原图那里手臂和围裙是贴合的，根本没有空隙。
     *
     * removeCheckerboard 管不到这里：它从图边泛洪，而孔洞按定义连不到图边。
     *
     * 判据放在**连通块**上而不是单像素上：剪刀的金属高光、眼白这类内容本来
     * 就是近白的，按像素砍会把它们一起砍掉。整块都白、而四周一圈真实内容
     * 不白，才算模型补失败。
     */
    /*
     * 深度分层守卫（用户第 3 点）。
     *
     * 深度擦除挖出来的那片区域，它的内容本该由**更靠后**的层决定。拿被挖过的
     * 图去取参照色，等于让"别的层露出来的颜色"参与定调——层次就是这么串的。
     *
     * erased 掩码标出的正是这些位置，直接传进去挡住。底板尤其需要：它一整张
     * 都被部件挖过，6044px 黑就是这么补出来的（源图中灰，模型填黑）。
     *
     * 只在有 erased 掩码时启用；没有深度信息的部件退回只看 alpha 的老行为，
     * 免得改动波及本来就对的路径。
     */
    const { fallback: holeFallback, count: guardedCount } = resolveHoleFillsWithCount(
      base.data, filledData, maskRaw.data, exterior, width, height, erased
    );

    /*
     * 质量分只算**看得见**的那部分像素。
     *
     * 被前方部件整个盖住的那片（front）补成什么样都无所谓——它的 alpha
     * 最后会被压成 0，渲染时根本不显示。可它面积很大（实测 body 那片
     * 5 万像素，占了 painted 的 70%），模型在那儿画得又是最常见的近白/近黑，
     * 守卫逐块往回捡，质量分就被这堆看不见的像素顶到 70%，
     * 明明看得见的部分是好的，却判成"不合格"白重补一轮。
     *
     * 所以分子分母都只统计 front 之外的像素。分母为 0（整个擦除区都是
     * 被盖住的）时直接算合格——没有可见部分要评。
     */
    let visiblePainted = 0, visibleGuarded = 0;
    for (let i = 0; i < width * height; i++) {
      if (maskRaw.data[i] <= 127) continue;
      if (front && front[i]) continue;
      visiblePainted++;
      if (holeFallback[i]) visibleGuarded++;
    }

    const out = Buffer.alloc(width * height * 4);
    let painted = 0;
    for (let i = 0; i < width * height; i++) {
      if (maskRaw.data[i] > 127) {
        // 洞：拿模型的颜色（补砸的孔洞改用四周均色）；
        // alpha 只在内部孔洞放行，外部留白保持透明
        const fb = holeFallback[i];
        out[i * 4] = fb ? fb[0] : filledData[i * 4];
        out[i * 4 + 1] = fb ? fb[1] : filledData[i * 4 + 1];
        out[i * 4 + 2] = fb ? fb[2] : filledData[i * 4 + 2];
        /*
         * 两种像素的 alpha 处置：
         *   - 外部留白（exterior）：0，轮廓外不凭空长东西。
         *   - 其余（真正的内部孔洞）：255，缺口就该补上。
         *
         * front 区不在这里——它在送模型的掩码里就已经挖掉了（见上面
         * maskForApi 那段），模型根本没补，maskRaw 在那儿是 0，走的是
         * 下面「原有内容」那一支，RGB 就是切图填回去的源图真值。
         */
        out[i * 4 + 3] = exterior[i] ? 0 : 255;
        painted++;
      } else {
        // 原有内容：一个字节都不动
        out[i * 4] = base.data[i * 4];
        out[i * 4 + 1] = base.data[i * 4 + 1];
        out[i * 4 + 2] = base.data[i * 4 + 2];
        out[i * 4 + 3] = base.data[i * 4 + 3];
      }
    }

    /*
     * alpha 扩散。
     *
     * 补出来的颜色里，洞的那一圈往往和原内容接不上（模型也是猜的），
     * 而洞的 alpha 是 0，双线性采样会把洞里的颜色和边缘的实色平均——
     * 不铺一层就会被拉出一圈脏边。切图那次扩散只覆盖了 bbox 外扩的几个像素，
     * 洞是补图新填出来的，得再扩散一次。
     *
     * 只写 RGB、不动 alpha，所以形状依然是原轮廓。
     */
    const finalBuf = bleedAlpha(out, width, height, 2);

    /*
     * 有真值的那片：把源图原样的颜色贴回去，覆盖模型在这片画的东西。
     *
     * 放在 bleedAlpha **之后**：扩散只写 RGB、不动 alpha，会把周围的颜色
     * 渗进这片，把真值搅脏。贴回是最后一步，写完就是最终像素。
     *
     * 放在选轮次**之后**：质量分只该看模型真正发挥的部分（可见区），
     * 被盖住那片既由真值决定，就不该参与评判。
     *
     * alpha 给 255 而不是留 0：用户要的是「隐藏区域(AI补全/Inpaint) →
     * 完整 Object RGBA」——围裙甩开的时候底下得有身体，留 0 就是个洞。
     * 跟着 body 骨头动的那块，画的是当时真正显示的颜色，接缝天然对得上。
     */
    if (truth) {
      let truthPainted = 0;
      for (let i = 0; i < width * height; i++) {
        if (!erased[i]) continue;
        const t = truth[i * 3], tg = truth[i * 3 + 1], tb = truth[i * 3 + 2];
        /*
         * 全零 = cutter 在那里没有真值（源图本来是空的，实测两件素材合计
         * 412px）。那种才留给模型补，不贴。
         */
        if (!t && !tg && !tb) continue;
        finalBuf[i * 4] = t;
        finalBuf[i * 4 + 1] = tg;
        finalBuf[i * 4 + 2] = tb;
        finalBuf[i * 4 + 3] = 255;
        truthPainted++;
      }
      if (truthPainted) {
        console.log(`[补图] ⧉ ${partName ?? ''} 被前方盖住的 ${truthPainted}px 用源图真值贴回（不让模型编）`);
      }
    }

    // 守卫救回来的比例就是这一轮的质量分，越低越好（只算可见像素）
    const gFrac = visiblePainted > 0 ? visibleGuarded / visiblePainted : 0;
    /*
     * 选"最好的一轮"按**可见**质量分，不按绝对像素数。
     *
     * 按像素数选会被大面积、看不见的 front 区带偏：第 1 轮可见部分完美
     * 但 front 区画砸了 5 万像素，第 2 轮可见部分差一点但 front 区画得好，
     * 就会选中第 2 轮——而用户看到的正是可见部分。
     */
    const gFracForPick = visiblePainted > 0 ? visibleGuarded / visiblePainted : 0;
    if (gFracForPick < bestFrac || bestFinalBuf === null) {
      bestFinalBuf = finalBuf;
      bestFrac = gFracForPick;
      bestGuarded = visibleGuarded;
      bestPainted = visiblePainted;
      bestChk = chkCleared;
      bestAttempt = qAttempt;
    }

    if (gFrac <= GUARD_OK_FRAC) {
      if (qAttempt > 1) {
        console.log(`[补图] ✓ ${partName ?? ''} 第 ${qAttempt} 轮合格（守卫 ${(gFrac * 100).toFixed(1)}%）`);
      }
      break;
    }

    if (qAttempt < qMax) {
      console.log(
        `[补图] ↻ ${partName ?? ''} 第 ${qAttempt} 轮不合格（守卫救回 ${visibleGuarded}/${visiblePainted}px = ` +
        `${(gFrac * 100).toFixed(1)}% > ${(GUARD_OK_FRAC * 100).toFixed(0)}%），重补`
      );
    } else {
      console.warn(
        `[补图] ⚠ ${partName ?? ''} ${qMax} 轮都不合格，采用最好的第 ${bestAttempt} 轮` +
        `（守卫 ${(bestGuarded / Math.max(1, bestPainted) * 100).toFixed(1)}%）`
      );
    }
  }

  // 一轮都没成（每轮的接口重试都用尽了）：把最后那个错误抛出去
  if (!bestFinalBuf) {
    throw lastQualErr ?? new Error('补图未产出结果');
  }

  const finalBuf = bestFinalBuf;
  const painted = bestPainted;
  const chkCleared = bestChk;
  const guardedCount = bestGuarded;

  /*
   * 有真值的那片：把源图原样的颜色贴回去，覆盖模型在这片画的东西。
   *
   * 放在选轮次**之后**：质量分和轮次选择只该看模型真正发挥的部分（可见区），
   * 被盖住那片既然由真值决定，就不该参与评判。
   *
   * alpha 给 255 而不是留 0：用户要的是「隐藏区域(AI补全/Inpaint) →
   * 完整 Object RGBA」——围裙甩开的时候底下得有身体，留 0 就是个洞。
   * 会跟着 body 骨头动的那块，现在画的是当时真正显示的颜色，接缝天然对得上。
   */


  await sharp(finalBuf, { raw: { width, height, channels: 4 } }).png().toFile(pngPath);

  return {
    ok: true,
    coverage,
    painted,
    guardedFrac: bestFrac === Infinity ? 0 : bestFrac,
    guardedPixels: guardedCount,
    paintedPixels: painted,
    size: `${width}x${height}`,
    checkerboardCleared: chkCleared
  };
}


/**
 * 一个部件补图时真正要补的东西。
 *
 * 这张表是理解为什么"每个部件单独补一次"就够的关键：
 * 部件 A 的切片里，透明区正好就是"被 A 遮住的那些部件"。
 * 把这些位置按 A 的形状补出内容，A 转动或缩放时露出的就是合理的内容，
 * 而不是透明洞。所以补 A 的切片 = 补 A 遮住的所有东西，一次调用同时解决。
 *
 * 也就是说：
 *   - "头发切走后额头要补成光头" —— 头发是后画的，它遮住额头；
 *     补头发的切片（把额头位置按头皮内容填上）就是这件事。
 *   - "部件自身边缘要完整" —— 同一个蒙版顺带解决，发梢外的透明区一起被填。
 * 两件事一个蒙版、一次调用，不需要一个共享的底图层
 * （当前每个部件都是独立 sprite，也确实没有那种图层）。
 */
/** 用原生 http/https 发 multipart，返回一个 Response 形状的对象 */
async function postMultipart(url, form, extraHeaders, timeoutMs) {
  const { request } = url.startsWith('https:')
    ? await import('node:https')
    : await import('node:http');
  const { URL } = await import('node:url');

  const u = new URL(url);

  return new Promise((resolve, reject) => {
    const req = request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...form.getHeaders(), ...extraHeaders }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => buf.toString('utf-8'),
          buffer: async () => buf
        });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时（>${timeoutMs / 1000}s）`)));
    req.on('error', reject);

    // 流式 pipe：长度由 form-data 自己算，和 getHeaders 里的 Content-Length 天然一致
    form.pipe(req);
  });
}

// RING_* 与 resolveHoleFills 一并导出，只给测试用：这几条判据（洞的连通块、
// 参照色、外扩上限）是补图最容易出错的一环，必须在真函数上验，而不是在测试里
// 重写一遍——重写出来的守卫和线上跑的不是同一份代码，遮住过一次 bug
// （skirt 的 462px 白）。RING_MAX 尤其要共用，测试里另抄一个 12 就改不动线上了。
export { ALPHA_CUTOFF, MAX_EDGE, RING_MAX, RING_MIN_N, resolveHoleFills };

/**
 * 清除中转站补图返回的棋盘格伪透明。
 *
 * 中转站的 /v1/images/edits 返回的是 3 通道 PNG（channels=3 hasAlpha=false），
 * 模型无法输出真透明，只能把"透明"画成 RGB 纹理——症状是棋盘格。
 *
 * 检测：从四边泛洪，只吃与边缘连通的近白中性灰（R,G,B 都在 237~255 且通道差 ≤7）。
 * 和去背的逻辑一致：内部的白（白衣服、白发）不与边缘连通，保留。
 *
 * @param {Buffer} data - RGBA 像素缓冲
 * @param {number} width
 * @param {number} height
 * @param {number} channels - 必须是 4
 * @returns {{buffer: Buffer, cleared: number}}
 */
export function removeCheckerboard(data, width, height, channels) {
  if (channels !== 4) throw new Error(`removeCheckerboard 要求 4 通道，实际 ${channels}`);

  const out = Buffer.from(data);
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let sp = 0;

  // 近白中性灰：每个通道 237~255，通道间差 ≤7
  const isChk = (idx) => {
    const i = idx * 4;
    const r = out[i], g = out[i + 1], b = out[i + 2];
    const mn = Math.min(r, g, b);
    const mx = Math.max(r, g, b);
    return mn >= 237 && (mx - mn) <= 7;
  };

  const tryPush = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (seen[idx]) return;
    if (!isChk(idx)) return;
    seen[idx] = 1;
    stack[sp++] = idx;
  };

  // 从四边作为种子
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

  return { buffer: out, cleared };
}
