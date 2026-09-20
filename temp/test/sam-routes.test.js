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
import { mkdtemp, rm } from 'node:fs/promises';
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
    env: { ...process.env, PORT: String(port), SPINE_SAM_HOME: emptyEnvHome },
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
