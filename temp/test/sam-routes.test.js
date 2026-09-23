/**
 * /api/sam-status 路由的测试。
 *
 * 这个路由原来一条测试都没有，结果就出过事：改 import 时把
 * getSamClient 从 index.js 里换掉了，路由还在用它，接口直接返回
 * `ok:false, error:"getSamClient is not defined"`。
 * 前端拿到 ok:false 会取消勾选开关，用户看到的是"功能没装"，
 * 而环境其实好端端的——错误信息还被吞在那句提示里，很难查。
 *
 * index.js import 时就会 app.listen，没法直接 import 进来测，
 * 所以照项目里其它验证脚本的做法起子进程，再用 fetch 打接口。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

let proc;
let port;
let emptyEnvHome;

before(async () => {
  emptyEnvHome = await mkdtemp(join(tmpdir(), 'samroute-'));
  // 用一个空目录当 SPINE_SAM_HOME：确定性地走"环境未装"分支
  port = 3900 + Math.floor(Math.random() * 90);
  proc = spawn('node', [join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // 这个进程专门测"没装 MobileSAM"的分支，所以必须固定成 mobilesam。
      // 不显式设的话会继承外层的 SPINE_SEGMENTER —— 用户 .env 里设成 sam3
      // 就整片测试都测错了对象，而且单跑通过、全套挂，最难查的那类。
      SPINE_SEGMENTER: 'mobilesam',
      // SAM 3 也指到空目录：这个进程要确定性地走"什么都没装"
      SPINE_SAM3_HOME: emptyEnvHome,
      SPINE_SAM_HOME: emptyEnvHome
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  // 等端口真的能用，而不是盲等固定秒数
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务端没能在 15 秒内起来');
});

after(async () => {
  if (proc) proc.kill();
  if (emptyEnvHome) await rm(emptyEnvHome, { recursive: true, force: true });
});

test('/api/sam-status: 返回结构完整，不因内部报错而字段全丢', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sam-status`);
  assert.equal(r.status, 200, '接口本身必须是 200');
  const j = await r.json();

  /*
   * 关键断言：不该出现"路由内部抛异常被 catch 住"的形态。
   *
   * 那种情况返回的是 { ok:false, error:'xxx is not defined' }，
   * 字段少得可怜。前端只看 ok 字段，会把"代码写错了"误读成"环境没装"。
   * 这里要求正常的完整响应结构一定存在。
   */
  assert.ok(!j.error, `接口不该报错，实际: ${j.error}`);
  assert.equal(typeof j.ok, 'boolean');
  assert.equal(typeof j.venv, 'boolean');
  assert.equal(typeof j.repo, 'boolean');
  assert.equal(typeof j.weights, 'boolean');
  assert.equal(typeof j.deps, 'boolean');
  assert.equal(typeof j.running, 'boolean');
  assert.ok(j.stats, 'stats 应当在');
  assert.equal(typeof j.stats.segments, 'number');
  assert.equal(j.setupCommand, 'node server/sam/setup.mjs',
    '没装的时候前端要靠这个命令提示用户');
});

test('/api/sam-status: 环境未装时 ok=false 且各子项都是 false', async () => {
  const j = await (await fetch(`http://127.0.0.1:${port}/api/sam-status`)).json();
  assert.equal(j.ok, false, '空目录当 SPINE_SAM_HOME 时必须报未装');
  assert.equal(j.venv, false);
  assert.equal(j.repo, false);
  assert.equal(j.weights, false);
  assert.equal(j.running, false, '环境没装当然不会有 worker 在跑');
  // home 要指向我们指定的那个空目录，证明 SPINE_SAM_HOME 真的生效了
  assert.ok(j.home.includes('samroute-') || j.home === emptyEnvHome,
    `home 应当是本次指定的临时目录，实际 ${j.home}`);
});

test('/api/sam-status: 不装环境时不抛 500，前端能正常拿到 JSON', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sam-status`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
});

/*
 * ── 分割器切换接口 ──────────────────────────────────────────────────
 *
 * 这些测试共用一个临时 .env（SPINE_ENV_PATH 指过去），绝不能碰仓库根
 * 那份真实配置——里面躺着用户的 API Key。
 *
 * 另一个必须注意的点：切换会把选择写进文件，所以测试之间会互相影响。
 * 每条用前先显式把状态设成它需要的样子，不依赖上一条的残留。
 */

/** 起第二个服务进程，专门测切换：它要一份自己的临时 .env 和目录 */
let swPort;
let swProc;
let swEnvPath;
let swRoot;

before(async () => {
  swRoot = await mkdtemp(join(tmpdir(), 'samswitch-'));
  swEnvPath = join(swRoot, '.env');
  await writeFile(swEnvPath, 'ANTHROPIC_API_KEY=sk-not-a-real-key\nPORT=0\n', 'utf-8');

  swPort = 4000 + Math.floor(Math.random() * 90);
  swProc = spawn('node', [join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(swPort),
      SPINE_ENV_PATH: swEnvPath,
      // 真环境都在本机，这样测的是"切换成功"而不是"没装"。
      // 刻意不设 SPINE_SEGMENTER，让初始值是 mobilesam
      SPINE_SEGMENTER: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  swProc.stdout.on('data', () => {});
  swProc.stderr.on('data', () => {});

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${swPort}/api/health`);
      if (r.ok) break;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (swProc) swProc.kill();
  if (swRoot) await rm(swRoot, { recursive: true, force: true });
});

const switchUrl = () => `http://127.0.0.1:${swPort}/api/segmenter`;
const statusUrl = () => `http://127.0.0.1:${swPort}/api/sam-status`;
const post = (body) => fetch(switchUrl(), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('/api/segmenter: 切到 sam3 后，状态接口跟着变', async (t) => {
  // 真环境不在本机时跳过（CI 上没装）
  const before = await (await fetch(statusUrl())).json();
  if (!before.alternates?.sam3) return t.skip('本机没装 SAM 3 环境，跳过');

  const r = await post({ segmenter: 'sam3' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.success, true);
  assert.equal(j.segmenter, 'sam3');

  const after = await (await fetch(statusUrl())).json();
  assert.equal(after.segmenter, 'sam3', '状态接口要报新值，否则界面显示的和实际不一致');
});

test('/api/segmenter: 选择写进 .env，重启后还在', async (t) => {
  const before = await (await fetch(statusUrl())).json();
  if (!before.alternates?.sam3) return t.skip('本机没装 SAM 3 环境，跳过');

  await post({ segmenter: 'sam3' });
  const text = await readFile(swEnvPath, 'utf-8');
  assert.match(text, /^SPINE_SEGMENTER=sam3$/m, '.env 里要留下这个键');
});

test('/api/segmenter: 不认识的值得 400，不能静默退回默认值', async () => {
  // 静默退回是最坏的一种：用户以为切成功了，实际用的是另一个模型
  for (const bad of ['sam-3', 'SAM4', 'mobile', '', null, 42]) {
    const r = await post({ segmenter: bad });
    assert.equal(r.status, 400, `"${bad}" 应当被拒，实际 HTTP ${r.status}`);
    const j = await r.json();
    assert.equal(j.success, false);
    assert.match(j.error, /mobilesam/);
  }
});

test('/api/segmenter: 缺字段也要 400，不能当成切换成功', async () => {
  const r = await fetch(switchUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(r.status, 400);
});

test('/api/segmenter: 环境没装的那一项被拒，并给出安装命令', async () => {
  // 置灰只是 UI，直接打接口也得拦住。这里让 SAM 3 指向一个空目录
  // ——但 itest 用的是同一个进程，改不了它的环境变量，
  // 所以改用本文件第一个进程（那个 SPINE_SAM_HOME 指向空目录的）。
  const r = await fetch(`http://127.0.0.1:${port}/api/segmenter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segmenter: 'mobilesam' })
  });
  assert.equal(r.status, 400, 'MobileSAM 环境指向空目录时必须拒绝');
  const j = await r.json();
  assert.equal(j.success, false);
  assert.match(j.error, /setup\.mjs/, '要告诉用户怎么装');
});

test('/api/segmenter: 切换不会弄丢 .env 里别的键', async () => {
  const before = await (await fetch(statusUrl())).json();
  if (!before.alternates?.mobilesam) return t.skip('本机没装 MobileSAM 环境，跳过');

  await post({ segmenter: 'mobilesam' });
  const text = await readFile(swEnvPath, 'utf-8');
  // 这条防的是"写 .env 把别人配置冲掉"——代价不对称：
  // 没写进去用户重填一次就看见了，把 key 弄丢是静默的
  assert.match(text, /^ANTHROPIC_API_KEY=sk-not-a-real-key$/m, '原有的键必须原样保留');
});

test('/api/segmenter: 切到当前已经选中的值不算错（幂等）', async (t) => {
  const before = await (await fetch(statusUrl())).json();
  if (!before.alternates?.mobilesam) return t.skip('本机没装 MobileSAM 环境，跳过');

  await post({ segmenter: 'mobilesam' });
  const r = await post({ segmenter: 'mobilesam' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.success, true);
  assert.equal(j.unchanged, true, '重复切同一个值应当明确报 unchanged，而不是假装改了');
});

test('/api/sam-status: 报两个环境各自装没装，前端靠它置灰', async () => {
  const j = await (await fetch(statusUrl())).json();
  assert.ok(j.alternates, 'alternates 应当在');
  assert.equal(typeof j.alternates.mobilesam, 'boolean');
  assert.equal(typeof j.alternates.sam3, 'boolean');
});

test('/api/sam-status: 报 generating，生成中前端要能禁用切换', async () => {
  const j = await (await fetch(statusUrl())).json();
  assert.equal(typeof j.generating, 'boolean');
  assert.equal(j.generating, false, '空闲时应为 false');
});

test('/api/sam-status: 廉价——不能 spawn python 去验依赖', async () => {
  // 原来这里调 setup 的 check()，它 spawn python 跑 `import torch`：
  // 实测 MobileSAM 2.8 秒、SAM 3 5.2 秒。而这个接口每次页面加载都调，
  // 慢到界面像是卡住了（还因此让分割器切换看起来"点了没反应"）。
  // 钉一个上限：本地文件检查应该在几十毫秒内完成。
  const t0 = Date.now();
  await fetch(statusUrl());
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `状态接口应当在 1 秒内返回，实测 ${ms}ms`);
});
