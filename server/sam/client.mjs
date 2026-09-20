/**
 * MobileSAM 常驻进程的客户端。
 *
 * 「自动启动」的含义在这里：第一次有人要分割时，客户端自己去起 Python
 * worker，不用用户记任何命令。之后一直复用同一个进程。
 *
 * 三个必须处理好的失败路径，否则这个功能会变成"偶尔整条生成流程卡死"：
 *
 *   1. 环境没装   —— 启动前先 readiness 检查，没装就明确告知怎么装，
 *                    并且**退回现役多边形方案**，不让整个生成失败。
 *   2. 第一次调用慢 —— worker 要 import torch、加载权重，约 2 秒。
 *                    靠 worker 发出的 {"ready":true} 信号判断，不靠 sleep。
 *   3. worker 崩溃 —— 挂掉后把 pending 请求全部拒绝，下次调用重新拉起。
 *                    不能让请求永远挂着等一个已经死掉的进程。
 *
 * 空闲超时：默认 10 分钟没请求就关掉进程，把 585MB 的内存还给系统。
 * 下次要用再拉起来（约 2 秒），这个代价比一直占着内存划算。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { paths, setup, check } from './setup.mjs';

/** worker 启动 + 首次加载模型的耐心上限 */
const READY_TIMEOUT_MS = 120_000;
/** 单次请求的超时。编码一张 1024 图约 0.1s，解码十几毫秒，60s 已极宽松 */
const REQUEST_TIMEOUT_MS = 60_000;
/** 空闲多久关掉 worker */
const IDLE_MS = 10 * 60 * 1000;

export class SamClient {
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
    /** 环境检查结果：null = 还没查过 */
    this.envOk = null;
    this.lastError = null;
    /** 统计，便于诊断 */
    this.stats = { encodes: 0, cacheHits: 0, segments: 0, restarts: 0 };
  }

  /**
   * 环境是否就绪。只查文件是否存在，不 import torch——
   * 后者要 1 秒多，不该压在每次生成的路径上。
   */
  checkEnv() {
    const p = paths();
    const ok = existsSync(p.python) &&
      existsSync(p.repo + '/mobile_sam/__init__.py') &&
      existsSync(p.weights);
    this.envOk = ok;
    return ok;
  }

  /** 启动 worker 并等它报 ready。并发调用共享同一个 promise，不会起两个进程 */
  async ensureReady() {
    if (this.ready && this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return;
    }
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      if (!this.checkEnv()) {
        throw new Error(
          'MobileSAM 环境未安装。运行 `node server/sam/setup.mjs` 自动安装（约 800MB，一次性）'
        );
      }
      const p = paths();
      const args = [p.python, new URL('./worker.py', import.meta.url).pathname,
        p.weights, p.repo];
      if (this.device) args.push(this.device);

      this.onLog('[sam] 启动 MobileSAM worker…');
      const proc = spawn(args[0], args.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        // worker 的 stderr 单独收，别和协议用的 stdout 混在一起
        env: { ...process.env, PYTHONWARNINGS: 'ignore' },
      });
      this.proc = proc;

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => this._onLine(line));

      // worker 往 stderr 写的东西是它的日志/警告，转出来便于排查
      const errRl = createInterface({ input: proc.stderr });
      errRl.on('line', (line) => {
        if (line.trim()) this.onLog(`[sam:err] ${line}`);
      });

      proc.on('exit', (code, signal) => {
        this.ready = false;
        this.proc = null;
        this.readyPromise = null;
        // 进程没了，所有等着的请求不能永远挂着
        const err = new Error(`MobileSAM worker 退出（code=${code} signal=${signal}）`);
        for (const [, { reject, timer }] of this.pending) {
          clearTimeout(timer);
          reject(err);
        }
        this.pending.clear();
        if (code !== 0 && code !== null) {
          this.onLog(`[sam] ⚠ worker 异常退出 code=${code}，下次调用会重新拉起`);
        }
      });

      proc.on('error', (e) => {
        this.onLog(`[sam] ✗ 无法启动 worker: ${e.message}`);
      });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`MobileSAM worker ${READY_TIMEOUT_MS / 1000}s 内未就绪，已放弃`));
        }, READY_TIMEOUT_MS);

        const onReady = (info) => {
          clearTimeout(timer);
          this.ready = true;
          this.onLog(
            `[sam] ✓ 就绪，设备 ${info.device}，模型加载 ${info.loadSec}s`
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
      // worker 理论上只输出 JSON，混进别的东西时当日志看
      this.onLog(`[sam] ${line}`);
      return;
    }

    if (msg.id === 0 && msg.ready) {
      if (this._onReady) this._onReady(msg);
      return;
    }
    if (msg.id === 0 && msg.fatal) {
      // 加载失败：worker 马上就要退出了，直接把错误交给等待方
      if (this._readyTimeout) clearTimeout(this._readyTimeout);
      this.onLog(`[sam] ✗ ${msg.error}`);
      if (msg.trace) this.onLog(msg.trace);
      // exit 事件会兜底拒绝 pending，这里只需要让 ready 的等待方失败
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
        reject(new Error(`MobileSAM 请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  _touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.onLog(`[sam] 空闲 ${this.idleMs / 60000} 分钟，关闭 worker 释放内存`);
      this.stop();
    }, this.idleMs);
    // 别让这个定时器拖住 Node 进程退出
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /**
   * 给一批部件出掩码。
   *
   * @param {string} imagePath - 源图绝对路径
   * @param {Array<{name:string, bbox:{x,y,width,height}}>} parts
   * @returns {Promise<Map<string, {mask: Buffer, width, height, area, score, coverage}>>}
   *          mask 是单通道灰度缓冲，255 = 属于该部件
   */
  async segment(imagePath, parts) {
    await this.ensureReady();
    this._touchIdle();

    const reqParts = parts.map((p) => ({
      name: p.name,
      box: [p.bbox.x, p.bbox.y, p.bbox.x + p.bbox.width, p.bbox.y + p.bbox.height],
    }));

    const resp = await this._send({ cmd: 'segment', image: imagePath, parts: reqParts });
    this.stats.segments += reqParts.length;

    const out = new Map();
    for (const m of resp.masks) {
      if (m.error) {
        this.onLog(`[sam] ⚠ ${m.name} 分割失败: ${m.error}`);
        continue;
      }
      out.set(m.name, {
        // 掩码 PNG 交给调用方解码：worker 不做二次处理，
        // 保持"掩码就是掩码"的简单契约
        png: Buffer.from(m.png, 'base64'),
        width: m.width,
        height: m.height,
        area: m.area,
        score: m.score,
        coverage: m.coverage,
        decodeSec: m.decodeSec,
      });
    }
    return out;
  }

  /** 只做编码，不分割。预热用——生成流程一开始就调，把编码开销藏进 AI 分析时间里 */
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
      // 给它 2 秒体面退出，然后强杀
      const proc = this.proc;
      setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
      }, 2000).unref?.();
      this.proc = null;
      this.ready = false;
      this.readyPromise = null;
    }
  }
}

/** 进程退出时别留下孤儿 Python 进程 */
let singleton = null;
export function getSamClient(opts) {
  if (!singleton) {
    singleton = new SamClient(opts);
    const cleanup = () => singleton?.stop();
    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  }
  return singleton;
}

/**
 * 关掉全局 client 并清空单例。
 *
 * 测试和长时间运行的脚本需要它：worker 子进程的 stdio 管道会让 Node
 * 的事件循环一直有活动句柄，进程退不出去。实测跑测试时因此卡满 10 分钟
 * 的空闲超时。进程自己会关（SIGINT/SIGTERM 处理器），但那是"退出时"，
 * 测试是在"退出前"就要清干净。
 */
export function stopSamClient() {
  if (singleton) {
    singleton.stop();
    singleton = null;
  }
}

export { paths, setup, check };
