// 共用的 HTTP 工具：統一 User-Agent、逾時、錯誤處理
export const USER_AGENT =
  process.env.CRAWLER_USER_AGENT ||
  'VidscopeBot/0.1 (+https://github.com/DHoper/vidscope)';

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export async function getText(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return { text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
