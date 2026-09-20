/**
 * 工程目录管理的回归测试。
 *
 * 这块逻辑会删磁盘上的文件，写错的代价不对称：
 * 少删了只是留点垃圾，多删了就是把用户的素材弄丢。
 * 所以重点钉死两件事——该删的删干净，不该碰的一个都不碰。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { prepareProjectDir, prepareExportDir, cleanProjectDir, safeName, listArtifacts,
  projectDirOf, sourceDirOf, tempDirOf, imagesDirOf, resolveSourceName,
  targetDirOf, spineProjectDirOf, SPINE_PROJECT_DIR } from '../../server/api/workspace.js';

/** 造一个「上一次生成完」的工程目录，混入用户自己的文件 */
async function seedProject(root, name = 'demo') {
  const proj = join(root, name);
  await mkdir(join(proj, 'images'), { recursive: true });
  await mkdir(join(proj, 'my-notes'), { recursive: true });

  for (const f of ['demo.json', 'demo.atlas', 'demo.png', 'README.txt']) {
    await writeFile(join(proj, f), 'x');
  }
  for (const f of ['body.png', 'lens.png', 'stale.png']) {
    await writeFile(join(proj, 'images', f), 'x');
  }
  // 不该被碰的：隐藏文件、非产物扩展名、用户自建目录
  await writeFile(join(proj, '.DS_Store'), 'x');
  await writeFile(join(proj, 'source.psd'), 'x');
  await writeFile(join(proj, 'my-notes', 'note.md'), 'x');

  return proj;
}

async function withTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'spine-ws-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('prepareProjectDir: 默认清理掉上一次的产物', async () => {
  await withTmp(async (root) => {
    const proj = await seedProject(root);

    const ws = await prepareProjectDir(root, 'demo');
    const left = await readdir(proj);

    assert.equal(ws.projectDir, proj);
    assert.ok(ws.removed > 0, '应报告删除数量');

    for (const gone of ['demo.json', 'demo.atlas', 'demo.png', 'README.txt']) {
      assert.ok(!left.includes(gone), `${gone} 应被清掉`);
    }
    // images 被整个删掉后重建，里面的旧切图不该残留
    assert.deepEqual(await readdir(ws.imagesDir), []);
  });
});

test('prepareProjectDir: 不碰用户自己的文件和目录', async () => {
  await withTmp(async (root) => {
    const proj = await seedProject(root);

    await prepareProjectDir(root, 'demo');
    const left = await readdir(proj);

    // 隐藏文件不是我们产出的
    assert.ok(left.includes('.DS_Store'));
    // 非产物扩展名一律留下
    assert.ok(left.includes('source.psd'));
    // 用户自建的子目录不在 OWNED_DIRS 里
    assert.ok(left.includes('my-notes'));
    assert.deepEqual(await readdir(join(proj, 'my-notes')), ['note.md']);
  });
});

test('prepareProjectDir: clean 为 false 时一个都不删', async () => {
  await withTmp(async (root) => {
    const proj = await seedProject(root);
    const before = (await readdir(proj)).sort();

    const ws = await prepareProjectDir(root, 'demo', { clean: false });

    assert.equal(ws.removed, 0);
    assert.deepEqual((await readdir(proj)).sort(), before);
    // 旧切图也还在
    assert.ok((await readdir(ws.imagesDir)).includes('stale.png'));
  });
});

test('prepareProjectDir: 目录不存在时建好结构且不报错', async () => {
  await withTmp(async (root) => {
    const ws = await prepareProjectDir(root, 'brand-new');

    assert.equal(ws.removed, 0);
    assert.deepEqual(await readdir(ws.projectDir), ['images']);
    assert.deepEqual(await readdir(ws.imagesDir), []);
  });
});

test('cleanProjectDir: 目录不存在返回 0 而不是抛错', async () => {
  await withTmp(async (root) => {
    assert.equal(await cleanProjectDir(join(root, 'never-existed')), 0);
  });
});

test('safeName: 挡掉路径穿越与分隔符', () => {
  // 工程名是前端传来的，直接拿去拼路径就能让清理跑到工程目录之外
  assert.ok(!safeName('../../etc').includes('..'));
  assert.ok(!safeName('../../etc').includes('/'));
  assert.ok(!safeName('a/b').includes('/'));
  assert.ok(!safeName('a\\b').includes('\\'));
  assert.ok(!safeName('..').includes('..'));

  // 空值回退到默认名，不能产出空目录名
  assert.equal(safeName(''), 'generated');
  assert.equal(safeName(null), 'generated');
  assert.equal(safeName('   '), 'generated');

  // 正常名字原样保留
  assert.equal(safeName('ok_name-1'), 'ok_name-1');
  assert.equal(safeName('  spaced  '), 'spaced');
});

test('工程名带路径穿越时，产物仍落在输出根目录内', async () => {
  await withTmp(async (root) => {
    // 在 root 外面放一个「不能被删」的产物文件
    await writeFile(join(root, 'outside.json'), 'keep me');

    const nested = join(root, 'nest');
    await mkdir(nested, { recursive: true });

    const ws = await prepareProjectDir(nested, '../demo');
    assert.ok(ws.projectDir.startsWith(nested), `工程目录逃出了输出根目录: ${ws.projectDir}`);

    // 外面的文件没被动
    assert.ok((await readdir(root)).includes('outside.json'));
  });
});

test('listArtifacts: 列出产物、跳过隐藏文件、带相对路径', async () => {
  await withTmp(async (root) => {
    const proj = join(root, 'demo');
    await mkdir(join(proj, 'images'), { recursive: true });
    await writeFile(join(proj, 'demo.json'), '12345');
    await writeFile(join(proj, 'images', 'body.png'), 'abc');
    await writeFile(join(proj, '.DS_Store'), 'x');

    const arts = await listArtifacts(proj);
    const paths = arts.map((a) => a.path);

    assert.deepEqual(paths, ['demo.json', 'images/body.png']);
    assert.equal(arts.find((a) => a.path === 'demo.json').size, 5);
    // 子目录用 / 拼接，前端可直接展示
    assert.ok(paths.every((p) => !p.startsWith('/')));
  });
});

test('projectDirOf: 和 prepareProjectDir 指向同一个目录', async () => {
  await withTmp(async (root) => {
    // 「打开输出目录」按钮靠 projectDirOf 定位，生成靠 prepareProjectDir。
    // 两者一旦算法漂移，就会出现按钮打开一个空目录、产物躺在旁边那个。
    const ws = await prepareProjectDir(root, 'demo');
    assert.equal(projectDirOf(root, 'demo'), ws.projectDir);
  });
});

test('projectDirOf: 工程名同样走 safeName，挡掉路径穿越', () => {
  const root = '/tmp/spine-out';
  // '../escape' → 分隔符变 _、'..' 变 _，最终 '__escape'
  assert.equal(projectDirOf(root, '../escape'), join(root, '__escape'));
  assert.ok(projectDirOf(root, '../../etc').startsWith(root));
  // 空工程名回退到默认名，不能产出「输出根目录本身」
  assert.equal(projectDirOf(root, ''), join(root, 'generated'));
});

test('projectDirOf: 输出目录为空时回退到 ./output', () => {
  assert.equal(projectDirOf('', 'demo'), join(resolve('./output'), 'demo'));
  assert.equal(projectDirOf(undefined, 'demo'), join(resolve('./output'), 'demo'));
});

/* ---------- 分目录结构 ----------
 *
 * 生成 → output/<工程名>/<输入图名>_temp/Image/
 * 导出 → output/<工程名>/<输入图名>/
 *
 * 两者分开是用户明确要的：生成的中间产物（切图、补图、.erased 掩码）一直留着，
 * 导出目录每次清空重建只放交付物。
 */

/** 造一个「上一次生成完」的中间产物目录（_temp），混入用户自己的文件 */
async function seedSource(root, project = 'demo', source = 'teacher') {
  const dir = join(root, project, `${source}_temp`);
  await mkdir(join(dir, 'Image'), { recursive: true });
  await mkdir(join(dir, 'my-refs'), { recursive: true });

  for (const f of [`${source}.json`, `${source}.atlas`, `${source}.png`, 'README.txt']) {
    await writeFile(join(dir, f), 'x');
  }
  for (const f of ['head.png', 'body.png', 'stale.png']) {
    await writeFile(join(dir, 'Image', f), 'x');
  }
  await writeFile(join(dir, '.DS_Store'), 'x');
  await writeFile(join(dir, 'source.psd'), 'x');
  await writeFile(join(dir, 'my-refs', 'note.md'), 'x');

  return dir;
}

test('prepareProjectDir: 生成产物落在 <工程名>/<输入图名>_temp/Image/ 下', async () => {
  await withTmp(async (root) => {
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    assert.equal(ws.projectDir, join(root, 'demo'));
    assert.equal(ws.sourceDir, join(root, 'demo', 'teacher_temp'));
    assert.equal(ws.imagesDir, join(root, 'demo', 'teacher_temp', 'Image'));
    assert.deepEqual(await readdir(ws.imagesDir), []);
  });
});

test('prepareProjectDir: 生成不创建、不触碰导出目录', async () => {
  await withTmp(async (root) => {
    // 上一次导出的结果已经在那儿，可能已经被拖进引擎了
    const exportDir = join(root, 'demo', 'teacher');
    await mkdir(join(exportDir, 'images'), { recursive: true });
    await writeFile(join(exportDir, 'teacher.json'), 'shipped');

    await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    // 一个字节都不该动：重新生成一次就把导出结果清空，引擎那边的引用当场断
    assert.deepEqual((await readdir(exportDir)).sort(), ['images', 'teacher.json']);
  });
});

test('prepareProjectDir: 重新生成同一张图只清它自己的目录', async () => {
  await withTmp(async (root) => {
    await seedSource(root, 'demo', 'teacher');
    // 同工程下另一张素材，必须一个文件都不少
    const other = await seedSource(root, 'demo', 'guard');

    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    assert.ok(ws.removed > 0, '应清掉 teacher 上一次的产物');
    const teacher = await readdir(ws.sourceDir);
    for (const gone of ['teacher.json', 'teacher.atlas', 'teacher.png', 'README.txt']) {
      assert.ok(!teacher.includes(gone), `${gone} 应被清掉`);
    }
    assert.deepEqual(await readdir(ws.imagesDir), []);

    // 这就是用户要的「不会删除不是自己的目录」：guard 原封不动
    assert.deepEqual((await readdir(other)).sort(), ['.DS_Store', 'Image', 'README.txt', 'guard.atlas', 'guard.json', 'guard.png', 'my-refs', 'source.psd'].sort());
    assert.deepEqual((await readdir(join(other, 'Image'))).sort(), ['body.png', 'head.png', 'stale.png']);
  });
});

test('prepareProjectDir: 不碰输入图目录里用户自己的东西', async () => {
  await withTmp(async (root) => {
    await seedSource(root, 'demo', 'teacher');

    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });
    const left = await readdir(ws.sourceDir);

    assert.ok(left.includes('.DS_Store'));
    assert.ok(left.includes('source.psd'));
    assert.ok(left.includes('my-refs'));
    assert.deepEqual(await readdir(join(ws.sourceDir, 'my-refs')), ['note.md']);
  });
});

test('prepareProjectDir: clean 为 false 时子目录里一个都不删', async () => {
  await withTmp(async (root) => {
    const dir = await seedSource(root, 'demo', 'teacher');
    const before = (await readdir(dir)).sort();

    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher', clean: false });

    assert.equal(ws.removed, 0);
    assert.deepEqual((await readdir(dir)).sort(), before);
    assert.ok((await readdir(ws.imagesDir)).includes('stale.png'));
  });
});

test('prepareProjectDir: 输入图名带路径穿越时仍在工程目录内', async () => {
  await withTmp(async (root) => {
    await writeFile(join(root, 'outside.json'), 'keep me');

    const ws = await prepareProjectDir(root, 'demo', { sourceName: '../../etc' });

    assert.ok(ws.sourceDir.startsWith(join(root, 'demo')), `输入图目录逃出了工程目录: ${ws.sourceDir}`);
    assert.ok((await readdir(root)).includes('outside.json'));
  });
});

test('tempDirOf/imagesDirOf: 和 prepareProjectDir 指向同一处', async () => {
  await withTmp(async (root) => {
    // 生成走 prepareProjectDir，补图重跑走 imagesDirOf。
    // 两者一旦漂移，就会出现「生成写进 A、补图去 B 里找切片」这种查半天的问题。
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    assert.equal(tempDirOf(root, 'demo', 'teacher'), ws.sourceDir);
    assert.equal(imagesDirOf(root, 'demo', 'teacher'), ws.imagesDir);

    // 导出目录是另一个，绝不能和生成目录重合——重合就等于导出清掉了中间产物
    assert.equal(sourceDirOf(root, 'demo', 'teacher'), join(root, 'demo', 'teacher'));
    assert.notEqual(sourceDirOf(root, 'demo', 'teacher'), ws.sourceDir);
  });
});

test('旧结构（产物直接躺在工程目录下）自动收进子目录', async () => {
  await withTmp(async (root) => {
    // 复现升级前的磁盘状态
    const proj = await seedProject(root, 'demo');

    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    // 搬进 _temp，不是搬进导出目录——导出每次 rm -rf 重建，搬进去下次就没了
    assert.equal(ws.migrated, 'teacher_temp');
    const moved = await readdir(ws.sourceDir);
    assert.ok(moved.includes('demo.json'), '旧骨架应被搬进新目录');
    assert.ok(moved.includes('images'));
    // 用户的目录和文件留在原地，不跟着搬
    assert.ok((await readdir(proj)).includes('my-notes'));
    assert.ok((await readdir(proj)).includes('source.psd'));
  });
});

test('已经搬过一次就不再动，也不会重复嵌套', async () => {
  await withTmp(async (root) => {
    await seedSource(root, 'demo', 'teacher');

    // 第二次生成：工程目录下已经有子目录了
    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    assert.equal(ws.migrated, null);
    assert.equal(ws.sourceDir, join(root, 'demo', 'teacher_temp'));
    assert.ok(!(await readdir(ws.sourceDir)).includes('teacher_temp'), '不该套出第三层');
  });
});

test('工程目录里只有用户自己的文件时不搬', async () => {
  await withTmp(async (root) => {
    const proj = join(root, 'demo');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'source.psd'), 'x');
    await writeFile(join(proj, 'notes.md'), 'x');

    const ws = await prepareProjectDir(root, 'demo', { sourceName: 'teacher' });

    assert.equal(ws.migrated, null);
    // 没认出来是我们的产物，就别乱搬
    assert.deepEqual((await readdir(proj)).sort(), ['notes.md', 'source.psd', 'teacher_temp']);
  });
});

/* ---------- 导出目录：点「导出」时清除再创建 ---------- */

test('prepareExportDir: 首次导出直接建空目录', async () => {
  await withTmp(async (root) => {
    const dir = join(root, 'demo', 'teacher');

    const r = await prepareExportDir(dir);

    assert.equal(r.sourceDir, dir);
    assert.equal(r.cleared, false, '本来不存在，没什么要清的');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('prepareExportDir: 再次导出先整个清掉', async () => {
  await withTmp(async (root) => {
    const dir = join(root, 'demo', 'teacher');
    await mkdir(join(dir, 'images'), { recursive: true });
    // 上一次导出的三件套 + 一张改名后已经不被图集引用的旧部件图
    for (const f of ['teacher.json', 'teacher.atlas', 'teacher.png', 'README.txt']) {
      await writeFile(join(dir, f), 'old');
    }
    await writeFile(join(dir, 'images', 'renamed_away.png'), 'old');

    const r = await prepareExportDir(dir);

    assert.equal(r.cleared, true);
    // 交付目录是我们独占的，清得比生成那边狠：整个 rm -rf，残留一个都不留
    assert.deepEqual(await readdir(dir), []);
  });
});

test('prepareExportDir: 不碰隔壁的 _temp 中间产物', async () => {
  await withTmp(async (root) => {
    const temp = await seedSource(root, 'demo', 'teacher');
    const exportDir = sourceDirOf(root, 'demo', 'teacher');
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, 'teacher.json'), 'old');

    await prepareExportDir(exportDir);

    // 补图重跑还要读 _temp/Image/ 里的切片，导出清空它就等于毁了重跑的输入
    assert.ok((await readdir(temp)).includes('Image'));
    assert.deepEqual((await readdir(join(temp, 'Image'))).sort(), ['body.png', 'head.png', 'stale.png']);
  });
});

test('resolveSourceName: 去掉扩展名，挡掉路径与空值', () => {
  assert.equal(resolveSourceName('teacher.png'), 'teacher');
  assert.equal(resolveSourceName('角色 A.png'), '角色 A');
  assert.equal(resolveSourceName('a.b.c.png'), 'a.b.c');
  // 没有扩展名就用原名
  assert.equal(resolveSourceName('teacher'), 'teacher');
  // 路径分隔符和 .. 一律夹掉，交给 safeName 处理
  assert.ok(!resolveSourceName('../../etc/passwd').includes('/'));
  assert.ok(!resolveSourceName('a/../b.png').includes('..'));
  // 取不到就退回调用方给的名字，不能产出空目录名
  assert.equal(resolveSourceName('', 'demo'), 'demo');
  assert.equal(resolveSourceName(null, 'demo'), 'demo');
  assert.equal(resolveSourceName('.png', 'demo'), 'demo');
});

test('listArtifacts: 工程目录下能列出所有素材的产物', async () => {
  await withTmp(async (root) => {
    const proj = join(root, 'demo');
    await mkdir(join(proj, 'teacher', 'images'), { recursive: true });
    await mkdir(join(proj, 'guard', 'images'), { recursive: true });
    await writeFile(join(proj, 'teacher', 'teacher.json'), '1');
    await writeFile(join(proj, 'teacher', 'images', 'head.png'), '2');
    await writeFile(join(proj, 'guard', 'guard.json'), '3');

    const paths = (await listArtifacts(proj)).map((a) => a.path);

    // 相对路径带上素材目录名，前端一眼能看出哪张图产出了什么
    assert.deepEqual(paths, [
      'guard/guard.json',
      'teacher/images/head.png',
      'teacher/teacher.json'
    ]);
  });
});

/*
 * 分目标目录的路径算法。
 *
 * 为什么值得单独钉：一个输入图可以同时导给 Cocos 和 Unity，两边的骨架、
 * 图集格式互不兼容（skins 形状、旋转关键帧字段名、atlas 字段顺序全不同）。
 * 算错一层就会互相覆盖——用户重导 Cocos，Unity 那份悄悄变成 3.8 的数据，
 * 直到他把资源拖进 Unity 才发现。
 */
test('targetDirOf: 每个导出目标各占一层，且都在导出目录里面', async () => {
  const root = '/tmp/outroot';
  const cocos = targetDirOf(root, 'demo', 'teacher', 'cocos-3.8');
  const unity = targetDirOf(root, 'demo', 'teacher', 'unity');
  const exp = sourceDirOf(root, 'demo', 'teacher');

  assert.equal(cocos, join(exp, 'cocos-3.8'));
  assert.equal(unity, join(exp, 'unity'));
  assert.notEqual(cocos, unity, '两个目标必须是两个目录，否则重导一个会盖掉另一个');
  assert.ok(cocos.startsWith(exp + '/') && unity.startsWith(exp + '/'));

  // 目标 id 也过 safeName：它虽然来自内置目标表，但请求体里是能伪造的
  assert.ok(!targetDirOf(root, 'demo', 'teacher', '../../etc').includes('..'));
});

test('spineProjectDirOf: .spine 和目标目录平级，不在任何目标里面', async () => {
  const root = '/tmp/outroot';
  const spineDir = spineProjectDirOf(root, 'demo', 'teacher');
  const exp = sourceDirOf(root, 'demo', 'teacher');

  assert.equal(spineDir, join(exp, SPINE_PROJECT_DIR));
  // 关键：不能落在某个目标目录里，否则重导那个目标会把源工程一起清掉
  for (const id of ['cocos-3.8', 'unity', 'spine-4.2']) {
    assert.ok(!spineDir.startsWith(targetDirOf(root, 'demo', 'teacher', id)),
      `.spine 落在了 ${id} 目录里，重导那个目标就会把它清掉`);
  }
});

test('清某个目标目录，不碰平级的 Spine工程/ 和别的目标', async () => {
  await withTmp(async (root) => {
    const exp = sourceDirOf(root, 'demo', 'teacher');
    const cocos = targetDirOf(root, 'demo', 'teacher', 'cocos-3.8');
    const unity = targetDirOf(root, 'demo', 'teacher', 'unity');
    const spineDir = spineProjectDirOf(root, 'demo', 'teacher');

    await mkdir(join(cocos, 'teacher'), { recursive: true });
    await mkdir(join(unity, 'teacher'), { recursive: true });
    await mkdir(spineDir, { recursive: true });
    await writeFile(join(cocos, 'teacher', 'teacher.json'), 'old-cocos');
    await writeFile(join(unity, 'teacher', 'teacher.json'), 'unity');
    await writeFile(join(spineDir, 'teacher.spine'), 'proj');

    const prep = await prepareExportDir(cocos);
    assert.equal(prep.cleared, true);

    // Cocos 被清空重建，另外两个原样
    assert.deepEqual(await readdir(cocos), []);
    assert.deepEqual(await readdir(join(unity, 'teacher')), ['teacher.json']);
    assert.deepEqual(await readdir(spineDir), ['teacher.spine']);
    // 上层目录本身没被删
    assert.ok((await readdir(exp)).includes(SPINE_PROJECT_DIR));
  });
});
