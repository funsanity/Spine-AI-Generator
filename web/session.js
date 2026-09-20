/**
 * 会话持久化：刷新后恢复上次的图、提示词、版本等全部输入与生成结果。
 *
 * 为什么分两处存：
 *   表单字段小且要在首帧就填好，用 localStorage 同步读取，界面不会闪一下空值。
 *   图片和骨架 JSON 体积大（蒙皮网格顶点尤其），localStorage 5MB 上限很容易撑爆，
 *   而 IndexedDB 能直接存 Blob——恢复出来就是 File，可以原样再提交一次生成。
 */

const INPUT_KEY = 'spineAiSession';
const DB_NAME = 'spineAiSession';
// v2 加了 history 库。升版本而不是把历史塞进 session 的某个键：
// 一次只读一条记录，不必为了渲染列表把所有原图 Blob 都拉进内存。
const DB_VERSION = 2;
const STORE = 'session';
const HISTORY_STORE = 'history';

/** 历史最多留这么多条，超了淘汰最旧的——每条都带着原图，不设上限会一直涨 */
const HISTORY_LIMIT = 12;

/** 表单字段：同步存取，供页面首帧直接回填 */
export function saveInputs(inputs) {
  try {
    localStorage.setItem(INPUT_KEY, JSON.stringify({ ...inputs, savedAt: Date.now() }));
  } catch (e) {
    console.warn('[会话] 保存输入失败:', e);
  }
}

export function loadInputs() {
  try {
    const raw = localStorage.getItem(INPUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[会话] 读取输入失败:', e);
    return null;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
  });
}

/**
 * 存上次上传的文件。存 Blob 而不是 dataURL：
 * 体积少三分之一，取回来能直接包成 File 再次提交。
 */
export async function saveFile(file) {
  try {
    await idbPut('file', {
      blob: file.slice(0, file.size, file.type),
      name: file.name,
      type: file.type,
      kind: file.type.startsWith('image/') ? 'image' : 'spine'
    });
  } catch (e) {
    console.warn('[会话] 保存文件失败:', e);
  }
}

/** 取回上次的文件，返回可直接放进 FormData 的 File */
export async function loadFile() {
  try {
    const rec = await idbGet('file');
    if (!rec?.blob) return null;
    const file = new File([rec.blob], rec.name, { type: rec.type });
    return { file, kind: rec.kind };
  } catch (e) {
    console.warn('[会话] 读取文件失败:', e);
    return null;
  }
}

/** 存上次的生成结果，刷新后能直接把预览和动画恢复出来 */
export async function saveResult(result) {
  try {
    await idbPut('result', result);
  } catch (e) {
    console.warn('[会话] 保存结果失败:', e);
  }
}

export async function loadResult() {
  try {
    return await idbGet('result');
  } catch (e) {
    console.warn('[会话] 读取结果失败:', e);
    return null;
  }
}

/** 清空当前会话（不动历史记录——那是另一份东西，用户会指望它还在） */
export async function clearSession() {
  localStorage.removeItem(INPUT_KEY);
  await idbDelete('file');
  await idbDelete('result');
}

/* ---------- 近期记录 ---------- */

/**
 * 历史记录存的是「能把界面完整还原回去」的一整份快照：
 * 原图 + 全部输入 + 骨架 + 切图结果。
 *
 * 为什么不只存工程名、点开再去磁盘读：
 *   磁盘上只有导出格式的产物，没有前端预览要用的那套内部结构；
 *   而且同名工程重新生成会把旧产物清掉，靠磁盘就等于靠一份随时会变的真相。
 *   自带快照的代价是占空间，所以限到 HISTORY_LIMIT 条。
 */
async function historyTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, mode);
    let out;
    try {
      out = fn(tx.objectStore(HISTORY_STORE));
    } catch (e) {
      db.close();
      reject(e);
      return;
    }
    tx.oncomplete = () => { db.close(); resolve(out?.result ?? out ?? null); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

/** 按时间倒序列出全部记录 */
export async function listHistory() {
  try {
    const all = await historyTx('readonly', (store) => store.getAll());
    return (all ?? []).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  } catch (e) {
    console.warn('[记录] 读取列表失败:', e);
    return [];
  }
}

export async function getHistory(id) {
  try {
    return await historyTx('readonly', (store) => store.get(id));
  } catch (e) {
    console.warn('[记录] 读取失败:', e);
    return null;
  }
}

/**
 * 写入一条记录，并把超出上限的旧记录淘汰掉。
 *
 * 配额写满时不能静默丢弃：删掉最旧的再试一次，还是不行就放弃——
 * 记录写不进去不该让刚生成成功的结果也跟着报错。
 */
export async function saveHistory(entry) {
  try {
    await historyTx('readwrite', (store) => store.put(entry));
  } catch (e) {
    console.warn('[记录] 保存失败，尝试腾出空间后重试:', e);
    const list = await listHistory();
    const oldest = list[list.length - 1];
    if (oldest && oldest.id !== entry.id) {
      await deleteHistory(oldest.id);
      try {
        await historyTx('readwrite', (store) => store.put(entry));
      } catch (again) {
        console.warn('[记录] 仍然存不下，本次不记录:', again);
        return false;
      }
    } else {
      return false;
    }
  }

  const list = await listHistory();
  for (const stale of list.slice(HISTORY_LIMIT)) {
    await deleteHistory(stale.id);
  }
  return true;
}

export async function deleteHistory(id) {
  try {
    await historyTx('readwrite', (store) => store.delete(id));
  } catch (e) {
    console.warn('[记录] 删除失败:', e);
  }
}

export async function clearHistory() {
  try {
    await historyTx('readwrite', (store) => store.clear());
  } catch (e) {
    console.warn('[记录] 清空失败:', e);
  }
}

export { HISTORY_LIMIT };
