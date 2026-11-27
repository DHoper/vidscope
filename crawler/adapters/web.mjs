// 通用網頁爬蟲：從 config.json 的 web.seeds 出發，抓任何網站頁面上的影片資訊。
// 自動找網站的部分在 discover.mjs（全網影片搜尋），它會把找到的頁面交給這裡的 extractVideos 解析。
//
// 讀取的資料（依序嘗試，前面有找到就不往下）：
//   1. JSON-LD 的 schema.org VideoObject
//   2. Open Graph 的 og:video、Twitter Card 的 twitter:player
//   3. 頁面中的 <video> / <source> 標籤
//   4. 嵌入的播放器 <iframe>（YouTube、Vimeo、Bilibili 等）
//   5. 直接連到影片檔的 <a href>
//
// 行為規範：
//   - 遵守 robots.txt
//   - 同一網站兩次請求之間至少間隔 web.delayMs 毫秒
//   - 每個 seed 有頁數上限與深度上限
//   - 只有頁面本身提供 <a download> 下載連結時，才會填 downloadUrl
import { getText, sleep } from '../lib/http.mjs';
import { isAllowed } from '../lib/robots.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'web';
export const label = '網頁';
export const needs = [];

const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i;

// seed 格式（字串等同 { url }）：
//   url       起始網址（選填，有 search 或 sitemap 時可省略）
//   search    站內搜尋網址模板，{query} 會換成 config.queries 裡的每個關鍵字
//   sitemap   影片 sitemap 網址（<video:video> 格式）
//   depth / maxPages / sameHost / include   見 README
export async function crawl(webConfig = {}) {
  const seeds = webConfig.seeds || [];
  const queries = webConfig.queries || [];
  const delayMs = webConfig.delayMs ?? 2000;
  const lastHit = new Map(); // host -> timestamp
  const results = [];

  const politeGet = async (url) => {
    const host = new URL(url).host;
    const wait = (lastHit.get(host) || 0) + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    return getText(url);
  };

  for (const raw of seeds) {
    const seed = typeof raw === 'string' ? { url: raw } : raw;
    const maxDepth = seed.depth ?? webConfig.depth ?? 1;
    const maxPages = seed.maxPages ?? webConfig.maxPages ?? 30;
    const sameHostOnly = seed.sameHost ?? true;
    const include = seed.include ? new RegExp(seed.include) : null;
    const label = seed.url || seed.search || seed.sitemap;
    const stats = { pages: 0, robots: 0, failed: 0, videos: 0, sitemap: 0 };

    // 影片 sitemap
    if (seed.sitemap) {
      try {
        if (await isAllowed(seed.sitemap)) {
          const { text } = await politeGet(seed.sitemap);
          const found = parseVideoSitemap(text, seed.sitemap);
          stats.sitemap = found.length;
          results.push(...found);
        } else stats.robots++;
      } catch (e) {
        stats.failed++;
        console.log(`  [web] sitemap 抓取失敗 ${seed.sitemap}: ${e.message}`);
      }
    }

    // 起始頁：url 本身，加上每個關鍵字的站內搜尋頁
    const starts = [];
    if (seed.url) starts.push({ url: seed.url, query: null });
    if (seed.search) {
      for (const q of queries) starts.push({ url: seed.search.replace(/\{query\}/g, encodeURIComponent(q)), query: q });
    }
    if (!starts.length) {
      console.log(`  [web] ${label}：sitemap ${stats.sitemap} 筆`);
      continue;
    }
    const seedHost = new URL(starts[0].url).host;
    const queue = starts.map((s) => ({ ...s, depth: 0 }));
    const seen = new Set(starts.map((s) => normalizeUrl(s.url)));
    // 每個起始頁平均分配頁數，避免第一個關鍵字把額度用光
    const budget = maxPages * Math.max(1, starts.length);

    while (queue.length && stats.pages < budget) {
      const { url, depth, query } = queue.shift();

      if (!(await isAllowed(url))) {
        stats.robots++;
        continue;
      }

      let html;
      try {
        const res = await politeGet(url);
        if (!res.contentType.includes('html')) continue;
        html = res.text;
      } catch (e) {
        stats.failed++;
        console.log(`  [web] 抓取失敗 ${url}: ${e.message}`);
        continue;
      }
      stats.pages++;

      const found = extractVideos(html, url).map((v) => ({ ...v, query: v.query || query }));
      stats.videos += found.length;
      results.push(...found);

      if (depth < maxDepth) {
        for (const link of extractLinks(html, url)) {
          const key = normalizeUrl(link);
          if (seen.has(key)) continue;
          if (sameHostOnly && new URL(link).host !== seedHost) continue;
          if (include && !include.test(link)) continue;
          seen.add(key);
          queue.push({ url: link, depth: depth + 1, query });
        }
      }
    }
    console.log(
      `  [web] ${label}：抓了 ${stats.pages} 頁，找到 ${stats.videos} 部影片` +
        (stats.sitemap ? `，sitemap ${stats.sitemap} 筆` : '') +
        (stats.robots ? `，robots.txt 擋掉 ${stats.robots} 頁` : '') +
        (stats.failed ? `，失敗 ${stats.failed} 頁` : ''),
    );
  }
  return dedupe(results);
}

// 影片 sitemap：https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps
export function parseVideoSitemap(xml, sitemapUrl) {
  const out = [];
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decode(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()) : null;
  };
  for (const urlBlock of xml.match(/<url>[\s\S]*?<\/url>/gi) || []) {
    const page = tag(urlBlock, 'loc');
    for (const v of urlBlock.match(/<video:video>[\s\S]*?<\/video:video>/gi) || []) {
      const content = abs(tag(v, 'video:content_loc'), sitemapUrl);
      const player = abs(tag(v, 'video:player_loc'), sitemapUrl);
      out.push(
        makeVideo({
          source: name,
          sourceId: content || player || `${page}#${out.length}`,
          title: tag(v, 'video:title'),
          description: tag(v, 'video:description'),
          channel: tag(v, 'video:uploader') || new URL(page || sitemapUrl).host,
          url: page,
          embedUrl: player,
          fileUrl: content && VIDEO_EXT.test(content) ? content : null,
          thumbnail: abs(tag(v, 'video:thumbnail_loc'), sitemapUrl),
          duration: tag(v, 'video:duration'),
          publishedAt: tag(v, 'video:publication_date'),
        }),
      );
    }
  }
  return out;
}

// ---------- 解析 ----------

export function extractVideos(html, pageUrl) {
  const out = [];
  const meta = readMeta(html);
  const downloads = readDownloadLinks(html, pageUrl);

  // 1. JSON-LD VideoObject
  for (const obj of readJsonLd(html)) {
    const contentUrl = abs(first(obj.contentUrl), pageUrl);
    const embedUrl = abs(first(obj.embedUrl), pageUrl);
    out.push(
      makeVideo({
        source: name,
        sourceId: contentUrl || embedUrl || `${pageUrl}#${out.length}`,
        title: obj.name || meta['og:title'],
        description: obj.description || meta['og:description'],
        channel: authorName(obj) || meta['og:site_name'] || new URL(pageUrl).host,
        url: pageUrl,
        embedUrl: embedUrl && !VIDEO_EXT.test(embedUrl) ? embedUrl : null,
        fileUrl: contentUrl && VIDEO_EXT.test(contentUrl) ? contentUrl : null,
        downloadUrl: pickDownload(downloads, contentUrl),
        thumbnail: abs(first(obj.thumbnailUrl) || imageUrl(obj.thumbnail) || meta['og:image'], pageUrl),
        duration: obj.duration,
        publishedAt: obj.uploadDate || obj.datePublished,
        license: typeof obj.license === 'string' ? obj.license : null,
      }),
    );
  }

  // 2. Open Graph / Twitter Card（沒有 JSON-LD 時才用）
  const ogVideo =
    meta['og:video:secure_url'] || meta['og:video:url'] || meta['og:video'] ||
    meta['twitter:player:stream'] || meta['twitter:player'];
  if (!out.length && ogVideo) {
    const u = abs(ogVideo, pageUrl);
    const isFile = VIDEO_EXT.test(u) || (meta['og:video:type'] || '').startsWith('video/');
    out.push(
      makeVideo({
        source: name, sourceId: u,
        title: meta['og:title'] || readTitle(html),
        description: meta['og:description'],
        channel: meta['og:site_name'] || new URL(pageUrl).host,
        url: pageUrl,
        embedUrl: isFile ? null : u,
        fileUrl: isFile ? u : null,
        downloadUrl: pickDownload(downloads, u),
        thumbnail: abs(meta['og:image'], pageUrl),
        duration: meta['video:duration'] || meta['og:video:duration'],
      }),
    );
  }

  // 3. <video> / <source>（前兩者都沒有時才用）
  if (!out.length) {
    const srcs = new Set();
    for (const m of html.matchAll(/<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
      const u = abs(m[1], pageUrl);
      if (u && !u.startsWith('blob:') && VIDEO_EXT.test(u)) srcs.add(u);
    }
    const posterMatch = html.match(/<video\b[^>]*\bposter=["']([^"']+)["']/i);
    for (const u of srcs) {
      out.push(
        makeVideo({
          source: name, sourceId: u,
          title: meta['og:title'] || readTitle(html),
          description: meta['og:description'] || meta['description'],
          channel: meta['og:site_name'] || new URL(pageUrl).host,
          url: pageUrl,
          fileUrl: u,
          downloadUrl: pickDownload(downloads, u),
          thumbnail: abs((posterMatch && posterMatch[1]) || meta['og:image'], pageUrl),
        }),
      );
    }
  }

  // 4. 嵌入的播放器 <iframe>（前面都沒有時才用）
  if (!out.length) {
    const seenEmbeds = new Set();
    for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) {
      const src = abs(attr(m[0], 'src') || attr(m[0], 'data-src'), pageUrl);
      if (!src || !PLAYER_RE.test(src) || seenEmbeds.has(src)) continue;
      seenEmbeds.add(src);
      out.push(
        makeVideo({
          source: name, sourceId: src,
          title: attr(m[0], 'title') || meta['og:title'] || readTitle(html),
          description: meta['og:description'] || meta['description'],
          channel: meta['og:site_name'] || new URL(pageUrl).host,
          url: pageUrl,
          embedUrl: src,
          thumbnail: thumbFromEmbed(src) || abs(meta['og:image'], pageUrl),
        }),
      );
    }
  }

  // 5. 直接連到影片檔的 <a href>（前面都沒有時才用）
  if (!out.length) {
    for (const href of new Set(readVideoFileLinks(html, pageUrl))) {
      out.push(
        makeVideo({
          source: name, sourceId: href,
          title: meta['og:title'] || readTitle(html),
          description: meta['og:description'] || meta['description'],
          channel: meta['og:site_name'] || new URL(pageUrl).host,
          url: pageUrl,
          fileUrl: href,
          downloadUrl: pickDownload(downloads, href),
          thumbnail: abs(meta['og:image'], pageUrl),
        }),
      );
    }
  }
  return out;
}

// 常見影片播放器的嵌入網址
const PLAYER_RE =
  /(youtube(-nocookie)?\.com\/embed\/|player\.vimeo\.com\/video\/|dailymotion\.com\/(embed|player)|geo\.dailymotion\.com\/player|archive\.org\/embed\/|player\.bilibili\.com|bilibili\.com\/blackboard|facebook\.com\/plugins\/video|player\.twitch\.tv|streamable\.com\/[eo]\/|rumble\.com\/embed\/|ted\.com\/talks\/embed|\/embed\/|\/player\/|[?&]embed=)/i;

function thumbFromEmbed(src) {
  const yt = src.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/i);
  return yt ? `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg` : null;
}

function readVideoFileLinks(html, pageUrl) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    const u = abs(m[1], pageUrl);
    if (u && VIDEO_EXT.test(u)) links.push(u);
  }
  return links;
}

function readMeta(html) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop');
    const content = attr(tag, 'content');
    if (key && content != null && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = decode(content);
  }
  return meta;
}

function readJsonLd(html) {
  const found = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    walk(data, found);
  }
  return found;
}

function walk(node, found) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, found));
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('VideoObject')) found.push(node);
  for (const key of ['@graph', 'video', 'mainEntity', 'itemListElement', 'item', 'hasPart']) {
    if (node[key]) walk(node[key], found);
  }
}

function readDownloadLinks(html, pageUrl) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\sdownload(\s|=|>|\/)/i.test(tag)) continue;
    const href = abs(attr(tag, 'href'), pageUrl);
    if (href && VIDEO_EXT.test(href)) links.push(href);
  }
  return links;
}

function pickDownload(downloads, fileUrl) {
  if (!downloads.length) return null;
  if (fileUrl && downloads.includes(fileUrl)) return fileUrl;
  return downloads[0];
}

function extractLinks(html, pageUrl) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#]+)["']/gi)) {
    const u = abs(m[1], pageUrl);
    if (u && /^https?:/.test(u) && !/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js)(\?|$)/i.test(u)) links.push(u);
  }
  return links;
}

function readTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decode(m[1].trim()) : null;
}

function attr(tag, key) {
  const m = tag.match(new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : null;
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function imageUrl(t) {
  const x = first(t);
  if (!x) return null;
  return typeof x === 'string' ? x : x.url || x.contentUrl || null;
}

function authorName(obj) {
  const a = first(obj.author) || first(obj.creator) || first(obj.publisher);
  if (!a) return null;
  return typeof a === 'string' ? a : a.name || null;
}

function abs(u, base) {
  if (!u || typeof u !== 'string') return null;
  try {
    return new URL(decode(u.trim()), base).href;
  } catch {
    return null;
  }
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href.replace(/\/$/, '');
  } catch {
    return u;
  }
}

function dedupe(list) {
  const map = new Map();
  for (const v of list) if (!map.has(v.id)) map.set(v.id, v);
  return [...map.values()];
}
