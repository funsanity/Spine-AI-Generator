/**
 * 模型清单。
 *
 * 为什么要去问中转站而不是写死一份：
 *   中转站能转发哪些模型是它自己决定的，各家都不一样，而且会变。
 *   写死的清单迟早会列出一个转发不了的模型，用户选中后要等到
 *   真正调用失败才知道。直接读它的 /v1/models 才是当前可用的真相。
 *
 * 拿不到也不能挡住流程：
 *   有的中转站不开放模型列表接口，有的要另一套鉴权。
 *   这种情况回退到内置清单，功能照常可用，只是列表可能不全。
 *
 * 只保留视觉模型：
 *   这个工具的唯一一次模型调用是「看图拆件」，纯文本模型选了必然失败。
 *   按名字粗筛掉明显不支持视觉的（embedding、tts、whisper 之类），
 *   宁可漏掉少数能用的，也不要让用户选到一个必然报错的。
 */

import { DEFAULT_MODEL } from './claude.js';

/** Anthropic 官方直连地址，前端没填 baseURL 时用它 */
const OFFICIAL_BASE = 'https://api.anthropic.com';

/**
 * 内置回退清单。
 * 取不到远端列表时用，覆盖当前主力的视觉模型。
 */
const FALLBACK_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5（默认）' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
];

/**
 * 名字里带这些词的不能用来「看图」，列出来只会让人选错。
 *
 * 要特别小心图像/视频**生成**模型：中转站会把它们和对话模型混在一个列表里，
 * 名字看着很强（gpt-image、seedream、nanobanana），但它们吃文字吐图片，
 * 根本不接受图片输入。选中后要等到调用失败才知道，所以在这里就筛掉。
 */
const NON_VISION = [
  // 非对话类
  'embed', 'embedding', 'rerank', 'tts', 'whisper', 'audio',
  'moderation', 'search',
  // 图像生成
  'image', 'dall-e', 'stable-diffusion', 'flux', 'midjourney',
  'seedream', 'nanobanana', 'imagen', 'grok-image',
  // 视频生成
  'sora', 'kling', 'seedance', 'veo', 'runway', 'pika',
  // 音乐生成
  'suno', 'udio'
];

/**
 * 已验证能做视觉输入的模型前缀。
 * 匹配上的排在列表前面——中转站给的是几十个混排的 id，
 * 不做区分的话用户得在一堆生成模型里翻找能用的那几个。
 */
const VISION_FIRST = ['claude-', 'gpt-5', 'gpt-6', 'gemini-', 'glm-'];

function looksVisionCapable(id) {
  const lower = String(id).toLowerCase();
  return !NON_VISION.some((word) => lower.includes(word));
}

function isPreferred(id) {
  const lower = String(id).toLowerCase();
  return VISION_FIRST.some((prefix) => lower.startsWith(prefix));
}

/**
 * 拉取可用模型。
 *
 * 两种接口形态都试：
 *   Anthropic  GET /v1/models      带 x-api-key + anthropic-version
 *   OpenAI 兼容 GET /v1/models     带 Authorization: Bearer
 * 中转站多数是后者，但也有原样转发前者的，所以两个头都带上——
 * 服务端会忽略它不认的那个。
 *
 * @param {object} opts - { apiKey, baseURL }
 * @returns {Promise<{models: Array, source: string, error?: string}>}
 */
export async function listModels({ apiKey, baseURL } = {}) {
  if (!apiKey) {
    return { models: FALLBACK_MODELS, source: 'fallback', error: '未配置 API Key' };
  }

  const base = String(baseURL || OFFICIAL_BASE).replace(/\/+$/, '');
  // baseURL 可能已经带了 /v1，重复拼会变成 /v1/v1
  const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;

  try {
    // 中转站偶尔会挂住不返回，超时拉短一点——列表拿不到有回退，不值得让界面干等
    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      return {
        models: FALLBACK_MODELS,
        source: 'fallback',
        error: `模型列表接口返回 ${res.status}`
      };
    }

    const body = await res.json();
    const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];

    const models = raw
      .map((m) => (typeof m === 'string' ? { id: m } : m))
      .map((m) => ({ id: m.id ?? m.model ?? m.name, label: m.display_name ?? m.id ?? m.model }))
      .filter((m) => m.id && looksVisionCapable(m.id))
      // 同一个 id 可能出现多次（不同分组转发同一个模型）
      .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
      .map((m) => ({ ...m, preferred: isPreferred(m.id) }))
      // 可靠的视觉模型排前面，其余按名字排在后面
      .sort((a, b) => (a.preferred === b.preferred ? a.id.localeCompare(b.id) : a.preferred ? -1 : 1));

    if (!models.length) {
      return { models: FALLBACK_MODELS, source: 'fallback', error: '远端列表为空或无视觉模型' };
    }

    // 默认模型必须能选到。中转站的列表里未必有它（改了名或未开通），
    // 但它是默认值，界面上缺了会导致默认档选不中任何一项。
    if (!models.some((m) => m.id === DEFAULT_MODEL)) {
      models.unshift({ id: DEFAULT_MODEL, label: `${DEFAULT_MODEL}（默认，列表未含）`, preferred: true });
    }

    return { models, source: 'remote' };
  } catch (err) {
    return {
      models: FALLBACK_MODELS,
      source: 'fallback',
      error: err.name === 'TimeoutError' ? '模型列表请求超时' : err.message
    };
  }
}

export { FALLBACK_MODELS, DEFAULT_MODEL };
