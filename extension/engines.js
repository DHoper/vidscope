// 全網影片搜尋（在擴充功能裡執行，所以不受網頁跨網域限制）。
//
// 1. 找網址：Bing 影片搜尋 + YouTube 站內搜尋，兩邊同時查
// 2. 補資料：YouTube 影片用官方 oEmbed 取得標題、頻道、縮圖；
//    其他網站打開頁面（遵守 robots.txt），用通用爬蟲的解析器找播放器與下載連結
//
// 搜尋頁的 HTML 結構可能隨時改版，所以每個解析器都有退路：
// 結構化資料解析不到時，至少從連結裡撈出影片網址，再交給第 2 步補資料。
import { makeVideo } from './vendor/lib/normalize.mjs';
import { isAllowed } from './vendor/lib/robots.mjs';
import { extractVideos } from './vendor/adapters/web.mjs';
import { knownEmbed } from './vendor/adapters/discover.mjs';

const TIMEOUT_MS = 12000;

async function getText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------- 網址整理 ----------
export function youtubeId(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtube.com') {
      if (x.searchParams.get('v')) return x.searchParams.get('v');
      const m = x.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
    if (host === 'youtu.be') return x.pathname.slice(1, 12) || null;
  } catch {}
  return null;
}

function canonical(u) {
  const id = youtubeId(u);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch {
    return null;
  }
}

// ---------- Bing 影片搜尋 ----------
export function parseBing(html) {
  const out = [];
  // 每個結果的 vrhm 屬性裡是一段 JSON（標題、片長、網頁網址、縮圖）
  for (const m of html.matchAll(/\bvrhm="([^"]+)"/g)) {
    try {
      const d = JSON.parse(decode(m[1]));
      const url = d.pgurl || d.purl || d.murl;
      if (!url) continue;
      out.push({ url, title: d.vt || d.t, duration: d.du, thumbnail: d.turl || d.thumb, channel: d.ch || d.pub || null });
    } catch {}
  }
  if (out.length) return out;
  // 退路：撈出所有指向影片網站的連結
  const seen = new Set();
  for (const m of html.matchAll(/\b(?:href|ourl|data-url|murl)="(https?:\/\/[^"]+)"/g)) {
    const url = decode(m[1]);
    if (!/youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d|dailymotion\.com\/video|bilibili\.com\/video/i.test(url)) continue;
    const c = canonical(url);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push({ url: c });
    }
  }
  return out;
}

// 一次抓前幾頁（Bing 每頁約 35 筆），重複的之後會去掉
async function searchBing(q, pages = 3) {
  const urls = Array.from({ length: pages }, (_, i) =>
    `https://www.bing.com/videos/search?q=${encodeURIComponent(q)}&FORM=HDRSC3${i ? `&first=${i * 35 + 1}` : ''}`,
  );
  const settled = await Promise.allSettled(urls.map((u) => getText(u)));
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) throw settled[0].reason;
  return ok.flatMap((s) => parseBing(s.value.text));
}

// ---------- YouTube 站內搜尋 ----------
export function parseYouTube(html) {
  const out = [];
  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
  if (m) {
    try {
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        const r = node.videoRenderer;
        if (r?.videoId) {
          out.push({
            url: `https://www.youtube.com/watch?v=${r.videoId}`,
            title: r.title?.runs?.map((x) => x.text).join('') || r.title?.simpleText,
            channel: r.ownerText?.runs?.[0]?.text || r.longBylineText?.runs?.[0]?.text,
            duration: r.lengthText?.simpleText,
            thumbnail: `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`,
            description: r.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((x) => x.text).join(''),
          });
          return;
        }
        for (const v of Object.values(node)) walk(v);
      };
      walk(JSON.parse(m[1]));
    } catch {}
  }
  if (out.length) return out;
  // 退路：只撈影片 ID
  const seen = new Set();
  for (const x of html.matchAll(/"videoId":"([\w-]{11})"/g)) {
    if (seen.has(x[1])) continue;
    seen.add(x[1]);
    out.push({ url: `https://www.youtube.com/watch?v=${x[1]}` });
  }
  return out;
}

async function searchYouTube(q) {
  const { text } = await getText(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=zh-TW&gl=TW`);
  return parseYouTube(text);
}

// ---------- 補資料 ----------
async function enrichYouTube(item) {
  try {
    const { text } = await getText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(item.url)}`);
    const d = JSON.parse(text);
    return { ...item, title: item.title || d.title, channel: item.channel || d.author_name, thumbnail: item.thumbnail || d.thumbnail_url };
  } catch {
    return item;
  }
}

async function enrichPage(item) {
  try {
    if (!(await isAllowed(item.url))) return item;
    const page = await getText(item.url);
    if (!page.contentType.includes('html')) return item;
    const v = extractVideos(page.text, item.url)[0];
    if (!v) return item;
    return {
      ...item,
      title: item.title || v.title,
      channel: item.channel || v.channel,
      thumbnail: item.thumbnail || v.thumbnail,
      duration: item.duration ?? v.duration,
      description: item.description || v.description,
      embedUrl: v.embedUrl,
      fileUrl: v.fileUrl,
      downloadUrl: v.downloadUrl,
      license: v.license,
    };
  } catch {
    return item;
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

// ---------- Google 影片搜尋 ----------
// Google 的搜尋頁一定要執行 JavaScript 才會出結果，直接抓 HTML 拿不到東西。
// 所以在背景開一個不切換過去的分頁，讓 Google 正常載入，再讀出結果連結，讀完立刻關掉。
// 如果 Google 要求人機驗證，就停下來請使用者自己去完成，不會試圖繞過。
async function searchGoogle(q, pages = 3) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const out = [];
  try {
    for (let p = 0; p < pages; p++) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=vid&hl=zh-TW${p ? `&start=${p * 10}` : ''}`;
      await loadTab(tab.id, url);
      const now = await chrome.tabs.get(tab.id);
      if (/google\.[^/]+\/sorry\//.test(now.url || '')) {
        throw new Error('Google 要求人機驗證：請先到 google.com 搜尋一次並完成驗證');
      }
      await new Promise((r) => setTimeout(r, 400));
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readGoogleResults });
      if (!result?.length) break;
      out.push(...result);
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  return out;
}

function loadTab(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Google 載入逾時'));
    }, 20000);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch((e) => {
      cleanup();
      reject(e);
    });
  });
}

// 在 Google 搜尋頁裡執行：每個結果都是一個包著標題（h3）的連結
function readGoogleResults() {
  const items = [];
  const seen = new Set();
  for (const heading of document.querySelectorAll('a[href] h3, a[href] [role="heading"]')) {
    const a = heading.closest('a');
    let href = a.href;
    try {
      const u = new URL(href);
      if (/(^|\.)google\./.test(u.hostname) && u.pathname === '/url') href = u.searchParams.get('q') || u.searchParams.get('url');
    } catch {}
    if (!href || !/^https?:/.test(href) || /^https?:\/\/([^/]*\.)?google\./.test(href) || seen.has(href)) continue;
    seen.add(href);
    const block = a.closest('[data-hveid]') || a.parentElement;
    const dur = (block?.innerText || '').match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
    items.push({ url: href, title: heading.innerText.trim(), duration: dur ? dur[0] : null });
  }
  return items;
}

// ---------- 主流程 ----------
export async function searchWeb(q, limit = 500) {
  const engines = { google: searchGoogle, bing: searchBing, youtube: searchYouTube };
  const status = {};
  const settled = await Promise.allSettled(Object.values(engines).map((fn) => fn(q)));

  // 兩邊交錯合併，避免某一邊全部排在前面
  const lists = [];
  Object.keys(engines).forEach((name, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      status[name] = { count: s.value.length };
      lists.push(s.value);
    } else {
      status[name] = { count: 0, error: s.reason?.message || String(s.reason) };
    }
  });
  if (!lists.length) {
    throw new Error(`搜尋引擎都沒有回應（${Object.entries(status).map(([k, s]) => `${k}: ${s.error}`).join('；')}）`);
  }
  const merged = [];
  const seen = new Set();
  for (let k = 0; merged.length < limit && lists.some((l) => k < l.length); k++) {
    for (const l of lists) {
      const it = l[k];
      const c = it && canonical(it.url);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      merged.push({ ...it, url: c });
      if (merged.length >= limit) break;
    }
  }

  // 補資料：YouTube 用 oEmbed，其他網站最多打開 10 頁
  let opened = 0;
  const enriched = await pool(merged, 6, (it) => {
    if (youtubeId(it.url)) return it.title && it.thumbnail ? it : enrichYouTube(it);
    if (knownEmbed(it.url)) return it;
    return opened++ < 20 ? enrichPage(it) : it;
  });

  const results = enriched
    .filter((it) => it.title)
    .map((it) =>
      makeVideo({
        source: 'discover',
        sourceId: it.url,
        query: q,
        title: it.title,
        description: it.description,
        channel: it.channel,
        url: it.url,
        embedUrl: knownEmbed(it.url) || it.embedUrl,
        fileUrl: it.fileUrl,
        downloadUrl: it.downloadUrl,
        thumbnail: it.thumbnail,
        duration: it.duration,
        license: it.license,
      }),
    );
  return { results, engines: status };
}
