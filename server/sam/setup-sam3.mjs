#!/usr/bin/env node
/**
 * SAM 3 环境一键准备（文本提示分割，MobileSAM 的可选替代）。
 *
 * 装什么、装到哪：
 *   虚拟环境   ~/.spine-tool/sam3/venv        （约 730MB，torch 占大头）
 *   权重       ~/.spine-tool/sam3/model.safetensors  （3.4GB）
 *   配置       ~/.spine-tool/sam3/*.json / merges.txt / vocab.json
 *
 * 为什么和 MobileSAM 分开一套环境：
 *   两个模型的依赖是冲突的。MobileSAM 钉在 torch 2.8.0 + Python 3.9，
 *   而 SAM 3 要求 Python 3.12+ 且需要 transformers 的 main 分支（PyPI
 *   上的正式版还没有 sam3）。装在一起必然要升级其中一个，把原本能跑的
 *   MobileSAM 弄坏。分开装之后两条路各自独立，任何一条坏了不影响另一条。
 *
 * ⚠ 许可证与 MobileSAM 不同，请先读这里：
 *   SAM 3 用的是 **SAM License**，不是 Apache-2.0（本项目是 Apache-2.0）。
 *   官方权重在 HuggingFace 上是需要申请审批的 gated 仓库。
 *   所以本脚本**只从 ModelScope 拉权重到你自己机器上，不随仓库分发**——
 *   和 MobileSAM 的处理方式一致。要用就把这段读完，自行确认合规。
 *
 * 幂等：每一步都先检查是否已完成，重复跑不会重装。
 *
 * 用法:
 *   node server/sam/setup-sam3.mjs           # 装（缺什么补什么）
 *   node server/sam/setup-sam3.mjs --check   # 只报告状态，不装
 *   node server/sam/setup-sam3.mjs --force   # 忽略已有环境，重装
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 权重必须 ≥ 这个大小才算下完整。实测完整文件 3,439,938,512 字节 */
const WEIGHT_MIN_BYTES = 3_400_000_000;
/** 精确字节数，用来发现"下到一半断了"这种情况。上游 API 报多少就是多少 */
const WEIGHT_EXACT_BYTES = 3_439_938_512;

/**
 * 权重与配置的来源。
 *
 * 用 ModelScope 而不是 HuggingFace：HF 上 facebook/sam3 是 gated 仓库，
 * 要登录并等审批；ModelScope 这个镜像不需要，省掉一道门槛。
 * 内容与官方一致（按字节数核对过）。
 */
const MS_BASE = 'https://modelscope.cn/models/facebook/sam3/resolve/master';
/** 模型本体。3.4GB，最慢的一步 */
const WEIGHT_URL = `${MS_BASE}/model.safetensors`;
/** 配置和分词器，都很小，但少了任何一个 from_pretrained 都起不来 */
const CONFIG_FILES = [
  'config.json',
  'processor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
  'special_tokens_map.json',
];

/** SAM 3 要求的 Python 版本下限。低于它 pip 装不上，白等半天 */
const MIN_PY = [3, 10];
/** 这个组合实测可用（M2 Pro / macOS / MPS + bf16） */
const TORCH_VERSION = '2.8.0';
const TORCHVISION_VERSION = '0.23.0';

export function sam3Home() {
  return process.env.SPINE_SAM3_HOME || join(homedir(), '.spine-tool', 'sam3');
}

export function sam3Paths() {
  const home = sam3Home();
  return {
    home,
    venv: join(home, 'venv'),
    python: join(home, 'venv', 'bin', 'python'),
    weights: join(home, 'model.safetensors'),
    config: join(home, 'config.json'),
    worker: new URL('./worker_sam3.py', import.meta.url).pathname,
  };
}

async function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // quiet 只控制要不要透出输出。两个分支都必须持续读走输出，
    // 否则管道缓冲（64KB）塞满后子进程会阻塞在写 stdout 上——pip 的进度
    // 输出有几十 KB，正好能塞满。这条是从 setup.mjs 继承来的教训。
    const quiet = !!opts.quiet;
    const spawnOpts = { env: opts.env, cwd: opts.cwd };
    spawnOpts.stdio = quiet ? 'pipe' : 'inherit';

    const p = spawn(cmd, args, spawnOpts);
    let out = '';
    if (p.stdout) p.stdout.on('data', (d) => { if (quiet) out += d; else process.stdout.write(d); });
    if (p.stderr) p.stderr.on('data', (d) => { if (quiet) out += d; else process.stderr.write(d); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * 找一个够新的 Python。
 *
 * 和 setup.mjs 那个不同：这里必须校验版本，不能只找到就用。
 * 系统自带的 /usr/bin/python3 是 3.9，用它建 venv 之后
 * pip install torch 会失败，而且要等几分钟才失败。
 */
async function findSystemPython(minVersion = MIN_PY) {
  const candidates = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
  const tried = [];
  for (const cmd of candidates) {
    try {
      const { code, out } = await run(cmd,
        ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { quiet: true });
      if (code !== 0) continue;
      const [maj, min] = out.trim().split('.').map(Number);
      tried.push(`${cmd}=${out.trim()}`);
      if (maj > minVersion[0] || (maj === minVersion[0] && min >= minVersion[1])) {
        return { cmd, version: out.trim() };
      }
    } catch { /* 试下一个 */ }
  }
  return { none: true, tried };
}

/** 只报告状态，不装任何东西 */
export async function checkSam3() {
  const p = sam3Paths();
  const state = {
    home: p.home,
    venv: existsSync(p.python),
    weights: false,
    weightBytes: 0,
    config: false,
    deps: false,
    python: null,
    ok: false,
  };
  if (existsSync(p.weights)) {
    const st = await stat(p.weights);
    state.weights = st.size >= WEIGHT_MIN_BYTES;
    state.weightBytes = st.size;
  }
  state.config = CONFIG_FILES.every((f) => existsSync(join(p.home, f)));
  if (state.venv) {
    const { code } = await run(p.python,
      ['-c', 'import torch; print(torch.__version__)'], { quiet: true });
    if (code === 0) {
      const { code: c2 } = await run(p.python,
        ['-c', 'from transformers import Sam3Model, Sam3Processor'], { quiet: true });
      state.deps = c2 === 0;
    }
  }
  state.ok = state.venv && state.weights && state.config && state.deps;
  return state;
}

export async function setupSam3({ force = false, log = console.log } = {}) {
  const p = sam3Paths();
  await mkdir(p.home, { recursive: true });

  if (force) {
    log('--force：清掉已有环境重装');
    await rm(p.venv, { recursive: true, force: true });
    await rm(p.weights, { force: true });
  }

  // --- 1. 虚拟环境 ---
  if (existsSync(p.python)) {
    log(`✓ 虚拟环境已存在：${p.venv}`);
  } else {
    const py = await findSystemPython();
    if (py.none) {
      throw new Error(
        `找不到 Python ${MIN_PY.join('.')}+（SAM 3 的硬要求）。` +
        `试过：${py.tried.join(', ') || '无'}\n` +
        'macOS 上装一个：brew install python@3.12'
      );
    }
    log(`· 建虚拟环境（用 ${py.cmd} ${py.version}）`);
    const { code } = await run(py.cmd, ['-m', 'venv', p.venv]);
    if (code !== 0) throw new Error('创建虚拟环境失败');
    log(`✓ 虚拟环境：${p.venv}`);
  }

  // --- 2. Python 依赖 ---
  let depsOk = false;
  {
    const { code } = await run(p.python,
      ['-c', 'import torch; from transformers import Sam3Model'], { quiet: true });
    depsOk = code === 0;
  }
  if (depsOk) {
    log('✓ Python 依赖已装全');
  } else {
    log(`· 安装 torch ${TORCH_VERSION}（约 300MB，首次较慢）`);
    await run(p.python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { quiet: true });
    const r1 = await run(p.python, ['-m', 'pip', 'install',
      `torch==${TORCH_VERSION}`, `torchvision==${TORCHVISION_VERSION}`]);
    if (r1.code !== 0) throw new Error('pip 安装 torch 失败，检查网络');

    log('· 安装 numpy / pillow');
    const r2 = await run(p.python, ['-m', 'pip', 'install', 'numpy', 'pillow'], { quiet: true });
    if (r2.code !== 0) throw new Error('pip 安装 numpy/pillow 失败');

    // transformers 必须从 git main 装：PyPI 上的正式发行版还没有 sam3 模块，
    // 实测 5.18.0.dev0 才带 Sam3Model。
    // --no-deps 是必须的：不加的话它会顺手把 torch 换成自己钉的版本，
    // 把刚装好的 MPS 可用组合冲掉。
    log('· 安装 transformers（git main 分支，PyPI 正式版还没有 sam3）');
    const r3 = await run(p.python, ['-m', 'pip', 'install', '--no-deps',
      'git+https://github.com/huggingface/transformers.git']);
    if (r3.code !== 0) throw new Error('安装 transformers 失败，检查网络');

    log('· 补齐 transformers 的运行时依赖');
    const r4 = await run(p.python, ['-m', 'pip', 'install', '--no-deps',
      'accelerate', 'safetensors', 'tokenizers', 'regex', 'requests', 'tqdm', 'huggingface_hub']);
    if (r4.code !== 0) throw new Error('安装 transformers 依赖失败');

    log('✓ Python 依赖装好了');
  }

  // --- 3. 配置与分词器 ---
  const missCfg = CONFIG_FILES.filter((f) => !existsSync(join(p.home, f)));
  if (!missCfg.length) {
    log('✓ 配置与分词器已存在');
  } else {
    log(`· 下载配置与分词器（${missCfg.length} 个文件）`);
    for (const f of missCfg) {
      const { code } = await run('curl', ['-fsSL', '-o', join(p.home, f), `${MS_BASE}/${f}`],
        { quiet: true });
      if (code !== 0) throw new Error(`下载 ${f} 失败，检查网络`);
    }
    log('✓ 配置与分词器齐了');
  }

  // --- 4. 权重（3.4GB，最慢一步）---
  if (existsSync(p.weights)) {
    const st = await stat(p.weights);
    if (st.size >= WEIGHT_MIN_BYTES) {
      if (st.size === WEIGHT_EXACT_BYTES) {
        log(`✓ 权重已存在且完整：${(st.size / 1024 / 1024).toFixed(0)}MB`);
      } else {
        // 比最小阈值大但和精确值对不上：可能是上游换版本了，
        // 也可能是下到了别的文件。不自动删，但要说明白，让人自己判断。
        log(`⚠ 权重大小 ${st.size} 与预期的 ${WEIGHT_EXACT_BYTES} 不一致。`);
        log('  如果模型能正常加载就忽略这条；加载报错的话删掉重下：');
        log(`  rm "${p.weights}"`);
      }
    } else {
      log(`· 权重不完整（${(st.size / 1024 / 1024).toFixed(0)}MB），续传`);
      // -C - 续传：断了一半的时候不用从头再来
      const { code } = await run('curl', ['-fsSL', '-C', '-', '-o', p.weights, WEIGHT_URL]);
      if (code !== 0) throw new Error('权重下载失败，检查网络');
      const st2 = await stat(p.weights);
      log(`✓ 权重：${(st2.size / 1024 / 1024).toFixed(0)}MB`);
    }
  } else {
    log('· 下载权重（3.4GB，按实测网速约 30~40 分钟，中途断了可以重跑续传）');
    const { code } = await run('curl', ['-fsSL', '-C', '-', '-o', p.weights, WEIGHT_URL]);
    if (code !== 0) throw new Error('权重下载失败，检查网络');
    const st = await stat(p.weights);
    log(`✓ 权重：${(st.size / 1024 / 1024).toFixed(0)}MB`);
  }

  // --- 5. 冒烟测试：真的能出掩码才算装好 ---
  log('· 冒烟测试（加载模型 + 文本提示 + 出掩码）');
  const probe = `
import json, sys, numpy as np
from PIL import Image
from transformers import Sam3Model, Sam3Processor
import torch
d = ${JSON.stringify(p.home)}
dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
dtype = torch.bfloat16 if dev == 'mps' else torch.float32
m = Sam3Model.from_pretrained(d, dtype=dtype, low_cpu_mem_usage=True).to(dev).eval()
pr = Sam3Processor.from_pretrained(d)
# 造一张纯色图：只要流程能跑通、输出形状对，就算装好。
# 不用真图是因为这里只验环境，不验效果。
img = Image.new('RGB', (256, 256), (200, 180, 160))
b = pr(images=img, text='object', return_tensors='pt')
b = {k: (v.to(dev).to(dtype) if torch.is_tensor(v) and torch.is_floating_point(v)
         else (v.to(dev) if torch.is_tensor(v) else v)) for k, v in b.items()}
with torch.no_grad():
    out = m(**b)
print(json.dumps({'device': dev, 'dtype': str(dtype),
                  'masks': list(out.pred_masks.shape)}))
`;
  const { code, out } = await run(p.python, ['-c', probe], { quiet: true });
  if (code !== 0) {
    log('✗ 冒烟测试失败，输出如下：');
    log(out.trim().slice(-2000));
    throw new Error('SAM 3 装好了但跑不起来，见上面的报错');
  }
  let info = {};
  try { info = JSON.parse(out.trim().split('\n').pop()); } catch { /* 解析不了就只报成功 */ }
  log(`✓ 冒烟测试通过（设备 ${info.device || '?'}，dtype ${info.dtype || '?'}）`);

  log('');
  log('装完了。切换分割器：');
  log('  在 .env 里设 SPINE_SEGMENTER=sam3（默认是 mobilesam）');
  log('  别忘了 SPINE_SAM3_HOME 可以改权重位置');
  return { ok: true, ...info };
}

/** 直接运行时走 CLI */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const s = await checkSam3();
    console.log(JSON.stringify(s, null, 2));
    console.log(s.ok ? '\n✓ SAM 3 环境就绪' : '\n✗ 还不完整，跑一次 node server/sam/setup-sam3.mjs');
    process.exit(s.ok ? 0 : 1);
  }
  try {
    await setupSam3({ force: args.includes('--force') });
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}
