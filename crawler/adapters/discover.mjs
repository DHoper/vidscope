// 全網影片搜尋：依 config.queries 自動找出全網的影片頁面，不需要手動填網址。
//
// 搜尋提供者（有設定哪個就用哪個，兩個都有時優先 SearXNG）：
//   - SearXNG：免費開源的搜尋聚合器。workflow 會在 GitHub Actions 裡臨時啟動一個，
//     並設定環境變數 SEARXNG_URL（例如 http://localhost:8080）。
//   - Brave Search API：環境變數 BRAVE_API_KEY。每月 5 美元免費額度，超過按次計費。
//
// 流程：
//   1. 每個關鍵字向搜尋提供者要影片結果（任何網站都可能出現）
//   2. 已知平台（YouTube / Vimeo / Bilibili，以及有 Player ID 的 Dailymotion）直接轉成嵌入網址
//   3. 其他網站：對前 deepLimit 筆結果實際打開頁面（遵守 robots.txt），
//      用通用爬蟲的解析器找出播放器、影片檔與下載連結
import { getJson, getText, sleep } from '../lib/http.mjs';
import { isAllowed } from '../lib/robots.mjs';
import { makeVideo } from '../lib/normalize.mjs';
import { extractVideos } from './web.mjs';

export const name = 'discover';
export const label = '全網搜尋';
export const needs = []; // 用 isConfigured 判斷：SEARXNG_URL 或 BRAVE_API_KEY 有一個就好

export function isConfigured() {
  return Boolean(process.env.SEARXNG_URL || process.env.BRAVE_API_KEY);
}

let deepUsed = 0;

// ---------- 搜尋提供者：都轉成同一種格式 ----------
// { url, title, description, channel, thumbnail, duration, publishedAt, embedUrl }

async function searchSearxng(query, limit, config) {
  const base = process.env.SEARXNG_URL.replace(/\/$/, '');
  const results = [];
  // SearXNG 每頁約 10–20 筆，多翻幾頁湊到 limit
  for (let page = 1; page <= 3 && results.length < limit; page++) {
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'videos', pageno: String(page) });
    if (config.searchLang) params.set('language', config.searchLang);
    if (config.safesearch != null) params.set('safesearch', String({ off: 0, moderate: 1, strict: 2 }[config.safesearch] ?? config.safesearch));
    const data = await getJson(`${base}/search?${params}`);
    const batch = data.results || [];
    if (!batch.length) break;
    for (const r of batch) {
      results.push({
        url: r.url,
        title: r.title,
        description: r.content,
        channel: r.author || (r.engines || [r.engine]).filter(Boolean).join(', ') || null,
        thumbnail: r.thumbnail || r.thumbnail_src || r.img_src,
        duration: r.length,
        publishedAt: r.publishedDate,
        embedUrl: r.iframe_src || null,
      });
    }
  }
  return results.slice(0, limit);
}

async function searchBrave(query, limit, config) {
  const params = new URLSearchParams({ q: query, count: String(Math.min(limit, 50)) });
  if (config.country) params.set('country', config.country);
  if (config.searchLang) params.set('search_lang', config.searchLang);
  if (config.safesearch) params.set('safesearch', config.safesearch);
  const data = await getJson(`https://api.search.brave.com/res/v1/videos/search?${params}`, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' },
  });
  return (data.results || []).map((r) => ({
    url: r.url,
    title: r.title,
    description: r.description,
    channel: r.video?.creator || r.video?.publisher || r.meta_url?.hostname,
    thumbnail: r.thumbnail?.src || r.thumbnail?.original,
    duration: r.video?.duration,
    publishedAt: r.page_age || r.age,
    embedUrl: null,
  }));
}

export async function search(query, { limit = 20, config = {} } = {}) {
  const raw = process.env.SEARXNG_URL
    ? await searchSearxng(query, limit, config)
    : await searchBrave(query, limit, config);

  const deepLimit = config.deepLimit ?? 40; // 每次執行最多實際打開幾個頁面
  const delayMs = config.delayMs ?? 1500;
  const out = [];
  const seen = new Set();

  for (const r of raw) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const base = {
      source: name, sourceId: r.url, query,
      title: r.title, description: r.description,
      channel: r.channel || hostOf(r.url),
      url: r.url,
      thumbnail: r.thumbnail,
      duration: r.duration,
      publishedAt: r.publishedAt,
    };

    // SearXNG 給的 iframe_src 也能用；但 Dailymotion 舊版嵌入網址會回 403，排除
    const providerEmbed =
      r.embedUrl && /^https?:/.test(r.embedUrl) && !/dailymotion\.com\/embed/.test(r.embedUrl) ? r.embedUrl : null;
    const known = knownEmbed(r.url) || providerEmbed;
    if (known) {
      out.push(makeVideo({ ...base, embedUrl: known }));
      continue;
    }

    // 其他網站：打開頁面找播放器 / 影片檔
    let extracted = null;
    if (deepUsed < deepLimit) {
      try {
        if (await isAllowed(r.url)) {
          deepUsed++;
          await sleep(delayMs);
          const page = await getText(r.url);
          if (page.contentType.includes('html')) extracted = extractVideos(page.text, r.url)[0] || null;
        }
      } catch {
        // 打不開就只留搜尋結果本身
      }
    }
    out.push(
      makeVideo({
        ...base,
        embedUrl: extracted?.embedUrl,
        fileUrl: extracted?.fileUrl,
        downloadUrl: extracted?.downloadUrl,
        thumbnail: base.thumbnail || extracted?.thumbnail,
        duration: base.duration ?? extracted?.duration,
        license: extracted?.license,
      }),
    );
  }
  return out;
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// 已知平台的網址直接轉成嵌入網址
export function knownEmbed(u) {
  let x;
  try {
    x = new URL(u);
  } catch {
    return null;
  }
  const host = x.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtube.com' && x.searchParams.get('v')) return `https://www.youtube.com/embed/${x.searchParams.get('v')}`;
  if (host === 'youtube.com' && x.pathname.startsWith('/shorts/')) return `https://www.youtube.com/embed/${x.pathname.split('/')[2]}`;
  if (host === 'youtu.be') return `https://www.youtube.com/embed/${x.pathname.slice(1)}`;
  const vimeo = host === 'vimeo.com' && x.pathname.match(/^\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  const bili = host === 'bilibili.com' && x.pathname.match(/\/video\/(BV\w+)/i);
  if (bili) return `https://player.bilibili.com/player.html?bvid=${bili[1]}&autoplay=0`;
  // Dailymotion 需要 Player ID（見 dailymotion.mjs），沒有就不嵌入
  const dm = host === 'dailymotion.com' && x.pathname.match(/\/video\/(\w+)/);
  if (dm && process.env.DAILYMOTION_PLAYER_ID) {
    return `https://geo.dailymotion.com/player/${process.env.DAILYMOTION_PLAYER_ID}.html?video=${dm[1]}`;
  }
  return null;
}
