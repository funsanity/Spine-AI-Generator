/**
 * 截图判据的回归测试。
 *
 * 这一组不启浏览器，只拿两张真实截图（修复前 / 修复后各一张）验证
 * `analyzePreviewShot` 的判据确实能把"坏"和"好"分开。
 *
 * 为什么值得单独测：判据本身写错过两次——
 *   1. 直接数"暗色像素占比"。画布底就是深色，角色占比被淹掉，
 *      结果对着一张明确是坏图判"通过"。
 *   2. 拿"同尺寸纯色底图"做差。canvas 是透明的，透出来的是页面网格，
 *      底对不上，差出来全是噪声。
 * 判据要是错了，截图测试就会变成"永远绿"，比没有还糟。
 *
 * 夹具说明：
 *   fixtures/preview-broken-blackbox.png —— 修复前拍的。部件被糊成实心黑框，
 *     把角色整个盖住，彩色像素只剩 1.1%。
 *   fixtures/preview-good.png —— 修复后拍的。彩色像素 10.4%。下
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

/** 与 test/screenshot.test.js 里的 analyze 保持一致 */
async function analyzePreviewShot(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;

  let dark = 0, colorful = 0, bright = 0;
  for (let i = 0; i < total; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 50) dark++;
    if (mx - mn > 40 && mx > 50) colorful++;
    if (mn > 230) bright++;
  }

  return {
    width: info.width, height: info.height,
    darkRatio: dark / total,
    colorfulRatio: colorful / total,
    brightRatio: bright / total
  };
}

const BROKEN = join(FIXTURES, 'preview-broken-blackbox.png');
const GOOD = join(FIXTURES, 'preview-good.png');

test('判据：坏截图（实心黑框）必须判为不合格', { skip: !existsSync(BROKEN) && '缺少夹具' }, async () => {
  const a = await analyzePreviewShot(BROKEN);
  // 3% 是判断门槛，坏图应当远在门槛之下
  assert.ok(a.colorfulRatio < 0.03,
    `坏截图的彩色占比是 ${(a.colorfulRatio * 100).toFixed(1)}%，` +
    `已经高过 3% 的门槛——判据失效了，它会把这类的坏图放过去`);
});

test('判据：好截图必须判为合格', { skip: !existsSync(GOOD) && '缺少夹具' }, async () => {
  const a = await analyzePreviewShot(GOOD);
  assert.ok(a.colorfulRatio > 0.03,
    `好截图的彩色占比只有 ${(a.colorfulRatio * 100).toFixed(1)}%，被误判成坏图——门槛定高了`);
});

test('判据：好坏的差距必须足够大，不能贴在一起', { skip: (!existsSync(BROKEN) || !existsSync(GOOD)) && '缺少夹具' }, async () => {
  const bad = await analyzePreviewShot(BROKEN);
  const good = await analyzePreviewShot(GOOD);
  const ratio = good.colorfulRatio / Math.max(bad.colorfulRatio, 1e-6);

  console.log(`  坏 ${(bad.colorfulRatio * 100).toFixed(1)}%  好 ${(good.colorfulRatio * 100).toFixed(1)}%  相差 ${ratio.toFixed(1)} 倍`);

  /*
   * 门槛要落在两者之间，而且离两边都有余量。
   *
   * 实测差距是 10 倍上下（1.1% vs 10.4%）。要求至少 3 倍，
   * 是为了保证门槛的选择有余地——如果哪天只剩 1.5 倍，
   * 说明判据在退化，即便当前阈值还能过也该警觉。
   */
  assert.ok(ratio >= 3,
    `好坏只差 ${ratio.toFixed(1)} 倍，判据的区分度不够，门槛会变得不可靠`);
});
