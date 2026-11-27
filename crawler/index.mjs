// 爬蟲主程式：依 config.json 跑所有來源，合併進 data/videos.json
//
// 用法：
//   node crawler/index.mjs                 跑全部
//   node crawler/index.mjs archive web     只跑指定來源
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as youtube from './adapters/youtube.mjs';
import * as archive from './adapters/archive.mjs';
import * as wikimedia from './adapters/wikimedia.mjs';
import * as pexels from './adapters/pexels.mjs';
import * as pixabay from './adapters/pixabay.mjs';
import * as vimeo from './adapters/vimeo.mjs';
import * as dailymotion from './adapters/dailymotion.mjs';
import * as web from './adapters/web.mjs';
import * as discover from './adapters/discover.mjs';

// 新增來源：在 adapters/ 寫一個檔案（匯出 name、label、needs、search 或 crawl），再加進這個陣列
const ADAPTERS = [discover, youtube, archive, wikimedia, pexels, pixabay, vimeo, dailymotion, web];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const VIDEOS_FILE = join(DATA_DIR, 'videos.json');
const META_FILE = join(DATA_DIR, 'meta.json');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const config = await readJson(join(ROOT, 'crawler', 'config.json'), {});
  const only = process.argv.slice(2);
  const queries = config.queries || [];
  const perQuery = config.perQuery || 20;

  const fresh = [];
  const prevMeta = await readJson(META_FILE, {});
  const report = { ...(prevMeta.lastRun || {}) };

  for (const adapter of ADAPTERS) {
    if (only.length && !only.includes(adapter.name)) continue;
    const srcCfg = adapter.name === 'web' ? config.web || {} : config.sources?.[adapter.name] || {};
    if (srcCfg.enabled === false) {
      report[adapter.name] = { label: adapter.label, status: 'disabled' };
      continue;
    }
    const missing = adapter.needs.filter((k) => !process.env[k]);
    if (adapter.isConfigured && !adapter.isConfigured()) missing.push('（未設定搜尋提供者）');
    if (missing.length) {
      console.log(`[${adapter.name}] 缺少 ${missing.join(', ')}，略過`);
      report[adapter.name] = { label: adapter.label, status: 'no-key', missing };
      continue;
    }
    // 付費 API 用 minIntervalHours 控制頻率（手動指定來源執行時不受限）
    const prevRan = Date.parse(prevMeta.lastRun?.[adapter.name]?.ranAt || '');
    if (!only.length && srcCfg.minIntervalHours && prevRan && Date.now() - prevRan < srcCfg.minIntervalHours * 3600e3) {
      console.log(`[${adapter.name}] 距離上次執行不到 ${srcCfg.minIntervalHours} 小時，這次略過`);
      continue;
    }

    console.log(`[${adapter.name}] 開始`);
    const got = [];
    const errors = [];
    if (adapter.crawl) {
      try {
        got.push(...(await adapter.crawl({ ...srcCfg, queries })));
      } catch (e) {
        errors.push(e.message);
      }
    } else {
      const qs = srcCfg.maxQueries ? queries.slice(0, srcCfg.maxQueries) : queries;
      for (const q of qs) {
        try {
          got.push(...(await adapter.search(q, { limit: srcCfg.perQuery || perQuery, config: srcCfg })));
        } catch (e) {
          errors.push(`${q}: ${e.message}`);
        }
      }
    }
    console.log(`[${adapter.name}] 取得 ${got.length} 筆${errors.length ? `，錯誤 ${errors.length} 個` : ''}`);
    errors.forEach((e) => console.log(`  ! ${e}`));
    fresh.push(...got);
    report[adapter.name] = {
      label: adapter.label,
      status: errors.length && !got.length ? 'error' : 'ok',
      count: got.length,
      errors: errors.slice(0, 5),
      ranAt: new Date().toISOString(),
    };
  }

  // 合併：新資料覆蓋舊資料（同 id），保留舊的
  const old = await readJson(VIDEOS_FILE, []);
  const byId = new Map(old.map((v) => [v.id, v]));
  for (const v of fresh) byId.set(v.id, { ...byId.get(v.id), ...v });

  const maxItems = config.maxItems || 3000;
  const all = [...byId.values()]
    .sort((a, b) => (b.publishedAt || b.fetchedAt || '').localeCompare(a.publishedAt || a.fetchedAt || ''))
    .slice(0, maxItems);

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(VIDEOS_FILE, JSON.stringify(all));

  const counts = {};
  for (const v of all) counts[v.source] = (counts[v.source] || 0) + 1;
  const sources = Object.fromEntries(ADAPTERS.map((a) => [a.name, a.label]));
  await writeFile(
    META_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), total: all.length, counts, sources, lastRun: report }, null, 2),
  );

  console.log(`完成：本次新抓 ${fresh.length} 筆，資料庫共 ${all.length} 筆`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
