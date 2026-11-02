/**
 * 部件数量由模型按图判断，只设上限（用户 2026-11-02：「部件数量应该由模型来判断，
 * 而不是在提示词上写死，可以指定写死最大部件数量，比如最大 33 个」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisPrompt, capParts, DEFAULT_MAX_PARTS, maxTokensFor } from '../../server/ai/claude.js';

test('默认上限 33', () => {
  assert.equal(DEFAULT_MAX_PARTS, 33);
});

test('系统提示词不写死范围，只给上限', () => {
  const p = buildAnalysisPrompt({ maxParts: 33 });
  assert.doesNotMatch(p, /6~15/);
  assert.match(p, /最多 33 个/);
  assert.match(buildAnalysisPrompt({ maxParts: 20 }), /最多 20 个/);
});

test('四个模板都不再写死部件数量范围', () => {
  const t = JSON.parse(readFileSync(new URL('../../config/prompt-templates.json', import.meta.url), 'utf-8'));
  for (const [k, v] of Object.entries(t)) {
    assert.doesNotMatch(v.template, /\d+\s*[~～-]\s*\d+\s*个(?!像素)/, `${k} 模板还写着固定范围`);
  }
});

const part = (name, parent, w, h) => ({ name, parent, bbox: { x: 0, y: 0, width: w, height: h } });

test('超过上限：先去掉面积最小的叶子部件（没有子部件的），父部件和有子部件的不动', () => {
  const parts = [
    part('body', null, 400, 600), part('head', 'body', 200, 200),
    part('eye_l', 'head', 10, 10), part('eye_r', 'head', 12, 12), part('arm', 'body', 100, 300)
  ];
  const { parts: kept, dropped } = capParts(parts, 3);
  assert.deepEqual(dropped, ['eye_l', 'eye_r']);
  assert.deepEqual(kept.map((p) => p.name), ['body', 'head', 'arm']);
});

test('没超上限：原样返回', () => {
  const parts = [part('body', null, 400, 600), part('head', 'body', 200, 200)];
  const r = capParts(parts, 33);
  assert.equal(r.parts, parts);
  assert.deepEqual(r.dropped, []);
});

test('输出上限随部件数上限放大：33 个部件的 JSON 不能被截断', () => {
  assert.ok(maxTokensFor(15) >= 8192);
  assert.ok(maxTokensFor(33) >= 33 * 600, `33 个部件只给了 ${maxTokensFor(33)} token`);
});
