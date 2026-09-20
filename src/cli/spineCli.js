/**
 * Spine 编辑器 CLI 封装。
 *
 * 重要事实（决定了整个工具的架构）：
 *   1. Spine 的编辑能力**全部**在编辑器进程里，不存在独立的 SDK。
 *      所有程序化修改都必须走"导出 JSON → 改 → 回导"这条路。
 *   2. 导入只接受与导出时**完全相同**的版本，版本不匹配会静默丢数据。
 *   3. 导出可以完全 headless；导入在某些版本上会拉起 GUI。
 *
 * 因此本模块只做两件事：探测安装、拼命令行。
 * 它不假设 Spine 一定存在——未安装时给出可执行的修复指引，
 * 而不是抛一个裸的 ENOENT。
 */

import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Spine 在各平台的默认安装位置。macOS 优先，因为本项目开发机是 arm64 mac。 */
export const DEFAULT_CANDIDATES = [
  '/Applications/Spine.app/Contents/MacOS/Spine',
  `${process.env.HOME}/Applications/Spine.app/Contents/MacOS/Spine`,
  '/opt/spine/Spine',
  '/usr/local/bin/Spine',
  'C:\\Program Files\\Spine\\Spine.com',
];

export class SpineNotFoundError extends Error {
  constructor(searched) {
    super(
      '未找到 Spine 编辑器可执行文件。\n' +
        '本项目所有编辑操作都依赖 Spine 本体（不存在独立的 Spine SDK）。\n' +
        '请任选其一：\n' +
        '  1. 安装 Spine 4.2.x Professional 到 /Applications\n' +
        '  2. 设置环境变量 SPINE_CLI_PATH 指向已有安装\n' +
        '已搜索路径:\n' +
        searched.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'SpineNotFoundError';
    this.searched = searched;
  }
}

/**
 * 定位 Spine 可执行文件。
 * 显式配置优先于默认位置——开发机可能装了多个版本。
 */
export async function findSpineCli(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath, ...DEFAULT_CANDIDATES]
    : [process.env.SPINE_CLI_PATH, ...DEFAULT_CANDIDATES].filter(Boolean);

  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // 继续找下一个
    }
  }
  throw new SpineNotFoundError(candidates);
}

/**
 * 探测 Spine 版本。
 * CLI 没有 --version，只能靠 -h 的输出；拿不到就返回 null，
 * 让调用方决定是否继续（版本未知时不应阻断导出）。
 */
export async function probeSpineVersion(cliPath) {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ['-h'], { timeout: 15000 });
    const text = `${stdout}\n${stderr}`;
    const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  } catch (err) {
    const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  }
}

/**
 * 构造一次 CLI 调用的参数数组。
 *
 * Spine CLI 的约定是一次调用可传多组 io 对：
 *   -i a.spine -o dir -e json.json  -i b.spine -o dir2 -e json.json
 * 所以内部统一用"任务列表"表示，而不是单组参数。
 *
 * @param {object} opts
 * @param {string} opts.spineVersion  目标版本，如 '4.2'
 * @param {Array<{input:string, output:string, export:string, name?:string, preset?:string}>} opts.jobs
 */
export function buildArgs({ spineVersion, jobs }) {
  const args = [];
  if (spineVersion) args.push('-u', spineVersion);

  for (const job of jobs) {
    if (!job.input || !job.output) {
      throw new Error('每个导出任务必须同时有 input 和 output');
    }
    args.push('-i', job.input, '-o', job.output);

    if (job.export) {
      args.push('-e', job.export);
    }
    // -n 只在打包图集时用（给 atlas 起名）
    if (job.name) args.push('-n', job.name);
    // -p 指定图集导出预设
    if (job.preset) args.push('-p', job.preset);
  }

  return args;
}

/**
 * 执行一次 CLI 调用。
 *
 * 超时是必要的：Spine 在导入失败时会弹 GUI 模态框，
 * 进程会一直挂着，没有超时就会永久卡住流水线。
 */
export async function runSpine({ cliPath, args, timeoutMs = 180000, cwd }) {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      cwd,
    });
    return { ok: true, stdout, stderr, args };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      // killed 为 true 通常意味着超时（很可能是 GUI 模态框挂住了）
      timedOut: err.killed === true,
      code: err.code,
      args,
    };
  }
}

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 导出预设文件的绝对路径 */
export const EXPORT_PRESETS = {
  json: join(__dirname, '../../.spine-presets/export-json.json'),
  binary: join(__dirname, '../../.spine-presets/export-binary.json'),
};

/**
 * 把 .spine 工程导出成运行时资产。
 */
export async function exportProject({ cliPath, spineVersion, projectPath, outDir, preset = 'json' }) {
  const exportSettingsPath = EXPORT_PRESETS[preset];
  if (!exportSettingsPath) {
    throw new Error(`未知的导出预设: ${preset}。可用: ${Object.keys(EXPORT_PRESETS).join(', ')}`);
  }

  const args = buildArgs({
    spineVersion,
    jobs: [{ input: projectPath, output: outDir, export: exportSettingsPath }],
  });
  return runSpine({ cliPath, args });
}

/**
 * 把导出的 JSON 回导成 .spine 工程。
 *
 * 注意：-r 在某些版本里是导入必需的，但行为不稳定。
 * 更可靠的做法是让用户在 GUI 里导入一次，之后以 .spine 为唯一真源。
 * 本函数保留，但调用方必须检查返回的 ok。
 */
export async function importJson({ cliPath, spineVersion, jsonPath, projectPath }) {
  const args = ['-u', spineVersion, '-i', jsonPath, '-o', projectPath, '-r'];
  return runSpine({ cliPath, args });
}

/**
 * 打包图集：把一堆散图打成 atlas + png。
 * 这是 P1 拆件产物的落地出口。
 */
export async function packAtlas({
  cliPath,
  spineVersion,
  imagesDir,
  outDir,
  name,
  preset = 'atlas-1.0.json',
}) {
  const args = buildArgs({
    spineVersion,
    jobs: [{ input: imagesDir, output: outDir, name, preset }],
  });
  return runSpine({ cliPath, args });
}
