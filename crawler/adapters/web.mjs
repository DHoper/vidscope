// 通用網頁爬蟲：從 config.json 的 web.seeds 出發，抓任何網站頁面上的影片資訊。
//
// 讀取的資料（都是網站自己公開標註、給搜尋引擎看的影片資訊）：
//   1. JSON-LD 的 schema.org VideoObject
//   2. Open Graph 的 og:video / og:title / og:image
//   3. 頁面中的 <video> / <source> 標籤
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

export async function crawl(webConfig = {}) {
  const seeds = webConfig.seeds || [];
  const delayMs = webConfig.delayMs ?? 2000;
  const lastHit = new Map(); // host -> timestamp
  const results = [];

  for (const seed of seeds) {
    const seedUrl = typeof seed === 'string' ? seed : seed.url;
    const maxDepth = seed.depth ?? webConfig.depth ?? 1;
    const maxPages = seed.maxPages ?? webConfig.maxPages ?? 30;
    const sameHostOnly = seed.sameHost ?? true;
    const include = seed.include ? new RegExp(seed.include) : null;
    const seedHost = new URL(seedUrl).host;

    const queue = [{ url: seedUrl, depth: 0 }];
    const seen = new Set([normalizeUrl(seedUrl)]);
    let pages = 0;

    while (queue.length && pages < maxPages) {
      const { url, depth } = queue.shift();
      const host = new URL(url).host;

      if (!(await isAllowed(url))) {
        console.log(`  [web] robots.txt 不允許，略過 ${url}`);
        continue;
      }
      const wait = (lastHit.get(host) || 0) + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastHit.set(host, Date.now());

      let html;
      try {
        const res = await getText(url);
        if (!res.contentType.includes('html')) continue;
        html = res.text;
      } catch (e) {
        console.log(`  [web] 抓取失敗 ${url}: ${e.message}`);
        continue;
      }
      pages++;

      results.push(...extractVideos(html, url));

      if (depth < maxDepth) {
        for (const link of extractLinks(html, url)) {
          const key = normalizeUrl(link);
          if (seen.has(key)) continue;
          if (sameHostOnly && new URL(link).host !== seedHost) continue;
          if (include && !include.test(link)) continue;
          seen.add(key);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
    console.log(`  [web] ${seedUrl}：抓了 ${pages} 頁`);
  }
  return dedupe(results);
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

  // 2. Open Graph（沒有 JSON-LD 時才用）
  const ogVideo = meta['og:video:secure_url'] || meta['og:video:url'] || meta['og:video'];
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
  return out;
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
