// Vidscope 本機版伺服器：提供網站本身，並在你搜尋時即時去全網（SearXNG）與各平台搜尋。
// 沒有任何 npm 相依套件。
//
//   docker compose up           （建議：會一起啟動 SearXNG）
//   node server/index.mjs       （只跑網站與各平台搜尋，不含全網搜尋，除非另外設定 SEARXNG_URL）
//
// API：
//   GET /api/health                 → { ok, searxng, sources }
//   GET /api/search?q=關鍵字&limit=  → { query, results, sources: { 來源: { count, error } } }
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as discover from '../crawler/adapters/discover.mjs';
import * as youtube from '../crawler/adapters/youtube.mjs';
import * as archive from '../crawler/adapters/archive.mjs';
import * as wikimedia from '../crawler/adapters/wikimedia.mjs';
import * as dailymotion from '../crawler/adapters/dailymotion.mjs';
import * as vimeo from '../crawler/adapters/vimeo.mjs';
import * as pexels from '../crawler/adapters/pexels.mjs';
import * as pixabay from '../crawler/adapters/pixabay.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const VIDEOS_FILE = join(ROOT, 'data', 'videos.json');
const CACHE_MS = 10 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 25_000;

const LIVE = [discover, youtube, archive, wikimedia, dailymotion, vimeo, pexels, pixabay];
const ready = (a) => a.needs.every((k) => process.env[k]) && (!a.isConfigured || a.isConfigured());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- 即時搜尋 ----------
const cache = new Map(); // query -> { at, payload }

async function liveSearch(query, limit) {
  const key = `${query.toLowerCase()}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.payload;

  const active = LIVE.filter(ready);
  const settled = await Promise.allSettled(
    active.map((a) =>
      withTimeout(
        a.search(query, {
          limit,
          // 即時搜尋：同時打開多頁、不額外等待，每次搜尋各自計算額度
          config: { deepLimit: 12, delayMs: 0, concurrency: 6, pageTimeoutMs: 8000, deepBudget: { used: 0 } },
        }),
        SOURCE_TIMEOUT_MS,
      ),
    ),
  );

  const results = [];
  const sources = {};
  settled.forEach((s, i) => {
    const a = active[i];
    if (s.status === 'fulfilled') {
      results.push(...s.value);
      sources[a.name] = { label: a.label, count: s.value.length };
    } else {
      sources[a.name] = { label: a.label, count: 0, error: s.reason?.message || String(s.reason) };
    }
  });

  const payload = { query, results: dedupe(results), sources };
  cache.set(key, { at: Date.now(), payload });
  remember(payload.results); // 搜過的結果也存進本機資料庫，之後不用連網也找得到
  return payload;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('逾時')), ms))]);
}

function dedupe(list) {
  const map = new Map();
  for (const v of list) if (!map.has(v.id)) map.set(v.id, v);
  return [...map.values()];
}

// 把即時搜尋結果合併進 data/videos.json（每 30 秒最多寫一次）
let pending = [];
let flushTimer = null;
function remember(list) {
  pending.push(...list);
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const batch = pending;
    pending = [];
    try {
      const old = JSON.parse(await readFile(VIDEOS_FILE, 'utf8').catch(() => '[]'));
      const byId = new Map(old.map((v) => [v.id, v]));
      for (const v of batch) byId.set(v.id, { ...byId.get(v.id), ...v });
      const all = [...byId.values()].slice(-10000);
      await writeFile(VIDEOS_FILE, JSON.stringify(all));
    } catch (e) {
      console.error('寫入 data/videos.json 失敗：', e.message);
    }
  }, 30_000);
}

// ---------- HTTP ----------
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(ROOT, rel || 'index.html');
  if (!file.startsWith(ROOT + sep) && file !== ROOT) return sendJson(res, 403, { error: 'forbidden' });
  // 不對外提供隱藏檔（.env、.git 等）
  if (rel.split(/[/\\]/).some((part) => part.startsWith('.'))) return sendJson(res, 404, { error: 'not found' });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        searxng: Boolean(process.env.SEARXNG_URL),
        sources: LIVE.filter(ready).map((a) => a.name),
      });
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      if (!q) return sendJson(res, 400, { error: '請提供搜尋關鍵字 q' });
      const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50);
      return sendJson(res, 200, await liveSearch(q, limit));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const on = LIVE.filter(ready).map((a) => a.label).join('、');
  console.log(`Vidscope 已啟動：http://localhost:${PORT}`);
  console.log(`即時搜尋來源：${on}`);
  if (!process.env.SEARXNG_URL) console.log('提示：沒有設定 SEARXNG_URL，全網搜尋未啟用（用 docker compose up 會自動帶起 SearXNG）');
});
