/**
 * 部件分割入口的测试。
 *
 * 这个模块的契约是「永不抛异常，失败就返回 null」——生成流程靠它兜底，
 * 所以每条失败分支都必须真的有测试，不能只靠"应该不会出错"。
 *
 * 环境判断通过 SPINE_SAM_HOME 环境变量切换：指向真环境就测成功路径，
 * 指向一个不存在的目录就测降级路径。这样不需要 mock，测的是真实代码。
 *
 * 真环境不存在时（比如 CI 上没装）成功路径那几条自动跳过，
 * 降级路径照测——那些才是"没装也能用"的保证。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { check } from '../../server/sam/setup.mjs';
import { segmentParts } from '../../server/sam/segment.mjs';
import { stopSamClient } from '../../server/sam/client.mjs';

let dir;
let source;
let envReady = false;
const savedHome = process.env.SPINE_SAM_HOME;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seg-'));
  source = join(dir, 'src.png');

  // 一张小图，左边红块右边蓝块，够 SAM 分出东西
  const W = 96, H = 96;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const left = x < W / 2;
      px[i] = left ? 220 : 40;
      px[i + 1] = 40;
      px[i + 2] = left ? 40 : 220;
      px[i + 3] = 255;
    }
  }
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(source);

  const st = await check();
  envReady = st.ok;
});

after(async () => {
  /*
   * 必须显式关掉 worker。
   *
   * worker 子进程的 stdio 是活句柄，不关的话测试断言早就跑完了、
   * 进程却退不出去——实测卡满 10 分钟的空闲超时才结束。
   * client 自己会在 SIGINT/SIGTERM 时清理，但那是"进程退出时"，
   * 测试要的是"退出之前"就清干净。
   */
  stopSamClient();
  await rm(dir, { recursive: true, force: true });
  if (savedHome) process.env.SPINE_SAM_HOME = savedHome;
  else delete process.env.SPINE_SAM_HOME;
});

/**
 * 掩码 PNG 的质心横坐标。
 *
 * 用来判断"这块掩码在图的左半边还是右半边"，比面积可靠：
 * 面积只能说明大小，说明不了位置。
 */
async function maskCentroidX(png, W, H) {
  const { data, info } = await sharp(png).toColourspace('b-w').raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0, n = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] > 127) { sum += x; n++; }
    }
  }
  return n ? sum / n : -1;
}

/** 造一个合法的部件 */
function part(name, x, y, w, h) {
  return { name, bbox: { x, y, width: w, height: h } };
}

test('segmentParts: useSam 为 false 时直接返回 null，不碰 worker', async () => {
  let logged = false;
  const r = await segmentParts(source, [part('a', 4, 4, 40, 40)], {
    useSam: false,
    onLog: () => { logged = true; }
  });
  assert.equal(r, null);
  assert.equal(logged, false, '关掉时不该有任何日志，说明压根没往下走');
});

test('segmentParts: 没有可用部件时返回 null', async () => {
  const r = await segmentParts(source, [], { onLog: () => {} });
  assert.equal(r, null);

  // bbox 缺失的部件等同不可用
  const r2 = await segmentParts(source, [{ name: 'x' }], { onLog: () => {} });
  assert.equal(r2, null);
});

test('segmentParts: 环境未装时返回 null 并提示安装命令', async () => {
  process.env.SPINE_SAM_HOME = join(dir, 'definitely-not-installed');
  const logs = [];
  const r = await segmentParts(source, [part('a', 4, 4, 40, 40)], {
    onLog: (m) => logs.push(m)
  });
  assert.equal(r, null, '没装也必须优雅返回 null，不能抛');
  const text = logs.join('\n');
  assert.match(text, /setup\.mjs/, '提示里要给出安装命令');
  assert.match(text, /未安装/);
  if (savedHome) process.env.SPINE_SAM_HOME = savedHome;
  else delete process.env.SPINE_SAM_HOME;
});

test('segmentParts: requireEnv 为 true 时没装就抛错（测试/CLI 用）', async () => {
  process.env.SPINE_SAM_HOME = join(dir, 'definitely-not-installed');
  await assert.rejects(
    () => segmentParts(source, [part('a', 4, 4, 40, 40)], {
      requireEnv: true,
      onLog: () => {}
    }),
    /未安装/
  );
  if (savedHome) process.env.SPINE_SAM_HOME = savedHome;
  else delete process.env.SPINE_SAM_HOME;
});

test('segmentParts: 真环境下返回掩码，且掩码尺寸等于源图', async (t) => {
  if (!envReady) {
    t.skip('本机没装 MobileSAM 环境，跳过成功路径');
    return;
  }
  const parts = [part('left', 2, 2, 46, 92), part('right', 48, 2, 46, 92)];
  const logs = [];
  const masks = await segmentParts(source, parts, { onLog: (m) => logs.push(m) });

  assert.ok(masks, '真环境下应当拿到掩码');
  assert.equal(masks.size, 2);

  for (const name of ['left', 'right']) {
    const m = masks.get(name);
    assert.ok(m, `${name} 应当有掩码`);
    assert.equal(m.width, 96, '掩码宽等于源图宽');
    assert.equal(m.height, 96, '掩码高等于源图高');
    assert.ok(m.area > 0, `${name} 掩码不该是空的`);
    assert.ok(m.score > 0.5, `${name} 置信度应当偏高，实际 ${m.score}`);
  }

  /*
   * 刻意不断言"左右面积不同"。
   *
   * 一度这么写过，失败了——测试图左右是等大的红蓝方块，面积本来就该接近相等，
   * SAM 正确地给出了两块同样大的掩码。要验的是"分开了"，不是"不一样大"。
   * 下面查两块掩码的质心分别落在左右两侧，那才说明真的分开了。
   */
  const leftCx = await maskCentroidX(masks.get('left').png, 96, 96);
  const rightCx = await maskCentroidX(masks.get('right').png, 96, 96);
  assert.ok(leftCx < 48, `left 掩码质心该偏左，实际 ${leftCx.toFixed(1)}`);
  assert.ok(rightCx > 48, `right 掩码质心该偏右，实际 ${rightCx.toFixed(1)}`);

  const text = logs.join('\n');
  assert.match(text, /分割完成/, '应当报告完成');
});

test('segmentParts: 同样的输入调两次，掩码面积一致', async (t) => {
  if (!envReady) {
    t.skip('本机没装 MobileSAM 环境，跳过');
    return;
  }
  const parts = [part('left', 2, 2, 46, 92)];
  const a = await segmentParts(source, parts, { onLog: () => {} });
  const b = await segmentParts(source, parts, { onLog: () => {} });
  assert.equal(a.get('left').area, b.get('left').area,
    '同样的输入必须给同样的结果，否则切图不可复现');
});

test('segmentParts: 部分部件缺 bbox 时，只分割能用的那些', async (t) => {
  if (!envReady) {
    t.skip('本机没装 MobileSAM 环境，跳过');
    return;
  }
  const parts = [
    part('left', 2, 2, 46, 92),
    { name: 'broken' },                    // 缺 bbox
    part('right', 48, 2, 46, 92)
  ];
  const masks = await segmentParts(source, parts, { onLog: () => {} });
  assert.equal(masks.size, 2, '应当只出两个掩码');
  assert.ok(masks.has('left'));
  assert.ok(masks.has('right'));
  assert.ok(!masks.has('broken'), '缺 bbox 的不该凭空出现');
});

/*
 * 覆盖率兜底的测试。
 *
 * 这条兜底是真事故催出来的：test_role_arbg 那张人物图，SAM 给 left_arm /
 * right_arm_scissors 的掩码只盖住框内不透明像素的 5.4% / 3.7%，切出来是
 * 一小团手掌，整条袖子全没了。AI 多边形虽然粗，好歹是整条袖子。
 * 所以掩码覆盖率过低时必须丢掉它、退回多边形，不能"有掩码就用"。
 */
test('segmentParts: 掩码带 coverage 字段，正常部件不该被兜底误伤', async (t) => {
  if (!envReady) {
    t.skip('本机没装 MobileSAM 环境，跳过成功路径');
    return;
  }
  const parts = [part('left', 2, 2, 46, 92), part('right', 48, 2, 46, 92)];
  const logs = [];
  const masks = await segmentParts(source, parts, { onLog: (m) => logs.push(m) });

  assert.ok(masks, '应当拿到掩码');
  assert.equal(masks.size, 2, '两个方块都该留下，兜底不该误伤正常部件');
  for (const name of ['left', 'right']) {
    const c = masks.get(name).coverage;
    assert.equal(typeof c, 'number', `${name} 应当带 coverage`);
    assert.ok(c > 0.15,
      `${name} 是实心方块，覆盖率该远高于阈值，实际 ${c}`);
  }
  assert.doesNotMatch(logs.join('\n'), /几乎是空的/,
    '正常部件不该触发兜底提示');
});

test('segmentParts: 框里基本是透明背景时，掩码被判为空并退回多边形', async (t) => {
  if (!envReady) {
    t.skip('本机没装 MobileSAM 环境，跳过成功路径');
    return;
  }
  /*
   * 把框放在右下角那片透明区，只擦到蓝块一个角。
   * 这种框 SAM 只能圈出零星几个像素，正是要兜掉的形态。
   * 注意分母只算框内不透明像素，所以"框里全透明"会被 worker 判成
   * coverage=1.0（没有分母就不做判断），这里刻意留一点不透明像素进去。
   */
  const logs = [];
  const masks = await segmentParts(source, [part('corner', 60, 60, 34, 34)], {
    onLog: (m) => logs.push(m)
  });

  const text = logs.join('\n');
  const bailed = masks === null || !masks.has('corner');
  if (bailed) {
    assert.match(text, /几乎是空的|都不可用|没有产出/,
      '兜掉的时候要说清原因，否则用户不知道为什么轮廓变粗了');
  } else {
    // 没兜掉也可以接受——只要它确实盖住了足够多的像素，那就是个有效掩码
    assert.ok(masks.get('corner').coverage >= 0.15,
      `留下来的掩码覆盖率必须达标，实际 ${masks.get('corner').coverage}`);
  }
});

test('segmentParts: 图片不存在时返回 null 而不是抛异常', async (t) => {
  if (!envReady) {
    t.skip('本机没装 MobileSAM 环境，跳过');
    return;
  }
  const logs = [];
  const r = await segmentParts(join(dir, 'no-such-file.png'),
    [part('a', 4, 4, 40, 40)], { onLog: (m) => logs.push(m) });
  assert.equal(r, null, '读不到图也要优雅退化');
  assert.match(logs.join('\n'), /分割失败/, '要说明为什么退化');
});
