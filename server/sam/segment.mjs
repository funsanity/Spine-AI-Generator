/**
 * 部件分割的统一入口：拿到掩码，或在任何失败下干净地返回 null。
 *
 * 这段逻辑原来内联在 generate 路由里，抽出来的理由很实在：
 * 它有一堆失败分支（没装、起不来、部分失败、超时），内联在路由里就只能靠
 * 跑整个生成流程去测，而那个流程要调用 AI、要花钱、要几十秒。
 * 抽成纯函数之后可以用真的 worker 直接测每一条分支。
 *
 * 契约：**永不抛异常**。返回 null 表示"没有得到掩码，请用多边形轮廓"。
 * 调用方不需要处理任何错误情况——生成流程不因为分割失败而中断，
 * 这是这个模块存在的全部意义。
 */

import { getSamClient } from './client.mjs';

/**
 * @param {string} imagePath - 源图路径
 * @param {Array} parts - AI 分析结果里的部件列表（需要 name 和 bbox）
 * @param {object} opts
 * @param {boolean} [opts.useSam=true] - 关掉就直接返回 null，不碰 worker
 * @param {boolean} [opts.requireEnv=false] - true 时没装环境也抛错（测试用）
 * @param {(msg:string, level?:string)=>void} [opts.onLog] - 进度回调
 * @returns {Promise<Map<string, object>|null>}
 */
/**
 * 掩码至少要盖住 bbox 内这个比例的不透明像素，否则视为分割失败。
 * 定标见下面 weak 分支的注释。
 */
const MIN_COVERAGE = 0.15;

export async function segmentParts(imagePath, parts, opts = {}) {
  const { useSam = true, onLog = () => {}, requireEnv = false } = opts;

  if (!useSam) return null;

  const usable = (parts || []).filter(
    (p) => p && p.name && p.bbox && typeof p.bbox.x === 'number'
  );
  if (!usable.length) {
    onLog('没有可分割的部件（都缺 bbox）', 'info');
    return null;
  }

  const sam = getSamClient({ onLog });

  if (!sam.checkEnv()) {
    if (requireEnv) {
      throw new Error('MobileSAM 环境未安装');
    }
    onLog(
      '未安装 MobileSAM，用 AI 多边形轮廓切图。想要像素级效果请运行：node server/sam/setup.mjs',
      'info'
    );
    return null;
  }

  onLog('正在做像素级部件分割（MobileSAM）...', 'progress');
  try {
    const t0 = Date.now();
    const masks = await sam.segment(imagePath, usable);
    const ms = Date.now() - t0;

    if (!masks.size) {
      onLog('⚠ 分割没有产出任何掩码，退回多边形轮廓', 'info');
      return null;
    }

    /*
     * 丢掉「基本没分割出来」的掩码。
     *
     * SAM 在部件和邻件贴合、或者框里塞了两件东西时，会只圈出一小块碎片。
     * 实测 test_role_arbg 那张：left_arm 的掩码只盖住框内不透明像素的 5.4%，
     * right_arm_scissors 只有 3.7%，切出来都是一小团手掌，整条袖子没了；
     * 而 AI 多边形虽然粗，好歹是整条袖子。这种情况下用多边形明显更好。
     *
     * 阈值取 15%：实测 9 个部件里正常的落在 35.2%~79.9%，失败的两个是
     * 3.7% 和 5.4%，中间隔着 30 个百分点，不必卡得很精细。
     *
     * 注意别把「被大面积遮挡」误判成失败：分母只算框内不透明像素，
     * 被前方部件挡住的区域在源图里依然是不透明的，所以真正被挡住很多的部件
     * 覆盖率也不会低到这个程度——hair_bun 整块只有 2353px，覆盖率照样 41.9%。
     */
    const weak = [];
    for (const [name, m] of masks) {
      if (typeof m.coverage === 'number' && m.coverage < MIN_COVERAGE) {
        weak.push(`${name}(${(m.coverage * 100).toFixed(1)}%)`);
        masks.delete(name);
      }
    }
    if (weak.length) {
      onLog(`⚠ 这几个部件的掩码几乎是空的，改用多边形轮廓：${weak.join(', ')}`, 'info');
    }

    if (!masks.size) {
      onLog('⚠ 所有掩码都不可用，退回多边形轮廓', 'info');
      return null;
    }

    const avgScore = [...masks.values()].reduce((s, m) => s + m.score, 0) / masks.size;
    onLog(
      `✓ 分割完成：${masks.size}/${usable.length} 个部件，` +
      `耗时 ${(ms / 1000).toFixed(2)}s，平均置信度 ${avgScore.toFixed(2)}`,
      'success'
    );

    if (masks.size < usable.length) {
      const missing = usable
        .filter((p) => !masks.has(p.name))
        .map((p) => p.name).join(', ');
      onLog(`⚠ 这几个部件没切出掩码，将退回多边形轮廓：${missing}`, 'info');
    }

    return masks;
  } catch (e) {
    // 任何失败都不该中断生成：环境问题、worker 崩溃、超时，一律退化
    onLog(`⚠ 分割失败，退回多边形轮廓：${e.message}`, 'info');
    return null;
  }
}
