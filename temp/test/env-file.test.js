/**
 * .env 写入的回归测试。
 *
 * 这里动的是用户自己的文件，而且里面可能还躺着别的服务的配置。
 * 两类错误代价不对称：
 *   - 没写进去 → 用户重填一次，看得见
 *   - 把别的内容弄丢/弄乱 → 静默的，几周后别的服务起不来才知道
 * 所以重点钉：原有内容一字不动、键不重复、值不改写风格。
 *
 * 另外钉一条硬要求：返回值里绝不能有值。这个响应会被打到浏览器日志面板上，
 * 也可能被人截图，key 回显一次就是泄漏。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeEnv, readEnv, presenceOf } from '../../server/api/env-file.js';

async function withTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'spine-env-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SAMPLE = [
  '# Spine AI Generator 配置',
  'ANTHROPIC_BASE_URL=https://old.example.com',
  '',
  '# key 留空就表示用下面那个 token',
  'ANTHROPIC_API_KEY=',
  '',
  'PORT=3000',
  ''
].join('\n');

test('writeEnv: 就地替换已有键，注释与顺序原样保留', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, SAMPLE);

    const r = await writeEnv({ ANTHROPIC_API_KEY: 'sk-new' }, { path });
    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n');

    assert.deepEqual(r.changed, ['ANTHROPIC_API_KEY']);
    assert.equal(r.created, false);

    // 键在原来的位置，不是追加到末尾
    assert.equal(lines[4], 'ANTHROPIC_API_KEY=sk-new');
    // 注释、空行、别的键一字不动
    assert.equal(lines[0], '# Spine AI Generator 配置');
    assert.equal(lines[3], '# key 留空就表示用下面那个 token');
    assert.equal(lines[5], '');
    assert.equal(lines[6], 'PORT=3000');
    // 同名键只有一处，否则 dotenv 会以后出现的为准，用户看到的却是不生效那行
    assert.equal(text.split('\n').filter((l) => l.startsWith('ANTHROPIC_API_KEY')).length, 1);
  });
});

test('writeEnv: 文件里没有的键追加到末尾', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, 'PORT=3000\n');

    const r = await writeEnv({ ANTHROPIC_BASE_URL: 'https://new.example.com' }, { path });
    const text = await readFile(path, 'utf-8');

    assert.deepEqual(r.changed, ['ANTHROPIC_BASE_URL']);
    assert.equal(text, 'PORT=3000\nANTHROPIC_BASE_URL=https://new.example.com\n');
  });
});

test('writeEnv: 值没变就不写文件', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, SAMPLE);

    const before = await stat(path);
    // 等一拍，否则 mtime 分辨率不够，改了也看不出来
    await new Promise((r) => setTimeout(r, 10));
    const r = await writeEnv({ ANTHROPIC_BASE_URL: 'https://old.example.com' }, { path });
    const after = await stat(path);

    assert.deepEqual(r.changed, []);
    assert.equal(after.mtimeMs, before.mtimeMs, '无变化不该重写文件');
  });
});

test('writeEnv: 空串表示显式清空，不是「不动」', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, SAMPLE);

    const r = await writeEnv({ ANTHROPIC_BASE_URL: '' }, { path });
    const text = await readFile(path, 'utf-8');

    assert.deepEqual(r.changed, ['ANTHROPIC_BASE_URL']);
    assert.ok(text.includes('ANTHROPIC_BASE_URL='));
    assert.ok(!text.includes('old.example.com'));
  });
});

test('writeEnv: undefined 表示这次不动这一项', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, SAMPLE);

    const r = await writeEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: 'https://x.example' }, { path });

    assert.deepEqual(r.changed, ['ANTHROPIC_BASE_URL']);
    assert.ok((await readFile(path, 'utf-8')).includes('ANTHROPIC_API_KEY=\n'));
  });
});

test('writeEnv: 含 # 和空格的值加引号，往返不被截断', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, '');

    const tricky = 'sk-ab#cd ef"gh\\ij';
    await writeEnv({ ANTHROPIC_API_KEY: tricky }, { path });

    const back = await readEnv({ path });
    assert.equal(back.ANTHROPIC_API_KEY, tricky, '写进去再读出来必须还是原值');
  });
});

test('writeEnv: 普通 key 保持裸写，不把文件风格改掉', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, '');

    await writeEnv({ ANTHROPIC_API_KEY: 'sk-abc123', ANTHROPIC_BASE_URL: 'https://a.example.com/v1' }, { path });
    const text = await readFile(path, 'utf-8');

    assert.ok(text.includes('ANTHROPIC_API_KEY=sk-abc123'));
    assert.ok(text.includes('ANTHROPIC_BASE_URL=https://a.example.com/v1'));
  });
});

test('writeEnv: 文件不存在时新建，并带上说明注释', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');

    const r = await writeEnv({ ANTHROPIC_API_KEY: 'sk-1' }, { path });

    assert.equal(r.created, true);
    const text = await readFile(path, 'utf-8');
    assert.ok(text.startsWith('# Spine AI Generator 配置'));
    assert.ok(text.includes('ANTHROPIC_API_KEY=sk-1'));
    assert.ok(text.endsWith('\n'));
  });
});

test('writeEnv: 值里带路径分隔符也不会跑到目录外', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, '');

    // 值本身是路径不构成穿越：写的是文件内容，不是文件名
    await writeEnv({ ANTHROPIC_BASE_URL: '../../etc/passwd' }, { path });
    const back = await readEnv({ path });

    assert.equal(back.ANTHROPIC_BASE_URL, '../../etc/passwd');
    assert.ok(await readFile(path, 'utf-8'));
  });
});

test('writeEnv: 返回值里不含任何值', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    const secret = 'sk-super-secret-value';

    const r = await writeEnv({ ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: 'https://x.example' }, { path });

    // 这个返回值会进浏览器日志，绝不能带 key
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(secret), '返回值里出现了 key');
    assert.ok(!serialized.includes('x.example'), '返回值里出现了 baseURL 的值');
    assert.deepEqual(Object.keys(r).sort(), ['changed', 'created', 'path']);
  });
});

test('readEnv: 解析注释、export 前缀和引号', async () => {
  await withTmp(async (root) => {
    const path = join(root, '.env');
    await writeFile(path, [
      '# 注释',
      'export PORT=3000',
      'A=bare',
      'B="quoted value"',
      "C='single'",
      'D=',
      'E=trail # 注释',
      ''
    ].join('\n'));

    const values = await readEnv({ path });
    assert.equal(values.PORT, '3000');
    assert.equal(values.A, 'bare');
    assert.equal(values.B, 'quoted value');
    assert.equal(values.C, 'single');
    assert.equal(values.D, '');
    assert.equal(values.E, 'trail');
  });
});

test('readEnv: 文件不存在时返回空对象而不是抛错', async () => {
  await withTmp(async (root) => {
    assert.deepEqual(await readEnv({ path: join(root, 'nope.env') }), {});
  });
});

test('presenceOf: 只报有没有配和长度，不报值', () => {
  const p = presenceOf({ A: 'secret-value', B: '' });

  assert.deepEqual(p.A, { set: true, length: 12 });
  assert.deepEqual(p.B, { set: false });
  assert.ok(!JSON.stringify(p).includes('secret'));
});
