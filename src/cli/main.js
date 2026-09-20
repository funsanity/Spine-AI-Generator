/**
 * spine-tool 命令行入口。
 *
 * P0 阶段只暴露四个子命令，覆盖闭环的最小链路：
 *   doctor     环境自检（Spine 装没装、版本对不对）
 *   inspect    看懂一份骨架/图集里有什么（拆件前必须先看清）
 *   validate   校验引用完整性
 *   roundtrip  往返闭环验证
 *
 * 刻意不用参数解析库：子命令少、参数简单，手写解析反而更容易
 * 控制错误信息——这个工具的使用者主要是自己，报错要直接可执行。
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { loadSkeleton } from '../spine/loadSkeleton.js';
import { validateSkeleton } from '../spine/validate.js';
import { parseAtlas, listAtlasParts } from '../atlas/parseAtlas.js';
import { runRoundtrip } from '../spine/roundtrip.js';
import { findSpineCli, probeSpineVersion, SpineNotFoundError } from './spineCli.js';

const COMMANDS = {
  doctor: cmdDoctor,
  inspect: cmdInspect,
  validate: cmdValidate,
  roundtrip: cmdRoundtrip,
};

export async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`未知子命令: ${command}\n\n`);
    printUsage();
    return 2;
  }

  try {
    return await handler(rest);
  } catch (err) {
    if (err instanceof SpineNotFoundError) {
      process.stderr.write(`\n${err.message}\n`);
      return 3;
    }
    process.stderr.write(`\n错误: ${err.message}\n`);
    if (process.env.SPINE_TOOL_DEBUG) process.stderr.write(`${err.stack}\n`);
    return 1;
  }
}

function printUsage() {
  process.stdout.write(
    `spine-tool — Spine 部件自动化工具 (P0)

用法: spine-tool <子命令> [选项]

子命令:
  doctor                         环境自检
  inspect <文件>                 查看骨架或图集内容
  validate <骨架文件>            校验引用完整性
  roundtrip --project <工程>     往返闭环验证

inspect 选项:
  --atlas <路径>                 同时解析图集，列出部件清单
  --json                         以 JSON 输出（便于后续处理）

validate 选项:
  --atlas <路径>                 用图集交叉校验附件区域

roundtrip 选项:
  --project <路径>               .spine 工程文件（必填）
  --work <目录>                  中间产物目录，默认 ./roundtrip-out
  --transform <规格>             要施加的变换，可重复。
                                 格式: 名字,键=值,键=值
                                 可用: rename-bone, rename-slot,
                                       prefix-bones, delete-bone
  --execute                      真正调用 Spine（默认只打印计划）
  --allow-import                 允许回导写回 Spine（默认关闭）

环境变量:
  SPINE_CLI_PATH                 Spine 可执行文件路径
  SPINE_TOOL_DEBUG=1             出错时打印堆栈

示例:
  spine-tool doctor
  spine-tool inspect assets/Wand/WandItem.skel.bytes --atlas assets/Wand/Wand.atlas.txt
  spine-tool roundtrip --project Hero.spine --transform rename-bone,from=root,to=Root --execute
`,
  );
}

// --- doctor ---

async function cmdDoctor() {
  const lines = [];
  let exitCode = 0;

  lines.push('环境自检');
  lines.push('='.repeat(50));
  lines.push(`Node       ${process.version}`);
  lines.push(`平台       ${process.platform} ${process.arch}`);
  lines.push('');

  // Spine 是唯一的硬依赖，装没装决定后续所有能力
  try {
    const cliPath = await findSpineCli();
    lines.push(`Spine      已找到: ${cliPath}`);
    const version = await probeSpineVersion(cliPath);
    if (version) {
      lines.push(`Spine 版本 ${version}`);
      const major = Number.parseInt(version.split('.')[0], 10);
      if (major < 4) {
        lines.push('');
        lines.push('  ⚠ 检测到 Spine 3.x。本工具的往返闭环按 4.x 设计，');
        lines.push('    3.x 的 CLI 导入路径不兼容，建议升级到 4.2.x。');
        exitCode = 4;
      }
    } else {
      lines.push('Spine 版本 无法探测（不影响导出，但请自行确认是 4.2.x）');
    }
  } catch (err) {
    if (err instanceof SpineNotFoundError) {
      lines.push('Spine      未安装');
      lines.push('');
      for (const line of err.message.split('\n')) lines.push(`  ${line}`);
      lines.push('');
      lines.push('  当前可用能力（不依赖 Spine）:');
      lines.push('    - inspect  解析骨架与图集');
      lines.push('    - validate 引用完整性校验');
      lines.push('  不可用能力:');
      lines.push('    - roundtrip 的 execute / import 阶段');
      exitCode = 3;
    } else {
      throw err;
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
  return exitCode;
}

// --- inspect ---

async function cmdInspect(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      atlas: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const target = positionals[0];
  if (!target) throw new Error('缺少文件参数。用法: spine-tool inspect <文件>');

  // 图集不是骨架，不能丢给 loadSkeleton——它会在二进制解析器里
  // 报"版本字符串无法解析"，把人引到完全错误的方向上。
  if (isAtlasPath(target)) {
    return inspectAtlas(target, values.json);
  }

  const doc = await loadSkeleton(target);

  let atlasParts = null;
  if (values.atlas) {
    const text = await readFile(values.atlas, 'utf-8');
    atlasParts = listAtlasParts(parseAtlas(text));
  }

  if (values.json) {
    process.stdout.write(
      JSON.stringify({ doc: stripRaw(doc), atlasParts }, null, 2) + '\n',
    );
    return 0;
  }

  const out = [];
  out.push(`文件       ${target}`);
  out.push(`格式       ${doc.format}`);
  out.push(`版本       ${doc.version ?? '(未知)'}`);
  if (doc.partial) out.push(`⚠ 结构解析未完成: ${doc.partialReason}`);
  out.push(`尺寸       ${doc.width} x ${doc.height}`);
  out.push(`FPS        ${doc.fps}`);
  out.push('');

  out.push(`骨骼 (${doc.bones.length})`);
  for (const b of doc.bones) {
    const parent = b.parent ? ` ← ${b.parent}` : ' (根)';
    out.push(`  ${b.name}${parent}`);
  }
  out.push('');

  out.push(`槽位 (${doc.slots.length})`);
  for (const s of doc.slots) {
    const att = s.attachment ? ` [${s.attachment}]` : '';
    out.push(`  ${s.name} → ${s.bone}${att}`);
  }
  out.push('');

  if (doc.skins.length) {
    out.push(`皮肤 (${doc.skins.length})`);
    for (const s of doc.skins) out.push(`  ${s.name} (${s.attachments} 个附件)`);
    out.push('');
  }

  if (doc.animations.length) {
    out.push(`动画 (${doc.animations.length})`);
    for (const a of doc.animations) {
      const bits = [];
      if (a.bones.length) bits.push(`${a.bones.length} 骨骼轨`);
      if (a.slots.length) bits.push(`${a.slots.length} 槽位轨`);
      if (a.hasDeform) bits.push('形变');
      if (a.hasEvents) bits.push(`${a.hasEvents} 事件`);
      out.push(`  ${a.name}  ${a.duration.toFixed(2)}s  ${bits.join(', ')}`);
    }
    out.push('');
  }

  if (atlasParts) {
    out.push(`图集部件 (${atlasParts.length})`);
    const byPage = new Map();
    for (const p of atlasParts) {
      if (!byPage.has(p.page)) byPage.set(p.page, []);
      byPage.get(p.page).push(p);
    }
    for (const [page, parts] of byPage) {
      out.push(`  ${page}`);
      for (const p of parts) {
        const bounds = p.bounds ? `${p.bounds.w}x${p.bounds.h}` : '(无 bounds)';
        const rot = p.rotate ? ' [旋转]' : '';
        out.push(`    ${p.name}  ${bounds}${rot}`);
      }
    }
  }

  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

/**
 * 图集文件判定。
 * Spine 导出的图集后缀是 .atlas 或 .atlas.txt，两者都要认。
 */
function isAtlasPath(p) {
  return /\.atlas(\.txt)?$/i.test(p);
}

/** inspect 的图集分支：骨架那套字段（骨骼/槽位/动画）对图集没有意义 */
async function inspectAtlas(target, asJson) {
  const atlas = parseAtlas(await readFile(target, 'utf-8'));

  if (asJson) {
    process.stdout.write(JSON.stringify(atlas, null, 2) + '\n');
    return 0;
  }

  const parts = listAtlasParts(atlas);
  const out = [];
  out.push(`文件       ${target}`);
  out.push(`格式       atlas`);
  out.push(`分页       ${atlas.pages.length}`);
  out.push(`部件       ${parts.length}`);
  out.push('');

  for (const page of atlas.pages) {
    const size = page.params.size ? `${page.params.size.w} x ${page.params.size.h}` : '(未声明尺寸)';
    out.push(`${page.name}  ${size}`);
    const extras = [];
    if (page.params.filter) extras.push(`filter:${page.params.filter.join(',')}`);
    if (page.params.pma !== undefined) extras.push(`pma:${page.params.pma}`);
    if (page.params.scale !== undefined) extras.push(`scale:${page.params.scale}`);
    if (extras.length) out.push(`  ${extras.join('  ')}`);

    for (const region of page.regions) {
      const b = region.params.bounds;
      const bounds = b ? `${b.w}x${b.h} @ ${b.x},${b.y}` : '(无 bounds)';
      const rot = region.params.rotate ? ' [旋转]' : '';
      const idx = region.index !== null ? ` #${region.index}` : '';
      out.push(`  ${region.name}${idx}  ${bounds}${rot}`);
    }
    out.push('');
  }

  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

// --- validate ---

async function cmdValidate(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { atlas: { type: 'string' } },
    allowPositionals: true,
  });

  const target = positionals[0];
  if (!target) throw new Error('缺少文件参数。用法: spine-tool validate <骨架文件>');

  const doc = await loadSkeleton(target);
  let atlasParts = null;
  if (values.atlas) {
    atlasParts = listAtlasParts(parseAtlas(await readFile(values.atlas, 'utf-8')));
  }

  const result = validateSkeleton(doc, { atlasParts });

  const out = [];
  out.push(`校验 ${target}  (${basename(target)})`);
  out.push('');

  if (result.errors.length) {
    out.push(`错误 ${result.errors.length}`);
    for (const e of result.errors) out.push(`  ✗ [${e.code}] ${e.message}`);
    out.push('');
  }
  if (result.warnings.length) {
    out.push(`警告 ${result.warnings.length}`);
    for (const w of result.warnings) out.push(`  ! [${w.code}] ${w.message}`);
    out.push('');
  }

  out.push(result.ok ? '通过' : '未通过');
  process.stdout.write(out.join('\n') + '\n');
  return result.ok ? 0 : 1;
}

// --- roundtrip ---

async function cmdRoundtrip(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      work: { type: 'string', default: 'roundtrip-out' },
      transform: { type: 'string', multiple: true, default: [] },
      execute: { type: 'boolean', default: false },
      'allow-import': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (!values.project) {
    throw new Error('缺少 --project。用法: spine-tool roundtrip --project <工程文件>');
  }

  const transforms = values.transform.map(parseTransformSpec);

  // 未指定 --execute 时不碰 Spine，只打印计划。
  // 这是刻意的：往返会写磁盘，误触代价高。
  const cliPath = values.execute || values['allow-import'] ? await findSpineCli() : null;
  const spineVersion = cliPath ? (await probeSpineVersion(cliPath))?.split('.').slice(0, 2).join('.') : null;

  const result = await runRoundtrip({
    projectPath: resolve(values.project),
    workDir: resolve(values.work),
    cliPath,
    spineVersion,
    transforms,
    execute: values.execute,
    allowImport: values['allow-import'],
  });

  const out = [];
  out.push(`往返闭环 ${values.project}`);
  out.push('='.repeat(50));

  for (const s of result.stages) {
    const mark = { ok: '✓', failed: '✗', skipped: '−', hint: '!' }[s.status] ?? '?';
    out.push(`  ${mark} ${s.name.padEnd(10)} ${s.detail ?? ''}`);
  }
  out.push('');

  if (result.dryRun) {
    out.push('计划:');
    for (const line of result.plan) out.push(`  ${line}`);
    out.push('');
    out.push('这是 dry-run。加 --execute 才会真正调用 Spine。');
    // 这里必须自己输出再返回：末尾那句 write 在分支之外，
    // 提前 return 会让整个计划被丢掉，表现为"命令成功但什么都不打印"。
    process.stdout.write(out.join('\n') + '\n');
    return 0;
  }

  if (result.applied?.length) {
    out.push('已施加的变换:');
    for (const a of result.applied) {
      out.push(`  [${a.risk}] ${a.transform}: ${a.detail}`);
    }
    out.push('');
  }

  if (result.expectedDiff) {
    out.push('预期差异:');
    out.push(formatDiffBlock(result.expectedDiff));
    out.push('');
  }

  if (result.note) {
    out.push(`注意: ${result.note}`);
    out.push('');
  }

  if (result.artifacts) {
    out.push('产物:');
    for (const [k, v] of Object.entries(result.artifacts)) out.push(`  ${k}: ${v}`);
    out.push('');
  }

  out.push(result.ok ? '闭环成立' : '闭环未成立');
  process.stdout.write(out.join('\n') + '\n');
  return result.ok ? 0 : 1;
}

function formatDiffBlock(diff) {
  const lines = [];
  const section = (title, group) => {
    if (!group.added.length && !group.removed.length) return;
    lines.push(`  ${title}:`);
    for (const n of group.added) lines.push(`    + ${n}`);
    for (const n of group.removed) lines.push(`    - ${n}`);
  };
  section('骨骼', diff.bones);
  section('槽位', diff.slots);
  section('动画', diff.animations);
  if (!lines.length) lines.push('  (无)');
  return lines.join('\n');
}

/**
 * 解析 --transform 规格。
 * 格式: 名字,键=值,键=值
 * 例:   rename-bone,from=root,to=Root
 */
export function parseTransformSpec(spec) {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const name = parts.shift();
  const args = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) throw new Error(`变换参数格式错误: ${p}（应为 键=值）`);
    args[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
  }
  return { name, args };
}

/** 去掉 _raw，避免 inspect --json 输出里混进重复的原始数据 */
function stripRaw(doc) {
  const { _raw, ...rest } = doc;
  return rest;
}
