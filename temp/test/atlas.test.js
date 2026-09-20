/**
 * Atlas 解析器：无损往返 + 部件清单
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAtlas, writeAtlas, listAtlasParts, AtlasParseError } from '../../src/atlas/parseAtlas.js';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

function loadFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

// ─── 无损往返 ─────────────────────────────────────────────────────────────────

test('Wand.atlas.txt: parse → write 输出与原始文本相同', () => {
  const src = loadFixture('Wand.atlas.txt');
  const atlas = parseAtlas(src);
  const out = writeAtlas(atlas);
  assert.equal(out, src, '往返后文本应完全相同');
});

// ─── 分页结构 ─────────────────────────────────────────────────────────────────

test('Wand.atlas.txt: 解析出正确的分页信息', () => {
  const atlas = parseAtlas(loadFixture('Wand.atlas.txt'));
  assert.equal(atlas.pages.length, 1, '只有一张贴图');
  const page = atlas.pages[0];
  assert.equal(page.name, 'Wand.png');
  assert.deepEqual(page.params.size, { w: 512, h: 256 });
  assert.deepEqual(page.params.filter, ['Linear', 'Linear']);
  assert.equal(page.params.pma, true);
  assert.equal(page.params.scale, 0.8);
});

// ─── 区段结构 ─────────────────────────────────────────────────────────────────

test('Wand.atlas.txt: 解析出正确的区段数量和名称', () => {
  const atlas = parseAtlas(loadFixture('Wand.atlas.txt'));
  const names = atlas.pages[0].regions.map((r) => r.name);
  // 文件里有 Wand 和 glow_spot
  assert.ok(names.includes('Wand'), '应包含 Wand 区段');
  assert.ok(names.includes('glow_spot'), '应包含 glow_spot 区段');
});

test('Wand.atlas.txt: Wand 区段的 bounds 和 offsets 正确', () => {
  const atlas = parseAtlas(loadFixture('Wand.atlas.txt'));
  const wand = atlas.pages[0].regions.find((r) => r.name === 'Wand');
  assert.ok(wand, '区段 Wand 必须存在');
  assert.deepEqual(wand.params.bounds, { x: 2, y: 2, w: 172, h: 239 });
  assert.deepEqual(wand.params.offsets, { x: 50, y: 12, w: 280, h: 280 });
});

// ─── 部件清单 ─────────────────────────────────────────────────────────────────

test('listAtlasParts: 每个区段都出现在清单里，字段齐全', () => {
  const atlas = parseAtlas(loadFixture('Wand.atlas.txt'));
  const parts = listAtlasParts(atlas);
  assert.ok(parts.length >= 2, '至少有 Wand 和 glow_spot');
  for (const p of parts) {
    assert.ok(typeof p.name === 'string', 'name 必须是字符串');
    assert.ok(typeof p.page === 'string', 'page 必须是字符串');
    assert.equal(p.page, 'Wand.png', '都属于同一张贴图');
  }
});

test('listAtlasParts: pma 字段继承自分页', () => {
  const atlas = parseAtlas(loadFixture('Wand.atlas.txt'));
  const parts = listAtlasParts(atlas);
  for (const p of parts) {
    assert.equal(p.pma, true, '分页 pma:true 应继承到所有区段');
  }
});

// ─── 错误处理 ─────────────────────────────────────────────────────────────────

test('parseAtlas: 参数在分页前出现时抛出 AtlasParseError', () => {
  assert.throws(
    () => parseAtlas('size:512,256\nWand.png\n'),
    AtlasParseError,
  );
});

test('parseAtlas: bounds 格式错误时抛出 AtlasParseError', () => {
  assert.throws(
    () => parseAtlas('Wand.png\nWand\nbounds:notanumber\n'),
    AtlasParseError,
  );
});

// ─── 最小构造往返 ─────────────────────────────────────────────────────────────

test('手工构造最小 atlas: parse → write 往返成立', () => {
  const src = 'sprites.png\nsize:256,256\nfilter:Linear,Linear\npma:false\nhero\nbounds:0,0,64,64\n';
  const out = writeAtlas(parseAtlas(src));
  assert.equal(out, src);
});
