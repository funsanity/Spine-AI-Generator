/**
 * 往返闭环（round-trip）。
 *
 * 这是 P0 要验证的核心命题：
 *   对骨架做一次程序化修改，经过 Spine 编辑器导出后，
 *   差异是否**恰好等于**我们主动做的那一次修改。
 *
 * 为什么这个命题值得单独验证：
 *   Spine 没有编辑 SDK，唯一的程序化入口是"改导出数据 + 回导"。
 *   这条路的失败模式很隐蔽——回导可能静默丢字段、可能因为版本不匹配
 *   而部分生效、可能把没改的地方也一起改掉。不建立闭环验证，
 *   后面所有功能都是建在流沙上。
 *
 * 闭环的四个阶段：
 *   base      以 .spine 工程为准，CLI 导出 → base.json
 *   transform 对 base.json 施加变换 → transformed.json（+ 预期差异）
 *   rebuild   把 transformed.json 回导成工程 → CLI 再导出 → rebuilt.json
 *   compare   diff(base, rebuilt) 必须等于预期差异
 *
 * 第三阶段是唯一需要写回 Spine 的步骤，也是最脆弱的
 * （部分版本会拉起 GUI）。因此默认不执行，需要显式开启。
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseAtlas, listAtlasParts } from '../atlas/parseAtlas.js';
import { loadSkeleton } from './loadSkeleton.js';
import { validateSkeleton } from './validate.js';
import { diffSkeleton, formatDiff, matchesExpected } from './diff.js';
import { exportProject, importJson } from '../cli/spineCli.js';
import { TRANSFORMS } from './transforms.js';
import { findExportedJson } from '../util/findExport.js';

/**
 * @param {object} opts
 * @param {string} opts.projectPath   .spine 工程文件
 * @param {string} opts.workDir       往返过程中的中间产物目录
 * @param {string} opts.cliPath       Spine 可执行文件
 * @param {string} opts.spineVersion  如 '4.2'
 * @param {Array}  opts.transforms    [{ name, args: {...} }] 要施加的变换
 * @param {boolean} opts.execute      false 时只做 dry-run，不调用 Spine
 * @param {boolean} opts.allowImport  是否允许回导（会写回 Spine）
 */
export async function runRoundtrip(opts) {
  const {
    projectPath,
    workDir,
    cliPath,
    spineVersion,
    transforms = [],
    execute = false,
    allowImport = false,
  } = opts;

  const stages = [];
  const record = (name, status, detail) => {
    stages.push({ name, status, detail });
    return { name, status, detail };
  };

  await mkdir(workDir, { recursive: true });

  const baseJson = join(workDir, 'base.json');
  const transformedJson = join(workDir, 'transformed.json');
  const rebuiltJson = join(workDir, 'rebuilt.json');
  const rebuiltProject = join(workDir, 'rebuilt.spine');

  // --- 阶段 1: base ---
  if (execute) {
    const res = await exportProject({
      cliPath,
      spineVersion,
      projectPath: resolve(projectPath),
      outDir: workDir,
      preset: 'json',
    });
    if (!res.ok) {
      record('base', 'failed', `导出失败: ${res.stderr || res.stdout || res.code}`);
      return { ok: false, stages, reason: 'Spine 导出 base 失败' };
    }
  } else {
    record('base', 'skipped', `dry-run：将执行 Spine 导出 ${projectPath} → ${workDir}`);
    return {
      ok: true,
      dryRun: true,
      stages,
      plan: buildPlan({ projectPath, workDir, transforms, allowImport }),
    };
  }

  // Spine 的导出文件名由工程内部名字决定，不是我们指定的，
  // 所以导出后要按内容找回来——不能假设它叫 base.json。
  const exportedBase = await findExportedJson(workDir);
  if (!exportedBase) {
    record('base', 'failed', `Spine 报告导出成功，但 ${workDir} 里找不到骨架 JSON`);
    return { ok: false, stages };
  }
  record('base', 'ok', exportedBase);

  // --- 阶段 2: transform ---
  const baseDoc = await loadSkeleton(exportedBase);
  const baseValidation = validateSkeleton(baseDoc);
  if (!baseValidation.ok) {
    record('transform', 'failed', `基线骨架本身不合法，有 ${baseValidation.errors.length} 个错误`);
    return { ok: false, stages, validation: baseValidation };
  }

  let current = baseDoc;
  const applied = [];
  for (const t of transforms) {
    const spec = TRANSFORMS[t.name];
    if (!spec) {
      record('transform', 'failed', `未知变换: ${t.name}`);
      return { ok: false, stages, applied };
    }
    const result = spec.fn(current, ...Object.values(t.args ?? {}));
    current = result.doc;
    applied.push({ transform: t.name, args: t.args, risk: spec.risk, detail: summarize(result) });
  }

  const transformedValidation = validateSkeleton(current);
  await writeFile(transformedJson, JSON.stringify(current._raw, null, 2), 'utf-8');

  if (!transformedValidation.ok) {
    record('transform', 'failed', `变换后骨架不合法：${transformedValidation.errors[0].message}`);
    return { ok: false, stages, applied, validation: transformedValidation };
  }
  record('transform', 'ok', `已施加 ${applied.length} 个变换 → ${transformedJson}`);

  // 预期差异 = 变换前 vs 变换后。这就是闭环要复现的目标。
  const expectedDiff = diffSkeleton(baseDoc, current);

  // --- 阶段 3: rebuild（需要写回 Spine）---
  if (!allowImport) {
    record(
      'rebuild',
      'skipped',
      '回导需要写回 Spine 工程，默认不执行。加 --allow-import 开启。',
    );
    return {
      ok: true,
      stages,
      applied,
      expectedDiff,
      transformedJson,
      needsImport: true,
      note: '未完成闭环验证——只确认了"变换在数据层成立"，未确认"Spine 能接受这次变换"。',
    };
  }

  const importRes = await importJson({
    cliPath,
    spineVersion,
    jsonPath: transformedJson,
    projectPath: rebuiltProject,
  });
  if (!importRes.ok) {
    record('rebuild', 'failed', `回导失败: ${importRes.stderr || importRes.stdout || importRes.code}`);
    if (importRes.timedOut) {
      record(
        'rebuild',
        'hint',
        '进程超时，很可能是 Spine 弹出了 GUI 模态框等待人工确认——请改用 GUI 手工导入一次，并保留 .spine 作为真源',
      );
    }
    return { ok: false, stages, applied, expectedDiff };
  }

  const reexportDir = join(workDir, 'rebuilt');
  const reexportRes = await exportProject({
    cliPath,
    spineVersion,
    projectPath: rebuiltProject,
    outDir: reexportDir,
    preset: 'json',
  });
  if (!reexportRes.ok) {
    record('rebuild', 'failed', `重建后导出失败: ${reexportRes.stderr || reexportRes.code}`);
    return { ok: false, stages, applied, expectedDiff };
  }
  const exportedRebuilt = await findExportedJson(reexportDir);
  if (!exportedRebuilt) {
    record('rebuild', 'failed', `重建后导出目录 ${reexportDir} 里找不到骨架 JSON`);
    return { ok: false, stages, applied, expectedDiff };
  }
  record('rebuild', 'ok', exportedRebuilt);

  // --- 阶段 4: compare ---
  const rebuiltDoc = await loadSkeleton(exportedRebuilt);
  const actualDiff = diffSkeleton(baseDoc, rebuiltDoc);
  const check = matchesExpected(actualDiff, {
    addedBones: expectedDiff.bones.added,
    removedBones: expectedDiff.bones.removed,
    addedSlots: expectedDiff.slots.added,
    removedSlots: expectedDiff.slots.removed,
    addedAnimations: expectedDiff.animations.added,
    removedAnimations: expectedDiff.animations.removed,
  });

  const extra = diffSkeleton(current, rebuiltDoc);
  const lossless = extra.isEmpty;

  if (check.ok && lossless) {
    record('compare', 'ok', '闭环成立：重建结果与预期完全一致，无额外丢失');
  } else {
    record(
      'compare',
      'failed',
      check.ok
        ? `闭环有数据丢失：${formatDiff(extra)}`
        : `闭环差异不符预期: ${check.problems.join('; ')}`,
    );
  }

  return {
    ok: check.ok && lossless,
    stages,
    applied,
    expectedDiff,
    actualDiff,
    lossFromTransform: extra,
    // 两份产物都留档，便于人工核对
    artifacts: {
      baseJson: exportedBase,
      transformedJson,
      rebuiltJson: exportedRebuilt,
      rebuiltProject,
    },
  };
}

function buildPlan({ projectPath, workDir, transforms, allowImport }) {
  return [
    `1. 导出 ${projectPath} → ${workDir}/base.json`,
    `2. 施加变换: ${transforms.map((t) => t.name).join(', ') || '(无)'}`,
    allowImport
      ? `3. 回导 → rebuilt.spine → 再导出 → rebuilt.json`
      : `3. (跳过) 未开启 --allow-import，闭环不完整`,
    `4. diff base vs rebuilt，验证差异等于预期`,
  ];
}

function summarize(result) {
  if (result.kind === 'bone') return `${result.from} → ${result.to}`;
  if (result.kind === 'slot') return `${result.from} → ${result.to}`;
  if (result.kind === 'bone-prefix') return `${result.renamed.length} 根骨骼加前缀 ${result.prefix}`;
  if (result.kind === 'bone-delete') return `删除 ${result.name}，连带槽位 ${result.removedSlots.join(', ') || '无'}`;
  return JSON.stringify(result);
}

/**
 * 不依赖 Spine 的纯数据层验证。
 * 用途：装了没装 Spine 都能跑，是 CI 里的默认测试形态。
 */
export async function validateFiles({ skeletonPath, atlasPath }) {
  const doc = await loadSkeleton(skeletonPath);
  let atlasParts = null;

  if (atlasPath) {
    const text = await readFile(atlasPath, 'utf-8');
    atlasParts = listAtlasParts(parseAtlas(text));
  }

  const result = validateSkeleton(doc, { atlasParts });
  return { doc, validation: result, atlasParts };
}
