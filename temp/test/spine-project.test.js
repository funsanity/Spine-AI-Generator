/**
 * .spine 源工程生成。
 *
 * 用户要的是「点导出能看到 .spine 文件，拿进 Spine 做二次编辑」。
 * 这个文件**不能**自己拼：它是 Spine 私有的二进制工程格式，各 4.x
 * 小版本之间都会变，反推一份写出来编辑器一升级就静默读坏。
 * 所以只能调编辑器自带的 CLI（`Spine -i x.json -o x.spine --to 名 -r`）。
 *
 * 于是测试分两半：
 *   - 找不到 CLI 时必须**优雅降级**（返回 ok=false + 原因，不抛异常）。
 *     这条在任何机器上都能跑，也是最容易被写错的一条——
 *     少了它，没装 Spine 的用户点导出会直接看到"导出失败"。
 *   - 机器上真有 Spine 时，跑一次真导入，确认文件真的生成了、且非空。
 *     没装就跳过，不让 CI 因为这唯一一条依赖外部程序的用例红掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { buildSpineProject, findSpineCli, SPINE_CANDIDATES } from '../../server/api/spine-project.js';

async function withTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'spine-proj-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 一份 Spine 4.x 形状的最小骨架，和 buildExportSkeleton 的产物同结构 */
const minimalSkeleton = (name, spineVersion = '4.3.26') => ({
  skeleton: { hash: 'testhash', spine: spineVersion, images: './images/', audio: '' },
  bones: [{ name: 'root' }, { name: 'arm', parent: 'root', x: 10 }],
  slots: [{ name: 'arm', bone: 'arm', attachment: 'arm' }],
  skins: {
    default: {
      arm: { arm: { x: 0, y: 0, width: 20, height: 10 } }
    }
  },
  animations: {}
});

test('找不到 CLI 时返回 ok=false 和原因，不抛异常', async () => {
  await withTmp(async (root) => {
    const jsonPath = join(root, 'sk.json');
    await writeFile(jsonPath, JSON.stringify(minimalSkeleton('sk')), 'utf-8');

    const r = await buildSpineProject({
      jsonPath,
      outPath: join(root, 'sk.spine'),
      name: 'sk',
      cliPath: '/nonexistent/Spine-cli-for-test'
    });

    assert.equal(r.ok, false, '找不到 Spine 应降级，不该假装成功');
    assert.match(r.reason, /Spine/, '原因里要说清是 Spine 没找到，用户才知道去装什么');
    assert.ok(!existsSync(join(root, 'sk.spine')), '没成功就不该留下半个文件');
  });
});

test('骨架 JSON 不存在时也能降级', async () => {
  await withTmp(async (root) => {
    const r = await buildSpineProject({
      jsonPath: join(root, 'nope.json'),
      outPath: join(root, 'x.spine'),
      name: 'x',
      cliPath: '/nonexistent/Spine-cli-for-test'
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /骨架 JSON 不存在/);
  });
});

/*
 * 显式路径不许回退到别的安装。
 *
 * 这条看着刻薄，但它挡的是一个很难查的坑：.spine 的格式跟编辑器版本绑死
 * （实测 4.3.26 和 4.3.2 写出的同一份工程字节都不同）。用户指名要 4.2 那个，
 * 我们悄悄用机器上的 4.3 写一份出来，文件是有了，他打开可能直接读不了，
 * 而日志里一句异常都没有。
 */
test('findSpineCli：显式路径不存在就返回 null，不偷偷换成别的安装', async () => {
  assert.equal(await findSpineCli('/nonexistent/Spine-cli-for-test'), null,
    '显式路径不该回退——.spine 格式跟版本绑死，换一个版本写出来的文件用户可能打不开');

  // 候选项要覆盖三大平台，不然 Linux/Windows 的用户永远走降级分支
  assert.ok(SPINE_CANDIDATES.some((p) => p.includes('/Applications')));
  assert.ok(SPINE_CANDIDATES.some((p) => p.includes('Program Files')));
});

test('本机装了 Spine 时真跑一次导入，产出非空的 .spine', { skip: !existsSync(SPINE_CANDIDATES[0]) && '本机没装 Spine，跳过真导入' }, async () => {
  await withTmp(async (root) => {
    // 造一份带图片目录的交付结构，路径要和 .spine 里的 images 对得上
    const jsonPath = join(root, 'sk.json');
    await writeFile(jsonPath, JSON.stringify(minimalSkeleton('teacher')), 'utf-8');

    const outPath = join(root, 'teacher.spine');
    const r = await buildSpineProject({ jsonPath, outPath, name: 'teacher' });

    assert.equal(r.ok, true, `真导入失败: ${r.reason ?? ''}`);
    const st = await stat(outPath);
    assert.ok(st.size > 100, `.spine 只有 ${st.size} 字节，不可能是一份真工程`);
  });
});

/*
 * 可重复性只能按"体积接近"验，不能按字节相等。
 *
 * 实测同一份输入两次导入，字节是**不同**的：工程里存了每个骨架的内部 id
 * （Spine 自己生成的，带随机性），压缩后差异会扩散到整段数据。
 * 真正要保证的是"每次都能导、导出来的是同一个工程"，体积几乎一致
 * （实测两次都是 4xx 字节、差个位数）就够说明这一点。
 */
test('同一份骨架连跑两次都能导，产出体积一致', { skip: !existsSync(SPINE_CANDIDATES[0]) && '本机没装 Spine，跳过' }, async () => {
  await withTmp(async (root) => {
    const jsonPath = join(root, 'sk.json');
    await writeFile(jsonPath, JSON.stringify(minimalSkeleton('a')), 'utf-8');

    const p1 = join(root, 'a1.spine');
    const p2 = join(root, 'a2.spine');
    assert.equal((await buildSpineProject({ jsonPath, outPath: p1, name: 'a' })).ok, true);
    assert.equal((await buildSpineProject({ jsonPath, outPath: p2, name: 'a' })).ok, true);

    const [b1, b2] = [await readFile(p1), await readFile(p2)];
    assert.ok(Math.abs(b1.length - b2.length) < 32,
      `两次产出体积差太多（${b1.length} vs ${b2.length}），可能有一次没装进全部数据`);
  });
});
