/**
 * 补图熔断 + 补图改了 bbox 后的 pivot 平移。
 *
 * 熔断：2026-11-02 实测中转站图像接口连续 500 时，旧流程对 20 个部件各重试一遍，
 * 白等好几分钟、日志刷满同一条错误。同一个 5xx 连着出两次就别再试了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInpaintBreaker, applyInpaintBbox } from '../../server/api/inpaint.js';

const e = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('熔断：同一个 5xx 连续两次 → 断开', () => {
  const b = createInpaintBreaker();
  b.record(e(500)); assert.equal(b.tripped, false);
  b.record(e(500)); assert.equal(b.tripped, true);
  assert.match(b.reason, /500/);
});

test('熔断：不同状态码不算连续', () => {
  const b = createInpaintBreaker();
  b.record(e(500)); b.record(e(502));
  assert.equal(b.tripped, false);
});

test('熔断：中间成功一次就清零', () => {
  const b = createInpaintBreaker();
  b.record(e(500)); b.record(null); b.record(e(500));
  assert.equal(b.tripped, false);
});

test('熔断：4xx（比如 key 错）不熔断，交给逐个报错', () => {
  const b = createInpaintBreaker();
  b.record(e(401)); b.record(e(401));
  assert.equal(b.tripped, false);
});

test('补图把窗口往左上撑开，pivot 同量往回补，骨头位置不变', () => {
  const cut = { bbox: { x: 100, y: 100, width: 80, height: 80 }, size: { width: 80, height: 80 }, pivot: { x: 50, y: 60 } };
  applyInpaintBbox(cut, { x: 90, y: 95, width: 100, height: 90 });
  assert.deepEqual(cut.bbox, { x: 90, y: 95, width: 100, height: 90 });
  assert.deepEqual(cut.size, { width: 100, height: 90 });
  assert.deepEqual(cut.pivot, { x: 60, y: 65 });
});

test('bbox 没变就什么都不动', () => {
  const cut = { bbox: { x: 100, y: 100, width: 80, height: 80 }, size: { width: 80, height: 80 }, pivot: { x: 50, y: 60 } };
  applyInpaintBbox(cut, { x: 100, y: 100, width: 80, height: 80 });
  assert.deepEqual(cut.pivot, { x: 50, y: 60 });
});

test('熔断：超时/断连（没有状态码）连续两次也断开——中转站卡死比报 500 更耗时', () => {
  const b = createInpaintBreaker();
  b.record(new Error('请求超时（>180s）'));
  b.record(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  assert.equal(b.tripped, true);
});
