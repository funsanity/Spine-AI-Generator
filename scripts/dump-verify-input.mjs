/**
 * 把一次 E2E 真跑的产物合成 render-animation.mjs 要的那一个输入文件。
 *
 *   node scripts/dump-verify-input.mjs <e2e输出目录> <源图.png>
 *
 * E2E 落盘的是 in-memory 骨架（bones/slots），但缺每个部件的 bbox——
 * 而 bbox 是"切图贴回源图哪个位置"的唯一依据，没有它渲染不出动画。
 * 所以这里从切图目录本身反推：每张 <部件名>.png 的尺寸 + 骨架里槽位的
 * 顺序只能给出相对关系，bbox 还是得从 analysis 拿。
 *
 * analysis 从骨架文件同级找：E2E 会写 <name>.json（骨架），
 * 部件表则另外存一份 <name>.parts.json（由本脚本负责在第一次运行时补出来）。
 */
import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';

const [,, runDir, srcPath] = process.argv;
if (!runDir) {
  console.error('用法: node scripts/dump-verify-input.mjs <e2e输出目录> [源图.png]');
  process.exit(1);
}

const files = await readdir(runDir);
/*
 * 挑骨架文件：同名目录下还有另几个 json，都不是骨架，必须显式排除。
 *   - `cut-input.json`：字典序排在 `<名字>.json` 前面，**旧版就是这么挑错的**
 *     ——把 cut-input 当骨架读，再去找 cut-input.parts.json，报"缺少部件表"
 *   - `verify-input.json`：本脚本写出来的文件，重跑时会在
 *   - `<名字>.parts.json` / `<名字>.report.json`：部件表与补图报告
 */
const skelFile = files.find((f) =>
  f.endsWith('.json')
  && !f.endsWith('.parts.json')
  && !f.endsWith('.report.json')
  && f !== 'cut-input.json'
  && f !== 'verify-input.json');
if (!skelFile) {
  console.error(`${runDir} 里找不到骨架 json`);
  process.exit(1);
}

const sk = JSON.parse(await readFile(join(runDir, skelFile), 'utf-8'));
const partsFile = join(runDir, skelFile.replace(/\.json$/, '.parts.json'));

let parts;
try {
  parts = JSON.parse(await readFile(partsFile, 'utf-8'));
} catch {
  console.error(
    `缺少 ${partsFile}\n` +
    '这是每个部件的 bbox 表，动画渲染靠它把切图贴回源图坐标。\n' +
    'E2E 跑完请用它返回的 analysis.parts 生成这个文件。'
  );
  process.exit(1);
}

const out = {
  parts,
  bones: sk.bones ?? [],
  slots: sk.slots ?? []
};

const dest = join(runDir, 'verify-input.json');
await writeFile(dest, JSON.stringify(out, null, 2));
console.log(`✓ ${dest}`);
console.log(`  ${out.parts.length} 个部件，${out.bones.length} 根骨头，${out.slots.length} 个槽位`);
if (srcPath) console.log(`  源图: ${srcPath}`);
