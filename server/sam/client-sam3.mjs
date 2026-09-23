/**
 * SAM 3 常驻进程的客户端。
 *
 * 和 client.mjs（MobileSAM）是平行关系，**不是**它的子类或替代：
 * 两条路各自独立，由 segment.mjs 按配置选择。分开写而不是抽象成一个
 * 基类，是因为两者的超时参数差一个数量级（MobileSAM 单部件 10~25ms，
 * SAM 3 单部件约 4.5s），共用一个超时值必然有一边不合适。
 *
 * 三个必须处理好的失败路径（与 client.mjs 同样的三条，理由见那边的注释）：
 *   1. 环境没装      —— 明确告知怎么装，退回多边形方案，不让整个生成失败
 *   2. 启动慢        —— SAM 3 要加载 3.4GB 权重，实测约 9s，靠 ready 信号判断
 *   3. worker 崩溃   —— 拒绝所有 pending，下次调用重新拉起
 *
 * 空闲超时比 MobileSAM 短（3 分钟 vs 10 分钟）：这个 worker 占着约 1.9GB
 * 显存和 3.4GB 内存，闲置时早还早好。重新拉起约 9s，比一直占着划算。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { sam3Paths, checkSam3 } from './setup-sam3.mjs';

/**
 * 启动 + 加载权重的耐心上限。
 * 实测加载 9.2s，但首次从磁盘冷读 3.4GB 可能慢得多（尤其是机械盘或
 * 内存吃紧需要换页时），给到 180s。
 */
const READY_TIMEOUT_MS = 180_000;
/** 单次请求超时。实测每提示词约 4.5s，9 个部件一趟约 41s，给足余量 */
const REQUEST_TIMEOUT_MS = 300_000;
/** 空闲多久关掉 worker。这个进程占地大，比 MobileSAM 短 */
const IDLE_MS = 3 * 60 * 1000;

export class Sam3Client {
  constructor(opts = {}) {
    this.proc = null;
    this.ready = false;
    this.readyPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.device = opts.device;
    this.onLog = opts.onLog ?? ((msg) => console.log(msg));
    this.envOk = null;
    this.lastError = null;
    this.stats = { encodes: 0, cacheHits: 0, segments: 0, restarts: 0 };
  }

  /**
   * 环境是否就绪。
   *
   * 只查文件是否存在，**不 import torch** —— 后者要 3 秒多，不该压在
   * 每次生成的路径上。真正的可用性由 worker 的 ready 信号保证。
   */
  checkEnv() {
    const p = sam3Paths();
    const cfg = ['config.json', 'processor_config.json', 'tokenizer.json']
      .every((f) => existsSync(p.home + '/' + f));
    const ok = existsSync(p.python) && existsSync(p.weights) && cfg;
    this.envOk = ok;
    return ok;
  }

  async ensureReady() {
    if (this.ready && this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return;
    }
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      if (!this.checkEnv()) {
        throw new Error(
          'SAM 3 环境未安装。运行 `node server/sam/setup-sam3.mjs` 自动安装（约 4GB，一次性）'
        );
      }
      const p = sam3Paths();
      const args = [p.python, p.worker, p.home];
      if (this.device) args.push(this.device);

      this.onLog('[sam3] 启动 worker（加载 3.4GB 权重，约 10 秒）…');
      const proc = spawn(args[0], args.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONWARNINGS: 'ignore' },
      });
      this.proc = proc;

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => this._onLine(line));

      const errRl = createInterface({ input: proc.stderr });
      errRl.on('line', (line) => {
        // transformers 会往 stderr 写各种 deprecation 警告，逐条转出来太吵，
        // 只放行看起来像错误/异常的行
        const t = line.trim();
        if (!t) return;
        if (/error|exception|traceback|failed|killed/i.test(t)) {
          this.onLog(`[sam3:err] ${t}`);
        }
      });

      proc.on('exit', (code, signal) => {
        this.ready = false;
        this.proc = null;
        this.readyPromise = null;
        const err = new Error(`SAM 3 worker 退出（code=${code} signal=${signal}）`);
        for (const [, { reject, timer }] of this.pending) {
          clearTimeout(timer);
          reject(err);
        }
        this.pending.clear();
        if (code !== 0 && code !== null) {
          this.onLog(`[sam3] ⚠ worker 异常退出 code=${code}，下次调用会重新拉起`);
        }
      });

      proc.on('error', (e) => {
        this.onLog(`[sam3] ✗ 无法启动 worker: ${e.message}`);
      });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`SAM 3 worker ${READY_TIMEOUT_MS / 1000}s 内未就绪，已放弃`));
        }, READY_TIMEOUT_MS);

        const onReady = (info) => {
          clearTimeout(timer);
          this.ready = true;
          this.deviceInfo = info;
          this.onLog(
            `[sam3] ✓ 就绪，设备 ${info.device}（${info.dtype}），模型加载 ${info.loadSec}s`
          );
          resolve();
        };
        this._onReady = onReady;
        this._readyTimeout = timer;
      });
    })().catch((e) => {
      this.readyPromise = null;
      this.lastError = e.message;
      throw e;
    });

    return this.readyPromise;
  }

  _onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      /*
       * 不是 JSON —— 是 worker 之外的东西抢了 stdout。
       *
       * 实测 transformers 会往 **stdout**（不是 stderr）打这么一行：
       *   [ERROR] `image_like_kwargs` is part of BaseImageProcessor.preprocess's
       *   signature, but not documented. Make sure to add it to the docstring...
       * 它是 BaseImageProcessor 的自检输出，纯文档层面的抱怨，和本次分割
       * 毫无关系。但它以 "[ERROR]" 开头，照关键词放行的写法必然把它漏出去，
       * 让人以为分割炸了。所以这里**反过来**：默认挡掉，只放行已知的真故障形状。
       *
       * 已知的真故障形状只有两类：
       *   · 我们自己的协议行坏掉了（以 { 开头却解析不了）
       *   · Python 的异常栈（Traceback / 以 Error、Exception 结尾的那一行）
       * 其余一律算噪音，但留个痕——出问题时能证明它是被拦下的而不是没发生。
       */
      if (line.startsWith('{')) {
        this.onLog(`[sam3] 响应不是合法 JSON：${line.slice(0, 300)}`);
        return;
      }
      if (/^traceback\b/i.test(line) || /^(\w+Error|\w+Exception):/.test(line)) {
        this.onLog(`[sam3] ${line}`);
        return;
      }
      this.stats.suppressed = (this.stats.suppressed || 0) + 1;
      this.lastSuppressed = line.slice(0, 200);
      return;
    }

    if (msg.id === 0 && msg.ready) {
      if (this._onReady) this._onReady(msg);
      return;
    }
    if (msg.id === 0 && msg.fatal) {
      if (this._readyTimeout) clearTimeout(this._readyTimeout);
      this.onLog(`[sam3] ✗ ${msg.error}`);
      if (msg.trace) this.onLog(msg.trace);
      this.lastError = msg.error;
      return;
    }

    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error || 'worker 返回失败'));
  }

  _send(req, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SAM 3 请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  _touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.onLog(`[sam3] 空闲 ${this.idleMs / 60000} 分钟，关闭 worker 释放内存`);
      this.stop();
    }, this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /**
   * 给一批部件出掩码。
   *
   * @param {string} imagePath - 源图绝对路径
   * @param {Array<{name:string, bbox?:{x,y,width,height}}>} parts
   * @returns {Promise<Map<string, {png, width, height, area, score, coverage, presence}>>}
   *          mask 是源图尺寸的单通道灰度 PNG，255 = 属于该部件
   *
   * 与 MobileSAM 的差异：bbox 在这里是**可选**的。它不再用作提示词，
   * 只在一次提示返回多个实例时用来选哪一个（比如 "eye" 返回左右眼）。
   * 所以 AI 那边 bbox 给得糙一点，对 SAM 3 的影响远小于对 MobileSAM。
   */
  async segment(imagePath, parts) {
    await this.ensureReady();
    this._touchIdle();

    const reqParts = parts.map((p) => ({
      name: p.name,
      // 没 bbox 就不传，worker 会退化成"选面积最大的实例"
      box: p.bbox
        ? [p.bbox.x, p.bbox.y, p.bbox.x + p.bbox.width, p.bbox.y + p.bbox.height]
        : null,
    }));

    const resp = await this._send({ cmd: 'segment', image: imagePath, parts: reqParts });
    this.stats.segments += reqParts.length;

    const out = new Map();
    for (const m of resp.masks) {
      if (m.error) {
        this.onLog(`[sam3] ⚠ ${m.name} 分割失败: ${m.error}`);
        continue;
      }
      if (m.empty) {
        // 没命中不是错误 —— "图里没有眼镜"是完全合法的结果。
        // 这里**不放进返回的 Map**：调用方（cutter.js）拿到条目就假定
        // entry.png 是一张能解码的 PNG，给它一个 null 会让它走进
        // 「解码失败」分支，打出误导性的日志。让这个部件干脆不存在，
        // 调用方自然走「没掩码 → 退回多边形」那条正常路径。
        //
        // presence 是模型自己的"图里有没有这个东西"判断，和 score 不同：
        // 前者回答"有没有"，后者回答"切得准不准"。日志里带上，便于区分
        // 「图上确实没有」和「有但没切出来」。
        this.onLog(`[sam3] · ${m.name}: ${m.reason}`);
        continue;
      }
      out.set(m.name, {
        png: Buffer.from(m.png, 'base64'),
        width: m.width,
        height: m.height,
        area: m.area,
        score: m.score,
        coverage: m.coverage,
        presence: m.presence,
        candidates: m.candidates,
        decodeSec: m.decodeSec,
      });
    }
    return out;
  }

  /** 只做预热，不分割。把 worker 拉起和权重加载藏进 AI 分析时间里 */
  async warmup(imagePath) {
    await this.ensureReady();
    this._touchIdle();
    const resp = await this._send({ cmd: 'encode', image: imagePath });
    if (resp.cached) this.stats.cacheHits++;
    else this.stats.encodes++;
    return resp.encodeSec;
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.stdin.write(JSON.stringify({ id: this.nextId++, cmd: 'shutdown' }) + '\n');
      } catch { /* 已经死了就算了 */ }
      const proc = this.proc;
      setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
      }, 3000).unref?.();
      this.proc = null;
      this.ready = false;
      this.readyPromise = null;
    }
  }
}

let singleton = null;
export function getSam3Client(opts) {
  if (!singleton) {
    singleton = new Sam3Client(opts);
    const cleanup = () => singleton?.stop();
    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  }
  return singleton;
}

/** 关掉全局 client 并清空单例。测试用，理由见 client.mjs 的对应注释 */
export function stopSam3Client() {
  if (singleton) {
    singleton.stop();
    singleton = null;
  }
}

export { sam3Paths, checkSam3 };
