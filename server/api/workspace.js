/**
 * 输出目录管理。
 *
 * 目录结构：
 *
 *   output/
 *   └── <工程名>/
 *       ├── <输入图名>_temp/            ← 生成的中间产物，一直留着
 *       │   └── Image/*.png             切图、补图、掩码（.erased.png）
 *       ├── <输入图名>/                 ← 点「导出」才创建
 *       │   ├── Spine工程/
 *       │   │   └── <输入图名>.spine    源工程，拿进 Spine 编辑器做二次编辑
 *       │   └── <目标 id>/              每个导出目标各一层，互不覆盖
 *       │       └── <输入图名>/
 *       │           ├── <输入图名>.json 骨架
 *       │           ├── <输入图名>.atlas
 *       │           ├── <输入图名>.png
 *       │           ├── README.txt
 *       │           └── images/*.png    散图
 *       └── <另一张输入图>_temp/
 *
 * 为什么把生成和导出分成两个目录（用户明确要的）：
 *   生成阶段的产物是**过程性**的——切图、补图的中间结果、深度擦除掩码。
 *   它们要留着：补图重跑要读，出了问题要能对着看是哪一步砸的，
 *   所以 _temp 不会在导出时被清掉。
 *   而导出目录是**交付物**——拖进引擎的那一套，里面不该混进 .erased.png
 *   这种只有我们自己看得懂的东西。每次导出前整个清掉重建，
 *   免得上一次的残留（比如改名后的旧部件图）跟着进引擎。
 *
 * 为什么按输入图再分一层：
 *   一个工程往往对应一整套素材——角色 A、角色 B、道具、特效，各自一张源图。
 *   全平铺在一个目录里，文件名的前缀就成了唯一的分组手段，而骨架、图集、散图
 *   三件套的文件名还不一样（有的跟工程名、有的跟部件名），根本看不出谁是谁的。
 *   分开之后，「重新生成角色 A」只会动角色 A 那个目录，角色 B 的产物原封不动——
 *   这也是用户明确要的：不会删掉不属于自己的目录。
 *
 * 清理范围限定在本次那个输入图目录内，且只删我们自己产出的那几类文件，
 * 用户手动放进去的东西不动——误删别人的素材比留下垃圾严重得多。
 */

import { mkdir, readdir, rename, rm, stat } from 'fs/promises';
import { join, resolve, basename } from 'path';

/** 我们自己产出的文件类型。清理只碰这些，其余一律留下 */
const OWNED_EXT = ['.png', '.json', '.atlas', '.txt', '.skel'];

/** 工程目录下我们会创建的子目录。Image 是 _temp 里的，images 是导出目录里的 */
const OWNED_DIRS = ['images', 'Image'];

/** 生成中间产物目录的后缀。导出目录 = 同名但没有这个后缀 */
const TEMP_SUFFIX = '_temp';

/**
 * 准备一次生成要用的目录。
 *
 * @param {string} outputDir - 输出根目录（如 ./output）
 * @param {string} projectName - 工程名
 * @param {object} opts - { clean, sourceName }
 *   sourceName 为空时退回旧行为（工程目录直属），保证老调用方不被破坏
 * @returns {Promise<{projectDir, sourceDir, imagesDir, removed, migrated}>}
 *   projectDir 是工程目录本身，sourceDir 是这次产物的实际落点（= imagesDir 的父目录）
 */
export async function prepareProjectDir(outputDir, projectName, opts = {}) {
  const clean = opts.clean !== false;
  const projectDir = projectDirOf(outputDir, projectName);

  /*
   * 没给输入图名时维持旧结构：产物直接落在工程目录下。
   *
   * 这条路上不做迁移——调用方明说「按旧规矩来」，我们却偷偷把目录重排一遍，
   * 它会拿着算好的路径去读文件然后找不到。真正走这条路的只有还没升级的调用方，
   * 而生成入口永远带 sourceName。
   */
  if (!opts.sourceName) {
    let removed = 0;
    if (clean) removed = await cleanProjectDir(projectDir);
    const imagesDir = join(projectDir, 'images');
    await mkdir(imagesDir, { recursive: true });
    return { projectDir, sourceDir: projectDir, imagesDir, removed, migrated: null };
  }

  /*
   * 生成落在 _temp 目录，不碰导出目录。
   *
   * 导出目录（<输入图名>/）现在只由「导出」按钮创建和清理。生成阶段动它是
   * 错的：用户可能已经把上一次的导出结果拖进引擎了，重新生成一次就把它清空，
   * 引擎那边的引用当场就断。
   */
  const sourceDir = tempDirOf(outputDir, projectName, opts.sourceName);

  /*
   * 先清理，再收旧产物。
   *
   * 顺序不能反：cleanSourceDir 清的是目标目录里的旧产物，而迁移正是往那儿放。
   * 先清的语义也更对——「这是新一次的产物目录」，旧东西收进来只是为了让它们
   * 有个说得清的位置，不该被当成这一次的产出留在原地。反过来先搬再清，
   * 搬进来的旧文件会被立刻删掉，白搬一趟。
   */
  let removed = 0;
  if (clean) removed = await cleanSourceDir(sourceDir);

  const migrated = await migrateLegacyLayout(projectDir, opts.sourceName);

  const imagesDir = imagesDirOf(outputDir, projectName, opts.sourceName);
  await mkdir(imagesDir, { recursive: true });

  return { projectDir, sourceDir, imagesDir, removed, migrated };
}

/**
 * 准备导出目录：先整个清掉，再建空的（用户明确要的「清除再创建」）。
 *
 * 和生成那边的 cleanSourceDir 不同，这里是 rm -rf 整个目录而不是「只删我们
 * 认得的扩展名」。理由：导出目录从定义上就是**我们独占**的交付物目录，每次
 * 导出都应该是一份干净的、可以直接拖进引擎的东西。留下上一次的残留才危险——
 * 部件改名之后旧的 PNG 还躺在 images/ 里，图集不再引用它，美术却会以为它还有用。
 *
 * 生成的 _temp 目录不受影响，所以清错了也能重新导一次，不会丢中间产物。
 *
 * 调用方传的必须是**目标格式自己那一层**（targetDirOf 的结果），不能是
 * <输入图名>/ 那一层：那一层里还并排放着 Spine工程/ 和别的导出目标，
 * 整个清掉会连带把 Unity 那份和 .spine 源工程一起删了。
 *
 * @returns {Promise<{sourceDir: string, cleared: boolean}>}
 */
export async function prepareExportDir(sourceDir) {
  let cleared = false;
  try {
    await stat(sourceDir);
    await rm(sourceDir, { recursive: true, force: true });
    cleared = true;
  } catch (err) {
    // 不存在就是首次导出，没什么要清的
    if (err.code !== 'ENOENT') throw err;
  }

  await mkdir(sourceDir, { recursive: true });
  return { sourceDir, cleared };
}

/**
 * 工程目录的唯一算法来源。
 *
 * 生成、导出、在文件管理器里打开——几处都要指到同一个目录。
 * 各自拼一遍 resolve + safeName，迟早会有一处漏掉规范化，
 * 于是「打开输出目录」开到一个空目录，而产物躺在旁边那个。
 */
export function projectDirOf(outputDir, projectName) {
  return join(resolve(outputDir || './output'), safeName(projectName));
}

/**
 * 导出目录：点「导出」时才创建，放目标格式的交付物。
 *
 * 两层名字都过 safeName：sourceName 是文件名去掉扩展名来的，同样来自前端，
 * 写成 "../../etc" 就能让清理和写入跑到工程目录之外。
 */
export function sourceDirOf(outputDir, projectName, sourceName) {
  return join(projectDirOf(outputDir, projectName), safeName(sourceName));
}

/**
 * 某个导出目标自己的交付目录：<输入图名>/<目标 id>/。
 *
 * 一个输入图可以分别导给 Cocos 和 Unity，两边的骨架版本、图集版本都不同
 * （3.8 的 skins 是对象、旋转写 angle；4.x 是数组、写 value），
 * 混在一个目录里必然互相覆盖。按目标各占一层，重导 Cocos 不动 Unity 那份。
 */
export function targetDirOf(outputDir, projectName, sourceName, targetId) {
  return join(sourceDirOf(outputDir, projectName, sourceName), safeName(targetId));
}

/**
 * Spine 编辑器工程（.spine）的落点：<输入图名>/Spine工程/<输入图名>.spine。
 *
 * 单独一层而不是和目标格式并排，是因为它的地位不同：
 * 目标格式那几份是**交付给引擎/编辑器**的成品，.spine 是**源工程**——
 * 用户拿它在 Spine 里开一次、手工调网格或加动画、再导出一次。
 * 用户明确要的就是这个文件。
 */
export function spineProjectDirOf(outputDir, projectName, sourceName) {
  return join(sourceDirOf(outputDir, projectName, sourceName), SPINE_PROJECT_DIR);
}

/** 源工程目录名。中文，因为用户在 Finder 里直接点进去找的是这个词 */
export const SPINE_PROJECT_DIR = 'Spine工程';

/**
 * 生成中间产物目录（<输入图名>_temp）。
 *
 * 后缀拼在 safeName **之后**：safeName 会把 ".." 和分隔符换成下划线，
 * 先拼后过会让 "_temp" 参与规范化，两边算出来的名字就可能不一致。
 */
export function tempDirOf(outputDir, projectName, sourceName) {
  return join(projectDirOf(outputDir, projectName), safeName(sourceName) + TEMP_SUFFIX);
}

/**
 * 切图、补图的落点：<输入图名>_temp/Image/。
 *
 * 生成阶段全程只写这里，导出时再从这儿拷进交付目录。名字用大写 Image
 * 是用户指定的；导出目录里的散图目录仍是小写 images（Spine 那边的惯例，
 * atlas 和 README 都按这个名字引）。
 */
export function imagesDirOf(outputDir, projectName, sourceName) {
  return join(tempDirOf(outputDir, projectName, sourceName), 'Image');
}

/**
 * 从上传的文件名推出输入图名（不含扩展名）。
 *
 * 有它才能把「重新生成同一张图」映射到同一个目录上。取不到就退回工程名——
 * 至少保证每次生成落在同一个地方，而不是散成一堆 source/source-2/source-3。
 */
export function resolveSourceName(originalName, fallback = 'source') {
  const raw = basename(String(originalName || '')).replace(/\.[^.]+$/, '').trim();
  return raw ? safeName(raw) : safeName(fallback);
}

/**
 * 清掉某个输入图目录里上一次的产物。
 *
 * 只递归删 images/、只删本层的产物文件；目录本身留着（马上要往里写）。
 * @returns {Promise<number>} 删除的条目数
 */
export async function cleanSourceDir(sourceDir) {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  let removed = 0;

  for (const entry of entries) {
    const full = join(sourceDir, entry.name);

    if (entry.isDirectory()) {
      // 只清我们自己建的子目录，用户另外放的目录不动
      if (!OWNED_DIRS.includes(entry.name)) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
      continue;
    }

    // 隐藏文件（.DS_Store 之类）留着，不是我们的东西
    if (entry.name.startsWith('.')) continue;

    const lower = entry.name.toLowerCase();
    if (!OWNED_EXT.some((ext) => lower.endsWith(ext))) continue;

    await rm(full, { force: true });
    removed++;
  }

  return removed;
}

/**
 * 清掉工程目录里上一次的产物（旧结构，产物直接躺在工程目录下）。
 *
 * 目录不存在就当清完了——首次生成走的就是这条路。
 * @returns {Promise<number>} 删除的条目数
 */
export async function cleanProjectDir(projectDir) {
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  let removed = 0;

  for (const entry of entries) {
    const full = join(projectDir, entry.name);

    if (entry.isDirectory()) {
      // 只清我们自己建的子目录，用户另外放的目录不动
      if (!OWNED_DIRS.includes(entry.name)) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
      continue;
    }

    // 隐藏文件（.DS_Store 之类）留着，不是我们的东西
    if (entry.name.startsWith('.')) continue;

    const lower = entry.name.toLowerCase();
    if (!OWNED_EXT.some((ext) => lower.endsWith(ext))) continue;

    await rm(full, { force: true });
    removed++;
  }

  return removed;
}

/**
 * 把旧平铺结构收进输入图的中间产物目录。
 *
 *   output/demo/{demo.json, images/}  →  output/demo/demo_temp/{demo.json, images/}
 *
 * 搬进 _temp 而不是导出目录：导出目录每次导出前都会被整个 rm -rf 重建，
 * 旧产物搬进去等于下一次导出就没了——那是实打实的数据丢失，
 * 而这个函数的全部意义就是「不删用户的东西，只是给它换个位置」。
 *
 * 只搬我们自己产出的东西：产物文件和 images/ 散图目录。用户在工程目录里放的
 * 参考图、笔记、源文件一律原地不动——那些本来就不属于某一张输入图，
 * 搬进哪一层都是错的，还容易让人以为丢了。
 *
 * 用 rename 而不是复制：同一分区内是原子操作，几 MB 的产物瞬间完成，
 * 中途失败也不会留下半份。
 *
 * 判断依据是「工程目录这一层还有没有我们的产物文件」，而不是「目录是不是空的」：
 * 用户完全可能在工程目录里放自己的东西，光看有没有子目录会误判成已经迁移过，
 * 于是旧产物永远留在工程根目录上，和新的子目录并存。只要这层还有产物文件，
 * 就是还没搬完（搬完之后这层只会剩用户自己的东西和子目录）。
 *
 * @returns {Promise<string|null>} 迁移后的输入图目录名，没迁移则是 null
 */
export async function migrateLegacyLayout(projectDir, sourceName) {
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }

  /** 表层这些条目是我们要搬的：我们的产物文件 + images/ 散图目录 */
  const mine = entries.filter((e) => {
    if (e.name.startsWith('.')) return false;
    if (e.isDirectory()) return OWNED_DIRS.includes(e.name);
    const lower = e.name.toLowerCase();
    return OWNED_EXT.some((ext) => lower.endsWith(ext));
  });
  if (mine.length === 0) return null;

  // 旧产物没记录源图名，只能退回工程名——和它自己的文件名一致，看得懂
  const target = join(projectDir, safeName(sourceName || basename(projectDir)) + TEMP_SUFFIX);

  try {
    await mkdir(target, { recursive: true });
    for (const entry of mine) {
      const dst = join(target, entry.name);
      // 目标里已经有了就跳过，绝不覆盖（只有用户手动摆过才可能撞上）
      if (await exists(dst)) continue;
      await rename(join(projectDir, entry.name), dst);
    }
    return basename(target);
  } catch {
    // 搬不动就维持原样：这次生成走新目录，旧的留在这儿等人自己处理，
    // 总比删掉强
    return null;
  }
}

/** 路径存在与否，不抛错 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 目录名要能安全地当路径用。
 * 路径分隔符和 .. 必须挡掉——名字是前端传来的，
 * 写成 "../../etc" 就能让清理和写入跑到目标目录之外。
 */
export function safeName(name) {
  const cleaned = String(name || '')
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();

  return cleaned || 'generated';
}

/**
 * 列出目录里的产物，用于生成后回报「这次到底产出了什么」。
 * 之前只报一个路径，用户得自己开 Finder 才知道齐不齐。
 */
export async function listArtifacts(dir) {
  const out = [];

  async function walk(base, prefix = '') {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(base, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }

      try {
        const info = await stat(full);
        out.push({ path: rel, size: info.size });
      } catch {
        /* 刚被删掉之类，跳过 */
      }
    }
  }

  await walk(dir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export { OWNED_EXT, OWNED_DIRS, basename };
