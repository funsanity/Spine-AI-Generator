/**
 * 量「切完之后有没有内容谁都没画」——也就是用户看到的"头转了脸不转"。
 *
 * MobileSAM 是纯框提示，头这个框里它给的往往是头发，脸/下巴/耳朵落在掩码外，
 * 于是既不在 head 切图里、也不在别的部件里，动画一动就露馅。
 *
 * 用法：node scripts/verify-cut-isolation.mjs <verify-input.json> <源图.png>
 */
import sharp from 'sharp';
import { cutImageParts } from '../server/api/cutter.js';
import { segmentParts } from '../server/sam/segment.mjs';
import { stopSamClient } from '../server/sam/client.mjs';
import { readFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const d = JSON.parse(await readFile('output/verify_role/test_role_arbg_temp/verify-input.json', 'utf-8'));
const src = 'test_assets/test_role_arbg.png';
const masks = await segmentParts(src, d.parts, {});
const out = await mkdtemp(join(tmpdir(), 'recut-'));
const cuts = await cutImageParts(src, d.parts, out, { margin: 5, bleed: 1, snap: false, samMasks: masks });

// head 的丢失像素还有多少
const H = d.parts.find((p) => p.name === 'head');
const hc = cuts.find((c) => c.name === 'head');
const { data: head, info } = await sharp(hc.path).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const { data: sraw } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const srcW = 298;
let lost = 0;
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  if (head[(y*info.width+x)*4+3] >= 8) continue;
  const sx = hc.bbox.x + x, sy = hc.bbox.y + y;
  if (sraw[(sy*srcW+sx)*4+3] < 8) continue;
  lost++;
}
console.log(`\nhead 切图里"源图有内容但丢了"的像素: ${lost}`);

// 导出对比图
await sharp(hc.path).resize(info.width*3, info.height*3, { kernel: 'nearest' })
  .flatten({ background: { r: 230, g: 240, b: 255 } })
  .png().toFile('output/_verify_video/role/E-head-after.png');
console.log(`→ E-head-after.png (${info.width}x${info.height})`);
await stopSamClient();
