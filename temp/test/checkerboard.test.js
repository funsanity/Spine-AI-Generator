/**
 * 棋盘格清除测试。
 *
 * 中转站返回的补图是 3 通道 PNG（channels=3 hasAlpha=false），
 * 模型无法输出真透明，只能把"透明"画成 RGB 纹理——症状是棋盘格。
 * 这组测试验证：只清除与边缘连通的近白中性灰，内部的白衣服/白发不误删。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeCheckerboard } from '../../server/api/inpaint.js';

/** 造一张 RGBA 图 */
function makeRGBA(width, height, fill = [0, 0, 0, 255]) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = fill[0];
    buf[i * 4 + 1] = fill[1];
    buf[i * 4 + 2] = fill[2];
    buf[i * 4 + 3] = fill[3];
  }
  return buf;
}

/** 设置某个像素 */
function set(buf, w, x, y, rgba) {
  const i = (y * w + x) * 4;
  buf[i] = rgba[0];
  buf[i + 1] = rgba[1];
  buf[i + 2] = rgba[2];
  buf[i + 3] = rgba[3];
}

/** 读取某个像素的 alpha */
const alpha = (buf, w, x, y) => buf[(y * w + x) * 4 + 3];

test('场景一：四周棋盘格 + 中间深色内容 —— 棋盘格清掉，内容留住', () => {
  const W = 40, H = 40;
  const img = makeRGBA(W, H, [250, 250, 250, 255]); // 近白棋盘格底
  // 中间画一块深色内容（角色）
  for (let y = 15; y < 25; y++) {
    for (let x = 15; x < 25; x++) {
      set(img, W, x, y, [50, 60, 70, 255]);
    }
  }

  const result = removeCheckerboard(img, W, H, 4);
  assert.equal(alpha(result.buffer, W, 0, 0), 0, '角落棋盘格应透明');
  assert.equal(alpha(result.buffer, W, 20, 20), 255, '内容区应不透明');
  assert.ok(result.cleared > 1200, '应清除大部分边缘区域');
});

test('场景二：角色内部的白不能被删', () => {
  const W = 40, H = 40;
  const img = makeRGBA(W, H, [250, 250, 250, 255]); // 边缘是棋盘格
  // 深色方块（角色身体）
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 30; x++) {
      set(img, W, x, y, [40, 40, 60, 255]);
    }
  }
  // 内部白块（白衣服）
  for (let y = 17; y < 23; y++) {
    for (let x = 17; x < 23; x++) {
      set(img, W, x, y, [255, 255, 255, 255]);
    }
  }

  const result = removeCheckerboard(img, W, H, 4);
  assert.equal(alpha(result.buffer, W, 20, 20), 255, '内部白必须留住（这是白衣服）');
  assert.equal(alpha(result.buffer, W, 0, 0), 0, '边缘棋盘格应清掉');
});

test('检测阈值：只清近白中性灰（237~255，通道差 ≤7）', () => {
  const W = 20, H = 20;
  const img = makeRGBA(W, H, [240, 240, 240, 255]); // 符合阈值
  set(img, W, 10, 10, [200, 200, 200, 255]); // 太暗，不符合

  const result = removeCheckerboard(img, W, H, 4);
  assert.equal(alpha(result.buffer, W, 0, 0), 0, '240,240,240 应被清');
  assert.equal(alpha(result.buffer, W, 10, 10), 255, '200,200,200 应保留');
});

test('通道差超标：不是中性灰的白不清（带色的白）', () => {
  const W = 20, H = 20;
  const img = makeRGBA(W, H, [250, 245, 250, 255]); // 通道差 5，符合
  set(img, W, 10, 10, [250, 240, 250, 255]); // 通道差 10，超标

  const result = removeCheckerboard(img, W, H, 4);
  assert.equal(alpha(result.buffer, W, 0, 0), 0, '通道差 5 应清');
  assert.equal(alpha(result.buffer, W, 10, 10), 255, '通道差 10 应保留');
});

test('连通性：内部棋盘格若与边缘连通则一起清掉', () => {
  const W = 40, H = 40;
  const img = makeRGBA(W, H, [250, 250, 250, 255]);
  // 深色方块，右侧开口
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 30; x++) {
      if (y < 19 || y > 21 || x < 25) {
        set(img, W, x, y, [40, 40, 60, 255]);
      }
    }
  }
  // 内部有一块棋盘格，通过开口与外界连通
  const result = removeCheckerboard(img, W, H, 4);
  assert.equal(alpha(result.buffer, W, 27, 20), 0, '连通后内部棋盘格应清掉');
});

test('四边都能作为种子', () => {
  const W = 40, H = 40;
  const img = makeRGBA(W, H, [250, 250, 250, 255]);
  // 一条横贯整幅的深色条，把画布切成上下两半
  for (let x = 0; x < W; x++) {
    set(img, W, x, 19, [20, 20, 20, 255]);
    set(img, W, x, 20, [20, 20, 20, 255]);
  }

  const result = removeCheckerboard(img, W, H, 4);
  assert.equal(alpha(result.buffer, W, 5, 5), 0, '上半部分棋盘格清掉');
  assert.equal(alpha(result.buffer, W, 5, 35), 0, '下半部分棋盘格也清掉');
  assert.equal(alpha(result.buffer, W, 5, 19), 255, '深色条留住');
});

test('大图不爆栈（用显式栈）', () => {
  const W = 400, H = 400;
  const img = makeRGBA(W, H, [250, 250, 250, 255]);
  // 中间一个深色方块
  for (let y = 150; y < 250; y++) {
    for (let x = 150; x < 250; x++) {
      set(img, W, x, y, [10, 10, 10, 255]);
    }
  }

  const result = removeCheckerboard(img, W, H, 4);
  assert.ok(result.cleared >= 150000, '应清除大部分棋盘格');
  assert.equal(alpha(result.buffer, W, 200, 200), 255, '内容区不动');
});
