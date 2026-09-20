/**
 * 量一件事：切出来的部件图里，有多少像素是「多个部件都画了同一处源图内容」。
 *
 * 用户看到的"头部在多个部件上都出现、动画里断裂滑动"，在数据上就是：
 * 两张切图映射回源图坐标后，同一个源像素在两张图里都是不透明的。
 *
 * 两个调用方：
 *   - scripts/dup-check.mjs（CLI，人工看一眼）
 *   - test/e2e.test.js（真流程跑完的下限断言）
 * 所以这里只吐结构化的数，不打印。
 */
import sharp from 'sharp';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 判定"这格画错了"的色差门槛（L1，三通道合计）。
 *
 * 120 ≈ 每通道差 40，是"一眼能看出不是同一个颜色"的量级。
 * 实测修好之后 12.png 剩 1.8%（全是贴回边缘渗出来的一两像素锯齿），
 * 修好之前 55~75%。
 */
const GHOST_DSRC = 120;

/**
 * 量 `_temp` 目录里这一轮切图的重复像素。
 *
 * @param {string} runDir    _temp 目录（要有 verify-input.json 和 Image/）
 * @param {string} [srcPath] 源图，缺省用 verify-input.json 里的
 * @returns {Promise<{
 *   covered: number,    源图里被至少一张切图覆盖的像素数
 *   dup: number,        其中被 ≥2 个部件画的
 *   dupRatio: number,   dup / covered
 *   dupInErased: number, 重复像素里落在「某一方自己的擦除区」中的
 *   pairs: Array<{ a: string, b: string, n: number, inErased: number }>
 *   perPart: Array<{ name: string, depth: number, own: number, shared: number }>
 * }>}
 */
export async function checkDuplicates(runDir, srcPath) {
  const dataPath = join(runDir, 'verify-input.json');
  if (!existsSync(dataPath)) {
    throw new Error(`找不到 ${dataPath}——先跑 node scripts/dump-verify-input.mjs <_temp目录>`);
  }
  const d = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const parts = d.parts ?? [];
  const src = srcPath ?? d.sourceImage;

  const meta = await sharp(src).metadata();
  const W = meta.width, H = meta.height;

  /*
   * 窗口位置一律取 bboxActual（切图回填的），不取 parts[].bbox（AI 的框）：
   * 窗口会按归属表撑开，两个框能差几十像素，用错的那个贴出来的整张图
   * 都是错位的，指标跟着一起错。见 checkCoverage 里的同一段说明。
   */
  const boxOf = (p) => d.bboxActual?.[p.name] ?? p.bbox;
  const layers = new Map();
  const erased = new Map();
  for (const p of parts) {
    const png = join(runDir, 'Image', `${p.name}.png`);
    if (!existsSync(png)) continue;
    const x0 = Math.round(boxOf(p).x), y0 = Math.round(boxOf(p).y);

    const { data: px, info } = await sharp(png).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const a = new Uint8Array(W * H);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (px[(y * info.width + x) * 4 + 3] < 8) continue;
        const sx = x0 + x, sy = y0 + y;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        a[sy * W + sx] = 1;
      }
    }
    layers.set(p.name, a);

    const ef = join(runDir, 'Image', `${p.name}.erased.png`);
    if (!existsSync(ef)) continue;
    const { data: em, info: ei } = await sharp(ef).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const e = new Uint8Array(W * H);
    for (let y = 0; y < ei.height; y++) {
      for (let x = 0; x < ei.width; x++) {
        // alpha 是掩码语义；RGB 在 .erased.png 里装的是真值色
        if (em[(y * ei.width + x) * 4 + 3] <= 127) continue;
        const sx = x0 + x, sy = y0 + y;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        e[sy * W + sx] = 1;
      }
    }
    erased.set(p.name, e);
  }

  let dup = 0, dupInErased = 0, covered = 0;
  const pairMap = new Map();
  const sharedOf = new Map();
  const ownOf = new Map();

  for (let i = 0; i < W * H; i++) {
    const who = [];
    for (const [n, a] of layers) if (a[i]) who.push(n);
    if (!who.length) continue;
    covered++;
    for (const n of who) ownOf.set(n, (ownOf.get(n) ?? 0) + 1);
    if (who.length < 2) continue;
    dup++;
    let inEr = false;
    for (const n of who) {
      sharedOf.set(n, (sharedOf.get(n) ?? 0) + 1);
      if (erased.get(n)?.[i]) inEr = true;
    }
    if (inEr) dupInErased++;
    for (let a = 0; a < who.length; a++) {
      for (let b = a + 1; b < who.length; b++) {
        const key = [who[a], who[b]].sort().join(' × ');
        const cur = pairMap.get(key) ?? { a: who[a], b: who[b], n: 0, inErased: 0 };
        cur.n++;
        if (inEr) cur.inErased++;
        pairMap.set(key, cur);
      }
    }
  }

  return {
    covered,
    dup,
    dupRatio: covered > 0 ? dup / covered : 0,
    dupInErased,
    pairs: [...pairMap.values()].sort((x, y) => y.n - x.n),
    perPart: parts.map((p) => ({
      name: p.name,
      depth: p.depth ?? 0,
      own: ownOf.get(p.name) ?? 0,
      shared: sharedOf.get(p.name) ?? 0,
    })),
  };
}

/**
 * 量「重影」：被前方部件盖住的那片，被画成了什么。
 *
 * 为什么不能用 checkDuplicates 那套「同一个源像素被两张切图都画了」当判据：
 * 用户要的产物是「隐藏区域(AI补全/Inpaint) → 完整 Object RGBA」——
 * 围裙甩开的时候底下必须有身体。那么 body 在围裙底下有内容、围裙自己也有
 * 内容，按那个判据一定算重复，正确设计下永远过不了（实测 75.1% / 62.2%）。
 *
 * 也不能用「补出来的颜色像不像遮挡者」当判据——试过，假阳性一片。
 * 实测 12.png 的 handle<tomato 那对，`|handle-tomato| = 0` 的像素有 7260px，
 * 但那些点 handle 和 tomato **都精确等于源图色**，根本不是重影：
 * 那件素材整体偏暗（源图 rgb(1,0,0)、rgb(53,68,2)），任何两个暗色像素的
 * 绝对色差都低于任何合理门槛。色差只能相对的看。
 *
 * 真正定义重影的是**和真值差多少**。源图那一格就是真值——它就是当时
 * 真正显示的颜色（§15.2）。判据：
 *
 *   对每个"落在某部件 A 的擦除区（= A 被前方部件盖住、由重建填出来的那片）、
 *   且 A 在那里不透明"的源像素：
 *
 *     dSrc = |A色 - 源图那格色|   （L1，三通道合计）
 *     ghost ⇔ dSrc ≥ 120
 *
 * 120 的来历：三通道合计 120 ≈ 每通道差 40，是"一眼能看出不是同一个颜色"
 * 的量级。实测修好之后 12.png 只剩 1.8%（721px，全是边界锯齿：
 * 补图在贴回边缘渗了一两像素），修好之前 55~75%。
 *
 * @returns {Promise<{
 *   covered: number,      有内容的源像素数
 *   erasedPainted: number, 其中落在某部件擦除区且被画了内容的
 *   ghost: number,        dSrc ≥ GHOST_DSRC 的
 *   ghostOfCovered: number,
 *   ghostOfErased: number,
 *   pairs: Array<{ key: string, n: number, max: number }>
 * }>}
 */
export async function checkGhosts(runDir, srcPath) {
  const dataPath = join(runDir, 'verify-input.json');
  if (!existsSync(dataPath)) {
    throw new Error(`找不到 ${dataPath}——先跑 node scripts/dump-verify-input.mjs <_temp目录>`);
  }
  const d = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const parts = (d.parts ?? []).filter((p) => existsSync(join(runDir, 'Image', `${p.name}.png`)));
  const src = srcPath ?? d.sourceImage;

  const meta = await sharp(src).metadata();
  const W = meta.width, H = meta.height;
  const S = (await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data;

  const boxOf = (p) => d.bboxActual?.[p.name] ?? p.bbox;
  const L = new Map();
  for (const p of parts) {
    const { data, info } = await sharp(join(runDir, 'Image', `${p.name}.png`))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const x0 = Math.round(boxOf(p).x), y0 = Math.round(boxOf(p).y);
    const rgb = new Uint8Array(W * H * 3);
    const a = new Uint8Array(W * H);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const si = (y * info.width + x) * 4;
        if (data[si + 3] < 8) continue;
        const sx = x0 + x, sy = y0 + y;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const t = sy * W + sx;
        a[t] = 1;
        rgb[t * 3] = data[si];
        rgb[t * 3 + 1] = data[si + 1];
        rgb[t * 3 + 2] = data[si + 2];
      }
    }

    /*
     * 擦除区（= 被前方部件盖住、由"重建"填出来的那片）里，只挑**有真值**的。
     *
     * `.erased.png` 一个文件担两件事：alpha=255 是掩码（这格被擦了），
     * RGB 放着那格在源图里原样的颜色。但源图里彻底空掉的真洞（两件素材
     * 合计只有 412px）没有真值可存，cutter 在那里留 0,0,0 当哨兵。
     *
     * 必须把真洞排除掉：补图在那里编内容是它的**职责**——没有任何真值
     * 可参考，画成什么样都不能算错。实测 12.png 的 watermelon_slice
     * 46px"重影"，色差高达 628，一查全是源图 alpha=0 的真洞，
     * 补图照着旁边的西瓜画了红瓤和浅绿，完全合理。不排除就是纯假阳性。
     */
    let er = null;
    const ef = join(runDir, 'Image', `${p.name}.erased.png`);
    if (existsSync(ef)) {
      const { data: em, info: ei } = await sharp(ef).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      er = new Uint8Array(W * H);
      for (let y = 0; y < ei.height; y++) {
        for (let x = 0; x < ei.width; x++) {
          const i = (y * ei.width + x) * 4;
          if (em[i + 3] <= 127) continue;                    // 不在擦除掩码里
          if (!em[i] && !em[i + 1] && !em[i + 2]) continue;  // 真洞，没有真值
          const sx = x0 + x, sy = y0 + y;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          er[sy * W + sx] = 1;
        }
      }
    }
    L.set(p.name, { rgb, a, er });
  }

  const names = [...L.keys()];
  let covered = 0, erasedPainted = 0, ghost = 0;
  const per = new Map();
  for (let i = 0; i < W * H; i++) {
    if (S[i * 4 + 3] < 8) continue;          // 源图这里没有真值，不判
    let any = false;
    for (const n of names) {
      if (!L.get(n).a[i]) continue;
      any = true;
      const me = L.get(n);
      if (!me.er?.[i]) continue;             // 不在擦除区：不是"被盖住重建"的
      const dSrc = Math.abs(me.rgb[i * 3] - S[i * 4])
        + Math.abs(me.rgb[i * 3 + 1] - S[i * 4 + 1])
        + Math.abs(me.rgb[i * 3 + 2] - S[i * 4 + 2]);
      if (dSrc < GHOST_DSRC) continue;
      ghost++;
      const cur = per.get(n) ?? { key: n, n: 0, max: 0 };
      cur.n++;
      cur.max = Math.max(cur.max, dSrc);
      per.set(n, cur);
    }
    if (!any) continue;
    covered++;
    for (const n of names) {
      const me = L.get(n);
      if (me.a[i] && me.er?.[i]) { erasedPainted++; break; }
    }
  }

  return {
    covered,
    erasedPainted,
    ghost,
    ghostOfCovered: covered > 0 ? ghost / covered : 0,
    ghostOfErased: erasedPainted > 0 ? ghost / erasedPainted : 0,
    pairs: [...per.values()].sort((a, b) => b.n - a.n)
  };
}

/**
 * 量「切完之后有没有内容谁都没画」——用户看到的"头转了脸不转"。
 *
 * 每个部件只画自己认领的像素（归属表 + 按框认领），所以源图里任何一块内容
 * 只要没被认领，就谁的切图里都没有它，动画一动就露出背景。
 *
 * 实测 role10 有 17416px 这种孤儿，集中在 right_arm_and_scissors：
 * 它的 SAM 掩码几乎是空的（占框内 11.0%）被降级到 polygon 路径，可那份
 * 小掩码仍然参与了归属表、把框内像素判给了它，然后 polygon 那句
 * 「轮廓外的删掉」又把它们全删了。渲染出来手臂中间一串竖直白碎片。
 *
 * 判据分两档，性质不同：
 *   - **框外的孤儿**：连"按框认领"都兜不住（内容落在所有部件的框之外），
 *     说明 AI 给的框本身就漏了东西。这是硬伤，必须极少。
 *   - **框内的孤儿**：本可以按框认领、却没人认领（多个框都不含它、
 *     或者认领时被 depth 规则挡掉）。跑一次归属就能补上，属实现缺陷。
 *
 * @returns {Promise<{
 *   srcOpaque: number,   源图不透明的像素数
 *   orphan: number,      有内容但谁都没画的
 *   orphanOfSrc: number,
 *   outsideBox: number,  其中连"按框认领"都兜不住的
 *   outsideBoxOfSrc: number,
 *   byPart: Array<{ key: string, n: number }>  按"落在哪些框里"分组
 * }>}
 */
export async function checkCoverage(runDir, srcPath) {
  const dataPath = join(runDir, 'verify-input.json');
  if (!existsSync(dataPath)) {
    throw new Error(`找不到 ${dataPath}——先跑 node scripts/dump-verify-input.mjs <_temp目录>`);
  }
  const d = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const parts = (d.parts ?? []).filter((p) => existsSync(join(runDir, 'Image', `${p.name}.png`)));
  const src = srcPath ?? d.sourceImage;

  const meta = await sharp(src).metadata();
  const W = meta.width, H = meta.height;
  const S = (await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data;

  /*
   * 切图窗口在源图里的位置：优先用 bboxActual（切图自己回的框）。
   *
   * parts[].bbox 是 AI 的框，切图可能把窗口按归属表撑开（见 cutter.js 的
   * growCap），两者能差几十像素。撑开之后拿 AI 框去贴 PNG，撑出来的那圈
   * 就"落在所有框之外"，于是报一堆假孤儿——实测同一份切图，用错框是
   * 16.86%，用对框是 0.00%。这个判据以前就栽过一次（见 15.4），
   * 现在把"用哪个框"钉死成切图回填的那个。
   */
  const boxOf = (p) => d.bboxActual?.[p.name] ?? p.bbox;
  const drawn = new Uint8Array(W * H);
  for (const p of parts) {
    const { data, info } = await sharp(join(runDir, 'Image', `${p.name}.png`))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const x0 = Math.round(boxOf(p).x), y0 = Math.round(boxOf(p).y);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] < 8) continue;
        const sx = x0 + x, sy = y0 + y;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        drawn[sy * W + sx] = 1;
      }
    }
  }

  let srcOpaque = 0, orphan = 0, outsideBox = 0;
  const per = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (S[i * 4 + 3] < 8) continue;
      srcOpaque++;
      if (drawn[i]) continue;
      orphan++;
      const inBox = parts.filter((p) => {
        const b = boxOf(p);
        return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
      }).map((p) => p.name).sort();
      if (!inBox.length) {
        outsideBox++;
        per.set('(不在任何框内)', (per.get('(不在任何框内)') ?? 0) + 1);
        continue;
      }
      const k = inBox.join('+');
      per.set(k, (per.get(k) ?? 0) + 1);
    }
  }

  return {
    srcOpaque,
    orphan,
    orphanOfSrc: srcOpaque > 0 ? orphan / srcOpaque : 0,
    outsideBox,
    outsideBoxOfSrc: srcOpaque > 0 ? outsideBox / srcOpaque : 0,
    byPart: [...per.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
  };
}

/**
 * 数「源图上有内容、却没有一张切图画它」的像素——**不经过任何 bbox**。
 *
 * 这是「切图漏内容」唯一靠得住的判据。checkCoverage 分出的那两档
 * （框内 / 框外）都要先把切图贴回源图坐标，而贴回去要靠窗口位置，
 * 位置一旦取错（AI 的框 vs 切图回填的框）整张图就错位。这条不用位置：
 * 只问"这块内容到底有没有人画"，位置不对就把结果算错，不会算对。
 *
 * 所以**别把它和 checkCoverage 混起来**：那条给你"漏在哪个部件的框里"
 * 的诊断信息（有用，但会因口径错而误报），这条给你"到底漏没漏"的判决。
 *
 * @param {string} runDir - 产物目录（含 verify-input.json 和 Image/）
 * @param {object} [boxes] - 可选的 { 部件名: {x,y,width,height} }，不给就查 bboxActual
 * @returns {Promise<{srcOpaque:number, missing:number, ofSrc:number, byPart:Array}>}
 */
export async function checkMissingContent(runDir, boxes) {
  const ALPHA_CUTOFF = 8;
  const d = JSON.parse(readFileSync(join(runDir, 'verify-input.json'), 'utf-8'));
  const box = boxes ?? d.bboxActual;
  if (!box) {
    throw new Error('checkMissingContent 需要 bboxActual（跑 e2e 时落盘）或显式传 boxes');
  }
  const src = d.sourceImage;
  const meta = await sharp(src).metadata();
  const W = meta.width, H = meta.height;
  const S = (await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data;

  const drawn = new Uint8Array(W * H);
  const byPart = [];
  for (const p of d.parts ?? []) {
    const b = box[p.name];
    const png = join(runDir, 'Image', `${p.name}.png`);
    if (!b || !existsSync(png)) continue;
    const { data, info } = await sharp(png).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    let n = 0;
    const x0 = Math.round(b.x), y0 = Math.round(b.y);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] < ALPHA_CUTOFF) continue;
        const sx = x0 + x, sy = y0 + y;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        drawn[sy * W + sx] = 1;
        n++;
      }
    }
    byPart.push({ name: p.name, painted: n });
  }

  let srcOpaque = 0, missing = 0;
  for (let i = 0; i < W * H; i++) {
    if (S[i * 4 + 3] < ALPHA_CUTOFF) continue;
    srcOpaque++;
    if (!drawn[i]) missing++;
  }
  return { srcOpaque, missing, ofSrc: srcOpaque ? missing / srcOpaque : 0, byPart };
}
