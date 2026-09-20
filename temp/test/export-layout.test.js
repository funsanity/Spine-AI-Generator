/**
 * 输出目录结构的端到端回归测试。
 *
 * 用户明确要的布局：
 *
 *   output/<工程名>/
 *     <输入图名>_temp/Image/          ← 生成全程写这里，一直留着
 *     <输入图名>/                     ← 点「导出」才建
 *       Spine工程/<输入图名>.spine    ← 源工程，拿进 Spine 二次编辑
 *       <目标 id>/<输入图名>/         ← 三件套，给引擎直接加载
 *         <输入图名>.json / .atlas / .png / images/
 *
 * 这里把三步串起来跑一遍真实调用（prepareProjectDir → exportToSpine），
 * 钉死几件事：
 *   1. 生成落在 _temp，导出落在上一层，两者不重合
 *   2. 三件套落在 <输入图名>/<目标 id>/<输入图名>/，_temp 里不留交付物
 *   3. 清理只清本次目标那一层，别的目标目录不受影响
 *   4. 导出不会碰 _temp 里的中间产物和掩码
 *
 * 用真的 exportToSpine 而不是断言路径字符串：路径对不上是显性错误，
 * 真正难查的是「路径对了但产物写到了别处」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  prepareProjectDir, prepareExportDir, tempDirOf, imagesDirOf, sourceDirOf, targetDirOf
} from '../../server/api/workspace.js';
import { exportToSpine, generateSkeleton } from '../../server/api/generator.js';

async function withTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'spine-layout-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 造一张真 PNG 当切图产物，让图集能真的打出来 */
async function writePart(dir, name, w = 24, h = 24) {
  const path = join(dir, `${name}.png`);
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = 180; buf[i * 4 + 1] = 90; buf[i * 4 + 2] = 60;
    buf[i * 4 + 3] = i % 7 === 0 ? 0 : 255;   // 带点透明，别是纯实心块
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path);
  return { name, path, size: { width: w, height: h }, bbox: { x: 0, y: 0, width: w, height: h } };
}

/** 一份最小的部件几何，够 generateSkeleton 出骨架 */
const GEOM = {
  parts: [{ name: 'head', parent: null, bbox: { x: 0, y: 0, width: 24, height: 24 } }],
  sourceImage: 'x.png'
};
const skeletonOf = (parts = GEOM.parts) =>
  generateSkeleton({ ...GEOM, parts }, '3.8', { imageSize: { width: 48, height: 48 }, density: 8 });

/**
 * 跑一次导出。
 *
 * Spine CLI 在测试里**不调**：本机没装编辑器时它会去找安装路径，
 * 装上之后又会真起一个进程（首次导入要几秒），单测不该依赖这些。
 * 传一个不存在的路径，buildSpineProject 会走"找不到 CLI"那条分支，
 * 正好把"没装也能导出三件套"这条降级路径也验了。
 */
const exportOnce = (skel, root, name, opts = {}) => exportToSpine(skel, sourceDirOf(root, 'demo', name), name, {
  target: 'cocos-3.8',
  spineCliPath: '/nonexistent/spine-cli-for-test',
  ...opts
});

test('生成写 _temp，导出写上一层，两者不重合', async () => {
  await withTmp(async (root) => {
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    const tmpDir = tempDirOf(root, 'demo', 'teacher');
    const expDir = sourceDirOf(root, 'demo', 'teacher');

    assert.equal(ws.sourceDir, tmpDir, '生成落在 _temp');
    assert.equal(ws.imagesDir, imagesDirOf(root, 'demo', 'teacher'), '切图落在 _temp/Image');
    assert.notEqual(tmpDir, expDir, '生成目录和导出目录必须是两个');
    assert.ok(!expDir.startsWith(tmpDir), '导出目录不能在生成目录里面');
  });
});

test('导出：三件套落在 <输入图名>/<目标 id>/<输入图名>/，_temp 里不留交付物', async () => {
  await withTmp(async (root) => {
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });
    const cut = await writePart(ws.imagesDir, 'head');
    await writePart(ws.imagesDir, 'body');

    const skeleton = skeletonOf([
      { name: 'head', parent: null, bbox: { x: 0, y: 0, width: 24, height: 24 } },
      { name: 'body', parent: 'head', bbox: { x: 0, y: 24, width: 24, height: 24 } }
    ]);

    const targetDir = targetDirOf(root, 'demo', 'teacher', 'cocos-3.8');
    await prepareExportDir(targetDir);

    const r = await exportOnce(skeleton, root, 'teacher', { cutResults: [cut] });

    // 交付目录是 <输入图名>/<目标 id>/<输入图名>/
    assert.equal(r.projectDir, join(targetDir, 'teacher'));
    assert.ok(r.skeletonPath.startsWith(r.projectDir), `骨架应落在交付目录: ${r.skeletonPath}`);

    const files = await readdir(r.projectDir);
    assert.ok(files.includes('teacher.json'), '缺骨架 json');
    assert.ok(files.includes('teacher.atlas'), '缺图集');
    assert.ok(files.includes('teacher.png'), '缺图集页');

    // _temp 那边只剩中间产物，不该冒出骨架
    const tmpFiles = await readdir(ws.sourceDir);
    assert.ok(!tmpFiles.includes('teacher.json'), '_temp 里不该有骨架，那是交付物');
  });
});

test('导出清空重建：上一次的残留部件图不会被带进来', async () => {
  await withTmp(async (root) => {
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });
    const cut = await writePart(ws.imagesDir, 'head');

    const targetDir = targetDirOf(root, 'demo', 'teacher', 'cocos-3.8');
    await prepareExportDir(targetDir);

    // 第一次导出：留一张上次改过名的部件图在 images/ 里
    await mkdir(join(targetDir, 'teacher', 'images'), { recursive: true });
    await writeFile(join(targetDir, 'teacher', 'images', 'renamed_away.png'), 'stale');

    // 第二次导出前清空重建
    const prep = await prepareExportDir(targetDir);
    assert.equal(prep.cleared, true);

    await exportOnce(skeletonOf(), root, 'teacher', { cutResults: [cut] });

    const imgs = await readdir(join(targetDir, 'teacher', 'images'));
    assert.ok(!imgs.includes('renamed_away.png'),
      '上次的残留跟着进来了——图集已经不引用它，美术却会以为还有用');
    assert.ok(imgs.includes('head.png'), '本次的部件图应该在');
  });
});

test('清某个目标目录不会动别的目标，也不会动 Spine工程/', async () => {
  await withTmp(async (root) => {
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });
    const cut = await writePart(ws.imagesDir, 'head');

    const cocosDir = targetDirOf(root, 'demo', 'teacher', 'cocos-3.8');
    const unityDir = targetDirOf(root, 'demo', 'teacher', 'unity');

    // 先导 Unity，再导 Cocos（真实顺序：用户换了个目标重导一遍）
    await prepareExportDir(unityDir);
    await exportToSpine(skeletonOf(), sourceDirOf(root, 'demo', 'teacher'), 'teacher', {
      target: 'unity', cutResults: [cut], spineCliPath: '/nonexistent/spine'
    });
    const unityBefore = await readdir(join(unityDir, 'teacher'));

    // Spine 源工程落在 <输入图名>/Spine工程/，和目标目录平级
    const spineDir = join(sourceDirOf(root, 'demo', 'teacher'), 'Spine工程');
    await mkdir(spineDir, { recursive: true });
    await writeFile(join(spineDir, 'teacher.spine'), 'fake');

    await prepareExportDir(cocosDir);
    await exportOnce(skeletonOf(), root, 'teacher', { cutResults: [cut] });

    // Unity 那份必须原封不动
    const unityAfter = await readdir(join(unityDir, 'teacher'));
    assert.deepEqual(unityAfter, unityBefore, '重导 Cocos 不该动 Unity 的产物');
    assert.ok(unityAfter.includes('teacher.json'), 'Unity 骨架还在');

    // .spine 也得还在
    const spineFiles = await readdir(spineDir);
    assert.ok(spineFiles.includes('teacher.spine'), '.spine 源工程被清掉了');

    // Cocos 自己也齐了
    const cocosFiles = await readdir(join(cocosDir, 'teacher'));
    assert.ok(cocosFiles.includes('teacher.json'));
  });
});

test('导出不碰 _temp 里的切图和 .erased 掩码', async () => {
  await withTmp(async (root) => {
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });
    await writePart(ws.imagesDir, 'head');
    // 切图阶段写的擦除掩码：补图重跑要靠它
    await writeFile(join(ws.imagesDir, 'head.erased.png'), 'mask');

    await prepareExportDir(targetDirOf(root, 'demo', 'teacher', 'cocos-3.8'));
    await exportOnce(skeletonOf(), root, 'teacher', { cutResults: [] });

    const tmpImgs = await readdir(ws.imagesDir);
    assert.ok(tmpImgs.includes('head.png'), '切图被删了，补图重跑就没输入了');
    assert.ok(tmpImgs.includes('head.erased.png'), '擦除掩码被删了');
  });
});
