/**
 * .env 读写。
 *
 * 为什么要动用户的文件：
 *   把 key 填在设置面板里只落到 localStorage，换机器、清缓存、或者直接用
 *   CLI 跑同一个工程就没了。写进 .env 之后，服务端下次启动自己就带着配置。
 *
 * 改写而不是追加：
 *   用户在面板里改了 key，最省事的做法是往文件末尾追加一行 ANTHROPIC_API_KEY=...
 *   但 dotenv 后出现的值会覆盖前面的，于是文件里躺着两行同名 key，只有最后一行
 *   生效——过两天用户翻 .env 想核对，看到的却是那行不生效的旧值。
 *   所以这里是「就地替换第一处出现的键」，其余原样保留。
 *
 * 保留原文件的一切：
 *   注释、空行、键的顺序、缩进风格全部照旧。.env 是用户会手写和手改的文件，
 *   被程序重排一遍会让人认不出来。我们只动明确要改的那一两行。
 *
 * 值只在必要时加引号：
 *   key 里出现 # 会被 dotenv 当成注释起始（" #" 之后整段丢掉），出现空格会被截断，
 *   所以这类值必须包起来。但常见的 URL 和 API key 都是裸写的，一律加引号会让整个
 *   文件风格突变，也不好比对 git diff——只给真正需要的值加。
 */

import { readFile, rename, writeFile, chmod } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 服务端仓库根目录。.env 放在这儿，dotenv 默认也从这儿读 */
export const ENV_PATH = resolve(process.env.SPINE_ENV_PATH || join(__dirname, '../../.env'));

/** 这个工具认的键。写别的进去没用，还会污染用户的文件 */
export const KNOWN_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PORT'];

/** 整行匹配 KEY=... ，允许前面的 export 和空白 */
function keyPattern(key) {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
}

/**
 * 转成 .env 里安全的一行值。
 *
 * 裸值只在确定安全时才用：首尾空白、#、引号、反斜杠、换行任意一个出现，
 * 都退回双引号形式——宁可难看也不能让 key 被静默截断。
 */
function encodeValue(value) {
  const s = String(value);
  const needsQuotes = /[\s#"'\\)]/.test(s) || s === '';
  if (!needsQuotes) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/**
 * 把若干键写进 .env，保留文件里其余内容。
 *
 * @param {Record<string, string>} updates - 要写入的键值；空字符串表示「显式留空」
 * @param {object} opts - { path } 默认仓库根的 .env
 * @returns {Promise<{path, changed: string[], created: boolean}>}
 *   changed 是真正发生变化的键名，绝不含值——返回值会被打到浏览器日志里
 */
export async function writeEnv(updates, opts = {}) {
  const path = resolve(opts.path || ENV_PATH);

  let original = '';
  let exists = true;
  try {
    original = await readFile(path, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    exists = false;
    original = [
      '# Spine AI Generator 配置',
      '# 由设置面板写入，也可以手改；改完重启服务生效',
      ''
    ].join('\n');
  }

  const hadTrailingNewline = original.endsWith('\n');
  const lines = original.split('\n');
  // 末尾换行会split出一个空串，先摘掉再拼回去，否则每次保存都多出一行空行
  const trailing = hadTrailingNewline ? lines.pop() : null;

  const changed = [];

  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue);
    const line = `${key}=${encodeValue(value)}`;

    const at = lines.findIndex((l) => keyPattern(key).test(l));

    if (at === -1) {
      if (value === '') continue; // 文件里没有、值也是空：没必要凭空加一行空键
      lines.push(line);
      changed.push(key);
      continue;
    }

    // 已经是目标值就别写，省得白改文件、白刷 mtime
    if (parseLineValue(lines[at]) === value) continue;
    lines[at] = line;
    changed.push(key);
  }

  if (changed.length) {
    const out = lines.join('\n') + (trailing ?? '');
    await atomicWrite(path, out.endsWith('\n') ? out : `${out}\n`);
  }

  return { path, changed, created: !exists };
}

/** 取出一行的值，用于比对；解析失败返回 null（不同于空串） */
function parseLineValue(line) {
  const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
  if (!m) return null;

  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  } else {
    // 无引号时 # 之后是注释
    const hash = v.indexOf(' #');
    if (hash !== -1) v = v.slice(0, hash).trim();
  }
  return v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * 先写临时文件再改名。
 *
 * 直接覆写时若在中间崩掉，用户的 .env 会变成半截文件——里面可能还有别的服务的配置。
 * rename 在同一分区是原子的，读到的一直是完整的旧文件或完整的新文件。
 */
async function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf-8');
  // key 是长期凭证，别让同机器其他账号读到
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

/** .env 的当前内容（键值），供诊断用。绝不外传 */
export async function readEnv(opts = {}) {
  const path = resolve(opts.path || ENV_PATH);
  const text = await readFile(path, 'utf-8').catch(() => '');
  const out = {};

  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) out[m[1]] = parseLineValue(line);
  }
  return out;
}

/** 只报「有没有配」，不报值。给前端展示用 */
export function presenceOf(values) {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, v ? { set: true, length: String(v).length } : { set: false }])
  );
}
