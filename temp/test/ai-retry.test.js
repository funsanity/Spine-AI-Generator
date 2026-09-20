import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTransient, createWithRetry, parseWithRetry } from '../../server/ai/claude.js';

/** 造一个带 status / code 的假错误 */
const err = (status, message = '', code = '') => {
  const e = new Error(message);
  if (status) e.status = status;
  if (code) e.code = code;
  return e;
};

describe('isTransient: 哪些错误值得重试', () => {
  it('429 限流 → 重试', () => {
    assert.equal(isTransient(err(429, 'rate limited')), true);
  });

  it('5xx 服务端错误 → 重试', () => {
    assert.equal(isTransient(err(500, 'internal')), true);
    assert.equal(isTransient(err(503, 'unavailable')), true);
    assert.equal(isTransient(err(529, 'overloaded')), true);
  });

  it('中转站的笼统 400 Invalid request → 重试（实测是瞬时抖动）', () => {
    assert.equal(isTransient(err(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid request"}}')), true);
  });

  it('模型名不存在的 400 → 不重试（重试多少次都一样）', () => {
    assert.equal(isTransient(err(400, 'No active provider route for TEXT/claude-opus-5[1M] with mode SYNC')), false);
  });

  it('401/403 鉴权失败 → 不重试', () => {
    assert.equal(isTransient(err(401, 'invalid api key')), false);
    assert.equal(isTransient(err(403, 'forbidden')), false);
  });

  it('连接层抖动 → 重试', () => {
    assert.equal(isTransient(err(0, 'socket hang up', 'ECONNRESET')), true);
    assert.equal(isTransient(err(0, 'timeout', 'ETIMEDOUT')), true);
    assert.equal(isTransient(err(0, 'dns', 'ENOTFOUND')), true);
  });

  it('不认识的东西 → 不重试，早点报错', () => {
    assert.equal(isTransient(err(0, 'something weird')), false);
    assert.equal(isTransient(new Error('plain')), false);
  });
});

describe('createWithRetry: 退避重试行为', () => {
  /** 假 client：按脚本依次返回成功或抛错 */
  const fakeClient = (script) => {
    const calls = [];
    return {
      calls,
      messages: {
        create: async (req) => {
          calls.push(req);
          const step = script[calls.length - 1];
          if (step instanceof Error) throw step;
          return step;
        },
      },
    };
  };

  it('第一次就成功 → 只调一次', async () => {
    const client = fakeClient([{ ok: 1 }]);
    const r = await createWithRetry(client, { model: 'm' }, 1);
    assert.deepEqual(r, { ok: 1 });
    assert.equal(client.calls.length, 1);
  });

  it('前两次瞬时失败、第三次成功 → 调三次后返回结果', async () => {
    const client = fakeClient([
      err(400, 'Invalid request'),
      err(503, 'unavailable'),
      { ok: 'done' },
    ]);
    const r = await createWithRetry(client, { model: 'm' }, 1);
    assert.deepEqual(r, { ok: 'done' });
    assert.equal(client.calls.length, 3);
  });

  it('重试用尽还是失败 → 抛最后一次的错误', async () => {
    const client = fakeClient([
      err(400, 'Invalid request'),
      err(400, 'Invalid request'),
      err(400, 'Invalid request'),
    ]);
    await assert.rejects(() => createWithRetry(client, { model: 'm' }, 1), /Invalid request/);
    assert.equal(client.calls.length, 3, '应该是 1 次首发 + 2 次重试，不该更多');
  });

  it('不可重试的错误 → 立刻抛出，不浪费时间', async () => {
    const client = fakeClient([err(401, 'invalid api key')]);
    await assert.rejects(() => createWithRetry(client, { model: 'm' }, 1), /invalid api key/);
    assert.equal(client.calls.length, 1, '鉴权失败不该重试');
  });

  it('模型名不存在 → 立刻抛出，不重试', async () => {
    const client = fakeClient([err(400, 'No active provider route for TEXT/x')]);
    await assert.rejects(() => createWithRetry(client, { model: 'x' }, 1), /No active provider route/);
    assert.equal(client.calls.length, 1);
  });

  it('重试时原样重发同一个请求体', async () => {
    const req = { model: 'm', max_tokens: 10 };
    const client = fakeClient([err(503, 'unavailable'), { ok: 1 }]);
    await createWithRetry(client, req, 1);
    assert.deepEqual(client.calls[0], req);
    assert.deepEqual(client.calls[1], req);
  });
});

describe('parseWithRetry: 输出被截断时翻倍重发', () => {
  const SIZE = { width: 100, height: 100 };

  /** 造一份合法的部件表 JSON */
  const partsJSON = () => JSON.stringify({
    parts: [{
      name: 'body', parent: null, depth: 0,
      bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      pivot: { x: 0.5, y: 0.5 },
      occlusion_edges: [],
      polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }],
    }],
  });

  const resp = (text, stop) => ({ stop_reason: stop, content: [{ text }] });

  /** 假 client：按脚本依次返回响应 */
  const fakeClient = (script) => {
    const calls = [];
    return {
      calls,
      messages: {
        create: async (req) => { calls.push(req); return script[calls.length - 1]; },
      },
    };
  };

  it('没截断、解析得动 → 一次成功，不发第二次', async () => {
    const client = fakeClient([]);
    const a = await parseWithRetry(resp(partsJSON(), 'end_turn'), { model: 'm', max_tokens: 8192 }, client, SIZE);
    assert.equal(a.parts.length, 1);
    assert.equal(client.calls.length, 0, '不该有重发');
  });

  it('stop_reason=max_tokens 且 JSON 断了 → 额度翻倍重发', async () => {
    // 模拟真实故障：写到一半被切掉，JSON 语法就是错的
    const broken = partsJSON().slice(0, 80);
    const client = fakeClient([resp(partsJSON(), 'end_turn')]);
    const a = await parseWithRetry(resp(broken, 'max_tokens'), { model: 'm', max_tokens: 8192 }, client, SIZE);
    assert.equal(a.parts.length, 1, '第二次的完整响应应该解析得动');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].max_tokens, 16384, '额度要翻倍');
    assert.equal(client.calls[0].model, 'm', '其余请求字段要原样带过去');
  });

  it('解析失败但不是截断（模型胡说）→ 立刻抛，不浪费一次调用', async () => {
    const client = fakeClient([]);
    await assert.rejects(
      () => parseWithRetry(resp('我拒绝回答', 'end_turn'), { model: 'm', max_tokens: 8192 }, client, SIZE),
      /解析响应失败/,
    );
    assert.equal(client.calls.length, 0);
  });

  it('额度已经到上限 → 不再翻倍，直接抛', async () => {
    const client = fakeClient([]);
    await assert.rejects(
      () => parseWithRetry(resp('{"parts":[', 'max_tokens'), { model: 'm', max_tokens: 32768 }, client, SIZE),
      /解析响应失败/,
    );
    assert.equal(client.calls.length, 0, '再翻倍也没意义');
  });

  it('翻倍后仍被截断 → 只重发一次就放弃，不无限重发', async () => {
    const client = fakeClient([resp('{"parts":[', 'max_tokens')]);
    await assert.rejects(
      () => parseWithRetry(resp('{"parts":[', 'max_tokens'), { model: 'm', max_tokens: 8192 }, client, SIZE),
      /解析响应失败/,
    );
    assert.equal(client.calls.length, 1, '只重发一次');
  });
});
