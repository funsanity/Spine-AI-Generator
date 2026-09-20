/**
 * 图像生成模型目录。
 *
 * 两件事决定了这张表的形状：
 *
 * 1. 各家网关之间不通用。下面是实测可用的真实模型码，但用户可能换别家，
 *    所以探测走"目录里的都试一遍 + 允许自己填模型名"，而不是写死一份。
 * 2. 中转站把图像接口分成了两种协议，能力不一样：
 *      - 同步（sync）：/v1/images/generations 收 JSON、/v1/images/edits 收 multipart。
 *        multipart 可以直接传本地文件，也能带 mask —— 部件补图要走这条。
 *      - 异步（task）：POST /v1/images/create 拿 task_id，再轮询 /v1/tasks/{id}。
 *        只收 HTTPS 的 image_urls，不支持 mask，本地图片得先传成公网 URL。
 */

/** 同步接口：OpenAI 兼容，直接出图 */
export const SYNC_MODELS = [
  { id: 'gpt-image-2', label: 'GPT Image 2', note: 'OpenAI 兼容同步接口，支持 multipart 传本地图' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', note: '编辑精度更高（内测）' },
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', note: '日常生成，速度优先（内测）' }
];

/** 异步任务接口：需要轮询，只收公网图片 URL */
export const TASK_MODELS = [
  { id: 'nanobanana-2', label: 'NanoBanana 2', note: '异步任务，图片需公网 URL' },
  { id: 'nanobanana-pro', label: 'NanoBanana Pro', note: '异步任务，图片需公网 URL' },
  { id: 'nanobanana', label: 'NanoBanana', note: '异步任务，图片需公网 URL' },
  { id: 'seedream-5-0-pro', label: 'Seedream 5.0 Pro', note: '异步任务，图片需公网 URL' },
  { id: 'seedream-5-0-lite', label: 'Seedream 5.0 Lite', note: '异步任务，图片需公网 URL' },
  { id: 'seedream-4-5', label: 'Seedream 4.5', note: '异步任务，图片需公网 URL' },
  { id: 'gpt-image-2-async', label: 'GPT Image 2 (异步)', note: '异步任务，图片需公网 URL' }
];

export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

/** 探测顺序：先同步（本地图能用）再异步 */
export const ALL_IMAGE_MODELS = [
  ...SYNC_MODELS.map((m) => ({ ...m, protocol: 'sync' })),
  ...TASK_MODELS.map((m) => ({ ...m, protocol: 'task' }))
];

/**
 * 从任意模型的返回体里抠出图片。
 * 同步接口是 OpenAI 形状（data[].b64_json 或 data[].url），
 * 异步任务是 { data: [{ url }] }，两者 shape 恰好一致，一处解析就够。
 */
export function pickImage(body) {
  const list = body?.data ?? body?.images ?? [];
  const first = Array.isArray(list) ? list[0] : null;
  if (!first) return null;

  if (first.b64_json) return { kind: 'base64', value: first.b64_json };
  if (typeof first.url === 'string') return { kind: 'url', value: first.url };
  return null;
}

/** 把模型清单整理成前端下拉用的形状 */
export function describeImageModels() {
  return ALL_IMAGE_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    note: m.note,
    protocol: m.protocol,
    // 能不能直接吃本地文件，决定补图走哪条路
    localImage: m.protocol === 'sync'
  }));
}
