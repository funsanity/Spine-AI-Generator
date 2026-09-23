/**
 * Spine AI Generator Web 服务
 *
 * 美术/策划开箱即用的本地服务
 */

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import 'dotenv/config';
import { join, dirname, relative, isAbsolute, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { analyzeImage, classifyImage, DEFAULT_MODEL, REASONING_LEVELS } from './ai/claude.js';
import { listModels } from './ai/models.js';
import { readApiDefaults } from './ai/api-defaults.js';
import { SYNC_MODELS, TASK_MODELS, pickImage, describeImageModels, DEFAULT_IMAGE_MODEL } from './ai/image-models.js';
import { inpaintPart } from './api/inpaint.js';
import { removeBackground } from './api/background.js';
import { generateSkeleton, generateAnimations, exportToSpine } from './api/generator.js';
import { cutImageParts, getImageSize, applyCutGeometry, diagnoseAlignment } from './api/cutter.js';
import { buildBasePlate, basePlatePart, BASE_PLATE_NAME } from './api/baseplate.js';
import { EXPORT_TARGETS, DEFAULT_TARGET, resolveTarget } from './api/targets.js';
import {
  prepareProjectDir, prepareExportDir, listArtifacts, safeName, projectDirOf,
  sourceDirOf, tempDirOf, imagesDirOf, resolveSourceName, targetDirOf
} from './api/workspace.js';
import { writeEnv, readEnv, presenceOf, ENV_PATH } from './api/env-file.js';
import { getSamClient, stopSamClient, check as checkSamEnv } from './sam/client.mjs';
import { getSam3Client, checkSam3 as checkSam3Env } from './sam/client-sam3.mjs';
import { segmentParts } from './sam/segment.mjs';
import { execFile, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { stat, writeFile } from 'fs/promises';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });

/**
 * 提示词模板落点。
 *
 * 放在 config/ 下而不是仓库根：根目录已经堆了十来个脚本和文档，
 * 模板是**配置**（会被用户改、要被备份），和代码分开放才找得到。
 *
 * 兼容旧的根目录位置：只在 config/ 里没有、根目录里有时才用旧的。
 * 老用户升级上来，模板是他们改过的东西，直接读不到等于丢了。
 */
const PROMPT_TEMPLATES_DIR = join(__dirname, '../config');
const PROMPT_TEMPLATES_PATH = join(PROMPT_TEMPLATES_DIR, 'prompt-templates.json');
const LEGACY_PROMPT_TEMPLATES_PATH = join(__dirname, '../prompt-templates.json');
if (!existsSync(PROMPT_TEMPLATES_PATH) && existsSync(LEGACY_PROMPT_TEMPLATES_PATH)) {
  try {
    mkdirSync(PROMPT_TEMPLATES_DIR, { recursive: true });
    renameSync(LEGACY_PROMPT_TEMPLATES_PATH, PROMPT_TEMPLATES_PATH);
    console.log('[模板] 已把 prompt-templates.json 迁到 config/');
  } catch (err) {
    console.warn('[模板] 迁移到 config/ 失败，继续用根目录那份:', err.message);
  }
}
/** 实际读写的路径：迁移失败时回退到旧位置，不让模板功能整个断掉 */
const templatesPathNow = () => (existsSync(PROMPT_TEMPLATES_PATH)
  ? PROMPT_TEMPLATES_PATH
  : LEGACY_PROMPT_TEMPLATES_PATH);

// 存储活跃的 SSE 连接
const logClients = new Set();

/** 本进程的启动时刻。/api/health 带出去，前端用来认「是不是同一个进程」 */
const STARTED_AT = Date.now();

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../web')));
// 切好的部件图片要能直接被前端加载，用来在 Canvas 上组装预览
app.use('/output', express.static(join(__dirname, '../output')));

// 可选导出目标。前端下拉框直接渲染这个，省得两边各维护一份清单
app.get('/api/targets', (req, res) => {
  res.json({
    default: DEFAULT_TARGET,
    targets: Object.entries(EXPORT_TARGETS).map(([id, t]) => ({
      id,
      label: t.label,
      spine: t.spineHeader,
      note: t.note
    }))
  });
});

// API 接入点默认值。前端表单从这里取，不自己写死——
// 换服务商只改 config/api-defaults.json 一处。
app.get('/api/api-defaults', (req, res) => {
  res.json(readApiDefaults());
});

// 可用模型。优先问中转站的 /v1/models，取不到就回退内置清单——
// 列表拿不到不该挡住生成，只是选项少一些。
app.post('/api/models', async (req, res) => {
  const apiKey = req.body?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = req.body?.baseURL || process.env.ANTHROPIC_BASE_URL;

  const result = await listModels({ apiKey, baseURL });

  res.json({
    ...result,
    defaultModel: DEFAULT_MODEL,
    reasoningLevels: Object.entries(REASONING_LEVELS).map(([id, l]) => ({ id, label: l.label })),
    defaultReasoning: 'default'
  });
});

/**
 * 在系统文件管理器里打开输出目录。
 *
 * 浏览器打不开本地目录（file:// 受限，也没有这种 API），只能由本地服务代劳——
 * 这个工具本来就跑在用户自己的机器上，服务端和浏览器是同一台。
 *
 * 用 execFile 而不是 exec：参数以数组传入、不经过 shell，
 * 目录名里的空格、引号、$ 都只会被当成路径的一部分。
 */
const execFileAsync = promisify(execFile);

const FILE_MANAGERS = { darwin: 'open', win32: 'explorer', linux: 'xdg-open' };

app.post('/api/reveal', async (req, res) => {
  const opener = FILE_MANAGERS[process.platform];
  if (!opener) {
    return res.status(400).json({ success: false, error: `当前平台无法打开文件管理器: ${process.platform}` });
  }

  try {
    /*
     * 打开的是工程目录，不是具体的输入图目录。
     *
     * 一个工程下通常躺着好几套素材（角色 A、角色 B……），从「这个工程产出到哪了」
     * 的角度看，一层全看见才有用。想细看某一张，点进去就是。
     */
    const projectDir = projectDirOf(req.body?.outputDir, req.body?.projectName);
    const root = resolve(req.body?.outputDir || './output');

    // 工程目录还没生成过就退到输出根目录——
    // 报「目录不存在」不如直接把上一层打开，用户自己就能看明白
    let dir = null;
    for (const candidate of [projectDir, root]) {
      const info = await stat(candidate).catch(() => null);
      if (info?.isDirectory()) { dir = candidate; break; }
    }

    if (!dir) {
      return res.status(404).json({ success: false, error: `目录不存在: ${projectDir}` });
    }

    try {
      await execFileAsync(opener, [dir]);
    } catch (err) {
      // Windows 的 explorer 打开成功也会退出码 1，这是它的老毛病，不能当失败
      if (!(process.platform === 'win32' && err.code === 1)) throw err;
    }

    broadcastLog(`已在文件管理器中打开: ${dir}`, 'info');
    res.json({ success: true, dir, fallback: dir !== projectDir });
  } catch (error) {
    console.error('[打开目录] 错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 图像生成接口探测。
 *
 * 中转站对各家图像模型的封装并不统一：有的收 JSON、有的收 multipart，
 * 有的要 model 字段、有的按路径区分。与其猜，不如把这几种组合都打一遍，
 * 把原始响应原样带回来——"哪个能出图"只有真跑一次才知道。
 *
 * key 由前端从 localStorage 取、随请求发过来，服务端不落盘也不记日志：
 * 探测结果里只返回生成结果，不回显 key。
 */
app.post('/api/probe-image', async (req, res) => {
  const apiKey = req.body?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = (req.body?.baseURL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');

  if (!apiKey) return res.status(400).json({ error: '缺少 API Key' });
  if (!baseURL) return res.status(400).json({ error: '缺少 Base URL' });

  const PROMPT = 'a solid red square, flat color, no text';
  const attempts = [];

  const record = async (label, model, protocol, run, timeoutMs = 90000) => {
    const started = Date.now();
    try {
      const { httpStatus, body } = await run();
      const item = {
        model, protocol, label, status: httpStatus, ok: httpStatus >= 200 && httpStatus < 300,
        ms: Date.now() - started
      };

      if (item.ok) {
        const img = pickImage(body);
        item.detail = img
          ? `返回图片（${img.kind === 'url' ? 'URL' : 'base64'}）`
          : `200 但没解析出图片，字段: ${Object.keys(body ?? {}).join(', ') || '空'}`;
        if (!img) item.ok = false;
      } else {
        item.detail = (body?.error?.message) || JSON.stringify(body ?? {}).slice(0, 300);
      }

      attempts.push(item);
      return item;
    } catch (err) {
      attempts.push({
        model, protocol, label, status: 0, ok: false, ms: Date.now() - started,
        detail: err.name === 'TimeoutError' ? `超时（>${timeoutMs / 1000}s）` : err.message
      });
    }
  };

  const auth = { Authorization: `Bearer ${apiKey}` };

  /** 发请求并把响应统一解析成 { httpStatus, body } */
  const call = async (url, init, timeoutMs) => {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { httpStatus: r.status, body };
  };

  // --- 1. 同步接口：JSON 文生图。先确认这条路通不通，再谈传图 ---
  for (const m of SYNC_MODELS) {
    await record(`POST /v1/images/generations  model=${m.id}`, m.id, 'sync', () =>
      call(`${baseURL}/v1/images/generations`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.id, prompt: PROMPT, size: '1024x1024' })
      }, 90000));
  }

  // --- 2. 异步任务接口：提交后轮询。轮询也一并测，只提交不算通 ---
  for (const m of TASK_MODELS.slice(0, 2)) {
    await record(`POST /v1/images/create + 轮询  model=${m.id}`, m.id, 'task', async () => {
      const submit = await call(`${baseURL}/v1/images/create`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: m.id,
          input: { prompt: PROMPT, aspect_ratio: '1:1', resolution: '1k', output_format: 'png' }
        })
      }, 60000);

      if (submit.httpStatus !== 200) return submit;

      const taskId = submit.body?.task_id;
      if (!taskId) return { httpStatus: 200, body: { error: { message: '提交成功但没返回 task_id' } } };

      // 轮询到终态。补图最终也要这么等，所以这里把真实耗时测出来
      const deadline = Date.now() + 120000;
      let last = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        last = await call(`${baseURL}/v1/tasks/${taskId}`, { method: 'GET', headers: auth }, 30000);

        const st = last.body?.status;
        if (st === 'success') return last;
        if (st === 'failed') {
          return { httpStatus: 200, body: { error: { message: last.body?.msg || '任务失败' } } };
        }
      }
      return { httpStatus: 408, body: { error: { message: `轮询超时，最后状态: ${last?.body?.status}` } } };
    }, 200000);
  }

  res.json({ baseURL, attempts, models: describeImageModels() });
});

// 补图可用的图像模型清单。探测之前也能拿到，界面上先标「未验证」
app.get('/api/image-models', (req, res) => {
  res.json({ models: describeImageModels() });
});

// 健康检查
//
// pid 是给「重启服务器」用的：重启是「起新进程 + 老进程退出」，
// 光看接口通不通会撞上老进程还没死的窗口期，误判成已经重启好了。
// 比对 pid 变没变才是确定的判据。
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Spine AI Generator',
    pid: process.pid,
    startedAt: STARTED_AT
  });
});

/**
 * 重启服务端自己。
 *
 * 为什么要有这个按钮：这个进程把代码和 .env 都读在内存里了。改完 .env、
 * 或者改完 server/ 下的代码，页面上是看不出来的——之前就吃过亏，页面连着
 * 一个几小时前起的进程，改了半天不生效，还以为是功能坏了。
 *
 * 做法是「先安排好接班人，再自己退场」：
 *
 *   1. 先把响应发出去。进程一退浏览器只会看到连接断开，分不清是重启成功
 *      还是服务崩了，所以响应必须赶在退出之前。
 *   2. 起一个 detached 子进程接管同一个端口。detached + unref 缺一不可：
 *      不然它只是本进程的子进程，本进程一死它跟着走。
 *   3. 子进程带 SPINE_RESTART=1。老进程释放端口要一点时间，子进程直接
 *      listen 会 EADDRINUSE，带上这个标记它会重试几轮再放弃（见文件末尾）。
 *   4. 接班人拉起来了，才关 SAM worker、断 SSE、退出自己。拉不起来就
 *      **原地不动**——宁可没重启，也不能把用户的服务弄没了。
 */
app.post('/api/restart', (req, res) => {
  res.json({ success: true, pid: process.pid, port: PORT });

  // 等一小会儿让响应真的写出去，再动手拆自己
  setTimeout(() => {
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true,
        // 继承 stdio，新进程的输出照旧落在用户原来那个终端（或原来的日志文件）里。
        // 用 'ignore' 的话重启之后服务端就成了哑巴，出错了没处看——
        // 而「重启完看一眼日志」恰恰是这个按钮最常见的用法。
        stdio: 'inherit',
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(PORT), SPINE_RESTART: '1' }
      });
      child.unref();
    } catch (err) {
      console.error(`[重启] 拉起新进程失败，本进程继续服务: ${err.message}`);
      return;
    }
    console.log(`[重启] 已拉起新进程 PID=${child.pid}，本进程 ${process.pid} 退出`);

    // SAM worker 是本进程的子进程，不显式关掉会变成孤儿还占着 585MB
    try { stopSamClient(); } catch { /* 没起来过就没得关 */ }

    // SSE 是长连接，不主动断开 server.close() 永远等不到回调
    for (const c of logClients) { try { c.end(); } catch { /* 已经断了 */ } }
    logClients.clear();

    httpServer.close(() => process.exit(0));
    // keep-alive 的普通连接也可能吊着 close，兜底硬退，别让端口一直占着
    setTimeout(() => process.exit(0), 1500).unref();
  }, 150);
});

/**
 * MobileSAM 分割环境的状态。
 *
 * 前端用它决定要不要显示「开启像素级分割」这个选项，
 * 以及没装的时候提示用户去装。
 *
 * 只查文件是否存在，不 import torch —— 后者要一秒多，
 * 不该压在每次页面加载的路径上。
 */
app.get('/api/sam-status', async (req, res) => {
  try {
    // 当前选的是哪个分割器。默认 mobilesam，用 SPINE_SEGMENTER=sam3 切过去。
    const segmenter = String(process.env.SPINE_SEGMENTER || 'mobilesam').trim().toLowerCase() === 'sam3'
      ? 'sam3' : 'mobilesam';

    if (segmenter === 'sam3') {
      const st = await checkSam3Env();
      const client = getSam3Client();
      return res.json({
        segmenter,
        ...st,
        running: !!(client.proc && client.ready),
        stats: client.stats,
        lastError: client.lastError,
        setupCommand: 'node server/sam/setup-sam3.mjs',
        // 两个环境各自的就绪状态都报，用户想切换时不用自己去翻目录
        alternates: {
          mobilesam: await checkSamEnv().then((s) => s.ok).catch(() => false),
          sam3: st.ok
        }
      });
    }

    const st = await checkSamEnv();
    const client = getSamClient();
    res.json({
      segmenter,
      ...st,
      running: !!(client.proc && client.ready),
      stats: client.stats,
      lastError: client.lastError,
      setupCommand: 'node server/sam/setup.mjs',
      alternates: {
        mobilesam: st.ok,
        sam3: await checkSam3Env().then((s) => s.ok).catch(() => false)
      }
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/**
 * 把设置面板里的配置写进 .env。
 *
 * 只写服务端认的那几个键，用户 .env 里别的内容原样保留。
 *
 * 绝不回传值：返回值只报「哪些键变了」「配没配」「长度多少」。
 * 这个响应会直接进浏览器日志面板，也可能被人截图发出来，
 * key 一旦回显就等于泄漏，没有任何必要——前端本来就是它自己传上来的。
 */
app.post('/api/save-api-config', async (req, res) => {
  try {
    const { apiKey, baseURL } = req.body ?? {};

    if (apiKey === undefined && baseURL === undefined) {
      return res.status(400).json({ success: false, error: '没有要保存的配置' });
    }

    const updates = {};
    // undefined 表示「这次不动这一项」，空串表示「显式清空」
    if (apiKey !== undefined) updates.ANTHROPIC_API_KEY = String(apiKey).trim();
    if (baseURL !== undefined) updates.ANTHROPIC_BASE_URL = String(baseURL).trim();

    const result = await writeEnv(updates);

    // 让当前进程也能立刻用上新配置，不然用户会以为没保存上：
    // dotenv 只在启动时读一次文件，改完不重新赋值的话得重启才生效
    if (updates.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = updates.ANTHROPIC_API_KEY;
    if (updates.ANTHROPIC_BASE_URL) process.env.ANTHROPIC_BASE_URL = updates.ANTHROPIC_BASE_URL;

    if (result.changed.length) {
      broadcastLog(`✓ 已写入 .env：${result.changed.join('、')}`, 'success');
    } else {
      broadcastLog('配置无变化，.env 未改动', 'info');
    }

    res.json({ success: true, path: result.path, changed: result.changed, created: result.created });
  } catch (error) {
    broadcastLog(`✗ 写入 .env 失败: ${error.message}`, 'error');
    console.error('[保存配置] 错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/** .env 现状，只报「配没配」和长度。前端用它显示「已从 .env 读到 key」 */
app.get('/api/api-config', async (req, res) => {
  try {
    const values = await readEnv();
    const effective = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '',
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || ''
    };

    res.json({
      success: true,
      path: ENV_PATH,
      // 文件里存了什么
      file: presenceOf(values),
      // 这个进程实际会用什么。两者不同就说明改了 .env 但还没重启
      effective: presenceOf(effective)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 日志流接口 (SSE)
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  logClients.add(res);

  // 发送连接成功消息 —— 日志窗口的第一句话
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'WELCOME TO FUNSANITY AIGC...' })}\n\n`);

  req.on('close', () => {
    logClients.delete(res);
  });
});

// 广播日志到所有连接的客户端
function broadcastLog(message, type = 'info') {
  const data = JSON.stringify({ type, message, timestamp: Date.now() });
  for (const client of logClients) {
    client.write(`data: ${data}\n\n`);
  }
  console.log(`[${type.toUpperCase()}] ${message}`);
}

/** 静态挂载的输出根目录。只有落在它下面的图片，浏览器才取得到 */
const OUTPUT_ROOT = resolve(join(__dirname, '../output'));

/**
 * 磁盘路径 → 可访问的 URL。
 *
 * 预览要在 Canvas 上贴切图，所以切出来的 PNG 必须能被浏览器 GET 到。
 * 只有 /output 这一处做了静态挂载，用户把输出目录指到别处（比如 /tmp）时
 * 图片就取不到——这时返回 null，让前端明确说「预览拿不到图」，
 * 而不是拼一个必然 404 的地址然后静默显示空白。
 */
function toPublicUrl(diskPath) {
  const abs = isAbsolute(diskPath) ? diskPath : resolve(diskPath);
  const rel = relative(OUTPUT_ROOT, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return `/output/${rel.split(/[/\\]/).join('/')}`;
}

/**
 * 表单字段转数字。multipart 传过来的都是字符串，空值和非法值一律回退默认。
 * 允许 0（bleed=0 表示关掉扩散），所以判的是 Number.isFinite 而不是真值。
 */
function num(value, fallback, { min = 0, max = Infinity } = {}) {
  const n = (value === "" || value == null) ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 主流程：图片 → AI 分析 → 切图 → 生成骨骼+动画
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    // 前端没填 API 配置时，回退到环境变量 / .env，省得每次都手输
    const prompt = req.body.prompt;
    const apiKey = req.body.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    const baseURL = req.body.baseURL || process.env.ANTHROPIC_BASE_URL;
    // 导出目标决定骨架版本：Cocos 3.8 的内置运行时只认 3.8 格式，
    // 版本不匹配运行时会直接拒绝加载，所以不让两者各自选。
    const target = resolveTarget(req.body.target);
    const density = num(req.body.density, 8, { min: 3, max: 24 });
    const margin = num(req.body.margin, 4, { max: 32 });
    const bleed = num(req.body.bleed, 2, { max: 8 });
    const model = req.body.model || DEFAULT_MODEL;
    const reasoning = REASONING_LEVELS[req.body.reasoning] ? req.body.reasoning : 'default';
    // 复选框没勾时 multipart 里根本不会出现这个字段，所以判的是「显式关掉」
    const clean = req.body.clean !== 'false' && req.body.clean !== false;
    // 复选框没勾时字段不出现，所以判"显式关掉"
    const inpaint = req.body.inpaint !== 'false' && req.body.inpaint !== false;
    const imageModel = req.body.imageModel || DEFAULT_IMAGE_MODEL;
    /*
     * 每个部件最多补几次。面板默认 2，上限 5。
     *
     * 补图那边靠孔洞守卫给每一轮打分（守卫救回的像素越多 = 模型画得越离谱），
     * 不合格就从原始切图重补一次，留最好的那一轮。所以这个数字直接乘在
     * 耗时和费用上：2 次的最坏情况是补图阶段翻倍。
     */
    const maxInpaintAttempts = Math.max(1, Math.min(5,
      Math.round(Number(req.body.maxInpaintAttempts)) || 2));
    const tightCut = req.body.tightCut !== 'false' && req.body.tightCut !== false;
    // 剪影吸附默认开，只有显式传 'false' 才关
    const snap = req.body.snap !== 'false' && req.body.snap !== false;
    /*
     * MobileSAM 像素级分割，默认开。
     *
     * 环境没装时会自动降级回多边形方案（见下面的 try/catch），
     * 所以开着是安全的：装了就享受好效果，没装就退回老行为，
     * 不会因为缺依赖让整个生成失败。
     */
    const useSam = req.body.useSam !== 'false' && req.body.useSam !== false;
    const background = req.body.background !== 'false' && req.body.background !== false;

    if (!req.file) {
      return res.status(400).json({ error: '请上传图片' });
    }

    if (!prompt) {
      return res.status(400).json({ error: '请输入提示词' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: '请配置 API Key（界面或 .env 均可）' });
    }

    const imagePath = req.file.path;

    broadcastLog(`开始分析图片: ${req.file.originalname}`, 'info');
    broadcastLog(`提示词: ${prompt}`, 'info');
    broadcastLog(`API 模式: ${baseURL ? '自建网关' : 'Anthropic 直连'}`, 'info');
    broadcastLog(`模型: ${model}（推理等级：${REASONING_LEVELS[reasoning].label}）`, 'info');
    broadcastLog(`导出目标: ${target.label}（spine ${target.spineHeader}）`, 'info');
    broadcastLog(`网格密度: ${density}，补图外扩 ${margin}px，边缘扩散 ${bleed} 轮`, 'info');
    broadcastLog(`切分方式: ${tightCut ? '紧贴轮廓（部件各占自己的区域）' : '按完整轮廓（部件互不重叠拼回原图）'}`, 'info');
    broadcastLog(`剪影吸附: ${snap ? '开（框收紧到部件自己的内容）' : '关（按 AI 给的矩形框切）'}`, 'info');
    if (inpaint) {
      broadcastLog(`部件补图: 开启（模型 ${imageModel}）`, 'info');
      if (!background) {
        broadcastLog('提示: 已关闭去背。源图背景不透明时没有 alpha=0 的区域，补图会全部跳过、一次模型都不调', 'warning');
      }
      if (!tightCut) {
        broadcastLog('提示: 紧贴切分关闭时，被遮挡部分会跟着遮挡者一起动', 'warning');
      }
    } else {
      broadcastLog('部件补图: 关闭（仅做边缘扩散）', 'info');
      if (tightCut) {
        broadcastLog('提示: 紧贴切分已开启但补图关闭，接缝处可能露透明', 'warning');
      }
    }

    /*
     * 0. 去背景。
     *
     * 必须在分析之前做完，因为切图和补图都依赖它：
     *
     *   - 切图用 extract() 切矩形，背景不透明时每个部件都是实心方块，
     *     相邻部件的背景被一起切进来，拼回场景就是一堆白方块互相遮挡。
     *   - 补图判的是 alpha，背景不透明就没有一处 alpha=0，
     *     所有部件都会报「没有需要补的透明区」，功能一次都不会生效。
     *
     * 去背结果直接覆盖上传的临时文件，后面分析、切图读的都是同一份。
     * 文件名和格式都不变（仍是 PNG），所以下游不用知道这一步存在。
     */
    if (background) {
      broadcastLog('正在去除背景...', 'progress');
      try {
        const bg = await removeBackground(imagePath);
        if (bg.skipped && bg.reason === 'already-transparent') {
          broadcastLog('图片已带透明通道，跳过去背', 'info');
        } else if (bg.skipped) {
          broadcastLog('四角颜色不一致，无法判定背景色，跳过去背', 'warning');
        } else {
          await writeFile(imagePath, bg.buffer);
          broadcastLog(
            `✓ 去背完成：清除背景 ${(bg.ratio * 100).toFixed(1)}%，边缘还原 ${bg.feathered} px`,
            'success'
          );
        }
      } catch (err) {
        // 去背失败不该阻断整条流程：原图照样能切、能出骨架，只是带白底
        broadcastLog(`去背失败（继续处理）：${err.message}`, 'warning');
      }
    }

    // 原图尺寸：AI 返回归一化坐标，需要它才能换算成像素
    const imageSize = await getImageSize(imagePath);
    broadcastLog(`原图尺寸: ${imageSize.width} x ${imageSize.height}`, 'info');

    // 1. 图片分类（自动识别类别）
    broadcastLog('正在识别图片类别...', 'progress');
    const category = await classifyImage(imagePath, {
      apiKey,
      baseURL: baseURL || undefined,
      model
    });
    const categoryNames = {
      character: '角色类',
      prop: '道具类',
      effect: '特效类',
      item: '物品类'
    };
    broadcastLog(`✓ 识别为: ${categoryNames[category] || category}`, 'success');

    // 2. 加载模板并拼接
    let finalPrompt = prompt;
    try {
      const tplPath = templatesPathNow();
      if (existsSync(tplPath)) {
        const templates = JSON.parse(readFileSync(tplPath, 'utf-8'));
        const template = templates[category];
        if (template && template.template) {
          finalPrompt = `${template.template}\n\n用户补充：${prompt}`;
          broadcastLog(`已加载 ${categoryNames[category]} 模板`, 'info');
        }
      }
    } catch (err) {
      console.error('[模板] 加载失败:', err);
      // 加载模板失败不应阻塞流程
    }

    // 3. AI 分析图片
    broadcastLog('正在调用 AI 进行图像分析...', 'progress');

    const analysis = await analyzeImage(imagePath, finalPrompt, {
      apiKey,
      baseURL: baseURL || undefined,
      imageSize,
      model,
      reasoning,
      tightCutout: tightCut
    });

    broadcastLog(`✓ AI 分析完成，识别到 ${analysis.parts.length} 个部件`, 'success');

    // 2. 自动切图
    //
    // 产物固定落在 output/<工程名>/<输入图名>/ 下，默认先清掉上一次的：
    // 同名输入图重复生成时，旧的 PNG 会和新的混在一起，而 atlas 已经不再引用它们——
    // 预览看着正常（只读 atlas 有的区域），磁盘上却越堆越多。
    //
    // 清理只针对本次这个输入图目录，同一工程下别的素材（另一张源图）原样不动。
    const projectName = safeName(req.body.projectName || 'generated');
    const outputDir = req.body.outputDir || './output';
    // 输入图名决定子目录名。前端会显式带过来，取不到就从上传文件名推
    const sourceName = req.body.sourceName
      ? safeName(req.body.sourceName)
      : resolveSourceName(req.file.originalname, projectName);

    const workspace = await prepareProjectDir(outputDir, projectName, { clean, sourceName });
    if (workspace.migrated) {
      broadcastLog(`已把上次的产物收进 ${workspace.migrated}/（新的分目录结构）`, 'info');
    }
    if (clean && workspace.removed) {
      broadcastLog(`已清理上次产物：${workspace.removed} 项`, 'info');
    } else if (!clean) {
      broadcastLog('保留旧文件（未开启清理）', 'info');
    }
    broadcastLog(`输出目录: ${workspace.sourceDir}`, 'info');

    broadcastLog('正在切图...', 'progress');
    const imagesDir = workspace.imagesDir;

    // 分割失败不中断生成，内部已兜底，返回值可能是 null
    //
    // segmenter 可以由本次请求指定（界面上切），没给就走 .env 里的
    // SPINE_SEGMENTER，再没有就用默认的 mobilesam。做成按次生效是为了
    // 能同一条 UI 路径切着对比，而不用改 .env 再重启服务。
    const samMasks = await segmentParts(imagePath, analysis.parts, {
      useSam,
      onLog: broadcastLog,
      segmenter: req.body.segmenter
    });

    const cutResults = await cutImageParts(imagePath, analysis.parts, imagesDir,
      { margin, bleed, snap, samMasks });
    broadcastLog(`✓ 切图完成：${cutResults.length}/${analysis.parts.length} 张图片`, 'success');

    // 轮廓来源统计：让用户看得见这次到底走的哪条路
    const byContour = cutResults.reduce((acc, r) => {
      acc[r.contour] = (acc[r.contour] || 0) + 1;
      return acc;
    }, {});
    if (byContour.sam) {
      broadcastLog(
        `✓ 其中 ${byContour.sam} 个部件用了 SAM 像素级掩码` +
        (byContour.polygon ? `，${byContour.polygon} 个用多边形轮廓` : '') +
        (byContour.rect ? `，${byContour.rect} 个退回矩形` : ''),
        'info'
      );
    }

    // 吸附把多少张图从「矩形框」收紧成了「部件轮廓」，报给用户看
    if (snap) {
      const shrunk = cutResults.filter((r) => r.snapped);
      if (shrunk.length) {
        broadcastLog(`✓ 剪影吸附：${shrunk.length} 个部件收紧了框（原来框里带的邻件内容已剔除）`, 'info');
      }
    }

    /*
     * 底板：接住「没有任何部件认领」的源图像素。
     *
     * 部件轮廓只覆盖各自那块，源图上没被任何轮廓圈中的内容会彻底消失——
     * 实测这张角色图 30.1% 的不透明像素就是这么丢掉的（见 api/baseplate.js）。
     * 铺一层底板在所有部件后面，`底板 ∪ 部件 ≡ 源图` 就按构造成立了。
     *
     * 必须在补图**之前**算：补图会往洞里填颜色、改 alpha，那之后再算
     * 「部件认领了哪些像素」就不准了。
     */
    const basePlate = await buildBasePlate(imagePath, cutResults, imagesDir,
      { bleed, onLog: broadcastLog });
    if (basePlate) {
      // 放在最前面 = 绘制顺序最靠后 = 压在所有部件底下
      cutResults.unshift(basePlate);
    }

    /*
     * 对齐诊断。在补图之前跑：这时切图刚出来，切片里的 alpha 还是
     * "切图切出来的形状"，补图会往空洞里填颜色、改变 alpha 分布，
     * 之后再统计出来的 fillRatio 就不是框偏没偏的证据了。
     *
     * 底板不参与：它按定义就是整张画布、大部分是被挖空的洞，
     * fillRatio 必然很低，而「框偏了」对一张满画布的底板没有意义。
     */
    const alignment = await diagnoseAlignment(
      cutResults.filter((r) => r.name !== BASE_PLATE_NAME)
    );
    const offParts = alignment.filter((a) => a.flags?.length);
    if (offParts.length) {
      broadcastLog(
        `⚠ ${offParts.length} 个部件可能框偏了：${offParts.map((a) => a.name).join('、')}（预览里勾"对齐诊断"看图）`,
        'warning'
      );
    }

    /*
     * 部件补图。
     *
     * 放在切图之后、生成骨骼之前：补图只改切片里的像素，不改 bbox，
     * 所以骨骼照旧按补偿后的 bbox 算，两边不会错位。
     *
     * 逐个串行而不是并发：中转站对图像接口大多有并发限制，一把发出去
     * 反而大面积 429，而且串行才能把进度一条条报给用户。
     */
    // failedNames 记下失败的是哪些部件，供「只重跑失败的部件」用
    const inpaintReport = { enabled: inpaint, done: 0, skipped: 0, failed: 0, failedNames: [], startedAt: Date.now() };

    if (inpaint) {
      broadcastLog(
        `开始部件补图，共 ${cutResults.length} 个部件（每个最多 ${maxInpaintAttempts} 次图像调用，` +
        `模型审核不合格才重补）`,
        'progress'
      );

      for (const cut of cutResults) {
        try {
          const r = await inpaintPart(cut.path, {
            apiKey, baseURL: baseURL || undefined, model: imageModel, partName: cut.name,
            occlusionEdges: cut.occlusionEdges,
            maxQualityAttempts: maxInpaintAttempts
          });
          if (r.skipped) {
            inpaintReport.skipped++;
            broadcastLog(`  ○ ${cut.name}: ${r.reason}`, 'info');
          } else {
            inpaintReport.done++;
            // 守卫比例露出来：高的话说明模型在这个部件上画得不好，用户能据此调次数
            const guard = r.guardedFrac > 0.02
              ? `，守卫纠正 ${(r.guardedFrac * 100).toFixed(1)}%`
              : '';
            broadcastLog(`  ✓ ${cut.name}: 补了 ${(r.coverage * 100).toFixed(0)}% 的面积${guard}`, 'info');
          }
        } catch (err) {
          inpaintReport.failed++;
          inpaintReport.failedNames.push(cut.name);
          // 单个部件补图失败不能中断整条流程：退回边缘扩散的结果照样能用
          broadcastLog(`  ✗ ${cut.name} 补图失败: ${err.message}（保留边缘扩散结果）`, 'warning');
        }
      }

      const secs = ((Date.now() - inpaintReport.startedAt) / 1000).toFixed(1);
      broadcastLog(
        `✓ 补图完成：${inpaintReport.done} 成功，${inpaintReport.skipped} 无需补，${inpaintReport.failed} 失败，耗时 ${secs}s`,
        inpaintReport.failed ? 'warning' : 'success'
      );
    }

    // 外扩改了 bbox，骨骼和网格必须按补偿后的 bbox 算，
    // 否则贴图和顶点会差一个 margin。
    // 底板要作为一个部件进骨架：排在最前面，槽位顺序就是绘制顺序，
    // 它才会画在所有部件底下
    const partsWithBase = basePlate
      ? [basePlatePart(imageSize.width, imageSize.height), ...analysis.parts]
      : analysis.parts;
    const geom = { ...analysis, parts: applyCutGeometry(partsWithBase, cutResults) };

    // 3. 生成骨骼结构（像素坐标 → Spine 坐标需要原图尺寸）
    broadcastLog('正在生成骨骼结构...', 'progress');
    const skeleton = generateSkeleton(geom, target.atlasVersion, { imageSize, density });
    generateAnimations(skeleton);
    

    broadcastLog(
      `✓ 骨骼生成完成：${skeleton.bones.length} 个骨骼，${Object.keys(skeleton.animations).length} 个动画`,
      'success'
    );

    // 4. 返回预览数据（骨骼 + 动画 + 切图结果）
    res.json({
      success: true,
      sessionId: Date.now(),
      skeleton,
      // 回 geom 而不是原始 analysis：补图外扩过 bbox，
      // 前端拿到的几何要和骨架里的一致，否则调参重生成会对不上。
      analysis: geom,
      cutResults,
      imageSize,
      target: { id: target.id, label: target.label, spine: target.spineHeader },
      density,
      margin,
      bleed,
      inpaint,
      tightCut,
      snap,
      alignment,
      imageModel,
      inpaintReport,
      model,
      reasoning,
      clean,
      cleanedCount: workspace.removed,
      bones: skeleton.bones.length,
      slots: skeleton.slots.length,
      animations: Object.keys(skeleton.animations),
      projectDir: workspace.projectDir,
      sourceName,
      sourceDir: workspace.sourceDir,
      imagesDir,
      // 前端贴图要用的 URL。磁盘路径在静态目录外时为 null
      imagesUrl: toPublicUrl(imagesDir),
      artifacts: await listArtifacts(workspace.projectDir)
    });

  } catch (error) {
    broadcastLog(`✗ 生成失败: ${error.message}`, 'error');
    console.error('[生成] 错误:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 导出 Spine 工程
/**
 * 只重跑失败的部件。
 *
 * 补图失败是常态：中转站在连续调用时容易甩回瞬时错误。整条流程重跑一次要
 * 5 分钟，还会把已经补成功的部件再补一遍（白花钱、还可能补得不一样），
 * 所以留一个"只补失败的那几个"的入口。
 *
 * 直接对工程 images/ 下已存在的切片重跑，不碰骨骼、不动 bbox——
 * 补图本来就不改尺寸，所以重跑之后骨架不需要重新生成。
 */
app.post('/api/inpaint-retry', async (req, res) => {
  try {
    const apiKey = req.body.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    const baseURL = req.body.baseURL || process.env.ANTHROPIC_BASE_URL;
    const model = req.body.imageModel || DEFAULT_IMAGE_MODEL;
    const names = Array.isArray(req.body.names) ? req.body.names.filter(Boolean) : [];
    /*
     * 重跑时遮挡方向得由前端带回来：切图阶段算的 occlusionEdges 存在前端
     * currentCutResults 里，服务端这份没有留存。丢了它就退化成无定向补图，
     * 补图和首次生成的效果会不一致。
     */
    const occlusionMap = req.body.occlusionMap && typeof req.body.occlusionMap === 'object'
      ? req.body.occlusionMap
      : {};

    if (!apiKey) {
      return res.status(400).json({ error: '请配置 API Key' });
    }
    if (!names.length) {
      return res.status(400).json({ error: '没有指定要重跑的部件' });
    }

    const outputDir = req.body.outputDir || './output';
    const projectName = safeName(req.body.projectName || 'generated');
    /*
     * 重跑的是「某一张输入图」的部件。
     *
     * sourceName 必须是前端生成时拿到的那个——它决定去哪个子目录里找切片。
     * 传丢了就会跑到别的素材目录下乱补一遍，补的还是同名部件，很难发现。
     */
    const sourceName = safeName(req.body.sourceName || projectName);
    const imagesDir = imagesDirOf(outputDir, projectName, sourceName);

    broadcastLog(`开始重跑 ${names.length} 个部件的补图（模型 ${model}）`, 'progress');
    broadcastLog(`切片目录: ${imagesDir}`, 'info');

    const report = { done: 0, skipped: 0, failed: 0, failedNames: [] };

    for (const name of names) {
      // 部件名来自前端，必须先夹到 images 目录内，不然 ../ 就能跑到目录外
      const safe = basename(String(name));
      const partPath = join(imagesDir, `${safe}.png`);

      if (!existsSync(partPath)) {
        report.failed++;
        report.failedNames.push(safe);
        broadcastLog(`  ✗ ${safe}: 找不到切片 ${partPath}`, 'warning');
        continue;
      }

      try {
        const r = await inpaintPart(partPath, {
          apiKey, baseURL: baseURL || undefined, model, partName: safe,
          occlusionEdges: occlusionMap[safe],
          maxQualityAttempts: Math.max(1, Math.min(5,
            Math.round(Number(req.body.maxInpaintAttempts)) || 2))
        });
        if (r.skipped) {
          report.skipped++;
          broadcastLog(`  ○ ${safe}: ${r.reason}`, 'info');
        } else {
          report.done++;
          broadcastLog(`  ✓ ${safe}: 补了 ${(r.coverage * 100).toFixed(0)}% 的面积`, 'info');
        }
      } catch (err) {
        report.failed++;
        report.failedNames.push(safe);
        broadcastLog(`  ✗ ${safe} 补图失败: ${err.message}`, 'warning');
      }
    }

    broadcastLog(
      `✓ 重跑完成：${report.done} 成功，${report.skipped} 无需补，${report.failed} 失败`,
      report.failed ? 'warning' : 'success'
    );

    res.json({ success: true, ...report });

  } catch (error) {
    broadcastLog(`✗ 重跑补图失败: ${error.message}`, 'error');
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/export', async (req, res) => {
  try {
    const { skeleton, outputDir, projectName, cutResults } = req.body;
    const target = resolveTarget(req.body.target);

    if (!skeleton) {
      return res.status(400).json({ error: '缺少骨架数据' });
    }

    /*
     * 导出目录不再单独配置（用户要求合并成一个「输出目录」）。
     *
     * 落点固定是 output/<工程名>/<输入图名>/，下面分两支：
     *   <目标 id>/<输入图名>/   三件套，给引擎直接加载
     *   Spine工程/<输入图名>.spine  源工程，给 Spine 编辑器二次编辑
     * 生成的中间产物在隔壁 <输入图名>_temp/ 里，这次导出不碰它——补图重跑还要读。
     *
     * 清理只清**本次目标那一层**（<输入图名>/<目标 id>/），不清整个
     * <输入图名>/：那一层里并排放着 Spine工程/ 和别的导出目标，
     * 整个清掉会把用户上一轮导出的 Unity 那份和 .spine 一起删了。
     * 重导 Cocos 不该动 Unity，这是用户要的分目标目录的直接含义。
     */
    const sourceName = safeName(req.body.sourceName || projectName || 'generated');
    // 和生成走同一套规范化，否则同一个输入会落到两个目录
    const proj = safeName(projectName || 'generated');
    const outRoot = outputDir || './output';
    const sourceDir = sourceDirOf(outRoot, proj, sourceName);
    const targetDir = targetDirOf(outRoot, proj, sourceName, target.id);
    const name = sourceName;

    const prep = await prepareExportDir(targetDir);
    if (prep.cleared) broadcastLog(`已清空上次的导出目录: ${targetDir}`, 'info');

    /*
     * .spine 里的 images 指向 _temp/Image/——那是最全的一份切图，
     * 而且补图重跑、重新切图后它跟着更新，工程里看到的永远是最新的图。
     *
     * 层数要数清：.spine 落在 <工程名>/<输入图名>/Spine工程/，
     * 而 Image 在 <工程名>/<输入图名>_temp/Image/。从 Spine工程/ 上跳两层
     * 才回到 <工程名>/，所以是 ../../ 开头。少一层就指到
     * <输入图名>/<输入图名>_temp/ 这个不存在的地方，Spine 打开时报
     * "Images path not found"，工程里全是空附件框。
     */
    const spineImagesPath = `../../${sourceName}_temp/Image/`;

    broadcastLog(`正在导出 ${target.label} 工程到: ${targetDir}`, 'progress');

    const result = await exportToSpine(skeleton, sourceDir, name, {
      target: target.id,
      cutResults: Array.isArray(cutResults) ? cutResults : [],
      spineImagesPath,
      spineCliPath: req.body.spineCliPath
    });

    broadcastLog(`✓ 骨架: ${result.skeletonPath}`, 'success');
    if (result.atlas) {
      broadcastLog(
        `✓ 图集: ${result.atlas.atlasPath}（${result.atlas.regions} 区域，${result.atlas.page.width}x${result.atlas.page.height}）`,
        'success'
      );
    } else {
      broadcastLog('未打图集（没有可用切图），运行时可能加载失败', 'warn');
    }
    broadcastLog(`网格 ${result.stats.meshCount} 个，其中加权 ${result.stats.weightedCount} 个`, 'info');

    if (result.spineProject?.path) {
      broadcastLog(`✓ Spine 工程（可二次编辑）: ${result.spineProject.path}`, 'success');
    } else {
      // 少这一件不影响三件套进引擎，所以只提示、不判失败
      broadcastLog(`○ 未生成 .spine 源工程：${result.spineProject?.reason ?? '未知原因'}`, 'warning');
    }

    res.json({
      success: true,
      ...result,
      artifacts: await listArtifacts(result.exportRoot)
    });

  } catch (error) {
    broadcastLog(`✗ 导出失败: ${error.message}`, 'error');
    console.error('[导出] 错误:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 提示词模板管理 API
app.get('/api/prompt-templates', (req, res) => {
  try {
    const templatesPath = templatesPathNow();
    if (!existsSync(templatesPath)) {
      return res.json({});
    }
    const content = readFileSync(templatesPath, 'utf-8');
    res.json(JSON.parse(content));
  } catch (err) {
    console.error('[模板] 读取失败:', err);
    res.status(500).json({ error: '读取模板失败' });
  }
});

app.post('/api/prompt-templates', express.json(), (req, res) => {
  try {
    const templatesPath = templatesPathNow();
    mkdirSync(dirname(templatesPath), { recursive: true });
    writeFileSync(templatesPath, JSON.stringify(req.body, null, 2), 'utf-8');
    broadcastLog('提示词模板已保存', 'success');
    res.json({ success: true });
  } catch (err) {
    console.error('[模板] 保存失败:', err);
    broadcastLog(`提示词模板保存失败: ${err.message}`, 'error');
    res.status(500).json({ error: '保存模板失败' });
  }
});

// 删除工程目录 API
// 只允许删 output/ 下的路径，防止路径遍历
app.delete('/api/project', express.json(), async (req, res) => {
  try {
    const { projectDir } = req.body ?? {};
    if (!projectDir || typeof projectDir !== 'string') {
      return res.status(400).json({ error: '缺少 projectDir' });
    }
    const outputRoot = resolve(join(__dirname, '../output'));
    // 去掉前缀斜杠和可能的 output/ 前缀，再 resolve 到绝对路径
    const rel = projectDir.replace(/^\/+/, '').replace(/^output\//, '');
    const target = resolve(join(outputRoot, rel));
    // 安全检查：必须在 output/ 内（且不等于 output/ 本身）
    if (!target.startsWith(outputRoot + '/') || target === outputRoot) {
      return res.status(403).json({ error: '不允许删除 output/ 以外的路径' });
    }
    const { rmSync } = await import('fs');
    if (!existsSync(target)) return res.json({ success: true, note: '目录不存在' });
    rmSync(target, { recursive: true, force: true });
    console.log(`[删除] ${target}`);
    broadcastLog(`已删除工程目录: ${rel}`, 'info');
    res.json({ success: true });
  } catch (err) {
    console.error('[删除] 失败:', err);
    broadcastLog(`删除工程目录失败: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// 启动服务
const PORT = process.env.PORT || 3000;

/*
 * 端口被占时的重试，只在「重启拉起来的接班人」这一身份下生效。
 *
 * 老进程要把端口还回来需要一点时间，接班人如果一上来就 EADDRINUSE 退掉，
 * 用户点一次重启服务就没了。所以带 SPINE_RESTART=1 的进程会等一等再试。
 *
 * 平时启动**不重试**：那种情况下端口被占，多半是已经有一个服务在跑了，
 * 直接报错退出才是对的，闷头重试只会让人以为自己起了个新服务。
 */
const RESTART_RETRY_MS = 300;
const RESTART_RETRY_MAX = 20;   // 最多等 6 秒
let portRetries = 0;

let httpServer;

function listen() {
  httpServer = app.listen(PORT, onListening);
  httpServer.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (process.env.SPINE_RESTART !== '1' || portRetries >= RESTART_RETRY_MAX) {
      console.error(`✗ 端口 ${PORT} 被占用${
        process.env.SPINE_RESTART === '1' ? `（等了 ${RESTART_RETRY_MAX * RESTART_RETRY_MS / 1000} 秒仍未释放）` : ''
      }。换个端口: PORT=3001 npm run web`);
      process.exit(1);
    }
    portRetries++;
    setTimeout(listen, RESTART_RETRY_MS);
  });
}

listen();

function onListening() {
  if (portRetries) console.log(`[重启] 等了 ${portRetries * RESTART_RETRY_MS}ms 拿到端口 ${PORT}`);
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🦴  Spine AI Generator                                      ║
║                                                               ║
║   服务已启动: http://localhost:${PORT}                        ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

📖 使用说明:

1. 在浏览器打开上面的地址
2. 上传角色/部件图片
3. 输入提示词（描述部件结构）
4. 配置 API:
   - API Key: 你的 API Key（.env 里填过就不用再填）
   - Base URL: 留空走 Anthropic 官方；自建网关/中转服务填它给的地址
5. 点击"生成骨骼"
6. 在预览区查看结果
7. 导出 Spine 工程

💡 提示: 按 Ctrl+C 停止服务
`);
}

