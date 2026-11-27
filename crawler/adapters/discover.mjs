// 全網影片搜尋：用 Brave Search 的影片搜尋 API，依 config.queries 自動找出全網的影片頁面，
// 不需要手動填網址。需要環境變數 BRAVE_API_KEY（https://api-dashboard.search.brave.com）。
//
// 流程：
//   1. 每個關鍵字呼叫 Brave 影片搜尋，取得任何網站的影片結果（標題、網址、縮圖、片長）
//   2. 已知平台（YouTube / Vimeo / Dailymotion / Bilibili）直接轉成嵌入網址
//   3. 其他網站：對前 deepLimit 筆結果實際打開頁面（遵守 robots.txt），
//      用通用爬蟲的解析器找出播放器、影片檔與下載連結
//
// 費用：Brave 每月有 5 美元免費額度，超過按次計費。index.mjs 會依 minIntervalHours 控制頻率。
import { getJson, getText, sleep } from '../lib/http.mjs';
import { isAllowed } from '../lib/robots.mjs';
import { makeVideo } from '../lib/normalize.mjs';
import { extractVideos } from './web.mjs';

export const name = 'discover';
export const label = '全網搜尋';
export const needs = ['BRAVE_API_KEY'];

let deepUsed = 0;

export async function search(query, { limit = 20, config = {} } = {}) {
  const params = new URLSearchParams({ q: query, count: String(Math.min(limit, 50)) });
  if (config.country) params.set('country', config.country);
  if (config.searchLang) params.set('search_lang', config.searchLang);
  if (config.safesearch) params.set('safesearch', config.safesearch);
  const data = await getJson(`https://api.search.brave.com/res/v1/videos/search?${params}`, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' },
  });

  const deepLimit = config.deepLimit ?? 40; // 每次執行最多實際打開幾個頁面
  const delayMs = config.delayMs ?? 1500;
  const out = [];

  for (const r of data.results || []) {
    if (!r.url) continue;
    const base = {
      source: name, sourceId: r.url, query,
      title: r.title, description: r.description,
      channel: r.video?.creator || r.video?.publisher || r.meta_url?.hostname || hostOf(r.url),
      url: r.url,
      thumbnail: r.thumbnail?.src || r.thumbnail?.original,
      duration: r.video?.duration,
      publishedAt: r.page_age || r.age,
    };

    const known = knownEmbed(r.url);
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
