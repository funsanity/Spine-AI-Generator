/**
 * API 接入点默认值。
 *
 * 为什么要有这个文件：
 *   服务商是可以换的（直连 Anthropic、自建网关、任意兼容网关）。在这之前，
 *   默认地址散在三处：`.env.example`、`web/index.html` 的 placeholder/value、
 *   `web/app.js` 里 `loadApiConfig` 的兜底字符串。换一次要改三个地方，
 *   漏一处就出现「表单里显示旧地址、实际请求走新地址」这种极难查的不一致。
 *
 *   现在只有 `config/api-defaults.json` 一份是源头，前端启动时向
 *   /api/api-defaults 取。要换接入点，改那一个文件即可。
 *
 * 为什么不直接把地址写死在这里：
 *   这是要公开到 GitHub 的文件。默认值留空 → 回退 Anthropic 官方直连，
 *   仓库里不出现任何第三方地址；用户要中转就把自己的地址填进
 *   `config/api-defaults.json` 或 `.env`（`.env` 不进版本库）。
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = join(__dirname, '../../config/api-defaults.json');

/** 没有配置任何接入点时走官方直连，和 server/ai/models.js 的 OFFICIAL_BASE 一致 */
const FALLBACK = {
  baseURL: '',
  apiKeyPlaceholder: 'sk-ant-...'
};

/**
 * 读默认值。坏掉的配置文件不该让服务起不来——回退到内置值并在启动日志里说明。
 *
 * @returns {{baseURL: string, apiKeyPlaceholder: string}}
 */
export function readApiDefaults() {
  if (!existsSync(DEFAULTS_PATH)) return { ...FALLBACK };

  try {
    const raw = JSON.parse(readFileSync(DEFAULTS_PATH, 'utf-8'));
    return {
      baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : FALLBACK.baseURL,
      apiKeyPlaceholder: typeof raw.apiKeyPlaceholder === 'string'
        ? raw.apiKeyPlaceholder
        : FALLBACK.apiKeyPlaceholder
    };
  } catch (err) {
    console.warn(`[配置] ${DEFAULTS_PATH} 解析失败，回退内置默认值: ${err.message}`);
    return { ...FALLBACK };
  }
}
