/**
 * 角色模板里的切图/补图约束（用户 2026-11-02：「在提示词模板设置里加一个切图和补图约束」）。
 *
 * 旧模板有一条和补图目标直接冲突：「每层的 bbox 只框该层的可见区域，被遮住的部分不框进去」。
 * 补图要把被挡部分画完整（脸在头发下完整、身体在披风下完整），框都不框进去，
 * 补图画布就装不下它。另一个实测问题：right_upper_arm 的轮廓把披风内衬圈了进去，
 * 衣物归属没按「跟着哪根骨头动」来定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const t = JSON.parse(readFileSync(new URL('../../config/prompt-templates.json', import.meta.url), 'utf-8')).character.template;

test('不再要求「被遮住的部分不框进去」', () => {
  assert.doesNotMatch(t, /被遮住的部分不框进去/);
});

test('要求 bbox/polygon 框出被遮挡部分在内的完整形状', () => {
  const line = t.split('\n').find((l) => /被遮挡/.test(l) && /完整/.test(l));
  assert.ok(line, '缺「被遮挡部分也要框完整」的规则');
  assert.match(line, /bbox|polygon/);
});

test('衣物归属跟着运动的骨头：袖子归手臂、裤腿归腿', () => {
  assert.ok(t.split('\n').some((l) => /袖子/.test(l) && /手臂/.test(l)), '缺袖子→手臂');
  assert.ok(t.split('\n').some((l) => /裤腿/.test(l) && /腿/.test(l)), '缺裤腿→腿');
});

test('不许把别的部件的内容圈进自己的 polygon', () => {
  assert.ok(t.split('\n').some((l) => /polygon/.test(l) && /不要|不得|不能/.test(l) && /别的部件|其他部件|相邻部件/.test(l)));
});
