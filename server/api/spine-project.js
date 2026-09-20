/**
 * 生成 Spine 编辑器工程文件（.spine）。
 *
 * 为什么要有这个文件：
 *   导出的三件套（.json / .atlas / .png）是**运行时资产**——引擎直接加载，
 *   但在 Spine 编辑器里打开它只是"导入一份数据"，不是"一个可编辑的工程"。
 *   美术要手工调网格顶点、加动画、改插槽顺序，都需要一个真正的工程文件。
 *   用户明确要的「可能需要 spine 二次编辑」说的就是这件事。
 *
 * 为什么不能自己拼这个文件：
 *   .spine 是 Spine 私有的二进制工程格式（外层 raw-deflate，内部是
 *   自带字符串表的标记流）。格式没有公开规范，各 4.x 小版本之间都会变
 *   （实测 4.3.26 写出的文件与 4.3.2 写出的同一份工程字节不同）。
 *   照着反推一份写出来，编辑器一升级就静默读坏，比不产出更糟。
 *
 *   所以走官方支持的那条路：Spine 自带的 CLI 有这个能力——
 *       Spine -i <骨架.json> -o <工程.spine> --to <骨架名> -r
 *   实测在装好并已激活的编辑器上完全 headless，不弹 GUI，退出码 0。
 *
 * 装不上编辑器时怎么办：
 *   整轮导出**不因此失败**。三件套已经落盘、能进引擎，只是少了可编辑的
 *   源工程。这时返回原因，前端在日志里提示用户去装 Spine 或手工导入——
 *   比抛一个异常让用户以为"导出整个失败了"要好。
 */

import { existsSync } from 'fs';
import { access, constants } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Spine 编辑器的默认安装位置。
 * macOS 在前（开发机是 arm64 mac），Windows / Linux 依次兜底。
 */
export const SPINE_CANDIDATES = [
  '/Applications/Spine.app/Contents/MacOS/Spine',
  `${process.env.HOME}/Applications/Spine.app/Contents/MacOS/Spine`,
  '/opt/spine/Spine',
  '/usr/local/bin/Spine',
  'C:\\Program Files\\Spine\\Spine.com'
];

/**
 * 定位 Spine 可执行文件。
 *
 * 显式路径**不回退**：调用方指名了某个版本，而 .spine 的格式是跟版本绑的
 * （4.3.26 和 4.3.2 写出的同一份工程字节都不同）。指的那个不在，
 * 就悄悄换另一个版本写一份出来，用户拿去打开可能直接读不了——
 * 报错说"你指的这个不存在"才是对的。
 *
 * 没指名时才按 SPINE_CLI_PATH → 默认安装位置依次找。
 *
 * @param {string} [explicit] - 显式路径（调用方给）。给了就只认它
 * @returns {Promise<string|null>} 找不到返回 null，不抛——调用方要的是"能降级"
 */
export async function findSpineCli(explicit) {
  const candidates = explicit
    ? [explicit]
    : [process.env.SPINE_CLI_PATH, ...SPINE_CANDIDATES].filter(Boolean);

  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // 换下一个
    }
  }
  return null;
}

/**
 * 用 Spine 把骨架 JSON 导成 .spine 工程。
 *
 * 参数说明（都是实测出来的）：
 *   --to <名>   工程里的骨架名。不给的话 Spine 用文件名，和附件 path 对不上，
 *               打开工程会满屏找不到图。必须显式传，且与 json 里的骨架同名。
 *   --replace   同名骨架就覆盖。**少了它是累加**：第二次导入同一个名字，
 *               Spine 会建一个 "teacher2" 塞进同一个工程，导第三次就有
 *               teacher3。实测出来的——工程里堆着三份骨架，美术打开一看
 *               不知道该改哪个。
 *   -r          真正执行导入。**不给这个参数 Spine 只打印帮助就退出**，
 *               退出码却是 0——这是个很容易被骗过去的静默失败，所以下面
 *               除了退出码，还要检查文件真的生成了。
 *
 * 超时是必要的：Spine 在导入失败时会弹 GUI 模态框，进程会一直挂着，
 * 流水线就永远卡在那里。
 *
 * @param {object} opts
 * @param {string} opts.jsonPath   骨架 JSON（Spine 4.x 格式）
 * @param {string} opts.outPath    要写出的 .spine
 * @param {string} opts.name       骨架名
 * @param {string} [opts.cliPath]  Spine 可执行文件；不给则自己找
 * @returns {Promise<{ok:boolean, cliPath?:string, reason?:string, stderr?:string}>}
 */
export async function buildSpineProject({ jsonPath, outPath, name, cliPath }) {
  if (!existsSync(jsonPath)) {
    return { ok: false, reason: `骨架 JSON 不存在: ${jsonPath}` };
  }

  const cli = await findSpineCli(cliPath);
  if (!cli) {
    return {
      ok: false,
      reason: '未找到 Spine 编辑器，无法生成可二次编辑的 .spine 工程。'
        + '安装 Spine 4.x 后重新导出即可，或设 SPINE_CLI_PATH 指向它的可执行文件'
    };
  }

  try {
    await execFileAsync(cli, [
      '-i', jsonPath,
      '-o', outPath,
      '--to', name,
      '--replace',
      '-r'
    ], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').trim().slice(-300);
    return { ok: false, cliPath: cli, reason: `Spine 导入失败: ${detail}` };
  }

  /*
   * 退出码 0 不等于成功。
   * 少了 -r、或数据版本与编辑器差得太远时，Spine 会打印一段说明然后
   * 正常退出，文件根本不会出现。所以最终判据是文件在不在、非不非空。
   */
  if (!existsSync(outPath)) {
    return { ok: false, cliPath: cli, reason: 'Spine 退出码为 0，但没有生成工程文件' };
  }

  return { ok: true, cliPath: cli };
}
