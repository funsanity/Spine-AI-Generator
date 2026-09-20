/**
 * /api/restart 的测试。
 *
 * 这个路由干的是「起接班人 + 自己退场」，最容易出的错不是报错，而是
 * **看起来成功了其实没换人**：老进程退场前的窗口期里 /api/health 照样是
 * 200，只看「接口通不通」永远会显示成功。所以这里的判据一律是 **pid 变了**。
 *
 * 另外两条容易坏的路径也一并测了：
 *   - 重启出来的进程自己还能不能再重启（stdio / detached 链没断）
 *   - 普通启动遇到端口被占，必须立刻失败，不许闷头重试
 *     （重试会让人以为自己起了个新服务，实际连的是别人的）
 *
 * index.js import 时就 listen，没法直接 import 进来测，照 sam-routes.test.js
 * 的做法起子进程打接口。注意接班人是 detached 的，proc.kill() 管不到它，
 * 必须自己记住 pid 收尾，否则测试跑完会留一个占着端口的孤儿进程。
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
let samHome;
/** 所有见过的 pid，收尾时挨个确认已退出 */
const seen = new Set();

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function health() {
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  return r.json();
}

/** 等到 pid 变成 old 以外的值，返回新 pid；超时返回 null */
async function waitNewPid(old, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const h = await health();
      if (h.pid != null && h.pid !== old) { seen.add(h.pid); return h.pid; }
    } catch { /* 正在换人，连不上是正常的 */ }
  }
  return null;
}

async function waitPort(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const h = await health();
      if (h.status === 'ok') { seen.add(h.pid); return h; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务端没能起来');
}

before(async () => {
  // 空目录当 SPINE_SAM_HOME：不让测试去拉真的 SAM worker（慢且与本测试无关）
  samHome = await mkdtemp(join(tmpdir(), 'restart-'));
  port = 3800 + Math.floor(Math.random() * 90);
  proc = spawn('node', [join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SPINE_SAM_HOME: samHome },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitPort();
});

after(async () => {
  if (proc) proc.kill();
  // 接班人是 detached 的，父进程管不到，挨个收
  for (const pid of seen) {
    if (alive(pid)) { try { process.kill(pid); } catch { /* 已经走了 */ } }
  }
  if (samHome) await rm(samHome, { recursive: true, force: true });
});

test('/api/health: 带 pid 和 startedAt，前端靠它判断「换人了没」', async () => {
  const h = await health();
  assert.equal(h.status, 'ok');
  assert.equal(typeof h.pid, 'number', 'pid 必须在——没有它就无法确认重启是否真的发生');
  assert.ok(h.pid > 0);
  assert.equal(typeof h.startedAt, 'number');
});

test('/api/restart: 响应先回，然后真的换进程，老进程退出', async () => {
  const before = (await health()).pid;

  const r = await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST' });
  assert.equal(r.status, 200, '响应必须赶在进程退出之前发出去');
  const j = await r.json();
  assert.equal(j.success, true);
  assert.equal(j.pid, before, '响应里报的应当是「即将退场的那个」');

  const after = await waitNewPid(before);
  assert.ok(after, '30 秒内没等到新进程接管');
  assert.notEqual(after, before, 'pid 必须变——这是「真的重启了」的唯一判据');

  // 老进程要真的走掉，不能变成占内存的僵尸
  const deadline = Date.now() + 10000;
  while (alive(before) && Date.now() < deadline) {
    await new Promise((x) => setTimeout(x, 200));
  }
  assert.equal(alive(before), false, `老进程 ${before} 应当已退出`);
});

test('/api/restart: 重启出来的进程自己还能再重启（链不断）', async () => {
  const b = (await health()).pid;
  await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST' }).catch(() => {});
  const c = await waitNewPid(b);
  assert.ok(c, '第二次重启没等到新进程');
  assert.notEqual(c, b);

  // 换完人接口还能正常服务，不是只剩一个能响应 health 的空壳
  const st = await (await fetch(`http://127.0.0.1:${port}/api/sam-status`)).json();
  assert.equal(typeof st.ok, 'boolean', '重启后其它路由也得照常工作');
});

test('普通启动遇到端口被占：立刻失败退出，不许重试', async () => {
  // 端口被上面的服务占着。这时候闷头重试会让用户以为自己起了新服务，
  // 实际连的是别人的进程——必须报错退出。
  const child = spawn('node', [join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SPINE_SAM_HOME: samHome },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill(); resolve('超时未退出'); }, 15000);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });

  assert.equal(code, 1, `端口被占时应当以 1 退出，实际 ${code}`);
  assert.match(out, /端口 \d+ 被占用/, '要明确告诉用户端口被占，并给出换端口的办法');
});
