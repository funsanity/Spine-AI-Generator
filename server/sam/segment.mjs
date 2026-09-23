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
import { getSam3Client } from './client-sam3.mjs';

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

/**
 * 选哪个分割器。
 *
 *   mobilesam（默认）—— 框提示。快（每部件 10~25ms）、环境小（585MB），
 *                        但框里装了两件东西时会挑错：实测眼镜切成整张脸。
 *   sam3            —— 文本提示。慢（每部件约 4.5s）、环境大（4GB），
 *                        但不需要框，眼镜就是眼镜、眼睛就是眼睛。
 *
 * 默认仍是 mobilesam：它是现役路径，且绝大多数图跑得好好的。
 * 换 sam3 是**为了治具体的病**（细碎部件、框里有重物），不是普遍升级。
 *
 * 用 opts.segmenter 或环境变量 SPINE_SEGMENTER 切换。
 */
function resolveSegmenter(opts) {
  const v = opts.segmenter || process.env.SPINE_SEGMENTER || 'mobilesam';
  return String(v).trim().toLowerCase() === 'sam3' ? 'sam3' : 'mobilesam';
}

/* SAM 3 这条路**完全不设覆盖率门槛**，连很低的兜底下限都不要。
 *
 * 这个决定是踩了坑才定的：原本留了个 1% 的下限"兜住掩码塌成几个像素的情况"，
 * 结果它把**正确的**眼镜掩码杀掉了 —— 覆盖率 0.9%，刚好卡在门槛之下。
 * 眼镜本来就只占整张画布约 0.5%，它小不是因为切错了，而是因为它就是小。
 *
 * 更根本的问题是：没有 bbox 时覆盖率的分母会退化成整张图的不透明像素，
 * 而那些像素大部分属于身体的其它部位。这个数字衡量的是"掩码占整幅画的比例"，
 * 跟切得准不准无关。拿它当判据，越小的部件越容易被误杀 —— 而"细碎部件"
 * 恰恰是换到 SAM 3 的理由，门槛和目的是反的。
 *
 * 真正管用的两道闸在别处，而且都实测校准过：
 *   · worker 侧的得分门槛（0.5）—— 低于它根本不返回结果
 *   · presence_logits —— 模型自己判断"图上有没有这件东西"，判否的部件
 *     在客户端就被挡掉了（实测"backpack" presence=-4.41，正确识别为没有）
 *
 * 这两道闸之外再按面积加判断是多余的：post_process 走的是逐实例置信度，
 * 塌成几个像素的掩码压根到不了这一步。
 */

export async function segmentParts(imagePath, parts, opts = {}) {
  const { useSam = true, onLog = () => {}, requireEnv = false } = opts;

  if (!useSam) return null;

  const segmenter = resolveSegmenter(opts);

  /*
   * 可用的部件。
   *
   * 两边对 bbox 的依赖不同：
   *   MobileSAM 必须有 bbox —— 框就是它的提示词，没有框它无从下手
   *   SAM 3    bbox 可有可无 —— 提示词是部件名，框只在多实例时用来选哪一个
   * 所以 sam3 分支只要求有 name。
   */
  const usable = (parts || []).filter((p) =>
    p && p.name && (segmenter === 'sam3' || (p.bbox && typeof p.bbox.x === 'number'))
  );
  if (!usable.length) {
    onLog(
      segmenter === 'sam3'
        ? '没有可分割的部件（都缺 name）'
        : '没有可分割的部件（都缺 bbox）',
      'info'
    );
    return null;
  }

  if (segmenter === 'sam3') {
    return segmentWithSam3(imagePath, usable, { onLog, requireEnv });
  }
  return segmentWithMobileSam(imagePath, usable, { onLog, requireEnv });
}

/** MobileSAM 路径：框提示，保持原有行为一字不动 */
async function segmentWithMobileSam(imagePath, usable, { onLog, requireEnv }) {
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

/**
 * SAM 3 路径：文本提示。
 *
 * 与 MobileSAM 路径的四处关键差异：
 *
 *   1. **不需要框**。提示词就是部件名，所以 AI 给的 bbox 再糙也不影响结果。
 *      这治的是 MobileSAM 那个治不好的病：框里装了两件东西时它必然挑错。
 *
 *   2. **「模型判定图上没有这件东西」不是失败**。presence_logits 判否的部件
 *      在客户端就被挡掉了（根本不进返回的 Map），于是它们自然走
 *      「没掩码 → 退回多边形」那条正常路径。实测一个不存在的部件
 *      （"backpack"）被正确识别为没有，presence=-4.41。
 *
 *   3. **慢，慢两个数量级**。实测每提示词约 4.5s，8 个部件约 90s。
 *      所以日志里的措辞要让人有心理准备，不能照抄 MobileSAM 的"正在做…"。
 *
 *   4. **不做覆盖率筛选**。理由见文件上方那段注释 —— 那个指标在文本提示
 *      这条路上是纯粹的误伤源，连很低的兜底下限都会杀掉正确的小部件。
 */
async function segmentWithSam3(imagePath, usable, { onLog, requireEnv }) {
  const sam = getSam3Client({ onLog });

  if (!sam.checkEnv()) {
    if (requireEnv) {
      throw new Error('SAM 3 环境未安装');
    }
    onLog(
      '未安装 SAM 3，用 AI 多边形轮廓切图。想装的话运行：node server/sam/setup-sam3.mjs（4GB）',
      'info'
    );
    return null;
  }

  onLog(`正在做像素级部件分割（SAM 3 文本提示，${usable.length} 个部件，约 ${Math.round(usable.length * 4.5)}s）...`, 'progress');
  try {
    const t0 = Date.now();
    const masks = await sam.segment(imagePath, usable);
    const ms = Date.now() - t0;

    if (!masks.size) {
      onLog('⚠ 分割没有产出任何掩码，退回多边形轮廓', 'info');
      return null;
    }

    // 这里**刻意不做筛选**：能进到这个 Map 的掩码都已经过 worker 的
    // 得分门槛（0.5）和 presence 判定，再筛只会误伤小部件。
    // 理由见文件上方关于覆盖率门槛的说明。

    const avgScore = [...masks.values()].reduce((s, m) => s + m.score, 0) / masks.size;
    onLog(
      `✓ 分割完成（SAM 3）：${masks.size}/${usable.length} 个部件，` +
      `耗时 ${(ms / 1000).toFixed(1)}s，平均置信度 ${avgScore.toFixed(2)}`,
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
    onLog(`⚠ 分割失败，退回多边形轮廓：${e.message}`, 'info');
    return null;
  }
}
