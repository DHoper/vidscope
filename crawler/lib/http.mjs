// 共用的 HTTP 工具：統一 User-Agent、逾時、錯誤處理。
// 這個檔案和 archive / wikimedia / dailymotion 等 adapter 也會在瀏覽器裡直接使用（即時搜尋），
// 所以不能直接碰 process（瀏覽器沒有），一律透過 env 讀環境變數。
// 瀏覽器擴充功能的背景程式也沒有 window，所以用 process.versions.node 判斷是不是 Node。
const IS_NODE = typeof globalThis.process !== 'undefined' && Boolean(globalThis.process.versions?.node);
export const env = (IS_NODE && globalThis.process?.env) || {};

export const USER_AGENT = env.CRAWLER_USER_AGENT || 'VidscopeBot/0.1 (+https://github.com/DHoper/vidscope)';

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    // 瀏覽器裡不設 User-Agent：自訂標頭會觸發 CORS 預檢，部分 API 會因此失敗
    const headers = IS_NODE ? { 'User-Agent': USER_AGENT, ...(options.headers || {}) } : options.headers || {};
    return await fetch(url, { ...options, signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, options = {}, timeoutMs = 15000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export async function getText(url, options = {}, timeoutMs = 15000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return { text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
