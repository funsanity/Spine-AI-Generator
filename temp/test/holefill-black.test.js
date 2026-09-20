/**
 * 黑块守卫回归测试：resolveHoleFills 必须抓住"四周亮、洞里黑"的补图失败
 *
 * 实测底板 6044px 源图中灰 lum 60-80 → 模型补成 rgb(0-19)。
 * 老守卫只抓近白，黑块漏了。这组测试验证修复。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { resolveHoleFills, RING_MAX, RING_MIN_N } from '../../server/api/inpaint.js';

const W = 100, H = 100;
const ALPHA_CUTOFF = 8;

describe('resolveHoleFills 黑块守卫', () => {
  it('四周中灰、洞里黑 → 全部退回参照色', async () => {
    // 合成场景：60x60 的洞，四周 2px 环是 rgb(70,70,70)，洞里模型补成黑 rgb(5,5,5)
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const mask = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);  // 全 0 = 全是内部孔洞

    // 洞区域 20-79, 20-79
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 20 && x < 80 && y >= 20 && y < 80;
        const inRing = (x >= 18 && x < 82 && y >= 18 && y < 82) && !inHole;

        if (inRing) {
          // 四周真实内容：中灰
          base[i*4] = base[i*4+1] = base[i*4+2] = 70; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 70; filled[i*4+3] = 255;
        } else if (inHole) {
          // 洞：base 透明，filled 是模型补的黑
          base[i*4+3] = 0;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 5; filled[i*4+3] = 255;
          mask[i] = 1;
        }
      }
    }

    const maskData = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) maskData[i] = mask[i] ? 255 : 0;

    const fb = resolveHoleFills(base, filled, maskData, exterior, W, H);

    // 洞里所有像素都该退回参照色 rgb(70,70,70)
    let fixedN = 0;
    for (let y = 20; y < 80; y++) {
      for (let x = 20; x < 80; x++) {
        const i = y * W + x;
        assert.ok(fb[i] !== null, `洞内 (${x},${y}) 应被守卫抓住`);
        assert.deepEqual(fb[i], [70, 70, 70], `参照色应该是四周的 rgb(70,70,70)`);
        fixedN++;
      }
    }
    assert.equal(fixedN, 60 * 60, '整个洞都该被修正');
  });

  it('四周暗色、洞里黑 → 保持黑（不是补砸，是正常深色）', async () => {
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const mask = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);

    // 四周深色 rgb(20,20,20)，洞里黑
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 30 && x < 70 && y >= 30 && y < 70;
        const inRing = (x >= 28 && x < 72 && y >= 28 && y < 72) && !inHole;

        if (inRing) {
          base[i*4] = base[i*4+1] = base[i*4+2] = 20; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 20; filled[i*4+3] = 255;
        } else if (inHole) {
          base[i*4+3] = 0;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 8; filled[i*4+3] = 255;
          mask[i] = 1;
        }
      }
    }

    const maskData = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) maskData[i] = mask[i] ? 255 : 0;

    const fb = resolveHoleFills(base, filled, maskData, exterior, W, H);

    // 四周本来就暗，洞里黑是对的，不该退回
    for (let y = 30; y < 70; y++) {
      for (let x = 30; x < 70; x++) {
        const i = y * W + x;
        assert.equal(fb[i], null, `四周暗时，洞里黑不算补砸`);
      }
    }
  });

  it('四周亮色、洞里白 → 依然抓（老守卫的路径不能退化）', async () => {
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const mask = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);

    // 四周中灰，洞里白
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 25 && x < 75 && y >= 25 && y < 75;
        const inRing = (x >= 23 && x < 77 && y >= 23 && y < 77) && !inHole;

        if (inRing) {
          base[i*4] = base[i*4+1] = base[i*4+2] = 80; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 80; filled[i*4+3] = 255;
        } else if (inHole) {
          base[i*4+3] = 0;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 250; filled[i*4+3] = 255;
          mask[i] = 1;
        }
      }
    }

    const maskData = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) maskData[i] = mask[i] ? 255 : 0;

    const fb = resolveHoleFills(base, filled, maskData, exterior, W, H);

    let fixedN = 0;
    for (let y = 25; y < 75; y++) {
      for (let x = 25; x < 75; x++) {
        const i = y * W + x;
        if (fb[i]) fixedN++;
      }
    }
    assert.ok(fixedN > 0, '近白也该被抓住（老守卫路径不退化）');
  });

  it('四周中灰、洞里黑白混合 → 逐像素替换', async () => {
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const mask = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);

    // 洞 40x40，四周 rgb(90,90,90)，洞里奇偶行黑白相间
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 30 && x < 70 && y >= 30 && y < 70;
        const inRing = (x >= 28 && x < 72 && y >= 28 && y < 72) && !inHole;

        if (inRing) {
          base[i*4] = base[i*4+1] = base[i*4+2] = 90; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 90; filled[i*4+3] = 255;
        } else if (inHole) {
          base[i*4+3] = 0;
          const val = (y % 2 === 0) ? 8 : 240;  // 偶数行黑、奇数行白
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = val; filled[i*4+3] = 255;
          mask[i] = 1;
        }
      }
    }

    const maskData = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) maskData[i] = mask[i] ? 255 : 0;

    const fb = resolveHoleFills(base, filled, maskData, exterior, W, H);

    // 所有异常像素（黑和白）都该被替换
    for (let y = 30; y < 70; y++) {
      for (let x = 30; x < 70; x++) {
        const i = y * W + x;
        assert.ok(fb[i] !== null, `黑白混合，都该替换`);
        assert.deepEqual(fb[i], [90, 90, 90]);
      }
    }
  });
});

describe('resolveHoleFills 深度分层守卫（第 7 个参数 depthGuard）', () => {
  it('depthGuard 标出的像素不能当参照色来源', () => {
    const W2 = 60, H2 = 60;
    const base = Buffer.alloc(W2 * H2 * 4);
    const filled = Buffer.alloc(W2 * H2 * 4);
    const maskData = new Uint8Array(W2 * H2);
    const exterior = new Uint8Array(W2 * H2);
    const depthGuard = new Uint8Array(W2 * H2);

    /*
     * 布局：中间 20x20 的洞（25..45）。
     * 洞的左侧紧邻是"干净内容" rgb(100,100,100)，
     * 右侧紧邻是"被深度挖过的位置" rgb(200,10,10)——如果它被当参照，
     * 算出来的 ring 会偏红。守卫必须把它排除。
     */
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const i = y * W2 + x;
        const inHole = x >= 25 && x < 45 && y >= 25 && y < 45;
        if (inHole) {
          base[i*4+3] = 0;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 250;  // 模型补白
          maskData[i] = 255;
          continue;
        }
        // 洞外：右侧是"被挖过的位置"（alpha 仍然不透明，模拟补图后重跑）
        const rightOfHole = x >= 45 && x < 50 && y >= 25 && y < 45;
        const leftOfHole  = x >= 20 && x < 25 && y >= 25 && y < 45;
        if (rightOfHole) {
          base[i*4] = 200; base[i*4+1] = 10; base[i*4+2] = 10; base[i*4+3] = 255;
          filled[i*4] = 200; filled[i*4+1] = 10; filled[i*4+2] = 10; filled[i*4+3] = 255;
          depthGuard[i] = 1;   // 标成"深度擦除挖过"
        } else if (leftOfHole) {
          base[i*4] = base[i*4+1] = base[i*4+2] = 100; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 100; filled[i*4+3] = 255;
        } else {
          base[i*4] = base[i*4+1] = base[i*4+2] = 100; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 100; filled[i*4+3] = 255;
        }
      }
    }

    // 带守卫：参照应该只有干净的中灰，不含红色
    const fbGuarded = resolveHoleFills(base, filled, maskData, exterior, W2, H2, depthGuard);
    let fixedN = 0;
    for (let i = 0; i < W2*H2; i++) {
      if (fbGuarded[i]) {
        fixedN++;
        assert.equal(fbGuarded[i][0], 100, '参照不该被挖过的红色污染');
        assert.equal(fbGuarded[i][1], 100);
        assert.equal(fbGuarded[i][2], 100);
      }
    }
    assert.ok(fixedN > 0, '洞里的白应该被兜底');

    // 不带守卫（老行为）：红色会参与平均，R 明显偏高
    const fbUnguarded = resolveHoleFills(base, filled, maskData, exterior, W2, H2);
    let unguardedR = null;
    for (let i = 0; i < W2*H2; i++) if (fbUnguarded[i]) { unguardedR = fbUnguarded[i][0]; break; }
    assert.ok(unguardedR !== null, '不带守卫时也该抓到白填充');
    assert.ok(unguardedR > 100, `老行为会把挖过的红算进去（实测 R=${unguardedR}），这正是要修掉的`);
  });

  it('depthGuard 传 null 时行为与老代码一致', () => {
    const W2 = 40, H2 = 40;
    const base = Buffer.alloc(W2 * H2 * 4);
    const filled = Buffer.alloc(W2 * H2 * 4);
    const maskData = new Uint8Array(W2 * H2);
    const exterior = new Uint8Array(W2 * H2);

    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const i = y * W2 + x;
        const inHole = x >= 15 && x < 25 && y >= 15 && y < 25;
        if (inHole) {
          base[i*4+3] = 0;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 250;
          maskData[i] = 255;
        } else {
          base[i*4] = base[i*4+1] = base[i*4+2] = 60; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 60; filled[i*4+3] = 255;
        }
      }
    }

    const a = resolveHoleFills(base, filled, maskData, exterior, W2, H2, null);
    const b = resolveHoleFills(base, filled, maskData, exterior, W2, H2);
    for (let i = 0; i < W2*H2; i++) {
      assert.deepEqual(a[i], b[i], `下标 ${i} 处 null 守卫应与省略参数一致`);
    }
  });
});

describe('resolveHoleFills 中暗色环守卫（ring max 26-40）', () => {
  // 实测场景：ring=rgb(29,22,33) max=33，洞里填成 rgb(0,0,0)~rgb(25,25,25)。
  // 旧代码：ringIsDark=true 那个分支只替换近白，近黑被放过。
  // 新代码：ring 本身不是近黑（max>25），近黑填充就是补砸，应替换。
  it('ring 中暗（max=33）、洞里近黑 → 替换为参照色', () => {
    const W = 20, H = 20;
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const maskData = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 7 && x < 13 && y >= 7 && y < 13;
        if (inHole) {
          base[i*4+3] = 0;
          // filled with near-black (max=8)
          filled[i*4] = 8; filled[i*4+1] = 6; filled[i*4+2] = 8; filled[i*4+3] = 255;
          maskData[i] = 255;
        } else {
          // surround: rgb(29,22,33) — medium-dark, max=33 > 25
          base[i*4] = 29; base[i*4+1] = 22; base[i*4+2] = 33; base[i*4+3] = 255;
          filled[i*4] = 29; filled[i*4+1] = 22; filled[i*4+2] = 33; filled[i*4+3] = 255;
        }
      }
    }

    const result = resolveHoleFills(base, filled, maskData, exterior, W, H);
    let fixed = 0, untouched = 0;
    for (let y = 7; y < 13; y++) {
      for (let x = 7; x < 13; x++) {
        const i = y * W + x;
        if (result[i] !== null) fixed++;
        else untouched++;
      }
    }
    assert.strictEqual(untouched, 0, `${untouched}px 近黑应被替换但没有`);
    assert.ok(fixed > 0, '应有像素被替换');
    // Verify replacement color is close to the ring reference
    const sample = result[7 * W + 7];
    assert.ok(sample !== null);
    assert.ok(Math.abs(sample[0] - 29) <= 5 && Math.abs(sample[1] - 22) <= 5, `替换色应接近 rgb(29,22,33)，实际 rgb(${sample})`);
  });

  it('ring 真近黑（max=20）、洞里近黑 → 保持不动（正常暗色）', () => {
    const W = 20, H = 20;
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const maskData = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 7 && x < 13 && y >= 7 && y < 13;
        if (inHole) {
          base[i*4+3] = 0;
          filled[i*4] = 5; filled[i*4+1] = 3; filled[i*4+2] = 5; filled[i*4+3] = 255;
          maskData[i] = 255;
        } else {
          // truly near-black surround: max=20
          base[i*4] = 20; base[i*4+1] = 15; base[i*4+2] = 18; base[i*4+3] = 255;
          filled[i*4] = 20; filled[i*4+1] = 15; filled[i*4+2] = 18; filled[i*4+3] = 255;
        }
      }
    }

    const result = resolveHoleFills(base, filled, maskData, exterior, W, H);
    let replaced = 0;
    for (let y = 7; y < 13; y++) {
      for (let x = 7; x < 13; x++) {
        if (result[y * W + x] !== null) replaced++;
      }
    }
    assert.strictEqual(replaced, 0, `ring 本身近黑时不应替换近黑填充，但替换了 ${replaced}px`);
  });
});

describe('resolveHoleFills 脏白门槛（215）', () => {
  // 实测：底板 erased 区有 rgb(220~225) 的浅灰，源图那里是暗色 (lum 64-67)。
  // 门槛 225 抓不到，在深色袖子上就是一排白点。
  it('四周暗、洞里 rgb(220) 脏白 → 应替换（门槛已降到 215）', () => {
    const W = 20, H = 20;
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const maskData = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 7 && x < 13 && y >= 7 && y < 13;
        if (inHole) {
          base[i*4+3] = 0;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 220;  // 脏白：卡在 225 之下
          filled[i*4+3] = 255;
          maskData[i] = 255;
        } else {
          base[i*4] = 69; base[i*4+1] = 55; base[i*4+2] = 73; base[i*4+3] = 255;
          filled[i*4] = 69; filled[i*4+1] = 55; filled[i*4+2] = 73; filled[i*4+3] = 255;
        }
      }
    }

    const result = resolveHoleFills(base, filled, maskData, exterior, W, H);
    let replaced = 0;
    for (let y = 7; y < 13; y++) {
      for (let x = 7; x < 13; x++) if (result[y * W + x] !== null) replaced++;
    }
    assert.strictEqual(replaced, 36, `36px 脏白应全部替换，实际替换 ${replaced}px`);
  });

  it('洞里 rgb(230) 真白、四周亮 → 保持不动（老路径不退化）', () => {
    const W = 20, H = 20;
    const base = Buffer.alloc(W * H * 4);
    const filled = Buffer.alloc(W * H * 4);
    const maskData = new Uint8Array(W * H);
    const exterior = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inHole = x >= 7 && x < 13 && y >= 7 && y < 13;
        if (inHole) {
          base[i*4+3] = 0;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 230;
          filled[i*4+3] = 255;
          maskData[i] = 255;
        } else {
          // 四周也是白的（眼白那种）→ ringIsWhite，不应改
          base[i*4] = base[i*4+1] = base[i*4+2] = 240; base[i*4+3] = 255;
          filled[i*4] = filled[i*4+1] = filled[i*4+2] = 240; filled[i*4+3] = 255;
        }
      }
    }

    const result = resolveHoleFills(base, filled, maskData, exterior, W, H);
    let replaced = 0;
    for (let y = 7; y < 13; y++) {
      for (let x = 7; x < 13; x++) if (result[y * W + x] !== null) replaced++;
    }
    assert.strictEqual(replaced, 0, `四周本来就白时不该替换，实际替换 ${replaced}px`);
  });
});
