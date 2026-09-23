/**
 * Spine AI Generator 前端逻辑
 */

import { SpinePreview } from './renderer.js';
import {
  saveInputs, loadInputs,
  saveFile, loadFile,
  saveResult, loadResult,
  clearSession,
  listHistory, getHistory, saveHistory, deleteHistory, clearHistory
} from './session.js';

/**
 * 发请求并把响应读成 JSON，失败时给出能看懂的原因。
 *
 * 为什么不直接 `res.json()`：服务端没有这个路由时回的是 express 的 HTML 错误页，
 * 解析出来只有一句 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`——
 * 看的人完全猜不到真实原因是「浏览器连的服务进程是改动之前启的，重启才生效」。
 * 这种情况在本地开发里很常见（改完代码忘了重启），必须直说。
 *
 * @returns {Promise<object>} 解析后的 JSON
 * @throws {Error} message 是给人看的中文说明
 */
async function readJson(res, label = '请求') {
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 解析不了只可能是拿到了 HTML：路由不存在（旧进程）或服务报错
    if (res.status === 404) {
      throw new Error(`${label}失败：服务端没有这个接口——服务多半是改动之前启动的，重启后再生效`);
    }
    const head = text.trim().slice(0, 60).replace(/\s+/g, ' ');
    throw new Error(`${label}失败：服务端返回的不是 JSON（HTTP ${res.status}）：${head}`);
  }

  return data;
}

let currentSkeleton = null;
let logEventSource = null;
let preview = null;
let currentFileType = null; // 'image' or 'spine'
let currentCutResults = [];

// 补图失败清单。非空时「重跑补图」按钮可见，只重跑这几个部件
let failedInpaintNames = [];
// 上一次装配预览用的贴图 URL 与尺寸，重跑补图后要拿它们重新加载
let currentImageUrls = null;
let currentImageSize = null;
// 对齐诊断数据（AI 的框 vs 切图实际用的框）。只给预览画框用
let currentAlignment = null;

// 当前待生成的文件。刷新恢复出来的 File 没法塞回 input 元素，
// 所以统一走这个变量，input 只是它的一个来源。
let currentFile = null;

/*
 * 本次生成对应的输入图名。
 *
 * 产物落在 output/<工程名>/<输入图名>/ 下，补图和导出得指回同一个目录，
 * 所以这个名字要跟着会话走。服务端也能从上传文件名推出来，但重跑补图和
 * 导出时手里没有文件对象，只能由这里带过去——推错就会跑到别的素材目录里。
 */
let currentSourceName = '';

// DOM 元素
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const previewImg = document.getElementById('previewImg');
const generateBtn = document.getElementById('generateBtn');
const statusBox = document.getElementById('status');
const previewArea = document.getElementById('previewArea');
const previewCanvas = document.getElementById('previewCanvas');
const spineCanvas = document.getElementById('spineCanvas');
const emptyState = document.getElementById('emptyState');
const controls = document.getElementById('controls');
const exportBtn = document.getElementById('exportBtn');
const retryInpaintBtn = document.getElementById('retryInpaintBtn');

// API 配置相关
const apiConfig = document.getElementById('apiConfig');
const apiConfigTrigger = document.getElementById('openApiConfig');
const closeApiConfig = document.getElementById('closeApiConfig');
const saveApiConfig = document.getElementById('saveApiConfig');
const apiKeyInput = document.getElementById('apiKey');
const baseURLInput = document.getElementById('baseURL');

// 微调控制相关
const tweakControls = document.getElementById('tweakControls');
const animationSelect = document.getElementById('animationSelect');
const scaleSlider = document.getElementById('scaleSlider');
const scaleValue = document.getElementById('scaleValue');
const speedSlider = document.getElementById('speedSlider');
const speedValue = document.getElementById('speedValue');
const resetViewBtn = document.getElementById('resetViewBtn');

// 播放走带控件。声明放在这里而不是使用处附近：
// displaySkeletonInfo 会引用它们，而会话恢复可能在模块求值刚结束就跑到那里。
const playPauseBtn = document.getElementById('playPauseBtn');
const stopBtn = document.getElementById('stopBtn');
const prevFrameBtn = document.getElementById('prevFrameBtn');
const nextFrameBtn = document.getElementById('nextFrameBtn');
const timeline = document.getElementById('timeline');
const timeLabel = document.getElementById('timeLabel');
const loopToggle = document.getElementById('loopToggle');
const bonesToggle = document.getElementById('bonesToggle');
const wireToggle = document.getElementById('wireToggle');
const bboxToggle = document.getElementById('bboxToggle');

/**
 * API 接入点默认值，启动时从服务端取。
 *
 * 不在这里写死地址：换服务商是配置动作，不该改代码，更不该让仓库里
 * 留着一家服务商的域名。源头是 config/api-defaults.json。
 */
let apiDefaults = { baseURL: '', apiKeyPlaceholder: '' };

async function loadApiDefaults() {
  try {
    const res = await fetch('/api/api-defaults');
    apiDefaults = await res.json();
    apiKeyInput.placeholder = apiDefaults.apiKeyPlaceholder || apiKeyInput.placeholder;
    // 服务端配了接入点才回填，空着表示直连官方
    if (apiDefaults.baseURL && !baseURLInput.value) {
      baseURLInput.value = apiDefaults.baseURL;
    }
  } catch (err) {
    addLog(`读取 API 默认配置失败（不影响使用）: ${err.message}`, 'warning');
  }
}

// 从 localStorage 加载 API 配置
function loadApiConfig() {
  const saved = localStorage.getItem('spineAiApiConfig');
  if (saved) {
    try {
      const config = JSON.parse(saved);
      apiKeyInput.value = config.apiKey || '';
      baseURLInput.value = config.baseURL || apiDefaults.baseURL || '';
    } catch (e) {
      console.error('加载 API 配置失败:', e);
      addLog(`加载 API 配置失败: ${e.message}`, 'error');
    }
  }
  // 输入框空着但服务端有配置（多半是写进 .env 了），面板上说明一句，
  // 免得用户以为自己填的东西丢了、又手输一遍
  reflectEnvConfig();
}

/**
 * 显示 .env 里已经配好的东西。
 *
 * 只报「配了没」和长度——key 的明文不回传也不回显，前端本来就有它自己的输入框，
 * 这个接口是为了让人知道「不填也能跑」，不是为了把 key 拿出来看。
 */
async function reflectEnvConfig() {
  const hint = document.getElementById('envConfigHint');
  if (!hint) return;

  try {
    const res = await fetch('/api/api-config');
    const data = await readJson(res, '读取 .env 配置');
    if (!data.success) { hint.hidden = true; return; }

    const fileKey = data.file?.ANTHROPIC_API_KEY;
    const authKey = data.file?.ANTHROPIC_AUTH_TOKEN;
    const url = data.file?.ANTHROPIC_BASE_URL;
    const effKey = data.effective?.ANTHROPIC_API_KEY;
    const effAuth = data.effective?.ANTHROPIC_AUTH_TOKEN;

    if (!fileKey?.set && !authKey?.set && !url?.set) {
      hint.hidden = true;
      return;
    }

    const bits = [];
    if (fileKey?.set) bits.push(`API Key（${fileKey.length} 字符）`);
    if (authKey?.set) bits.push(`AUTH_TOKEN（${authKey.length} 字符）`);
    if (url?.set) bits.push('Base URL');
    hint.textContent = `📄 .env 已配置：${bits.join('、')}。留空则用它`;

    // 文件里配了、进程里没有：说明改完 .env 还没重启，那次改动不会生效
    const stale = (fileKey?.set && !effKey?.set) || (authKey?.set && !effAuth?.set);
    if (stale) {
      hint.textContent += '（服务未重启，本次改动尚未生效）';
    }
    hint.hidden = false;
  } catch {
    hint.hidden = true;
  }
}

/**
 * 保存 API 配置。
 *
 * 写两份：
 *   - localStorage 给界面自己用（刷新后输入框里还是那个 key）
 *   - .env 给服务端和其他用法用（CLI、换机器克隆下来直接跑）
 *
 * 写 .env 失败不阻断本次使用：localStorage 已经写好了，这一轮照样能跑，
 * 只是重启后要重填。所以不当成致命错误——但**状态栏必须翻红**。
 * 原来失败只往日志里塞一行、状态栏还是绿色的「✅ 已保存」，
 * 用户看到绿色就走了，几小时后才发现 .env 里什么都没有。
 */
async function saveApiConfigToStorage() {
  const config = {
    apiKey: apiKeyInput.value.trim(),
    baseURL: baseURLInput.value.trim()
  };
  localStorage.setItem('spineAiApiConfig', JSON.stringify(config));
  apiConfig.classList.remove('show');
  apiConfigTrigger.classList.remove('hidden');
  // 先按住结果再显示：.env 写失败时这句绿色是错的
  showStatus('⏳ 正在保存...', 'info');

  try {
    const res = await fetch('/api/save-api-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await readJson(res, '保存配置到 .env');

    if (data.success) {
      if (data.changed?.length) {
        showStatus(`✅ 已保存，并写入 .env：${data.changed.join('、')}`, 'success');
        addLog(`已写入 .env：${data.changed.join('、')}`, 'success');
      } else {
        showStatus('✅ 已保存（.env 内容无变化）', 'success');
        addLog('.env 内容无变化', 'info');
      }
      reflectEnvConfig();
    } else {
      showStatus(`⚠️ 已保存到本机，但写入 .env 失败：${data.error}`, 'warning');
      addLog(`写入 .env 失败（本次仍可使用）：${data.error}`, 'warning');
    }
  } catch (err) {
    showStatus(`⚠️ 已保存到本机，但写入 .env 失败：${err.message}`, 'warning');
    addLog(`写入 .env 失败（本次仍可使用）：${err.message}`, 'warning');
  }

  // 换了 Key 或接入点，能用的模型也跟着变，重新拉一次
  loadModels();
}

/**
 * 图像生成接口探测。
 *
 * key 从前端输入框取出直接转发给本地服务，服务端只用来发这一次请求。
 * 探测是串行的十几条外部调用，慢是正常的，所以按钮要有进度文案。
 */
document.getElementById('probeImageBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const box = document.getElementById('probeResult');
  const apiKey = apiKeyInput.value.trim();
  const baseURL = baseURLInput.value.trim();

  if (!apiKey) {
    box.hidden = false;
    box.innerHTML = '<div class="probe-row fail">请先填写 API Key</div>';
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ 探测中（可能要一分钟）...';
  box.hidden = false;
  box.innerHTML = '<div class="probe-row">正在逐条测试，请稍候...</div>';

  try {
    const res = await fetch('/api/probe-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, baseURL })
    });
    const data = await readJson(res, '探测图像接口');

    if (!res.ok) {
      box.innerHTML = `<div class="probe-row fail">探测失败: ${data.error ?? res.status}</div>`;
      return;
    }

    box.innerHTML = '';
    for (const a of data.attempts ?? []) {
      const row = document.createElement('div');
      row.className = `probe-row ${a.ok ? 'ok' : 'fail'}`;

      const label = document.createElement('div');
      label.className = 'probe-label';
      label.textContent = `${a.ok ? '✓' : '✗'} ${a.label}  [${a.status || '网络错误'}, ${a.ms}ms]`;

      const detail = document.createElement('div');
      detail.className = 'probe-detail';
      detail.textContent = a.detail ?? '';

      row.append(label, detail);

      // 真有图就贴出来：状态码 200 不等于真出了图，得看一眼
      if (a.thumb?.dataUrl) {
        const img = document.createElement('img');
        img.className = 'probe-thumb';
        img.src = a.thumb.dataUrl;
        img.alt = '探测返回的图';
        row.appendChild(img);
      } else if (a.thumb?.url) {
        const img = document.createElement('img');
        img.className = 'probe-thumb';
        img.src = a.thumb.url;
        img.alt = '探测返回的图';
        row.appendChild(img);
      }

      box.appendChild(row);
    }

    const okCount = (data.attempts ?? []).filter((a) => a.ok).length;
    const tail = document.createElement('div');
    tail.className = 'probe-row';
    tail.textContent = okCount
      ? `共 ${okCount} 条可用，已在下拉框里标出`
      : '没有一条走通，把上面的服务端原话发我';
    box.appendChild(tail);

    // 把"哪些模型真的验证过"记下来，生成时的下拉框据此标注。
    // 只按目录列出来没用——目录是文档里的清单，能不能用只有探测知道。
    const verified = [...new Set((data.attempts ?? []).filter((a) => a.ok).map((a) => a.model))];
    localStorage.setItem('spineAiImageModels', JSON.stringify({
      verified, at: Date.now(), baseURL: data.baseURL
    }));

    renderImageModels(data.models ?? []);
    addLog(`图像接口探测完成：${okCount} 条可用，验证通过 ${verified.length} 个模型`, okCount ? 'success' : 'warning');
  } catch (err) {
    box.innerHTML = `<div class="probe-row fail">探测失败: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 测试图像生成接口';
  }
});

/**
 * 重启服务端。
 *
 * 判据是 **pid 变了**，不是「接口通了」。重启是「起新进程 + 老进程退出」，
 * 老进程退场前的那个窗口期里 /api/health 照样是 200，光看通不通会立刻
 * 报「重启完成」，而用户拿到的还是旧代码——正是这个按钮要解决的问题本身。
 *
 * 服务断开期间 SSE 也断了，重连交给 connectLogStream 自己的重试逻辑，
 * 这里只负责等新进程起来，然后重新拉一遍依赖服务端状态的东西。
 */
document.getElementById('restartServerBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const box = document.getElementById('restartResult');
  const say = (html) => { box.hidden = false; box.innerHTML = html; };

  // 先记下现在是谁在服务。拿不到就没法判断重启有没有真的发生，直接不做
  let oldPid = null;
  try {
    const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
    oldPid = h.pid ?? null;
  } catch { /* 服务本来就不通，下面按「拿不到 pid」处理 */ }

  if (oldPid == null) {
    say('服务端没响应或版本过旧（/api/health 不带 pid），无法确认重启结果。请在终端手动重启。');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ 重启中...';
  say(`正在重启（当前进程 ${oldPid}）...`);

  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    // 进程可能在响应写完的同一瞬间就退了，读不到 body 不算失败
    await res.json().catch(() => ({}));
  } catch (err) {
    // 同理：连接被切断是预期内的，继续往下等新进程
  }

  // 等 pid 变成别的数字。老进程退场 + 新进程抢到端口，实测 1 秒内，
  // 给到 30 秒是为了兜住机器卡顿，不是为了等一个不会来的结果
  const deadline = Date.now() + 30000;
  let newPid = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
      if (h.pid != null && h.pid !== oldPid) { newPid = h.pid; break; }
    } catch { /* 正在换人，连不上是正常的 */ }
  }

  btn.disabled = false;
  btn.textContent = '🔄 重启服务器';

  if (newPid == null) {
    say('⚠ 30 秒内没等到新进程接管。服务可能没起来，请看终端输出。');
    addLog('重启服务器失败：没等到新进程接管', 'error');
    return;
  }

  say(`✓ 已重启：进程 ${oldPid} → ${newPid}。代码和 .env 都是最新的了。`);
  addLog(`服务端已重启（${oldPid} → ${newPid}）`, 'success');

  /*
   * 服务端换了进程，依赖它的状态要重新问一遍。
   *
   * 日志面板不用管：SSE 断了之后 initLogStream 的重连逻辑会自己接上。
   * 注意它重连时会清空日志区，所以上面那句 addLog 可能一闪而过——
   * 重启结果以按钮下方的 #restartResult 为准，那块不会被清。
   */
  syncSamStatus();
  reflectEnvConfig();
});

/**
 * 补图模型下拉。
 *
 * 各家 API 服务之间模型不通用，所以列表来自服务端目录 + 上次探测结果：
 * 探测通过的排前面并标「已验证」，其余标「未验证」——
 * 用户选了未验证的也能跑，失败了会退回边缘扩散，不会卡住流程。
 */
function renderImageModels(models) {
  const select = document.getElementById('imageModelSelect');
  const note = document.getElementById('imageModelNote');
  if (!select || !models.length) return;

  const want = select.value;
  let verified = [];
  try {
    const saved = JSON.parse(localStorage.getItem('spineAiImageModels') || '{}');
    verified = saved.verified ?? [];
  } catch { /* 存档损坏就当没探测过 */ }

  select.innerHTML = '';
  const ok = models.filter((m) => verified.includes(m.id));
  const rest = models.filter((m) => !verified.includes(m.id));

  const add = (list, parent, mark) => {
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${mark}${m.label}（${m.id}）`;
      opt.title = m.note ?? '';
      opt.dataset.note = m.note ?? '';
      parent.appendChild(opt);
    }
  };

  if (ok.length) add(ok, select, '✓ ');
  if (rest.length) add(rest, select, '');

  select.value = [...select.options].some((o) => o.value === want)
    ? want
    : (ok[0]?.id ?? models[0].id);

  const syncNote = () => {
    const opt = select.selectedOptions[0];
    if (!note || !opt) return;
    const isVerified = verified.includes(select.value);
    note.textContent = `${opt.dataset.note ?? ''}${isVerified ? '（已验证可用）' : '（未验证，失败会自动退回边缘扩散）'}`;
  };
  select.addEventListener('change', syncNote);
  syncNote();
  syncParamLabels();
}

/** 启动时按目录先填一次，没探测过就都是未验证状态 */
async function loadImageModels() {
  const select = document.getElementById('imageModelSelect');
  if (!select) return;
  try {
    const res = await fetch('/api/image-models');
    const data = await readJson(res, '读取图像模型列表');
    if (data.models?.length) renderImageModels(data.models);
  } catch (e) {
    console.warn('[补图] 模型列表加载失败', e);
  }
}

// API 配置窗口控制
apiConfigTrigger.addEventListener('click', () => {
  apiConfig.classList.add('show');
  apiConfigTrigger.classList.add('hidden');
  /*
   * 两个窗口锚在同一个位置，同时开着会叠在一起，所以开一个就收另一个。
   * 收完还要把日志按钮一起藏掉——设置窗口比日志按钮宽，留着它也点不到，
   * 只会盖在窗口底下露半个角。
   */
  hideLogPanel();
  showLogTrigger(false);
});

closeApiConfig.addEventListener('click', () => {
  apiConfig.classList.remove('show');
  apiConfigTrigger.classList.remove('hidden');
  showLogTrigger(true);
});

saveApiConfig.addEventListener('click', saveApiConfigToStorage);

// 日志浮动窗口
const logPanel = document.getElementById('logPanel');
const openLogPanel = document.getElementById('openLogPanel');
const closeLogPanel = document.getElementById('closeLogPanel');

/*
 * 两个浮动窗口都锚在右下角，谁打开都占掉那两个圆形按钮的位置。
 * 与其算够不够宽（窗口宽度会随内容变），不如打开时直接把按钮收起来——
 * 关掉窗口它会回来，用户不用找。
 */
function showLogTrigger(show) {
  openLogPanel.classList.toggle('hidden', !show);
}

/** 收起日志窗口，并让按钮回到原位 */
function hideLogPanel() {
  logPanel.classList.remove('show');
  showLogTrigger(true);
}

/**
 * 打开日志窗口。
 *
 * 只切显示，不动 SSE 连接——日志一直在往 #logContent 里写，
 * 关着的时候也记。这样打开看到的是完整历史，而不是从这一刻开始的空白。
 */
openLogPanel.addEventListener('click', () => {
  logPanel.classList.add('show');
  showLogTrigger(false);
  // 设置窗口占着同一片地方，先收起来
  apiConfig.classList.remove('show');
  apiConfigTrigger.classList.remove('hidden');
  // 关着期间新日志已经把滚动位置留在了别处，打开时贴到底部看最新几条
  const logContent = document.getElementById('logContent');
  logContent.scrollTop = logContent.scrollHeight;
});

closeLogPanel.addEventListener('click', hideLogPanel);

// 页面加载时加载配置。
// 先取服务端默认值再回填本地保存的，否则 localStorage 里没存过 URL 时
// 会先用空值渲染一帧，用户看到的是闪一下的空白输入框。
loadApiDefaults().then(loadApiConfig);

// --- 输入字段的记录与恢复 ---

// 这几个字段刷新后要保持原样。id 同时用作存储键，省掉一层映射。
const TRACKED_INPUTS = [
  'prompt', 'modelSelect', 'reasoningSelect', 'exportTarget',
  'outputDir', 'projectName',
  'densityInput', 'marginInput', 'bleedInput', 'imageModelSelect', 'maxInpaintInput'
];

// 复选框的状态在 .checked 上，不在 .value 上，得分开存取
const TRACKED_TOGGLES = ['cleanToggle', 'inpaintToggle', 'tightCutToggle', 'snapToggle', 'backgroundToggle', 'samToggle'];

function persistInputs() {
  const inputs = {};
  for (const id of TRACKED_INPUTS) {
    const el = document.getElementById(id);
    if (el) inputs[id] = el.value;
  }
  for (const id of TRACKED_TOGGLES) {
    const el = document.getElementById(id);
    if (el) inputs[id] = el.checked;
  }
  saveInputs(inputs);
}

function restoreInputs() {
  const saved = loadInputs();
  if (!saved) return null;

  for (const id of TRACKED_INPUTS) {
    const el = document.getElementById(id);
    // 只回填存过的字段，避免把默认值（./output 等）清成空串
    if (el && saved[id] !== undefined && saved[id] !== '') el.value = saved[id];
  }
  for (const id of TRACKED_TOGGLES) {
    const el = document.getElementById(id);
    // 这里要判 typeof：false 是有效状态，用真值判断会把"用户关掉了"当成没存过
    if (el && typeof saved[id] === 'boolean') el.checked = saved[id];
  }
  syncParamLabels();
  syncSectionSummaries();
  return saved;
}

// 边改边存。用 input 事件而不是 change，这样没等失焦就刷新也不丢。
for (const id of [...TRACKED_INPUTS, ...TRACKED_TOGGLES]) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('input', persistInputs);
  el.addEventListener('change', persistInputs);
}

/**
 * 导出目标列表从服务端取。
 * 硬编码在 HTML 里会和 targets.js 的目标表各自漂移——加个目标就得改两处，
 * 漏一处就出现"界面能选、服务端不认"。
 */
async function loadExportTargets() {
  const select = document.getElementById('exportTarget');
  const note = document.getElementById('targetNote');
  if (!select) return;

  try {
    const res = await fetch('/api/targets');
    const data = await readJson(res, '读取导出目标');
    if (!data.targets?.length) return;

    // 恢复出来的选择要保住，所以先记下当前值再重建选项
    const want = select.value;
    select.innerHTML = '';
    for (const t of data.targets) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      opt.dataset.note = t.note ?? '';
      select.appendChild(opt);
    }
    select.value = [...select.options].some((o) => o.value === want)
      ? want
      : data.default ?? data.targets[0].id;

    const sync = () => {
      const opt = select.selectedOptions[0];
      if (note && opt) note.textContent = opt.dataset.note || '';
    };
    select.addEventListener('change', sync);
    sync();
  } catch (e) {
    console.warn('[目标] 列表加载失败，用界面上的默认项', e);
  }
}

/**
 * 模型列表。
 *
 * 走 POST 而不是 GET：要把 apiKey 交给服务端去问上游的 /v1/models，
 * key 放在 query 里会进日志和浏览器历史。
 *
 * 拿不到列表不算失败——服务端会回退到内置清单，照样能生成，
 * 所以这里只在提示行里说明来源，不弹错误。
 */
async function loadModels() {
  const select = document.getElementById('modelSelect');
  const reasoning = document.getElementById('reasoningSelect');
  const note = document.getElementById('modelNote');
  if (!select) return;

  // 重建选项会清掉当前选中值，先记下来
  const wantModel = select.value;
  const wantReasoning = reasoning?.value;

  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: apiKeyInput.value.trim(),
        baseURL: baseURLInput.value.trim()
      })
    });
    const data = await readJson(res, '读取模型列表');

    select.innerHTML = '';
    // 能读图的排在前面，其余归到一个分组里——上游的列表里
    // 图像生成、纯文本模型混在一起，不分组就得在几十项里翻找
    const preferred = data.models.filter((m) => m.preferred !== false);
    const others = data.models.filter((m) => m.preferred === false);

    const addOptions = (list, parent) => {
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id === data.defaultModel ? `${m.id}（默认）` : m.id;
        parent.appendChild(opt);
      }
    };

    if (others.length) {
      const g1 = document.createElement('optgroup');
      g1.label = '推荐（支持读图）';
      addOptions(preferred, g1);
      select.appendChild(g1);

      const g2 = document.createElement('optgroup');
      g2.label = '其他（未验证读图能力）';
      addOptions(others, g2);
      select.appendChild(g2);
    } else {
      addOptions(preferred, select);
    }

    select.value = [...select.options].some((o) => o.value === wantModel)
      ? wantModel
      : data.defaultModel;

    if (reasoning && data.reasoningLevels?.length) {
      reasoning.innerHTML = data.reasoningLevels
        .map((l) => `<option value="${l.id}">${l.label}</option>`)
        .join('');
      reasoning.value = [...reasoning.options].some((o) => o.value === wantReasoning)
        ? wantReasoning
        : data.defaultReasoning;
    }

    syncSectionSummaries();

    if (note) {
      note.textContent = data.source === 'remote'
        ? `已从 API 服务读取 ${data.models.length} 个可用模型`
        : `用内置清单（${data.error ?? '未取到远端列表'}）`;
    }
  } catch (e) {
    console.warn('[模型] 列表加载失败，用界面上的默认项', e);
    if (note) note.textContent = '模型列表加载失败，使用默认模型';
  }
}

// --- 网格滑块的数值标签 ---
//
// 标签和滑块分开两个元素，所以每次改动都要手动同步。
// 恢复会话时也要调一次，否则滑块回到了 16 而标签还写着 8。
//
// 补图外扩/边缘扩散已从界面撤下（改成固定值），这里不再列它们——
// 列出来会把它们算进折叠摘要，等于又告诉用户"这两个能调"。
const PARAM_LABELS = [
  { input: 'densityInput', out: 'densityValue', fmt: (v) => `${v}` }
];

function syncParamLabels() {
  const parts = [];
  for (const { input, out, fmt } of PARAM_LABELS) {
    const el = document.getElementById(input);
    const label = document.getElementById(out);
    if (!el) continue;
    if (label) label.textContent = fmt(el.value);
    parts.push(fmt(el.value));
  }

  // 折叠起来后标题行右边的摘要。没有它，收起状态下改没改过参数完全看不出来。
  // 补图状态也带上：它是这一档里唯一会让耗时和费用翻倍的东西，
  // 收起来看不到就有可能在不知情的情况下跑一次很贵的生成。
  const inpaint = document.getElementById('inpaintToggle');
  const imageModel = document.getElementById('imageModelSelect');
  if (inpaint?.checked) parts.push(imageModel?.value ? `补图 ${imageModel.value}` : '补图');

  const summary = document.getElementById('meshSummary');
  if (summary) summary.textContent = parts.join(' · ');
}

/**
 * 模型区和输出区收起时的摘要。
 * 这两节收起后藏掉的正是"这次到底用哪个模型、产物落在哪"——
 * 不在标题行补一句，收起来就等于把关键信息藏了。
 */
function syncSectionSummaries() {
  const model = document.getElementById('modelSummary');
  if (model) {
    const id = document.getElementById('modelSelect')?.value ?? '';
    const level = document.getElementById('reasoningSelect');
    const levelText = level?.value && level.value !== 'default'
      ? ` · 推理${level.selectedOptions[0]?.textContent ?? level.value}`
      : '';
    model.textContent = `${id}${levelText}`;
  }

  const output = document.getElementById('outputSummary');
  if (output) output.textContent = projectDirText();
}

/**
 * 工程目录：输出目录 + 工程名。
 *
 * 导出路径不再单独配置（用户要求合并成一个「输出目录」），所以这里就是
 * 产物的唯一落点——生成时进 <工程名>/<输入图名>_temp/，点导出时进
 * <工程名>/<输入图名>/。摘要行只显示到工程名这一层，下面两层由输入图决定。
 */
function projectDirText() {
  const dir = (document.getElementById('outputDir')?.value ?? '').trim() || './output';
  const name = (document.getElementById('projectName')?.value ?? '').trim() || 'generated';
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

for (const id of ['outputDir', 'projectName']) {
  document.getElementById(id)?.addEventListener('input', () => {
    syncSectionSummaries();
    persistInputs();
  });
}

for (const id of ['modelSelect', 'reasoningSelect']) {
  document.getElementById(id)?.addEventListener('change', syncSectionSummaries);
}

for (const id of ['inpaintToggle', 'tightCutToggle', 'imageModelSelect']) {
  document.getElementById(id)?.addEventListener('change', syncParamLabels);
}


for (const { input } of PARAM_LABELS) {
  document.getElementById(input)?.addEventListener('input', syncParamLabels);
}
syncParamLabels();
syncSectionSummaries();

// --- 可折叠区块 ---
//
// 网格参数和骨骼名单都属于「偶尔才看」的内容，默认收起来是为了让
// 上传、提示词、模型、输出这几项主信息落在第一屏。
// 展开状态要记住：一个人如果天天调网格密度，不该每次刷新都重新点开。
const COLLAPSE_KEY = 'spineAiCollapse';

function loadCollapseState() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
  } catch {
    return {};
  }
}

function setCollapsed(btn, target, expanded) {
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  target.hidden = !expanded;
}

{
  const state = loadCollapseState();

  for (const btn of document.querySelectorAll('[data-collapse]')) {
    const id = btn.dataset.collapse;
    const target = document.getElementById(id);
    if (!target) continue;

    // 每节的默认展开状态写在 HTML 的 aria-expanded 上（模型/输出默认开，
    // 网格/骨骼树默认收）。localStorage 存过就以存的为准——
    // 这样默认值是声明式的，加新区块不用回来改这里。
    const fallback = btn.getAttribute('aria-expanded') === 'true';
    setCollapsed(btn, target, typeof state[id] === 'boolean' ? state[id] : fallback);

    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') !== 'true';
      setCollapsed(btn, target, expanded);

      const next = loadCollapseState();
      next[id] = expanded;
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch (e) {
        console.warn('[折叠] 状态保存失败:', e);
      }
    });
  }
}

// 初始化日志流
function initLogStream() {
  const logContent = document.getElementById('logContent');

  // 清空日志区
  logContent.innerHTML = '';

  logEventSource = new EventSource('/api/logs');

  logEventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    addLog(data.message, data.type);
  };

  logEventSource.onerror = () => {
    addLog('日志连接断开，尝试重连...', 'warning');
    setTimeout(() => {
      logEventSource.close();
      initLogStream();
    }, 3000);
  };
}

// 添加日志到日志面板
function addLog(message, type = 'info') {
  const logContent = document.getElementById('logContent');
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry log-${type}`;

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const icon = {
    'connected': '🔗',
    'info': 'ℹ️',
    'progress': '⏳',
    'success': '✓',
    'error': '✗',
    'warning': '⚠️'
  }[type] || 'ℹ️';

  logEntry.textContent = `[${time}] ${icon} ${message}`;

  logContent.appendChild(logEntry);
  logContent.scrollTop = logContent.scrollHeight;
}

/**
 * 恢复上次会话：图 + 提示词 + 版本 + 输出配置 + 上次生成的骨架。
 *
 * 表单字段先同步填好（避免闪一下默认值），图片和骨架再异步补上——
 * 它们在 IndexedDB 里，读取是异步的，但用户看到的顺序不受影响。
 */
async function restoreSession() {
  const saved = restoreInputs();

  const stored = await loadFile();
  if (stored) {
    currentFile = stored.file;
    currentFileType = stored.kind;
    if (stored.kind === 'image') {
      currentSourceName = sourceNameOf(stored.file.name);
      handleImageSelect(stored.file);
    } else {
      previewImg.style.display = 'none';
      document.querySelector('.upload-placeholder').style.display = 'none';
    }
  }

  const result = await loadResult();
  if (result?.skeleton) {
    // 图集要靠切图产物才能打，恢复时一起带回来，否则刷新后导出会缺 .atlas
    currentCutResults = result.cutResults ?? [];
    // 子目录名也在结果里存了一份：刷新后文件名可能已经取不到（localStorage 被清过），
    // 但补图和导出还得指回原来那个目录
    if (result.sourceName) currentSourceName = result.sourceName;
    // 切图产物还在 output 目录里，URL 和上次一致，直接重新组装预览
    const imageUrls = new Map(result.imageUrls ?? []);
    await displaySkeletonInfo(result.skeleton, imageUrls, result.imageSize, result.alignment ?? null);
  }

  if (stored || saved || result) {
    const when = saved?.savedAt ? new Date(saved.savedAt).toLocaleString('zh-CN') : '上次';
    addLog(`已恢复${when}的记录${stored ? `（${stored.file.name}）` : ''}`, 'info');
    showSessionHint(saved, stored);
  }
}

/**
 * 提示条：明确告诉用户当前界面是恢复出来的，不是新开的。
 * 不写这条，用户会以为提示词是自己刚填的，改了一半才发现是上次的。
 */
function showSessionHint(saved, stored) {
  const hint = document.getElementById('sessionHint');
  const text = document.getElementById('sessionHintText');
  if (!hint || !text) return;

  const bits = [];
  if (stored?.file?.name) bits.push(stored.file.name);
  if (saved?.exportTarget) bits.push(saved.exportTarget);
  const when = saved?.savedAt ? new Date(saved.savedAt).toLocaleString('zh-CN') : '';

  text.textContent = `已恢复${when ? ' ' + when : '上次'}的记录${bits.length ? '：' + bits.join(' · ') : ''}`;
  hint.style.display = '';
}

function hideSessionHint() {
  const hint = document.getElementById('sessionHint');
  if (hint) hint.style.display = 'none';
}

// 清除记录：把三处存储一并清掉，再把界面复位成初始状态。
// 只清存储不复位界面，会留下"记录已删但图还在"的错觉。
document.getElementById('clearSessionBtn')?.addEventListener('click', async () => {
  await clearSession();

  currentFile = null;
  currentFileType = null;
  currentSkeleton = null;
  currentSourceName = '';

  document.getElementById('prompt').value = '';
  previewImg.style.display = 'none';
  previewImg.src = '';
  const placeholder = document.querySelector('.upload-placeholder');
  if (placeholder) placeholder.style.display = '';

  document.getElementById('previewArea')?.querySelectorAll('canvas')
    .forEach((c) => { c.style.display = 'none'; });
  const empty = document.getElementById('emptyState');
  if (empty) empty.style.display = '';
  for (const id of ['tweakControls', 'controls']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  if (preview) preview.stop();

  hideSessionHint();
  // 工作区被清空了，"当前载入的是哪条记录"也就不成立了，
  // 高亮留着会让人以为那条还在预览里
  setActiveHistory(null);
  renderHistory();
  addLog('已清除上次的记录（近期记录列表保留）', 'info');
});

// 页面加载时初始化日志流并恢复上次记录
window.addEventListener('DOMContentLoaded', async () => {
  initLogStream();
  renderHistory();
  // 两个下拉都要先建好选项，restoreSession 回填的选择才落得进去。
  // 并发拉取：模型列表要转发到上游，比本地的目标列表慢得多。
  await Promise.all([loadExportTargets(), loadModels(), loadImageModels()]);
  restoreSession();
  // 不 await：状态查询是锦上添花，不该拖慢界面出来
  syncSamStatus();
});

/**
 * 查一次 MobileSAM 环境状态，把结果写进开关旁边的说明里。
 *
 * 环境没装时不该让开关装成"能用"的样子——勾着一个跑不起来的选项，
 * 用户只会以为功能坏了。这里改成取消勾选 + 直接给出安装命令。
 * 服务端那边就算收到 useSam=true 也会自己降级，两处兜底。
 */
async function syncSamStatus() {
  const toggle = document.getElementById('samToggle');
  const hint = document.getElementById('samHint');
  if (!toggle || !hint) return;

  try {
    const res = await fetch('/api/sam-status');
    const st = await res.json();

    /*
     * 两个分割器的耗时差两个数量级，提示语不能共用一套。
     * 拿 MobileSAM 的"每张约 0.3 秒"去描述 SAM 3（实测每部件约 4.5 秒、
     * 8 个部件约 90 秒）会让人以为卡死了，反过来则白劝退。
     */
    const sam3 = st.segmenter === 'sam3';
    const label = sam3 ? 'SAM 3' : 'MobileSAM';
    const cost = sam3
      ? '每个部件约 4~5 秒，8 个部件约 90 秒'
      : '首次调用约 2 秒，之后每张图约 0.3 秒';

    // 标签跟着实际用的分割器走。写死成 MobileSAM 的话，切到 SAM 3 之后
    // 界面上写着 MobileSAM、实际跑的是 SAM 3，排查问题时最容易被这条误导。
    const nameEl = document.getElementById('samLabel');
    if (nameEl) nameEl.textContent = label;

    if (st.ok) {
      toggle.disabled = false;
      hint.textContent = st.running
        ? `${label} 已在运行，切图轮廓精确到像素级`
        : `用 ${label} 把每个部件的轮廓描到像素级，切图里不再混进邻件。纯本地计算，${cost}`;
      hint.style.color = '';
      return;
    }
    // 没装：取消勾选并说明怎么装
    toggle.checked = false;
    toggle.disabled = false;
    hint.textContent = `未安装 ${label}，当前用 AI 多边形轮廓切图（较粗）。安装后切图轮廓精确到像素级：`
      + (st.setupCommand || 'node server/sam/setup.mjs');
    hint.style.color = 'var(--warning, #b8860b)';
  } catch {
    // 服务端没响应时保持原样，不干扰用户
  }
}

// 窗口尺寸变化时重算画布，避免预览被拉伸
window.addEventListener('resize', () => {
  if (preview) preview.resize();
});

// 初始化上传区域
uploadArea.addEventListener('click', () => {
  fileInput.click();
});

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.style.borderColor = 'var(--primary)';
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.style.borderColor = 'var(--border)';
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.style.borderColor = 'var(--border)';

  const file = e.dataTransfer.files[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    handleFileSelect(file);
  }
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    handleFileSelect(file);
  }
});

// 处理文件选择（图片或 Spine 文件）
function handleFileSelect(file) {
  const fileName = file.name.toLowerCase();

  if (file.type.startsWith('image/')) {
    // 图片文件
    currentFileType = 'image';
    currentFile = file;
    // 子目录名定下来，重跑补图和导出都靠它找对目录
    currentSourceName = sourceNameOf(file.name);
    saveFile(file);
    handleImageSelect(file);
  } else if (fileName.endsWith('.json') || fileName.endsWith('.skel')) {
    // Spine 文件
    currentFileType = 'spine';
    currentFile = file;
    saveFile(file);
    handleSpineFile(file);
  } else {
    showStatus('❌ 不支持的文件格式', 'error');
  }
}

/**
 * 从文件名取输入图名（去掉扩展名）。
 *
 * 和服务端 workspace.resolveSourceName 是同一套规则：产物落在
 * output/<工程名>/<这个名字>/ 下。两边算出来必须一样，否则生成写进 A 目录、
 * 补图跑去找 B 目录。这里不重复实现清洗（乱字符名交给服务端 safeName 兜），
 * 只做同一件事：去掉扩展名。
 */
function sourceNameOf(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '').trim();
}


// 处理图片选择
function handleImageSelect(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    previewImg.style.display = 'block';
    document.querySelector('.upload-placeholder').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

// 处理 Spine 文件
async function handleSpineFile(file) {
  try {
    const text = await file.text();
    const skeletonData = JSON.parse(text);

    // 隐藏图片预览，显示 Spine canvas
    previewImg.style.display = 'none';
    document.querySelector('.upload-placeholder').style.display = 'none';

    // 显示 Spine 预览（需要完整的资源才能渲染）
    showStatus('✅ Spine 文件已加载', 'success');

    // 载入的是一个现成的 Spine 文件，没有切图也就没有对齐诊断数据。
    // 不清掉的话，诊断框会停留在上一次生成的坐标上，看着像这个骨架的
    currentAlignment = null;

    // 显示骨骼信息
    displaySkeletonInfo(skeletonData);
  } catch (e) {
    showStatus('❌ 无法解析 Spine 文件: ' + e.message, 'error');
  }
}

// 显示骨骼信息
async function displaySkeletonInfo(skeleton, imageUrls, imageSize, alignment = null) {
  currentSkeleton = skeleton;
  // 重跑补图后要拿这两个重新装配预览
  currentImageUrls = imageUrls;
  currentImageSize = imageSize;
  // 对齐诊断数据：只用来画框，重跑补图不会让它失效（框是切图阶段定的）
  if (alignment) currentAlignment = alignment;

  // 更新统计信息
  const boneCount = skeleton.bones?.length || 0;
  const slotCount = skeleton.slots?.length || 0;

  document.getElementById('boneCount').textContent = boneCount;
  document.getElementById('slotCount').textContent = slotCount;

  // 显示骨骼树
  const boneTree = document.getElementById('boneTree');
  boneTree.innerHTML = '';

  if (skeleton.bones) {
    skeleton.bones.forEach(bone => {
      const boneItem = document.createElement('div');
      boneItem.className = 'bone-item';
      boneItem.textContent = `${bone.name}${bone.parent ? ` ← ${bone.parent}` : ' (root)'}`;
      boneTree.appendChild(boneItem);
    });
  }

  controls.style.display = 'block';

  // 有图片时用渲染器组装并播放动画
  if (imageUrls && imageUrls.size) {
    if (!preview) {
      preview = new SpinePreview(document.getElementById('spineCanvas'));
      // 进度条和时间标签由渲染循环推，暂停/逐帧/拖拽都自动对齐
      preview.onFrame = onPreviewFrame;
    } else {
      // 重新生成/切换记录时先停掉旧的渲染循环，避免两套骨骼叠在一起
      preview.stop();
      preview.reset();
    }
    // 叠加层跟随复选框的当前状态，避免重新生成后勾选还在、叠加层却没了
    preview.showBones = bonesToggle.checked;
    preview.showWireframe = wireToggle.checked;
    preview.showBbox = bboxToggle.checked;
    preview.alignment = currentAlignment;
    preview.setLoop(loopToggle.checked);
    preview.setSpeed(parseFloat(speedSlider.value) || 1);

    emptyState.style.display = 'none';
    previewCanvas.style.display = 'none';
    spineCanvas.style.display = 'block';

    const loaded = await preview.load(skeleton, imageUrls, imageSize);
    preview.start();

    // 切图在磁盘上，同名工程重新生成会把旧的清掉——
    // 载入一条旧记录时就会缺件。这里必须说出来，否则画面上少一块很难归因。
    if (loaded < imageUrls.size) {
      addLog(
        `有 ${imageUrls.size - loaded} 张部件图没取到，多半是该工程目录已被新一次生成清理，预览会缺件`,
        'warning'
      );
    }

    // 填充动画下拉框
    const anims = Object.keys(skeleton.animations ?? {});
    animationSelect.innerHTML = anims.length
      ? anims.map((n) => `<option value="${n}">${n}</option>`).join('')
      : '<option value="">无动画</option>';

    tweakControls.style.display = 'flex';
    playPauseBtn.textContent = preview.playing ? '❚❚' : '▶';
    showStatus(`✅ 已组装 ${loaded} 个部件，动画：${anims.join(' / ') || '无'}`, 'success');
  } else {
    // 没有切图就没法在画布上组装，骨骼层级已经在上面列出来了，
    // 这里只把预览区留在空状态并说明原因。
    spineCanvas.style.display = 'none';
    previewCanvas.style.display = 'none';
    emptyState.style.display = 'flex';
    emptyState.querySelector('p').textContent =
      `已读取 ${boneCount} 个骨骼，缺少部件图片，无法组装预览`;
    tweakControls.style.display = 'none';
  }
}


/**
 * 清空预览区。
 *
 * 重新生成时要先把上一次的结果抹掉，否则从点击到出图这几分钟里，画面上
 * 一直是上一次的骨架在动——新一次失败时更是「看着像成功了」。等新结果
 * 装配上来才恢复。
 *
 * 只收界面，不动上传的图（previewImg）和参数表单：那些是这次生成要用的输入，
 * 清掉反而让人以为白传了。
 */
function clearPreviewArea() {
  // 停掉渲染循环，不清的话旧骨骼会继续画在画布上
  if (preview) {
    preview.stop();
    preview.reset();
    preview.images.clear();
    preview.skeleton = null;
    preview.animation = null;
  }

  spineCanvas.style.display = 'none';
  previewCanvas.style.display = 'none';

  // 画布尺寸留着，只清像素：下次 load() 会 resize 回来，
  // 这里显示空态的话画布不该还挂着上一帧的残影
  for (const c of [spineCanvas, previewCanvas]) {
    const ctx = c.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, c.width, c.height);
  }

  emptyState.style.display = 'flex';
  emptyState.querySelector('p').textContent = '正在生成，请稍候…';

  // 骨骼树、统计、动画下拉都是上一次的，留着会和空画布自相矛盾
  const boneTree = document.getElementById('boneTree');
  if (boneTree) boneTree.innerHTML = '';
  document.getElementById('boneCount').textContent = '0';
  document.getElementById('slotCount').textContent = '0';
  animationSelect.innerHTML = '<option value="">无动画</option>';

  controls.style.display = 'none';
  tweakControls.style.display = 'none';

  // 结果状态一并失效：清空了预览却还留着旧骨架，导出会导出一份画面上没有的东西
  currentSkeleton = null;
  currentImageUrls = null;
  currentImageSize = null;
  currentAlignment = null;
  currentCutResults = [];

  // 上一次的失败清单跟着旧结果一起作废
  failedInpaintNames = [];
  retryInpaintBtn.hidden = true;

  // 进度条/时间标签归零，否则停在上一轮的位置上
  if (timeline) timeline.value = '0';
  if (timeLabel) timeLabel.textContent = '0.00s';
  if (playPauseBtn) playPauseBtn.textContent = '▶';

  showStatus('⏳ 正在生成...', 'info');
}

// 生成骨骼
generateBtn.addEventListener('click', async () => {
  // 优先用刚选的文件，其次用会话恢复出来的
  const file = fileInput.files[0] ?? currentFile;
  if (!file) {
    showStatus('❌ 请先上传文件', 'error');
    return;
  }

  // 检查 API 配置
  const apiKey = apiKeyInput.value.trim();
  const baseURL = baseURLInput.value.trim();

  if (!apiKey) {
    showStatus('❌ 请配置 API Key', 'error');
    apiConfig.classList.add('show');
    apiConfigTrigger.classList.add('hidden');
    return;
  }

  const prompt = document.getElementById('prompt').value.trim();
  const outputDir = document.getElementById('outputDir').value.trim();
  const projectName = document.getElementById('projectName').value.trim();
  const target = document.getElementById('exportTarget').value;

  if (!prompt) {
    showStatus('❌ 请输入提示词', 'error');
    return;
  }

  // 点了生成就落一次盘：这一组输入是用户真正用过的，值得记住
  persistInputs();

  // 先把上一次的预览清掉，再发请求：整个流程要跑几分钟，
  // 中间一直挂着旧骨骼会被当成「已经好了」
  clearPreviewArea();

  generateBtn.disabled = true;
  generateBtn.textContent = '⏳ 生成中...';

  const formData = new FormData();
  formData.append('image', file);
  formData.append('prompt', prompt);
  formData.append('apiKey', apiKey);
  formData.append('baseURL', baseURL);
  formData.append('outputDir', outputDir);
  formData.append('projectName', projectName);
  // 输入图名：服务端据此决定产物落在哪个子目录，回传回来供补图/导出复用
  formData.append('sourceName', currentSourceName || sourceNameOf(file.name));
  formData.append('target', target);
  formData.append('model', document.getElementById('modelSelect').value);
  formData.append('reasoning', document.getElementById('reasoningSelect').value);
  // multipart 里没有布尔类型，显式写成字符串，服务端判的是 !== 'false'
  formData.append('clean', document.getElementById('cleanToggle').checked ? 'true' : 'false');
  formData.append('density', document.getElementById('densityInput').value);
  formData.append('margin', document.getElementById('marginInput').value);
  formData.append('bleed', document.getElementById('bleedInput').value);
  formData.append('inpaint', document.getElementById('inpaintToggle').checked ? 'true' : 'false');
  formData.append('tightCut', document.getElementById('tightCutToggle').checked ? 'true' : 'false');
  formData.append('snap', document.getElementById('snapToggle').checked ? 'true' : 'false');
  formData.append('useSam', document.getElementById('samToggle').checked ? 'true' : 'false');
  formData.append('background', document.getElementById('backgroundToggle').checked ? 'true' : 'false');
  formData.append('imageModel', document.getElementById('imageModelSelect').value);
  formData.append('maxInpaintAttempts', document.getElementById('maxInpaintInput')?.value ?? '2');

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      body: formData
    });

    const result = await readJson(response, '生成');

    if (result.success) {
      showStatus('✅ 生成成功', 'success');
      currentCutResults = result.cutResults ?? [];
      // 服务端规范化后的名字才是准的（大小写、非法字符都处理过），以它为准
      currentSourceName = result.sourceName || currentSourceName;

      /*
       * 补图有几个部件失败时，把「重跑失败部件」露出来。
       *
       * 整条流程重跑一次要 5 分钟，还会把已经补成功的部件再补一遍
       * （白花钱，而且模型每次画的不一样）。只补失败的那几个更划算，
       * 而且补图不改尺寸，重跑之后骨架不用重新生成。
       */
      const inp = result.inpaintReport;
      if (inp?.failed > 0 && inp.failedNames?.length) {
        failedInpaintNames = inp.failedNames;
        retryInpaintBtn.hidden = false;
        retryInpaintBtn.textContent = `🔁 重跑补图（${inp.failedNames.length} 个失败）`;
        addLog(`补图有 ${inp.failedNames.length} 个部件失败：${inp.failedNames.join(', ')}`, 'warning');
      } else {
        failedInpaintNames = [];
        retryInpaintBtn.hidden = true;
      }
      logArtifacts(result.artifacts, result.projectDir);
      if (result.skeleton) {
        // 贴图 URL 由服务端算好：只有落在静态挂载的 output/ 下才取得到，
        // 用户把输出目录指到别处时 imagesUrl 为 null，这里就不装配预览。
        const imageUrls = new Map();
        if (result.imagesUrl && result.skeleton.slots) {
          for (const slot of result.skeleton.slots) {
            imageUrls.set(slot.bone, `${result.imagesUrl}/${slot.bone}.png`);
          }
        } else if (result.skeleton.slots?.length) {
          addLog('输出目录不在 output/ 下，浏览器取不到切图，预览无法装配', 'warning');
        }
        await displaySkeletonInfo(result.skeleton, imageUrls, result.imageSize, result.alignment);

        // 记下结果，刷新后预览和动画能直接回来。
        // imageUrls 是 Map，IndexedDB 存不了原型带方法的结构，转成数组。
        await saveResult({
          skeleton: result.skeleton,
          imageUrls: [...imageUrls],
          imageSize: result.imageSize,
          imagesDir: result.imagesDir,
          sourceName: currentSourceName,
          cutResults: currentCutResults,
          alignment: result.alignment ?? null,
          savedAt: Date.now()
        });

        // 同时进「近期记录」。存的是完整快照而不是目录名，
        // 这样点回来能还原整个工作区，不依赖磁盘上那份随时会被覆盖的产物。
        await pushHistory(file, result, imageUrls);
      }
    } else {
      showStatus(`❌ 生成失败: ${result.error}`, 'error');
      // 预览已经在点击时清空了，空态文案得跟着改口，
      // 否则会一直显示「正在生成」而按钮已经恢复可点
      emptyState.querySelector('p').textContent = `生成失败：${result.error}`;
    }
  } catch (error) {
    showStatus(`❌ 请求失败: ${error.message}`, 'error');
    emptyState.querySelector('p').textContent = `请求失败：${error.message}`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = '🚀 生成骨骼';
  }
});

// 导出
exportBtn.addEventListener('click', async () => {
  if (!currentSkeleton) {
    showStatus('❌ 没有可导出的骨架数据', 'error');
    return;
  }

  const outputDir = document.getElementById('outputDir').value.trim();
  const projectName = document.getElementById('projectName').value.trim();
  const target = document.getElementById('exportTarget').value;

  exportBtn.disabled = true;
  exportBtn.textContent = '⏳ 导出中...';

  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skeleton: currentSkeleton,
        outputDir,
        projectName,
        target,
        // 默认导出路径是 output/<工程名>/<输入图名>/，服务端靠它决定子目录和文件名
        sourceName: currentSourceName || undefined,
        // 图集要靠切图产物来打；不带过去服务端只能产出没有 .atlas 的半套东西
        cutResults: currentCutResults
      })
    });

    const result = await readJson(response, '导出');

    if (result.success) {
      showStatus(`✅ 导出成功: ${result.skeletonPath}`, 'success');
      /*
       * 清单从 <输入图名>/ 那一层列（服务端的 exportRoot），
       * Spine工程/ 和各个目标目录会一起出现——用户点完导出
       * 最想确认的就是"那个 .spine 到底有没有"。
       */
      logArtifacts(result.artifacts, result.exportRoot ?? result.projectDir);
      if (result.spineProject?.path) {
        addLog(`Spine 源工程（二次编辑用）: ${result.spineProject.path}`, 'success');
      } else if (result.spineProject?.reason) {
        addLog(`未生成 .spine 源工程：${result.spineProject.reason}`, 'warning');
      }
    } else {
      showStatus(`❌ 导出失败: ${result.error}`, 'error');
    }
  } catch (error) {
    showStatus(`❌ 导出失败: ${error.message}`, 'error');
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = '导出';
  }
});

// --- 播放控制 ---

// 拖动进度条时不能让渲染循环反过来覆盖它，否则滑块会被拽回去
let scrubbing = false;

/**
 * 每帧回调：把播放进度同步到进度条和时间标签。
 * 由渲染器驱动而不是用 setInterval，这样暂停、逐帧、拖拽都天然对齐。
 */
function onPreviewFrame(time, duration) {
  const d = duration || 1;
  if (!scrubbing) timeline.value = Math.round((time / d) * 1000);
  timeLabel.textContent = `${time.toFixed(2)}s / ${d.toFixed(2)}s`;
  playPauseBtn.textContent = preview?.playing ? '❚❚' : '▶';
}

playPauseBtn.addEventListener('click', () => {
  if (!preview) return;
  preview.togglePlay();
  playPauseBtn.textContent = preview.playing ? '❚❚' : '▶';
});

stopBtn.addEventListener('click', () => {
  preview?.stopPlayback();
  playPauseBtn.textContent = '▶';
});

// 逐帧按 30fps 走。刚性拼合的接缝往往只在某一两帧裂开，
// 逐帧停住才看得清是哪一帧、哪个部件。
prevFrameBtn.addEventListener('click', () => {
  preview?.step(-1);
  playPauseBtn.textContent = '▶';
});
nextFrameBtn.addEventListener('click', () => {
  preview?.step(1);
  playPauseBtn.textContent = '▶';
});

timeline.addEventListener('pointerdown', () => { scrubbing = true; });
timeline.addEventListener('pointerup', () => { scrubbing = false; });
timeline.addEventListener('input', (e) => {
  if (!preview) return;
  preview.seek((parseInt(e.target.value, 10) / 1000) * (preview.duration || 1));
  playPauseBtn.textContent = preview.playing ? '❚❚' : '▶';
});

loopToggle.addEventListener('change', (e) => preview?.setLoop(e.target.checked));
bonesToggle.addEventListener('change', (e) => {
  if (preview) preview.showBones = e.target.checked;
});
wireToggle.addEventListener('change', (e) => {
  if (preview) preview.showWireframe = e.target.checked;
});
bboxToggle.addEventListener('change', (e) => {
  if (preview) preview.showBbox = e.target.checked;
});

// --- 视图微调 ---

scaleSlider.addEventListener('input', (e) => {
  const scale = parseFloat(e.target.value);
  scaleValue.textContent = `${scale.toFixed(2)}x`;
  preview?.setZoom(scale);
});

speedSlider.addEventListener('input', (e) => {
  const speed = parseFloat(e.target.value);
  speedValue.textContent = `${speed.toFixed(2)}x`;
  preview?.setSpeed(speed);
});

animationSelect.addEventListener('change', (e) => {
  if (preview && e.target.value) {
    preview.playAnimation(e.target.value);
    playPauseBtn.textContent = preview.playing ? '❚❚' : '▶';
  }
});

resetViewBtn.addEventListener('click', () => {
  scaleSlider.value = 1;
  scaleValue.textContent = '1.00x';
  speedSlider.value = 1;
  speedValue.textContent = '1.00x';
  preview?.reset();
});

// 滚轮缩放 + 拖拽平移：预览区就是工作区，用鼠标直接凑近看接缝比拖滑块快得多
previewArea?.addEventListener('wheel', (e) => {
  if (!preview) return;
  e.preventDefault();
  const next = Math.min(4, Math.max(0.1, preview.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  preview.setZoom(next);
  scaleSlider.value = next.toFixed(2);
  scaleValue.textContent = `${next.toFixed(2)}x`;
}, { passive: false });

let dragging = null;
previewArea?.addEventListener('pointerdown', (e) => {
  if (!preview || e.target.closest('.tweak-controls')) return;
  dragging = { x: e.clientX, y: e.clientY, panX: preview.panX, panY: preview.panY };
  previewArea.setPointerCapture?.(e.pointerId);
});
previewArea?.addEventListener('pointermove', (e) => {
  if (!dragging || !preview) return;
  preview.setPan(dragging.panX + (e.clientX - dragging.x), dragging.panY + (e.clientY - dragging.y));
});
previewArea?.addEventListener('pointerup', () => { dragging = null; });

// 键盘快捷键：空格播放/暂停，左右逐帧。
// 焦点在输入框里时不接管，否则打字会被吞掉。
document.addEventListener('keydown', (e) => {
  if (!preview || !currentSkeleton) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    preview.togglePlay();
    playPauseBtn.textContent = preview.playing ? '❚❚' : '▶';
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    preview.step(-1);
    playPauseBtn.textContent = '▶';
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    preview.step(1);
    playPauseBtn.textContent = '▶';
  }
});

/* ---------- 近期记录 ---------- */

// 当前注入的是哪一条。刷新后要能继续高亮，所以落在 localStorage 而不是内存
const ACTIVE_KEY = 'spineAiActiveHistory';
let activeHistoryId = localStorage.getItem(ACTIVE_KEY) || null;

function setActiveHistory(id) {
  activeHistoryId = id;
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

/** 当前全部输入的快照，注入时原样回填 */
function snapshotInputs() {
  const inputs = {};
  for (const id of TRACKED_INPUTS) {
    const el = document.getElementById(id);
    if (el) inputs[id] = el.value;
  }
  for (const id of TRACKED_TOGGLES) {
    const el = document.getElementById(id);
    if (el) inputs[id] = el.checked;
  }
  return inputs;
}

/**
 * 列表用的缩略图。
 * 存原图当缩略图会让一条记录多占几 MB，而列表里它只有 38px——
 * 缩到 96px 边长再存，肉眼看不出差别，体积差两个数量级。
 */
async function makeThumb(file, max = 96) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(max / bmp.width, max / bmp.height, 1);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    // 用 PNG 而不是 JPEG：素材基本都带透明通道，转 JPEG 会把透明压成黑块
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('[记录] 缩略图生成失败:', e);
    return null;
  }
}

async function pushHistory(file, result, imageUrls) {
  const entry = {
    id: `h${Date.now()}`,
    savedAt: Date.now(),
    projectName: document.getElementById('projectName').value.trim() || 'generated',
    target: document.getElementById('exportTarget').value,
    model: document.getElementById('modelSelect').value,
    bones: result.skeleton?.bones?.length ?? 0,
    slots: result.skeleton?.slots?.length ?? 0,
    thumb: await makeThumb(file),
    // 原图一起存下来：注入之后直接点"生成骨骼"就能用同一张图重跑
    file: {
      blob: file.slice(0, file.size, file.type),
      name: file.name,
      type: file.type,
      kind: currentFileType ?? 'image'
    },
    inputs: snapshotInputs(),
    result: {
      skeleton: result.skeleton,
      imageUrls: [...imageUrls],
      imageSize: result.imageSize,
      imagesDir: result.imagesDir,
      projectDir: result.projectDir,
      // 载入记录时靠它找回 output/<工程名>/<输入图名>/ 那一层
      sourceName: result.sourceName ?? currentSourceName,
      cutResults: result.cutResults ?? []
    }
  };

  if (await saveHistory(entry)) setActiveHistory(entry.id);
  await renderHistory();
}

/** 今天的只显示时刻，更早的显示日期——窄列放不下完整时间戳 */
function shortTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : `${d.getMonth() + 1}-${d.getDate()}`;
}

async function renderHistory() {
  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  const clearBtn = document.getElementById('clearHistoryBtn');
  if (!list) return;

  const items = await listHistory();
  list.innerHTML = '';
  if (empty) empty.hidden = items.length > 0;
  if (clearBtn) clearBtn.hidden = items.length === 0;

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `history-item${item.id === activeHistoryId ? ' active' : ''}`;
    /*
     * 显示的是**上传的文件名**，不是工程名。
     *
     * 工程名是用户给这批产物起的名，一个工程下往往有好几张素材图
     * （角色 A、角色 B、道具……），全列成同一个名字就分不出谁是谁了。
     * 文件名才是"这条记录是拿哪张图跑出来的"的答案，也正好和磁盘上
     * output/<工程名>/<输入图名>/ 那一层的名字对得上。
     *
     * 早期记录可能没存 file.name（或存的是 Spine 文件），退回工程名。
     */
    const displayName = item.file?.name || item.projectName || '(未命名)';

    // 窄列里名字会被截断，完整信息放 title 里，悬停就能看全
    row.title = [
      displayName,
      item.projectName && item.projectName !== displayName ? `工程：${item.projectName}` : '',
      new Date(item.savedAt).toLocaleString('zh-CN'),
      `${item.bones} 骨骼 / ${item.slots} 槽位 · ${item.target ?? ''}`,
      item.model ?? '',
      '点击载入到工作区'
    ].filter(Boolean).join('\n');

    const thumb = document.createElement(item.thumb ? 'img' : 'div');
    thumb.className = 'history-thumb';
    if (item.thumb) {
      thumb.src = item.thumb;
      thumb.alt = '';
    }

    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const name = document.createElement('div');
    name.className = 'history-name';
    name.textContent = displayName;

    const sub = document.createElement('div');
    sub.className = 'history-sub';
    sub.textContent = `${shortTime(item.savedAt)} · ${item.bones} 骨`;

    meta.append(name, sub);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del';
    del.textContent = '×';
    del.title = '删除这条记录';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteHistory(item.id);
      if (activeHistoryId === item.id) setActiveHistory(null);
      await renderHistory();
    });

    // 删除文件按钮：同时删磁盘上的工程目录
    const delFiles = document.createElement('button');
    delFiles.type = 'button';
    delFiles.className = 'history-del';
    delFiles.textContent = '🗑';
    delFiles.title = '删除记录并删除磁盘文件';
    delFiles.style.marginRight = '2px';
    delFiles.addEventListener('click', async (e) => {
      e.stopPropagation();
      const projectDir = item.result?.projectDir;
      if (projectDir) {
        try {
          const r = await fetch('/api/project', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir })
          });
          const data = await r.json();
          if (!data.success) addLog(`删除文件失败: ${data.error}`, 'warning');
        } catch (err) {
          addLog(`删除文件失败: ${err.message}`, 'warning');
        }
      }
      await deleteHistory(item.id);
      if (activeHistoryId === item.id) setActiveHistory(null);
      await renderHistory();
    });

    row.append(thumb, meta, delFiles, del);
    row.addEventListener('click', () => injectHistory(item.id));
    list.appendChild(row);
  }
}

/**
 * 把一条记录注入当前工作区：输入、原图、骨架、预览全部换成那一次的。
 *
 * 注入后当前会话也跟着改写，所以刷新一次仍然停在这条记录上——
 * 否则会出现"点开了旧记录，一刷新又跳回最后一次生成"。
 */
async function injectHistory(id) {
  const entry = await getHistory(id);
  if (!entry) {
    showStatus('❌ 这条记录已不存在', 'error');
    await renderHistory();
    return;
  }

  // 表单
  for (const [key, value] of Object.entries(entry.inputs ?? {})) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (typeof value === 'boolean') el.checked = value;
    else el.value = value;
  }
  syncParamLabels();
  syncSectionSummaries();
  persistInputs();

  // 原图。必须同时清掉 file input：生成时优先取 fileInput.files[0]，
  // 不清的话会拿上一次手选的文件去跑，而界面显示的却是这条记录的图。
  if (entry.file?.blob) {
    currentFile = new File([entry.file.blob], entry.file.name, { type: entry.file.type });
    currentFileType = entry.file.kind ?? 'image';
    fileInput.value = '';
    await saveFile(currentFile);

    if (currentFileType === 'image') {
      currentSourceName = sourceNameOf(currentFile.name);
      handleImageSelect(currentFile);
    } else {
      previewImg.style.display = 'none';
      document.querySelector('.upload-placeholder').style.display = 'none';
    }
  }

  // 骨架与预览
  if (entry.result?.skeleton) {
    currentCutResults = entry.result.cutResults ?? [];
    // 老记录没有 sourceName 字段，用文件名推——推不出来就退回工程名，
    // 和服务端的默认规则一致
    if (entry.result.sourceName) currentSourceName = entry.result.sourceName;
    const imageUrls = new Map(entry.result.imageUrls ?? []);
    await displaySkeletonInfo(
      entry.result.skeleton,
      imageUrls,
      entry.result.imageSize,
      entry.result.alignment ?? null
    );
    await saveResult({ ...entry.result, sourceName: currentSourceName, savedAt: Date.now() });
  }

  setActiveHistory(id);
  await renderHistory();

  showSessionHint({ ...entry.inputs, savedAt: entry.savedAt }, { file: { name: entry.file?.name } });
  // 提示里用文件名，和列表里显示的是同一个名字——两边不一致会让人
  // 以为点开了另一条记录
  const loadedName = entry.file?.name || entry.projectName;
  addLog(`已载入记录：${loadedName}（${new Date(entry.savedAt).toLocaleString('zh-CN')}）`, 'info');
  showStatus(`✅ 已载入「${loadedName}」`, 'success');
}

document.getElementById('clearHistoryBtn')?.addEventListener('click', async () => {
  if (!confirm('清空全部近期记录？磁盘上的产物不会被删除。')) return;
  await clearHistory();
  setActiveHistory(null);
  await renderHistory();
  addLog('已清空近期记录', 'info');
});

/* ---------- 补图重跑 ---------- */

/**
 * 只重跑补图失败的部件。
 *
 * 补图不改变切片的尺寸，所以骨骼、图集、bbox 全都不用重算——
 * 重跑完把预览里的贴图重新加载一次就行。
 */
retryInpaintBtn?.addEventListener('click', async () => {
  if (!failedInpaintNames.length) return;

  retryInpaintBtn.disabled = true;
  retryInpaintBtn.textContent = '⏳ 重跑中...';
  showStatus(`⏳ 正在重跑 ${failedInpaintNames.length} 个部件的补图...`, 'info');
  addLog(`开始重跑补图：${failedInpaintNames.join(', ')}`, 'progress');

  try {
    const res = await fetch('/api/inpaint-retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        names: failedInpaintNames,
        // 遮挡方向存在前端 currentCutResults 里，服务端没留存，得带回去，
        // 否则重跑退化成无定向补图，和首次生成效果不一致
        occlusionMap: Object.fromEntries(
          (currentCutResults ?? [])
            .filter((c) => failedInpaintNames.includes(c.name))
            .map((c) => [c.name, c.occlusionEdges ?? []])
        ),
        apiKey: document.getElementById('apiKey').value.trim(),
        baseURL: document.getElementById('baseURL').value.trim(),
        imageModel: document.getElementById('imageModelSelect').value,
        maxInpaintAttempts: document.getElementById('maxInpaintInput')?.value ?? '2',
        outputDir: document.getElementById('outputDir').value.trim(),
        projectName: document.getElementById('projectName').value.trim(),
        // 指回这次生成的那个子目录；传丢了会跑去别的素材目录里乱补一遍
        sourceName: currentSourceName || undefined
      })
    });
    const data = await readJson(res, '重跑补图');

    if (!data.success) {
      showStatus(`❌ 重跑失败: ${data.error}`, 'error');
      addLog(`✗ 重跑失败: ${data.error}`, 'error');
      return;
    }

    const { done, skipped, failed, failedNames } = data;
    addLog(`✓ 重跑完成：${done} 成功，${skipped} 无需补，${failed} 失败`, failed ? 'warning' : 'success');

    if (failed > 0) {
      failedInpaintNames = failedNames ?? [];
      retryInpaintBtn.textContent = `🔁 重跑补图（${failedInpaintNames.length} 个失败）`;
      showStatus(`⚠️ 仍有 ${failed} 个失败：${failedInpaintNames.join(', ')}`, 'warning');
    } else {
      failedInpaintNames = [];
      retryInpaintBtn.hidden = true;
      showStatus(`✅ 补图已全部完成（${done} 个成功）`, 'success');
    }

    /*
     * 贴图变了，预览里那张合成的图得重新取。
     * imageUrls 指向的是同一批路径，加个时间戳打掉浏览器缓存——
     * 文件名没变，不加参数会一直拿旧图。
     */
    if (done > 0 && currentSkeleton?.slots?.length) {
      const urls = new Map();
      for (const slot of currentSkeleton.slots) {
        const base = currentImageUrls?.get(slot.bone);
        if (base) urls.set(slot.bone, `${base}?t=${Date.now()}`);
      }
      if (urls.size) await displaySkeletonInfo(currentSkeleton, urls, currentImageSize);
    }
  } catch (err) {
    showStatus(`❌ 重跑失败: ${err.message}`, 'error');
    addLog(`✗ 重跑失败: ${err.message}`, 'error');
  } finally {
    retryInpaintBtn.disabled = false;
    if (failedInpaintNames.length) {
      retryInpaintBtn.textContent = `🔁 重跑补图（${failedInpaintNames.length} 个失败）`;
    }
  }
});

/* ---------- 打开输出目录 ---------- */

// 浏览器开不了本地目录，只能让本地服务代劳（两者跑在同一台机器上）
document.getElementById('openOutputBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;

  try {
    const res = await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputDir: document.getElementById('outputDir').value.trim(),
        projectName: document.getElementById('projectName').value.trim()
      })
    });
    const data = await readJson(res, '打开输出目录');

    if (data.success) {
      // 工程目录还没生成时服务端会退到输出根目录，这跟用户点的不是一个地方，要说明
      showStatus(data.fallback ? `📂 该工程目录还不存在，已打开 ${data.dir}` : `📂 已打开 ${data.dir}`, 'success');
    } else {
      showStatus(`❌ 打开失败: ${data.error}`, 'error');
    }
  } catch (err) {
    showStatus(`❌ 打开失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

/**
 * 把产物清单打到日志里。
 * 之前只报一个目录路径，要确认三件套齐不齐得自己去开 Finder。
 */
function logArtifacts(artifacts, projectDir) {
  if (!artifacts?.length) return;

  if (projectDir) addLog(`产物目录: ${projectDir}`, 'info');
  const total = artifacts.reduce((sum, a) => sum + a.size, 0);
  for (const a of artifacts) {
    addLog(`  ${a.path}  ${formatSize(a.size)}`, 'info');
  }
  addLog(`共 ${artifacts.length} 个文件，${formatSize(total)}`, 'info');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// 状态提示
function showStatus(message, type = 'info') {
  statusBox.textContent = message;
  // CSS 写的是 .status-box.info 这种两段式选择器，早先拼成 status-info 一直没匹配上，
  // 状态框始终是白底黑字。这里按 CSS 的写法拼。
  statusBox.className = `status-box ${type}`;
  statusBox.style.display = 'block';

  // 所有状态提示同步写进日志面板，Toast 5 秒后消失但日志里有完整记录
  addLog(message, type);

  setTimeout(() => {
    statusBox.style.display = 'none';
  }, 5000);
}

// ===== 提示词模板管理 =====
let promptTemplates = {};
let currentTemplateCategory = 'character';
let defaultTemplates = {}; // 保存默认模板用于恢复

// 加载模板
async function loadPromptTemplates() {
  try {
    const res = await fetch('/api/prompt-templates');
    const templates = await res.json();
    promptTemplates = templates;
    defaultTemplates = JSON.parse(JSON.stringify(templates)); // 深拷贝
  } catch (err) {
    console.error('[模板] 加载失败:', err);
    addLog(`[模板] 加载失败: ${err.message}`, 'error');
    showStatus('❌ 加载提示词模板失败', 'error');
  }
}

// 保存模板
async function savePromptTemplates() {
  try {
    const res = await fetch('/api/prompt-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promptTemplates)
    });
    if (!res.ok) throw new Error('保存失败');
    showStatus('✓ 模板已保存', 'success');
  } catch (err) {
    console.error('[模板] 保存失败:', err);
    addLog(`[模板] 保存失败: ${err.message}`, 'error');
    showStatus('❌ 保存模板失败', 'error');
  }
}

// 打开模板设置弹窗
function openTemplateModal() {
  document.getElementById('promptTemplateModal').classList.add('show');
  updateTemplateDisplay(currentTemplateCategory);
}

// 关闭模板设置弹窗
function closeTemplateModal() {
  document.getElementById('promptTemplateModal').classList.remove('show');
}

// 更新模板显示
function updateTemplateDisplay(category) {
  currentTemplateCategory = category;
  
  // 更新 tab 激活状态
  document.querySelectorAll('.template-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.category === category);
  });
  
  const template = promptTemplates[category];
  if (template) {
    document.getElementById('templateDescription').textContent = template.description;
    document.getElementById('templateContent').value = template.template;
  }
}

// 恢复默认模板
function resetCurrentTemplate() {
  const defaultTemplate = defaultTemplates[currentTemplateCategory];
  if (defaultTemplate) {
    promptTemplates[currentTemplateCategory] = JSON.parse(JSON.stringify(defaultTemplate));
    updateTemplateDisplay(currentTemplateCategory);
    showStatus('已恢复默认模板', 'info');
  }
}

// 保存当前编辑
function saveCurrentTemplate() {
  const content = document.getElementById('templateContent').value.trim();
  if (promptTemplates[currentTemplateCategory]) {
    promptTemplates[currentTemplateCategory].template = content;
  }
  savePromptTemplates();
}

// 获取当前选中类别的模板内容（用于发送时自动拼接）
function getCurrentTemplatePrefix() {
  const category = localStorage.getItem('selectedTemplateCategory') || 'character';
  const template = promptTemplates[category];
  return template ? template.template : '';
}

// 绑定事件
document.getElementById('promptSettingsBtn')?.addEventListener('click', openTemplateModal);
document.getElementById('closeTemplateModal')?.addEventListener('click', closeTemplateModal);

document.querySelectorAll('.template-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    updateTemplateDisplay(tab.dataset.category);
  });
});

document.getElementById('resetTemplateBtn')?.addEventListener('click', resetCurrentTemplate);
document.getElementById('saveTemplateBtn')?.addEventListener('click', saveCurrentTemplate);

// 点击遮罩关闭
document.getElementById('promptTemplateModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'promptTemplateModal') {
    closeTemplateModal();
  }
});

// 页面加载时初始化模板
loadPromptTemplates();
