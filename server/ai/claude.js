/**
 * AI 图像分析模块 - 支持精确切图
 *
 * 坐标约定：AI 返回归一化比例（0~1），本模块换算成像素坐标后返回。
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';

const ANALYSIS_PROMPT = `直接分析下方这张图片，把图片拆解成可做骨骼动画的部件，并立即输出 JSON。

【核心理念】
拆图的目标是：每个部件在补图后能成为一张"独立完整的图片"，可以单独运动。
按**视觉层次**拆：前景遮后景，靠近镜头的在上层。
不要按"矩形框切割"拆成互不重叠的方块——那样被遮挡的区域会永远缺失。

【坐标规则 —— 最重要，请严格遵守】
所有 bbox 和 pivot 都必须用 **归一化比例** 表示，取值 0~1：
- 0 = 图片最上边/最左边，1 = 图片最下边/最右边
- 例如某个部件位于图片水平方向 30%~55%、垂直方向 10%~40% 的区域，
  就写 x=0.30, width=0.25, y=0.10, height=0.30
- **所有部件的 bbox 都相对于整张图片的左上角，不要相对于父部件**
- 不要输出像素值，不要出现大于 1 的数字

pivot 同样是归一化比例，但**相对于该部件自己 bbox 的左上角**：
- 旋转中心在部件正中 → pivot = {x: 0.5, y: 0.5}
- 旋转中心在部件上边缘中间 → pivot = {x: 0.5, y: 0.0}

【拆图规则 —— 每条都直接影响渲染质量，违反必出缺块/错位/白边】

1. **bbox 必须包含部件的完整范围，包括被遮挡的部分**
   被遮挡的区域不要排除在 bbox 之外——它会在补图时被还原出来。
   bbox 边缘要比可见内容再外扩 3~5 像素，保留轮廓线。
   例如：篮筐里的西红柿，bbox 要包含整个球的估算范围，不只是露出来的部分。

2. **bbox 允许重叠，遮挡关系靠 parent 层级保证**
   前景部件（遮住别人的）= 子级（后绘制，画在上层）
   后景部件（被遮住的）= 父级（先绘制，在下层）
   口诀：**"盖人的当儿子，被盖的当父亲"**

3. **遮挡关系判断规则（直接影响层次感）**
   - 判断依据：离镜头越近 = 越在上面 = 应该是子级（后绘制，盖住下面）
   - 具体规则：
     · 被遮住的部件 → parent = null 或更高父级（先绘制，在下层）
     · 遮住别人的部件 → parent 指向它盖住的那个部件（后绘制，在上层）
   - 常见错误方向：不能因为"头发在图片上方"就让头发当父级。
     头发盖在头部前面 → 头发是头部的子级，不是反过来。

4. **标注遮挡边（occlusion_edges）—— 指导补图方向**
   对于被其他部件遮挡的部分，用 occlusion_edges 标注哪些方向有遮挡：
   - 值是方向数组，可以是 "top"/"bottom"/"left"/"right" 的组合
   - 没有遮挡或完全可见的部件：occlusion_edges = []
   - 例：西红柿左侧被篮筐遮住 → occlusion_edges: ["left"]
   - 例：篮筐后景层顶部被前景层盖住 → occlusion_edges: ["top"]
   - 补图时会沿这些方向推断被遮挡的内容，所以必须准确

5. **bbox 只框「这个部件参与的区域」，不要框它完全不出现的区域**
   这条针对**被拆成前后两层的同一个物体**（典型：篮筐拆成前景层/后景层）。
   - 后景层（basket_back）：只框它实际露出的那部分范围（篮底 + 后半圈 + 提手）
   - 前景层（basket_front）：只框它实际露出的那部分范围（前面那半圈）
   - **不要两层都框整只篮子**——那样切出来两张一模一样的图，谁都补不对。
   - 中间层的水果反过来：bbox 要**扩到完整轮廓**，它被前圈挡住的底部靠补图补回来

   区分两种"被遮挡"：
   - 水果被篮筐挡住 → bbox 要扩到完整轮廓（补图要把它补成完整的西瓜）
   - 篮筐前层/后层 → bbox 只覆盖自己露出的范围（它们是同一物体的两个深度切片）

6. **部件数量控制在 6~15 个**
   太碎导致骨骼冗余；太粗则无法独立运动。
   不要拆文字、纹理、渐变、装饰线等不会独立运动的细节。

7. **bbox 不能超出图片边界**
   0 ≤ x, y 且 x+width ≤ 1，y+height ≤ 1。

8. **声明 depth —— 这个部件在深度排序里的位置（最重要的一条）**
   depth 是一个整数，表示"离镜头多近"，越小越靠后、越大越靠前。
   - 最里层（篮筐后景、躯干、背景）= 0
   - 每往外一层 +1：水果 1，篮筐前层 2
   - 同一层的部件用**相同的数字**（比如西瓜和西红柿都贴着篮底 → 都是 1）
   - 数字必须从 0 开始连续，不要跳号（不要出现 0,1,5）

   **为什么用数字而不是两两声明谁盖谁**：切图时要用这个顺序
   "擦掉所有比自己靠前的部件"，所以顺序必须是全局一致的。
   逐个声明"A 盖 B、B 盖 C"很容易绕成环（A 盖 B、B 盖 A），
   一旦成环切图就会把两个部件互相擦空。

   判断方法：想象把这堆部件按前后码成一摞，离眼睛最近的 depth 最大。
   例（12.png 篮筐）：
   - basket_back = 0（篮底、后半圈、提手）
   - watermelon = 1、tomato = 1、leaf_bag = 1（都坐在篮里，同一层）
   - basket_front = 2（前半个篮圈，盖住水果的底部）

   例（人物）：
   - body = 0、skirt = 1、apron = 2（围裙系在裙子外面）
   - 手臂插在躯干上 → 手臂 depth 比躯干大；眼镜架在脸上 → 比头大

9. **标注多边形轮廓 polygon —— 比 bbox 更精确**
   polygon 是 8~16 个顶点，按**顺时针**方向描出该部件的完整轮廓，含被遮挡的推算部分。
   坐标格式同 bbox，归一化 0~1，相对整张图左上角。

   - 被遮挡区域按部件真实形状推算：西红柿底部被篮圈压住 → 继续画圆弧到底部
   - 顶点不需要像素级，8~12 个对大多数部件够用；不规则形状可用到 16 个
   - polygon 比 bbox 更重要：切图时只保留 polygon 内的像素，
     框里的邻件像素会被自动去掉，西红柿里不会再混进篮子

   每个部件都必须输出 polygon，不能省略。

10. **紧密相连、一起运动的部件合并为一个**
   例如手持道具：手和道具一起运动时，合并为一个部件。
   分开后连接处必然出现缺块。

【层级规则 —— 决定动画时部件跟随关系】
- parent 表示运动归属：父部件转动时子部件跟着一起转
- 只有 1 个部件的 parent 为 null（根部件，通常是躯干/主体）
- 层级链示例：scissors → right_arm → body（剪刀跟着右臂，右臂跟着身体）

【篮筐类物品的典型拆法示例】
篮筐+水果这类图，正确拆法是：
- basket_back（篮筐后景层）：depth=0，包含篮底和后半圈+提手，occlusion_edges: []
- watermelon：depth=1，bbox 包含完整的西瓜估算范围，occlusion_edges: ["bottom","right"]
- tomato：depth=1，bbox 包含完整的西红柿，occlusion_edges: ["bottom","left"]
- basket_front（篮筐前景层）：depth=2，包含前半个篮圈，occlusion_edges: []

【输出格式】
只输出 JSON，不要任何解释文字、不要 markdown 代码块：

{
  "parts": [
    {
      "name": "basket_back", "parent": null, "depth": 0,
      "bbox": {"x": 0.05, "y": 0.30, "width": 0.90, "height": 0.70},
      "pivot": {"x": 0.5, "y": 0.5},
      "occlusion_edges": [],
      "polygon": [
        {"x": 0.50, "y": 0.30}, {"x": 0.85, "y": 0.38},
        {"x": 0.95, "y": 0.55}, {"x": 0.90, "y": 0.75},
        {"x": 0.70, "y": 0.90}, {"x": 0.30, "y": 0.90},
        {"x": 0.10, "y": 0.75}, {"x": 0.05, "y": 0.55},
        {"x": 0.15, "y": 0.38}
      ]
    },
    {
      "name": "tomato", "parent": "basket_back", "depth": 1,
      "bbox": {"x": 0.35, "y": 0.20, "width": 0.35, "height": 0.45},
      "pivot": {"x": 0.5, "y": 0.5},
      "occlusion_edges": ["bottom", "left"],
      "polygon": [
        {"x": 0.525, "y": 0.20}, {"x": 0.62, "y": 0.25},
        {"x": 0.68, "y": 0.38}, {"x": 0.68, "y": 0.52},
        {"x": 0.60, "y": 0.63}, {"x": 0.47, "y": 0.65},
        {"x": 0.37, "y": 0.57}, {"x": 0.35, "y": 0.43},
        {"x": 0.40, "y": 0.28}
      ]
    },
    {
      "name": "basket_front", "parent": "basket_back", "depth": 2,
      "bbox": {"x": 0.05, "y": 0.45, "width": 0.90, "height": 0.55},
      "pivot": {"x": 0.5, "y": 0.0},
      "occlusion_edges": [],
      "polygon": [
        {"x": 0.05, "y": 0.45}, {"x": 0.50, "y": 0.42},
        {"x": 0.95, "y": 0.45}, {"x": 0.95, "y": 1.00},
        {"x": 0.05, "y": 1.00}
      ]
    }
  ]
}`;

/**
 * 紧贴切图的补充规则。
 *
 * 默认那套规则要求"部件之间不重叠、拼起来能还原原图"，这在骨骼动画里是个坑：
 * 头发和后脑勺各自按完整轮廓划框的话，头发那块框里会连带一整片额头，
 * 头发一动，额头跟着一起动——正是要避免的。
 *
 * 所以这一档反过来要求：bbox 只框"这个部件独占的区域"，被遮住的部分不要框进来。
 * 允许重叠——槽位按父先子后的顺序绘制，子部件天然画在父部件上面，
 * 谁遮谁由 parent 层级决定，不需要靠 bbox 互不重叠来保证。
 */
const TIGHT_CUTOUT_RULES = `
【紧贴切图规则 —— 以下覆盖上面的第 1、2 条，其余规则不变】

1. bbox 只框住"这个部件自己独占、不被别的部件遮挡的区域"。
   - **不要把被其他部件遮挡的部分框进来**
   - 头发压着额头 → 头发只框头发本身，不框额头
   - 围裙盖着裙子 → 围裙只框围裙，不框裙子
   - **但 bbox 边缘仍要比可见内容外扩 3~5 像素**，保留轮廓线

2. 允许 bbox 重叠，遮挡关系一律靠 parent 层级决定：
   - 遮挡别人的 → **子级**（后绘制，盖在上面）
   - 被遮挡的 → **父级**（先绘制，露在下层）
   - 记忆口诀：**"盖人的当儿子，被盖的当父亲"**

3. 离镜头更近 = 更在上面 = 子级。不要用空间位置（上下左右）判断。
   - 头发在额头前面 → 头发是额头的子级（不是因为头发在图片上方）
   - 手臂在躯干前面 → 手臂是躯干的子级

4. 紧密相连一起动的部件要合并，不要拆开：
   - 手持道具：手+道具 → 合并为一个部件（分开必出缺块）
   - 眼镜+脸：如果眼镜不独立运动 → 归入头部，不单独拆

5. 宁可框大 3 像素，不要框小：切掉的轮廓线无法补回来。
`;

/** 默认模型。换模型前先确认它支持视觉输入——纯文本模型拆不了图 */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * 推理等级 → thinking 预算。
 *
 * 默认档刻意不传 thinking 字段，保持和加这个功能之前完全一致的行为：
 * 一是拆图是结构化视觉任务，开扩展思考收益有限却明显更慢更贵；
 * 二是中转站对 thinking 的支持参差不齐，不传最稳。
 *
 * budget 是「思考」能用的 token 数，必须小于 max_tokens，
 * 所以开启时把 max_tokens 抬到 budget + 基础输出量。
 */
export const REASONING_LEVELS = {
  default: { label: '默认（不开启）', budget: 0 },
  low: { label: '低', budget: 4096 },
  medium: { label: '中', budget: 10240 },
  high: { label: '高', budget: 24576 }
};

/** 不开思考时的输出上限。拆 6~15 个部件的 JSON 够用 */
const BASE_MAX_TOKENS = 8192;

/**
 * 截断重发的上限。
 *
 * 部件表是"一个 JSON 数组、每个部件带 8~16 个多边形顶点"，实测 12 个部件的
 * 人物图能写到 20KB 上下。一旦被 max_tokens 截断，`JSON.parse` 必然报
 * "Expected ',' or ']'" 之类的语法错——而这一句错会让整轮生成白跑：
 * 去背、SAM、切图、补图（实测 156s）全做完了，卡在最后一步的解析上。
 *
 * 所以解析失败不再直接抛，而是把额度翻倍重发一次。判断依据是响应本身的
 * `stop_reason === 'max_tokens'`，不是靠猜语法错误。
 */
const PARSE_RETRY_MAX_TOKENS = 32768;

/**
 * 中转站偶尔会回一个笼统的 400 Invalid request —— 同样的请求、同样的图，
 * 隔几秒重发就过。实测连续 5 次同请求全部成功，说明不是请求本身的问题。
 *
 * SDK 默认只重试 429 和 5xx，400 直接抛，于是这种瞬时抖动会让整个生成流程
 * 白跑（前面去背、补图都做完了，卡在最后一步）。这里补一层重试。
 *
 * 只重试"服务端抽风"这一类，两类不重试：
 *   - 模型名不存在（中转站回的是 "No active provider route ..."，不是这个文案）
 *   - 鉴权失败、请求体真的不合法（重试多少次都一样，早点报错省时间）
 */
const RETRY_MAX = 2;          // 最多再试 2 次，合计 3 次
const RETRY_BASE_MS = 1500;   // 退避基数：1.5s、3s

export function isTransient(err) {
  const status = err?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 400) {
    const msg = err?.message || '';
    return /invalid request/i.test(msg);
  }
  // 连接层抖动：DNS、TLS、socket 被掐
  const code = err?.code || err?.cause?.code || '';
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN/.test(code);
}

/**
 * 带退避的重试封装。只包 messages.create，不重试整个 analyzeImage ——
 * 重试整个函数会把读图、拼提示词也重做一遍，没必要。
 */
export async function createWithRetry(client, request, baseMs = RETRY_BASE_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.messages.create(request);
    } catch (err) {
      if (attempt >= RETRY_MAX || !isTransient(err)) throw err;
      const wait = baseMs * 2 ** attempt;
      console.warn(`[AI] 第 ${attempt + 1} 次调用失败（${err.status || err.code}），${wait}ms 后重试: ${(err.message || '').slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * 分析图片并生成部件结构（带精确像素 bbox）
 *
 * @param {string} imagePath - 图片路径
 * @param {string} prompt - 用户提示词
 * @param {object} options - { apiKey, baseURL, imageSize, model, reasoning }
 * @returns {Promise<object>} { parts: [{name, parent, bbox, pivot}] }
 */
export async function analyzeImage(imagePath, prompt, options) {
  const { apiKey, baseURL, imageSize } = options;
  const model = options.model || DEFAULT_MODEL;
  const level = REASONING_LEVELS[options.reasoning] ?? REASONING_LEVELS.default;

  // 读取图片并转 base64
  const imageData = readFileSync(imagePath).toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  // 构造 Anthropic 客户端
  const client = new Anthropic({
    apiKey,
    baseURL: baseURL || undefined
  });

  try {
    console.log(`[AI] 正在调用 ${model} 进行精确分析（推理等级：${level.label}）...`);

    // 紧贴切图那档要替换拆图规则，所以拼在基础提示词之后
    const rules = options?.tightCutout ? TIGHT_CUTOUT_RULES : '';
    const fullPrompt = `${ANALYSIS_PROMPT}${rules}\n\n用户需求：${prompt}`;

    const request = {
      model,
      max_tokens: level.budget ? level.budget + BASE_MAX_TOKENS : BASE_MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageData
            }
          },
          {
            type: 'text',
            text: fullPrompt
          }
        ]
      }]
    };

    // 只在选了非默认档时才加 thinking，默认档连字段都不出现
    if (level.budget) {
      request.thinking = { type: 'enabled', budget_tokens: level.budget };
    }

    const response = await createWithRetry(client, request);

    console.log(`[AI] API 调用成功（stop_reason=${response.stop_reason ?? 'n/a'}）`);

    const analysis = await parseWithRetry(response, request, client, imageSize);
    analysis.sourceImage = imagePath;
    return analysis;

  } catch (error) {
    console.error('[AI] 调用失败:', error);
    throw new Error(`AI 分析失败: ${error.message}`);
  }
}

/**
 * 解析响应；如果这一轮是**因为 max_tokens 被截断**才解析不动，就翻倍额度重发一次。
 *
 * 触发条件是响应自带的 `stop_reason === 'max_tokens'`，不是语法错误的文案——
 * 语法错误只是截断的后果，拿它当依据会把"模型胡说八道"也当成截断去重发。
 * 其他任何解析失败都直接抛：同样的提示词重发一次，结果还是同样一份坏 JSON。
 *
 * @param {object} response - 首次的完整响应
 * @param {object} request  - 首次的请求体，重发时复制它并改 max_tokens
 * @param {object} client   - Anthropic 客户端
 * @param {object} imageSize - 换算归一化坐标用
 */
export async function parseWithRetry(response, request, client, imageSize) {
  try {
    return parseResponse(response, imageSize);
  } catch (parseErr) {
    if (response.stop_reason !== 'max_tokens' || request.max_tokens >= PARSE_RETRY_MAX_TOKENS) {
      throw parseErr;
    }
    const bigger = Math.min(request.max_tokens * 2, PARSE_RETRY_MAX_TOKENS);
    console.warn(`[AI] 输出被 max_tokens 截断（${request.max_tokens}），提到 ${bigger} 重发一次`);
    const retry = await createWithRetry(client, { ...request, max_tokens: bigger });
    if (retry.stop_reason === 'max_tokens') {
      console.warn(`[AI] 重发后仍然被截断（${bigger}），部件表可能不全`);
    }
    return parseResponse(retry, imageSize);
  }
}

/**
 * 解析 AI 响应
 *
 * AI 返回的是归一化比例（0~1），这里乘以真实图片尺寸转成像素坐标。
 * 之所以不让 AI 直接给像素值：Vision 接口会先把图缩放进模型，
 * 模型报告的"像素坐标"其实是它看到的尺寸下的值，会整体偏小。
 */
export function parseResponse(response, imageSize) {
  try {
    // 提取文本内容
    let text = null;

    if (response.content?.[0]?.text) {
      text = response.content[0].text;
    } else if (response.message?.content) {
      text = response.message.content;
    } else if (response.text) {
      text = response.text;
    }

    if (!text) {
      throw new Error('无法提取响应文本');
    }

    console.log('[AI] 响应文本:', text.substring(0, 500));

    // 去掉可能的 markdown 代码块包裹
    const cleaned = text.replace(/```(?:json)?/g, '').trim();

    // 从第一个 { 到最后一个 } 之间取 JSON，容忍前后有解释文字
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) {
      throw new Error('未找到 JSON 数据');
    }

    const analysis = JSON.parse(cleaned.slice(start, end + 1));

    // 验证必需字段
    if (!analysis.parts || !Array.isArray(analysis.parts)) {
      throw new Error('缺少 parts 字段');
    }

    const W = imageSize?.width ?? 1;
    const H = imageSize?.height ?? 1;

    // 归一化 → 像素
    for (const part of analysis.parts) {
      const bb = part.bbox ?? {};
      const pv = part.pivot ?? {};

      // 兼容模型违规直接返回像素值的情况：数值超过 1 就当作已经是像素
      const looksLikePixels = (bb.x ?? 0) > 1 || (bb.y ?? 0) > 1 ||
                              (bb.width ?? 0) > 1 || (bb.height ?? 0) > 1;

      if (looksLikePixels) {
        console.warn(`[AI] 部件 ${part.name} 返回的不是比例值，按像素原样使用`);
        part.bbox = {
          x: Number(bb.x) || 0,
          y: Number(bb.y) || 0,
          width: Number(bb.width) || 10,
          height: Number(bb.height) || 10
        };
      } else {
        part.bbox = {
          x: clamp01(bb.x) * W,
          y: clamp01(bb.y) * H,
          width: Math.max(clamp01(bb.width) * W, 1),
          height: Math.max(clamp01(bb.height) * H, 1)
        };
      }

      // bbox 不能越出图片边界，否则 sharp 的 extract 会直接报错
      const b = part.bbox;
      b.x = Math.max(0, Math.min(b.x, W - 1));
      b.y = Math.max(0, Math.min(b.y, H - 1));
      b.width = Math.max(1, Math.min(b.width, W - b.x));
      b.height = Math.max(1, Math.min(b.height, H - b.y));

      // pivot 是相对 bbox 自身的比例
      part.pivot = {
        x: clamp01(pv.x !== undefined ? pv.x : 0.5) * b.width,
        y: clamp01(pv.y !== undefined ? pv.y : 0.5) * b.height
      };

      // polygon：多边形轮廓顶点，归一化 0~1 → 像素坐标（相对整张源图）
      // 缺失时退回 null，切图模块会降级为矩形 bbox 切图
      if (Array.isArray(part.polygon) && part.polygon.length >= 3) {
        part.polygon = part.polygon
          .map(({ x, y }) => ({
            x: Math.max(0, Math.min(W, clamp01(Number(x)) * W)),
            y: Math.max(0, Math.min(H, clamp01(Number(y)) * H))
          }))
          .filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y));
        if (part.polygon.length < 3) part.polygon = null;
      } else {
        part.polygon = null;
      }
    }

    // 校验父部件名必须存在，否则骨骼会找不到 parent
    const names = new Set(analysis.parts.map((p) => p.name));
    for (const part of analysis.parts) {
      if (part.parent && !names.has(part.parent)) {
        console.warn(`[AI] 部件 ${part.name} 的父部件 ${part.parent} 不存在，已改为根部件`);
        part.parent = null;
      }
      // occlusion_edges：标注哪些方向被其他部件遮挡，供补图模块生成定向 prompt
      // 合法值：top / bottom / left / right 的组合，缺失时默认空数组
      const VALID_EDGES = new Set(['top', 'bottom', 'left', 'right']);
      const raw = part.occlusion_edges;
      if (Array.isArray(raw)) {
        part.occlusion_edges = raw.filter(e => VALID_EDGES.has(String(e).toLowerCase()));
      } else {
        part.occlusion_edges = [];
      }
    }

    validateDepths(analysis.parts);

    console.log('[AI] 解析成功，识别到', analysis.parts.length, '个部件，已换算为像素坐标');

    return analysis;

  } catch (error) {
    console.error('[AI] 解析失败:', error);
    throw new Error(`解析响应失败: ${error.message}`);
  }
}

/**
 * 规范化 depth（深度序号），并把结果写回 parts。
 *
 * depth 是切图的唯一依据：「擦掉所有比本部件 depth 大的部件」。
 * 它必须满足两个条件，否则擦除会出错：
 *
 *   1. 每个部件都有值。AI 偶尔漏写某个部件的 depth，
 *      漏写当作 0（最靠后）——少擦只是接缝糙，猜大了会把前面部件擦空。
 *   2. 全局一致。AI 可能输出 0,1,5 这种跳号，也可能给所有部件同一个值。
 *      统一排序后重编成 0..n-1 的连续序号：跳号本身不影响相对顺序，
 *      真正要防的是"全同值"——那样谁都不擦，等于没分层，
 *      这时按 bbox 面积兜底（面积大的通常是被装在里面的后景）。
 *
 * 返回修正后的层数，供调用方打日志。
 */
export function validateDepths(parts) {
  for (const part of parts) {
    const n = Number(part.depth);
    part.depth = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  const uniq = [...new Set(parts.map(p => p.depth))].sort((a, b) => a - b);

  // 全同值：AI 没做出区分，退化成"按 bbox 面积定前后"这种弱判据
  if (uniq.length === 1 && parts.length > 1) {
    console.warn(`[AI] 所有部件 depth 都是 ${uniq[0]}，分层失效——按 bbox 面积兜底`);
    const byArea = [...parts].sort((a, b) =>
      ((b.bbox?.width ?? 0) * (b.bbox?.height ?? 0)) - ((a.bbox?.width ?? 0) * (a.bbox?.height ?? 0)));
    // 面积最大的排 0（最靠后），往外递增
    byArea.forEach((p, i) => { p.depth = i; });
    return byArea.length;
  }

  // 跳号：0,1,5 → 0,1,2（相对顺序不变，只是压紧）
  const rank = new Map(uniq.map((d, i) => [d, i]));
  for (const part of parts) part.depth = rank.get(part.depth);

  return uniq.length;
}

/** 把值限制在 0~1 */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 图片分类提示词
 */
const CLASSIFICATION_PROMPT = `请判断这张图片属于以下哪个类别：

1. character - 角色类：游戏角色、NPC、宠物等人形或动物角色
2. prop - 道具类：武器、工具、载具等机械器具
3. effect - 特效类：爆炸、光效、粒子、魔法阵等视觉效果
4. item - 物品类：场景物件、UI元素、静态装饰等

只输出类别的英文代号（character/prop/effect/item），不要任何解释。`;

/**
 * 对上传的图片进行分类
 * @param {string} imagePath - 图片路径
 * @param {object} options - { apiKey, baseURL, model }
 * @returns {Promise<string>} 类别代号 (character/prop/effect/item)
 */
export async function classifyImage(imagePath, options) {
  const { apiKey, baseURL } = options;
  const model = options.model || DEFAULT_MODEL;

  const imageData = readFileSync(imagePath).toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const client = new Anthropic({
    apiKey,
    baseURL: baseURL || undefined
  });

  try {
    console.log(`[AI] 正在识别图片类别...`);

    const response = await createWithRetry(client, {
      model,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageData
            }
          },
          {
            type: 'text',
            text: CLASSIFICATION_PROMPT
          }
        ]
      }]
    });

    const text = response.content[0]?.text?.trim().toLowerCase() || '';
    
    // 提取类别代号（去掉可能的多余字符）
    const match = text.match(/\b(character|prop|effect|item)\b/);
    const category = match ? match[1] : 'character'; // 默认角色类

    console.log(`[AI] 识别结果: ${category}`);
    return category;
  } catch (err) {
    console.error('[AI] 分类失败:', err.message);
    // 分类失败不应阻塞流程，返回默认值
    return 'character';
  }
}
