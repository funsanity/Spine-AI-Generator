/**
 * 骨骼生成器
 *
 * 根据 AI 分析的部件结构生成 Spine JSON 骨架。
 * 有父级的部件生成蒙皮网格（mesh + 权重），让关节处的接缝在转动时被拉住。
 */

import { buildSkinnedMesh, shouldSkin, MAX_INFLUENCES } from './mesh.js';

/**
 * 生成 Spine 骨架结构
 *
 * @param {object} analysis - AI 分析结果
 * @param {Array} analysis.parts - 部件列表
 * @param {string} spineVersion - Spine 版本 (4.0, 4.1, 4.2)
 * @param {object} options - { imageSize, density }
 * @returns {object} Spine JSON 格式骨架
 */
export function generateSkeleton(analysis, spineVersion = '4.0', options = {}) {
  const { parts } = analysis;
  const density = options.density ?? 8;

  // 版本映射。
  // 3.8 是给 Cocos Creator 3.8.x 用的：它内置的 Spine 运行时是 3.8，
  // 3.8.6 起才可在功能裁剪面板里切到 4.2。运行时与导出格式必须严格同版本，
  // 否则 JSON 直接加载失败，所以 Cocos 档默认走 3.8。
  const versionMap = {
    '3.8': '3.8.99',
    '4.0': '4.0.64',
    '4.1': '4.1.23',
    '4.2': '4.2.10'
  };

  const fullVersion = versionMap[spineVersion] || versionMap['4.0'];

  // 按层级排序（确保父部件在前）
  const sortedParts = topologicalSort(parts);

  // 整张图的包围盒，用来把像素坐标转成 Spine 坐标（原点居中、Y 向上）
  const bounds = computeBounds(analysis, options.imageSize);
  const originX = bounds.x + bounds.width / 2;
  const originY = bounds.y + bounds.height / 2;

  // 像素坐标（左上原点，Y 向下）→ Spine 坐标（画面中心原点，Y 向上）
  const toSpine = (px, py) => ({ x: px - originX, y: originY - py });

  // 每个部件自身包围盒的四个角（用于推导 attachment 偏移，见下）
  const bboxOf = (part) => {
    const bb = part.bbox;
    if (!bb) return null;
    const left = bb.x;
    const right = bb.x + bb.width;
    // 图片 Y 轴向下，Spine Y 轴向上：左上角在 Spine 里对应 bbox 的下边缘
    const bottom = bb.y + bb.height;
    return { left, right, bottom };
  };

  // 附件表。Spine 的数据结构是 skin → slot → attachment name → attachment 定义
  const attachments = {};

  const skeleton = {
    skeleton: {
      hash: generateHash(),
      spine: fullVersion,
      images: './images',
      audio: null
    },
    bones: [],
    slots: [],
    // Spine 3.8 起 skins 是数组 [{ name, attachments }]。
    // 之前写成对象 { default: {...} }，运行时按 length 遍历，
    // 结果一个附件都读不到——蒙皮网格等于没生效。
    skins: [
      {
        name: 'default',
        attachments
      }
    ],
    animations: {}
  };

  // 记录每个部件旋转中心在 Spine 坐标系里的绝对位置，
  // 子骨骼的 x/y 是相对父骨骼的偏移，所以必须先算绝对坐标再相减。
  const absAnchor = new Map();

  let skinnedCount = 0;

  /*
   * 合成一根 root 骨骼，所有顶层部件都挂在它下面。
   *
   * 为什么非有不可：Spine 编辑器导入时**硬性要求单根**，多一根整份拒收——
   *   [error] Skeleton cannot have multiple root bones: body
   *   ERROR: Unable to import skeleton.
   * 而运行时加载 .json 不校验这条。所以症状只有「.spine 生成不出来」，
   * 三件套看着完全正常，很容易顺着 Spine CLI 去查。
   *
   * 顶层部件本来就会不止一个：角色主体是一个，补洞用的 _base_plate 底板
   * 是另一个，两者谁也不该当谁的父级。所以只能在骨架这一层补一根。
   *
   * 它在原点、不挂槽位，纯变换用。顶层部件的 x/y 是绝对坐标，
   * 相对原点上的父骨骼仍然是同一个数，所以位置一个像素都不动。
   *
   * 名字避让：部件表里真有个叫 root 的部件时改用 root_1，
   * 否则合成骨骼会把它的骨骼顶掉，那个部件的附件就没处挂了。
   */
  const takenNames = new Set(parts.map((p) => p.name));
  let rootBoneName = 'root';
  for (let i = 1; takenNames.has(rootBoneName); i++) rootBoneName = `root_${i}`;
  skeleton.bones.push({ name: rootBoneName, x: 0, y: 0 });

  // 生成骨骼和槽位
  for (const part of sortedParts) {
    const bb = part.bbox ?? { x: 0, y: 0, width: 100, height: 100 };
    const pivot = part.pivot ?? { x: bb.width / 2, y: bb.height / 2 };

    // 旋转中心在像素坐标系里的绝对位置
    const pivotPx = { x: bb.x + pivot.x, y: bb.y + pivot.y };
    const anchor = toSpine(pivotPx.x, pivotPx.y);
    absAnchor.set(part.name, anchor);

    const parentAnchor = part.parent ? absAnchor.get(part.parent) : null;

    const bone = { name: part.name };
    // 顶层部件挂到合成 root 上——见上面那段：无父骨骼多于一根，.spine 导不出来
    bone.parent = part.parent || rootBoneName;

    // 相对父骨骼的偏移（根骨骼即绝对坐标）
    bone.x = parentAnchor ? anchor.x - parentAnchor.x : anchor.x;
    bone.y = parentAnchor ? anchor.y - parentAnchor.y : anchor.y;

    skeleton.bones.push(bone);

    // 添加对应的槽位
    const slotName = `${part.name}_slot`;
    skeleton.slots.push({
      name: slotName,
      bone: part.name,
      attachment: part.name
    });

    // region attachment 的原点在图片中心。
    // 要让图片绕 pivot 旋转，需把图片中心移到相对 pivot 的偏移处。
    const corners = bboxOf(part);
    let regionX = 0;
    let regionY = 0;

    if (corners) {
      // pivot 相对图片中心的偏移（像素，Y 向下）
      const offsetX = pivotPx.x - (corners.left + corners.right) / 2;
      const offsetY = pivotPx.y - (bb.y + corners.bottom) / 2;
      // 图片中心相对骨骼原点的偏移，Y 轴翻转
      regionX = -offsetX;
      regionY = offsetY;
    }

    // 有父级的部件做成蒙皮网格：让接缝两侧共享权重，
    // 转动时被"拉"在一起，而不是硬生生错开。
    // 根部件没有可混合的对象，保持 region 即可。
    const parentPart = part.parent ? parts.find((p) => p.name === part.parent) : null;

    if (shouldSkin(part, parentPart)) {
      const mesh = buildSkinnedMesh(part, parentPart, { density });

      // 部件自身骨骼是 boneIndex 1，父骨骼是 0，这里转成骨骼名
      const boneNames = [part.parent, part.name];
      const weighted = mesh.weights.map((influences) => {
        const names = influences.map((inf) => boneNames[inf.boneIndex]);
        const ws = influences.map((inf) => inf.weight);
        // Spine 要求每条顶点的 bone/weight 数组补 0 到 4 个
        while (names.length < MAX_INFLUENCES) {
          names.push(part.name);
          ws.push(0);
        }
        return { bones: names, weights: ws };
      });

      attachments[slotName] = {
        [part.name]: {
          type: 'mesh',
          name: part.name,
          path: `${part.name}.png`,
          width: bb.width,
          height: bb.height,
          uvs: mesh.uvs.map((v) => +v.toFixed(5)),
          triangles: mesh.triangles,
          hull: mesh.hull,
          vertices: mesh.vertices.map((v) => +v.toFixed(2)),
          // 把顶点从绝对顶点空间搬回骨骼原点
          x: +mesh.offset.x.toFixed(2),
          y: +mesh.offset.y.toFixed(2),
          // Spine 的 mesh 附件按顶点存权重，每个顶点最多 4 条骨骼影响
          bones: weighted.map((w) => w.bones),
          weights: weighted.map((w) => w.weights)
        }
      };

      skinnedCount++;
    } else {
      attachments[slotName] = {
        [part.name]: {
          type: 'region',
          name: part.name,
          path: `${part.name}.png`,
          width: bb.width,
          height: bb.height,
          x: regionX,
          y: regionY
        }
      };
    }
  }

  /*
   * 槽位顺序 = 绘制顺序，必须按 depth 排，不能沿用骨骼的拓扑序。
   *
   * 骨骼要拓扑序（父在子前，否则子骨骼算不出相对偏移），但那个顺序和
   * "谁压在谁上面"无关。沿用它就会出现 depth 小的部件画在 depth 大的
   * 部件之上——实测这张角色图：left_arm / right_arm_scissors 是 depth 1
   * （在 depth 2 的围裙、depth 3 的眼镜后面），却排在它们之后绘制。
   *
   * 后果不是"层级看着怪"，是**默认姿势就画错了**：手臂切图里那些被前方
   * 部件挖掉、再由补图按推断填回来的区域，会盖住围裙和眼镜真正可见的
   * 内容。实测默认姿势下颜色偏差 >40 的像素 23029px，其中 22981px
   * （99.8%）都是 right_arm_scissors 补出来的内容盖在真内容上。
   *
   * 排序用稳定排序 + depth 升序：depth 相同的保持拓扑序（父在子前），
   * 这样同层的父子关系看起来仍然自然。depth 缺失当 0。
   */
  const depthOf = (slot) => {
    const part = sortedParts.find((p) => `${p.name}_slot` === slot.name);
    return typeof part?.depth === 'number' ? part.depth : 0;
  };
  skeleton.slots = skeleton.slots
    .map((slot, i) => ({ slot, i, d: depthOf(slot) }))
    .sort((a, b) => (a.d - b.d) || (a.i - b.i))
    .map((e) => e.slot);

  skeleton.stats = { skinnedParts: skinnedCount, regionParts: sortedParts.length - skinnedCount };

  return skeleton;
}

/**
 * 计算所有部件的外包围盒，缺 bbox 时退回原点。
 */
function computeBounds(analysis, imageSize) {
  if (imageSize?.width && imageSize?.height) {
    return { x: 0, y: 0, width: imageSize.width, height: imageSize.height };
  }

  const boxes = (analysis.parts ?? []).map((p) => p.bbox).filter(Boolean);
  if (!boxes.length) {
    return { x: 0, y: 0, width: 100, height: 100 };
  }

  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 为骨架生成基础动画。
 *
 * 只产出 idle：整体轻微上下浮动 + 各部件错相位的小幅旋转，看起来像呼吸。
 *
 * 之前还会多产一个 wave（部件依次摆动），那是开发期用来肉眼确认父子层级和
 * pivot 的调试动画，不是能上线的东西，而且每根骨骼多一份用不上的关键帧。
 * 已经去掉——美术要别的动作，在 Spine 编辑器里照 idle 的写法加就行。
 *
 * 关键帧写进 Spine JSON 的 animations 字段，前端和 Spine 编辑器都能直接用。
 */
export function generateAnimations(skeleton) {
  const bones = skeleton.bones ?? [];
  if (!bones.length) return skeleton;

  const root = bones.find((b) => !b.parent) ?? bones[0];
  /*
   * 顶层部件（root 的直接子级）不单独给旋转轨道。
   *
   * 它们是角色主体和底板这一类东西，转它们等于把整个角色/整块底板转过去，
   * 拼合式切图的接缝会立刻露出来。整体起伏交给下面 root 的 translate，
   * 真正该摆动的是再往下的子部件。
   */
  const children = bones.filter((b) => b.parent && b.parent !== root.name);

  // 旋转关键帧的键名按版本走：3.8 是 angle，4.0 起改成 value。
  // 用错的话运行时读到 undefined，动画静止不动。
  const spine = skeleton.skeleton?.spine ?? '4.0';
  const rotKey = spine.startsWith('3.') ? 'angle' : 'value';
  const rot = (time, angle) => ({ time: +time.toFixed(3), [rotKey]: +angle.toFixed(3) });

  // 曲线一律不写，走默认线性插值。
  // 之前写的 curve: 'smooth' 不是 Spine 的合法值（只认 'stepped' 或贝塞尔
  // 控制点），运行时解析会出问题。平滑感靠加密关键帧来给，见下面的正弦采样。
  const idle = { bones: {} };

  // translate 是「相对静止姿势的偏移」，不是绝对坐标。
  // 之前写成 root.x / root.y，运行时会把骨骼自身位置再叠一遍，
  // 整个角色按自己的坐标平移出画面——这也是预览里图看着不全的原因之一。
  idle.bones[root.name] = {
    translate: sine(3, 8, (t) => ({ x: 0, y: Math.sin(t * Math.PI * 2) * 3 + 3 }))
  };

  // 子部件按深度错开相位，避免所有部件同步摆动显得僵硬。
  // 幅度压到 1.5° 以内：拼合式的切图一旦旋转，接缝会立刻暴露出来。
  children.forEach((bone, i) => {
    const phase = (i / Math.max(children.length, 1)) * 2;
    const amp = 0.6 + (i % 3) * 0.3;

    const keys = [];
    const steps = 12;
    for (let s = 0; s <= steps; s++) {
      const time = (s / steps) * 3;
      keys.push(rot(time, Math.sin(((time + phase) / 3) * Math.PI * 2) * amp));
    }
    idle.bones[bone.name] = { rotate: keys };
  });

  skeleton.animations = { idle };
  return skeleton;
}

/**
 * 用等间隔采样把一条连续曲线摊成关键帧。
 * Spine 的默认插值是线性，靠密度换平滑，省得跟贝塞尔控制点较劲。
 */
function sine(duration, steps, fn) {
  const keys = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    keys.push({ time: +(t * duration).toFixed(3), ...fn(t) });
  }
  return keys;
}

/**
 * 拓扑排序：确保父部件在子部件之前
 */
function topologicalSort(parts) {
  const sorted = [];
  const visited = new Set();

  function visit(part) {
    if (visited.has(part.name)) return;
    visited.add(part.name);

    // 先访问父部件
    if (part.parent) {
      const parent = parts.find(p => p.name === part.parent);
      if (parent) visit(parent);
    }

    sorted.push(part);
  }

  for (const part of parts) {
    visit(part);
  }

  return sorted;
}

/**
 * 生成随机 hash
 */
function generateHash() {
  return Math.random().toString(36).substring(2, 15);
}


/**
 * 导出成目标运行时能直接加载的工程。
 *
 * 产出「.json + .atlas + .png」三件套，而不是一堆散图：
 * Cocos / Unity 的 Spine 组件是按 atlas 找区域的，只给散图会直接报缺 atlas。
 *
 * 骨架 JSON 走 buildExportSkeleton 转成规范形状——预览用的结构里
 * 权重存在 bones/weights 两个平行数组，而规范要求把骨骼索引、
 * 骨骼空间坐标、权重全编码进 vertices。形状不对的话运行时会把它
 * 当成无权重网格，蒙皮静默失效。
 *
 * 目录分三层，各管一件事：
 *   <输入图名>/Spine工程/      .spine 源工程，拿进 Spine 编辑器做二次编辑
 *   <输入图名>/<目标 id>/      三件套，给引擎/编辑器直接加载
 * 每个目标各占一层，是因为 3.8 与 4.x 的骨架、图集格式互不兼容
 * （skins 形状、旋转关键帧字段名、atlas 字段顺序全不同），
 * 平铺在一个目录里只会互相覆盖。重导 Cocos 时 Unity 那份原封不动。
 *
 * 根目录由调用方给全（而不是这里再拼一遍 工程名/输入图名）：
 * 目录算法只有 workspace.js 一份，两边各拼一次迟早会漂到两个地方去。
 *
 * @param {object} skeleton - 预览用骨架
 * @param {string} sourceDir - 本次产物的落点，通常 output/<工程名>/<输入图名>/
 * @param {string} name - 三件套的文件名（不含扩展名），通常就是输入图名
 * @param {object} opts - { target, cutResults, outputDir, projectName, spineCliPath }
 */
export async function exportToSpine(skeleton, sourceDir, name = 'generated', opts = {}) {
  const { mkdir, writeFile, copyFile } = await import('fs/promises');
  const { join, basename, dirname } = await import('path');
  const { buildExportSkeleton, resolveTarget } = await import('./targets.js');
  const { packAtlas } = await import('./atlas.js');
  const { buildSpineProject } = await import('./spine-project.js');
  const { SPINE_PROJECT_DIR } = await import('./workspace.js');

  const target = resolveTarget(opts.target);
  const cutResults = opts.cutResults ?? [];

  /*
   * 交付目录：<输入图名>/<目标 id>/<输入图名>/
   *
   * 最里层再套一层同名目录，是用户在需求里画的结构——引擎那边按
   * 「一个文件夹 = 一套资源」导入，文件夹名就是资源名，外面那层
   * 目标名（cocos-3.8 / unity）只是我们这边用来分类的。
   */
  const projectDir = join(sourceDir, target.id, name);
  const imagesDir = join(projectDir, 'images');
  await mkdir(imagesDir, { recursive: true });

  const { json, stats } = buildExportSkeleton(skeleton, target.id);

  const skeletonPath = join(projectDir, `${name}.json`);
  await writeFile(skeletonPath, JSON.stringify(json, null, 2), 'utf-8');

  // 图集：区域名 = 部件名 = 附件 path，三者对齐运行时才找得到图
  let atlas = null;
  if (cutResults.length) {
    try {
      atlas = await packAtlas(cutResults, projectDir, {
        name,
        spineVersion: target.atlasVersion
      });
    } catch (err) {
      console.warn(`[导出] 图集打包失败：${err.message}`);
    }

    // 散图一并留一份，方便回 Spine 编辑器里重新编辑网格
    for (const cut of cutResults) {
      if (!cut.path) continue;
      try {
        await copyFile(cut.path, join(imagesDir, basename(cut.path)));
      } catch {
        /* 源图已被清理时跳过，不影响图集 */
      }
    }
  }

  /*
   * Spine 源工程。
   *
   * 拿交付目录里那份骨架 JSON 去导入——不是另造一份，这样 .spine 里装的
   * 正好就是本次导出的结果（同一批网格、同一套权重）。
   *
   * images 路径由调用方算好传进来（它知道 _temp 在哪）：.spine 落在
   * <输入图名>/Spine工程/，切图在 <输入图名>_temp/Image/，两处隔着一层。
   * 路径写错的后果是"打开工程满屏找不到图"，骨架结构还在，
   * 在编辑器里改一下资源路径就能救回来，不算致命。
   */
  const spineDir = join(sourceDir, SPINE_PROJECT_DIR);
  await mkdir(spineDir, { recursive: true });
  const spinePath = join(spineDir, `${name}.spine`);

  const projJson = {
    ...json,
    skeleton: { ...json.skeleton, images: opts.spineImagesPath ?? './images/', audio: '' }
  };
  const projJsonPath = join(spineDir, `${name}.project.json`);
  await writeFile(projJsonPath, JSON.stringify(projJson, null, 2), 'utf-8');

  let spineProject = null;
  try {
    spineProject = await buildSpineProject({
      jsonPath: projJsonPath,
      outPath: spinePath,
      name,
      cliPath: opts.spineCliPath
    });
  } catch (err) {
    spineProject = { ok: false, reason: err.message };
  } finally {
    /*
     * 中间那份 project.json 用完就删。
     *
     * 它和交付目录里的 <名>.json 内容几乎一样，留着只会有两种下场：
     * 美术分不清哪份是给引擎的，或者以为它是要一起拷贝的东西。
     * 它是给 Spine CLI 当输入用的，使命已经完成。
     */
    try {
      const { rm } = await import('fs/promises');
      await rm(projJsonPath, { force: true });
    } catch { /* 删不掉也不影响交付 */ }
  }

  await writeFile(join(projectDir, 'README.txt'), readmeFor({
    name, target, stats, atlas, count: cutResults.length, spineProject
  }), 'utf-8');

  return {
    skeletonPath,
    name,
    projectDir,
    parentDir: dirname(projectDir),
    /*
     * 本次导出的根：<输入图名>/。
     *
     * 产物清单要从这一层列，Spine工程/ 和各目标目录才会一起出现——
     * 用户点完导出最想确认的就是"那个 .spine 到底有没有"。
     * 用 parentDir 列只能看到目标目录里的三件套，正好把 .spine 漏掉。
     */
    exportRoot: sourceDir,
    imagesDir,
    target: { id: target.id, label: target.label, spine: target.spineHeader },
    spineProject: spineProject?.ok
      ? { path: spinePath }
      : { path: null, reason: spineProject?.reason ?? '未生成' },
    atlas: atlas && {
      atlasPath: atlas.atlasPath,
      pagePath: atlas.pagePath,
      page: atlas.page,
      regions: atlas.regions.length
    },
    stats,
    message: `已导出 ${target.label} 工程：${projectDir}`
  };
}

/** 导出说明。写清楚放哪、怎么拖，省得美术再问一遍 */
function readmeFor({ name, target, stats, atlas, count, spineProject }) {
  const files = [
    `- ${name}.json   骨架（${target.label} / spine ${target.spineHeader}）`,
    atlas ? `- ${name}.atlas  图集描述（${atlas.regions.length} 个区域）` : null,
    atlas ? `- ${name}.png    图集页 ${atlas.page.width}x${atlas.page.height}` : null,
    `- images/            ${count} 张散图（回编辑器改网格时用）`
  ].filter(Boolean).join('\n');

  return `Spine 工程: ${name}
导出目标: ${target.label}
骨架版本: ${target.spineHeader}
网格: ${stats.meshCount} 个（其中加权 ${stats.weightedCount} 个）
生成时间: ${new Date().toLocaleString('zh-CN')}

文件:
${files}

二次编辑:
${spineProject?.ok
    ? `- 上一层的 Spine工程/${name}.spine 是可直接用 Spine 打开的源工程，\n  改完网格/动画后从编辑器里重新导出，就能覆盖本目录的数据`
    : `- 本次没有生成 .spine 源工程（${spineProject?.reason ?? '未知原因'}）。\n  需要手工调整的话，可以在 Spine 里新建工程再导入本目录的 ${name}.json`}

${target.note}
`;
}
