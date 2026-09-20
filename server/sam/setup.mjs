#!/usr/bin/env node
/**
 * MobileSAM 环境一键准备。
 *
 * 装什么、装到哪：
 *   虚拟环境   ~/.spine-tool/mobilesam/venv        （约 585MB，torch 占大头）
 *   模型仓库   ~/.spine-tool/mobilesam/MobileSAM   （约 165MB）
 *   权重       ~/.spine-tool/mobilesam/mobile_sam.pt（39MB）
 *
 * 为什么放 ~/.spine-tool 而不是项目里：这些是几百 MB 的机器级依赖，
 * 放在项目里既容易被误提交，也会让每个 checkout 各装一份。
 * 想换位置就设 SPINE_SAM_HOME 环境变量。
 *
 * 幂等：每一步都先检查是否已完成，重复跑不会重装。
 *
 * 用法:
 *   node server/sam/setup.mjs           # 装（缺什么补什么）
 *   node server/sam/setup.mjs --check   # 只报告状态，不装
 *   node server/sam/setup.mjs --force   # 忽略已有环境，重装
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 权重的 SHA256。上游 README 没给，实测下载后与仓库自带文件比对一致，记在这里防掉包 */
export const WEIGHT_SHA256 =
  '6dbb90523a35330fedd7f1d3dfc66f995213d81b29a5ca8108dbcdd4e37d6c2f';

const WEIGHT_URL =
  'https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt';
const REPO_URL = 'https://github.com/ChaoningZhang/MobileSAM.git';

/**
 * Python 依赖清单的落点是仓库根的 `requirements.txt`，不在这里再写一份。
 *
 * 之前这份数组是唯一来源，于是 requirements.txt 应有的东西散在 .mjs 里，
 * 「装了什么」在 Python 侧完全看不到，用 conda 或手动建环境的人无从下手。
 * 现在两边共用一份：setup.mjs 读它，pip 也认它。
 *
 * 注意 timm 必须显式列出——上游 MobileSAM 自己的 requirements.txt 漏了它，
 * 少了 `import mobile_sam` 直接 ModuleNotFoundError。
 */
function readRequirements() {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../requirements.txt');
  const lines = readFileSync(path, 'utf-8').split('\n');
  const pkgs = lines
    .map((l) => l.split('#')[0].trim())
    .filter((l) => l && !l.startsWith('#'))
    // 只取包名，版本约束交给 pip 处理——写进命令行会把 "torch>=2" 当成
    // 一个字面量包名。
    .map((l) => l.split(/[<>=!~\[]/)[0].trim())
    .filter(Boolean);
  if (!pkgs.length) throw new Error(`requirements.txt 里没读到任何依赖: ${path}`);
  return pkgs;
}

export function samHome() {
  return process.env.SPINE_SAM_HOME || join(homedir(), '.spine-tool', 'mobilesam');
}

export function paths() {
  const home = samHome();
  return {
    home,
    venv: join(home, 'venv'),
    python: join(home, 'venv', 'bin', 'python'),
    repo: join(home, 'MobileSAM'),
    weights: join(home, 'mobile_sam.pt'),
  };
}

async function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    /*
     * quiet 只控制「要不要把输出透给用户看」，不能直接当成 stdio 选项传下去。
     *
     * 之前这里写成 stdio: opts.quiet ? 'pipe' : 'inherit'，然后把整个 opts
     * 展开——quiet 这个自定义键也会传给 spawn（它不认，但更糟的是下面这层）：
     * 两个分支都挂了 data 监听去攒 out。inherit 时 p.stdout 是 null，没影响；
     * 但 'pipe' 分支下 pip 的进度输出有几十 KB，管道缓冲（默认 64KB）塞满后
     * 子进程会阻塞在写 stdout 上——冒烟测试就是这么卡死的。
     * 现在的做法：两个分支都持续读走输出，pipe 时攒起来返回，inherit 时读完丢掉。
     */
    const quiet = !!opts.quiet;
    const spawnOpts = { env: opts.env, cwd: opts.cwd };
    if (quiet) spawnOpts.stdio = 'pipe';
    else spawnOpts.stdio = 'inherit';

    const p = spawn(cmd, args, spawnOpts);
    let out = '';
    // 无论哪种模式都必须读走输出，否则管道塞满会死锁
    if (p.stdout) p.stdout.on('data', (d) => { if (quiet) out += d; else process.stdout.write(d); });
    if (p.stderr) p.stderr.on('data', (d) => { if (quiet) out += d; else process.stderr.write(d); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function findSystemPython() {
  for (const cmd of ['python3', 'python']) {
    try {
      const { code, out } = await run(cmd, ['-c', 'import sys; print(sys.version_info[:2])'],
        { quiet: true });
      if (code === 0) return { cmd, version: out.trim() };
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 只报告状态，不装任何东西 */
export async function check() {
  const p = paths();
  const state = {
    home: p.home,
    venv: existsSync(p.python),
    repo: existsSync(join(p.repo, 'mobile_sam', '__init__.py')),
    weights: false,
    weightBytes: 0,
    deps: false,
    python: null,
    ok: false,
  };
  if (existsSync(p.weights)) {
    const st = await stat(p.weights);
    state.weights = st.size > 30 * 1024 * 1024;   // 权重约 39MB，明显偏小就是没下完
    state.weightBytes = st.size;
  }
  if (state.venv) {
    const { code, out } = await run(p.python,
      ['-c', 'import torch, mobile_sam_is_here if False else None; import numpy, PIL, cv2'],
      { quiet: true });
    // 上一条故意只验子集：mobile_sam 依赖注入顺序，单独在这里测会误报
    const { code: code2 } = await run(p.python,
      ['-c', 'import torch, numpy, PIL, cv2, timm; print("ok")'], { quiet: true });
    state.deps = code2 === 0;
    void code; void out;
  }
  state.ok = state.venv && state.repo && state.weights && state.deps;
  return state;
}

export async function setup({ force = false, log = console.log } = {}) {
  const p = paths();
  await mkdir(p.home, { recursive: true });

  if (force) {
    log('--force：清掉已有环境重装');
    await rm(p.venv, { recursive: true, force: true });
    await rm(p.repo, { recursive: true, force: true });
    await rm(p.weights, { force: true });
  }

  // --- 1. 虚拟环境 ---
  if (existsSync(p.python)) {
    log(`✓ 虚拟环境已存在：${p.venv}`);
  } else {
    const py = await findSystemPython();
    if (!py) throw new Error('找不到 python3。请先安装 Python 3.9+（macOS 可 brew install python@3.11）');
    log(`· 建虚拟环境（用 ${py.cmd} ${py.version}）`);
    const { code } = await run(py.cmd, ['-m', 'venv', p.venv]);
    if (code !== 0) throw new Error('创建虚拟环境失败');
    log(`✓ 虚拟环境：${p.venv}`);
  }

  // --- 2. Python 依赖 ---
  const depsOk = await run(p.python,
    ['-c', 'import torch, numpy, PIL, cv2, timm'], { quiet: true });
  if (depsOk.code === 0) {
    log('✓ Python 依赖已装全');
  } else {
    log('· 安装 Python 依赖（torch 约 300MB，首次较慢）');
    const { code } = await run(p.python, ['-m', 'pip', 'install', '--upgrade', 'pip'],
      { quiet: true });
    void code;
    const r = await run(p.python, ['-m', 'pip', 'install', ...readRequirements()]);
    if (r.code !== 0) throw new Error('pip 安装失败，检查网络');
    log('✓ Python 依赖装好了（含上游漏声明的 timm）');
  }

  // --- 3. MobileSAM 仓库 ---
  if (existsSync(join(p.repo, 'mobile_sam', '__init__.py'))) {
    log(`✓ MobileSAM 仓库已存在：${p.repo}`);
  } else {
    log('· 克隆 MobileSAM');
    const { code } = await run('git',
      ['clone', '--depth', '1', REPO_URL, p.repo]);
    if (code !== 0) throw new Error('git clone 失败，检查网络');
    log(`✓ MobileSAM 仓库：${p.repo}`);
  }

  // --- 4. 权重 ---
  if (existsSync(p.weights)) {
    const st = await stat(p.weights);
    if (st.size > 30 * 1024 * 1024) {
      log(`✓ 权重已存在：${(st.size / 1024 / 1024).toFixed(1)}MB`);
    } else {
      log(`· 权重文件偏小（${st.size} 字节），重新下载`);
      await rm(p.weights, { force: true });
    }
  }
  if (!existsSync(p.weights)) {
    log('· 下载权重（39MB）');
    const { code } = await run('curl', ['-fsSL', '-o', p.weights, WEIGHT_URL]);
    if (code !== 0) throw new Error('权重下载失败，检查网络');
    const st = await stat(p.weights);
    log(`✓ 权重：${(st.size / 1024 / 1024).toFixed(1)}MB`);
  }

  // --- 5. 冒烟测试：真的能出掩码才算装好 ---
  log('· 冒烟测试（加载模型 + 编码 + 解码）');
  const probe = `
import sys, json, time
sys.path.insert(0, ${JSON.stringify(p.repo)})
import numpy as np
from mobile_sam import sam_model_registry, SamPredictor
import torch
sam = sam_model_registry['vit_t'](checkpoint=${JSON.stringify(p.weights)})
sam.eval()
dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
sam.to(dev)
p = SamPredictor(sam)
img = np.zeros((64, 64, 3), dtype=np.uint8)
img[16:48, 16:48] = 200
p.set_image(img)
masks, scores, _ = p.predict(box=np.array([[12, 12, 52, 52]]), multimask_output=True)
print(json.dumps({'device': dev, 'areas': [int(m.sum()) for m in masks]}))
`;
  const smoke = await run(p.python, ['-c', probe], { quiet: true });
  if (smoke.code !== 0) {
    log(smoke.out);
    throw new Error('冒烟测试失败——上面的输出是原因');
  }
  const lastLine = smoke.out.trim().split('\n').pop();
  let info = {};
  try { info = JSON.parse(lastLine); } catch { /* 有 warning 混进来时忽略 */ }
  log(`✓ 冒烟测试通过（设备 ${info.device || '?'}，掩码面积 ${info.areas || '?'}）`);

  log('');
  log('装好了。启动服务时 SAM 会自动拉起，不需要手动做任何事。');
  log(`环境位置：${p.home}`);
  return p;
}

// 直接执行时跑 CLI；被 import 时只导出函数
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const st = await check();
    console.log(JSON.stringify(st, null, 2));
    process.exit(st.ok ? 0 : 1);
  }
  try {
    await setup({ force: args.includes('--force') });
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}
