// Vidscope 前端
//
// 搜尋分兩層：
//   1. 本機索引：data/videos.json（排程爬蟲預先抓好的），打字當下就篩選
//   2. 即時搜尋：停止打字或按 Enter 後，當場去各平台搜尋
//      - 本機版（docker compose up）：呼叫 /api/search，包含全網搜尋（SearXNG）
//      - GitHub Pages 版：瀏覽器直接呼叫 Internet Archive、Wikimedia Commons、Dailymotion
import * as archive from '../crawler/adapters/archive.mjs';
import * as wikimedia from '../crawler/adapters/wikimedia.mjs';
import * as dailymotion from '../crawler/adapters/dailymotion.mjs';

const BROWSER_SOURCES = [archive, wikimedia, dailymotion];
const PAGE_SIZE = 48;
const LIVE_DELAY_MS = 600;

// 每個來源一個識別色，只用在小圓點上
const SOURCE_COLORS = {
  discover: '#2847D9',
  youtube: '#E5372B',
  vimeo: '#16A6D9',
  archive: '#7A5C3E',
  wikimedia: '#2E8B57',
  pexels: '#0E9F8E',
  pixabay: '#6BA539',
  dailymotion: '#5A3FD8',
  web: '#C2410C',
};
const SOURCE_LABELS = {
  discover: '全網搜尋', youtube: 'YouTube', vimeo: 'Vimeo', archive: 'Internet Archive',
  wikimedia: 'Wikimedia Commons', pexels: 'Pexels', pixabay: 'Pixabay', dailymotion: 'Dailymotion', web: '網頁',
};

const state = {
  index: [],          // 預先爬好的
  live: new Map(),    // 本次關鍵字的即時結果 id -> video
  liveQuery: '',
  liveStatus: {},     // 來源 -> 'loading' | { count } | { error }
  backend: null,      // 本機版伺服器資訊；GitHub Pages 上為 null
  meta: null,
  q: '',
  source: 'all',
  downloadOnly: false,
  sort: 'relevant',
  shown: PAGE_SIZE,
  list: [],           // 目前畫面上的完整清單（給播放器上一部 / 下一部用）
  playing: -1,
};

const $ = (id) => document.getElementById(id);
const els = {
  q: $('q'), form: $('searchForm'), suggest: $('suggest'), chips: $('sourceChips'),
  downloadOnly: $('downloadOnly'), sort: $('sort'), status: $('status'), grid: $('grid'),
  more: $('moreBtn'), sentinel: $('sentinel'), updated: $('updated'),
  player: $('player'), pTitle: $('pTitle'), pMedia: $('pMedia'), pMeta: $('pMeta'),
  pDesc: $('pDesc'), pActions: $('pActions'), close: $('closeBtn'), prev: $('prevBtn'), next: $('nextBtn'),
};

// ---------- 工具 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const label = (src) => state.meta?.sources?.[src] || SOURCE_LABELS[src] || src;
const color = (src) => SOURCE_COLORS[src] || '#8891A5';

// 全網搜尋的結果顯示實際網站名稱，而不是「全網搜尋」
const SITE_NAMES = {
  'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'vimeo.com': 'Vimeo', 'dailymotion.com': 'Dailymotion',
  'bilibili.com': 'Bilibili', 'archive.org': 'Internet Archive', 'commons.wikimedia.org': 'Wikimedia Commons',
  'facebook.com': 'Facebook', 'twitch.tv': 'Twitch', 'tiktok.com': 'TikTok', 'rumble.com': 'Rumble', 'ted.com': 'TED',
};
function siteOf(v) {
  if (v.source !== 'discover' && v.source !== 'web') return label(v.source);
  const host = hostOf(v.url || '');
  const key = Object.keys(SITE_NAMES).find((k) => host === k || host.endsWith(`.${k}`));
  return key ? SITE_NAMES[key] : host;
}
// 舊資料的頻道欄位可能是搜尋引擎名稱（例如「bing videos」），不顯示
const ENGINE_RE = /^(?:[a-z]+[ .]videos?|wikicommons\.videos|[a-z]+ videos)(?:,\s*[a-z. ]+)*$/i;
function channelOf(v) {
  const c = (v.channel || '').trim();
  if (!c || ENGINE_RE.test(c) || c === siteOf(v) || c === hostOf(v.url || '')) return '';
  return c;
}

function fmtDuration(sec) {
  if (sec == null) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const rtf = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' });
function fmtAgo(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const days = Math.round((t - Date.now()) / 864e5);
  if (Math.abs(days) < 1) return '今天';
  if (Math.abs(days) < 30) return rtf.format(days, 'day');
  if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), 'month');
  return rtf.format(Math.round(days / 365), 'year');
}
function fmtDate(iso) {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ---------- 組出目前要顯示的清單 ----------
function termsOf(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}
function matches(v, terms) {
  if (!terms.length) return true;
  const hay = `${v.title} ${v.description} ${v.channel || ''} ${v.query || ''}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// 套用關鍵字與「只看可下載」，但還沒套用來源篩選（來源按鈕的數字用這份算）
function candidates() {
  const terms = termsOf(state.q);
  const byId = new Map();
  // 即時結果是搜尋引擎判斷過相關的，不再用字面比對過濾
  if (state.q && state.liveQuery === state.q) for (const v of state.live.values()) byId.set(v.id, { ...v, _live: true });
  for (const v of state.index) if (!byId.has(v.id) && matches(v, terms)) byId.set(v.id, v);
  let list = [...byId.values()];
  if (state.downloadOnly) list = list.filter((v) => safeUrl(v.downloadUrl));
  return list;
}

function score(v, terms) {
  // 標題命中越多越前面；即時結果略加分；可播放的再加一點
  const title = (v.title || '').toLowerCase();
  let s = 0;
  for (const t of terms) if (title.includes(t)) s += 3;
  if (terms.length && title.includes(terms.join(' '))) s += 4;
  if (v._live) s += 1;
  if (v.embedUrl || v.fileUrl) s += 1;
  return s;
}

function sorted(list) {
  const date = (v) => v.publishedAt || v.fetchedAt || '';
  const dur = (v) => v.duration ?? -1;
  const terms = termsOf(state.q);
  const by = {
    relevant: (a, b) => score(b, terms) - score(a, terms) || date(b).localeCompare(date(a)),
    new: (a, b) => date(b).localeCompare(date(a)),
    old: (a, b) => date(a).localeCompare(date(b)),
    long: (a, b) => dur(b) - dur(a),
    short: (a, b) => (dur(a) < 0 ? 1e9 : dur(a)) - (dur(b) < 0 ? 1e9 : dur(b)),
  };
  return list.sort(by[state.sort] || by.relevant);
}

// ---------- 畫面 ----------
function renderSuggest() {
  const counts = new Map();
  for (const v of state.index) if (v.query) counts.set(v.query, (counts.get(v.query) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([q]) => q);
  els.suggest.innerHTML = top.length
    ? `<span class="suggest-label">常搜</span>` +
      top.map((q) => `<button type="button" class="suggest-item" data-q="${esc(q)}">${esc(q)}</button>`).join('')
    : '';
}

function renderChips(all) {
  const counts = {};
  for (const v of all) counts[v.source] = (counts[v.source] || 0) + 1;
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (state.source !== 'all' && !counts[state.source]) keys.unshift(state.source); // 目前選的來源即使是 0 也留著
  const chip = (key, text, n, dot) =>
    `<button type="button" class="source" data-source="${esc(key)}" aria-pressed="${state.source === key}">` +
    (dot ? `<span class="dot" style="background:${dot}"></span>` : '') +
    `<span>${esc(text)}</span><span class="count">${(n || 0).toLocaleString()}</span></button>`;
  els.chips.innerHTML = chip('all', '全部來源', all.length) + keys.map((k) => chip(k, label(k), counts[k], color(k))).join('');
}

function card(v, i) {
  const thumb = safeUrl(v.thumbnail);
  const ago = fmtAgo(v.publishedAt);
  return `<article class="video">
    <button type="button" class="video-hit" data-i="${i}" aria-label="播放：${esc(v.title)}">
      <span class="frame">
        ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        ${v.duration != null ? `<span class="duration">${fmtDuration(v.duration)}</span>` : ''}
        ${safeUrl(v.downloadUrl) ? '<span class="can-dl">可下載</span>' : ''}
      </span>
    </button>
    <div class="video-text">
      <h3 class="video-title">${esc(v.title)}</h3>
      <p class="video-meta">
        <span class="video-source"><span class="dot" style="background:${color(v.source)}"></span>${esc(siteOf(v))}</span>
        ${channelOf(v) ? `<span class="video-channel">${esc(channelOf(v))}</span>` : ''}
        ${ago ? `<span>${esc(ago)}</span>` : ''}
      </p>
    </div>
  </article>`;
}

function skeletons(n) {
  return Array.from({ length: n }, () => '<div class="video skeleton" aria-hidden="true"><span class="frame"></span><span class="line"></span><span class="line short"></span></div>').join('');
}

function liveSummary() {
  const entries = Object.entries(state.liveStatus);
  if (!entries.length) return '';
  const loading = entries.filter(([, s]) => s === 'loading').map(([k]) => label(k));
  if (loading.length) return `正在搜尋 ${loading.join('、')}`;
  const failed = entries.filter(([, s]) => s?.error).map(([k]) => label(k));
  return failed.length ? `${failed.join('、')} 這次沒有回應` : '';
}

function isLoading() {
  return Object.values(state.liveStatus).some((s) => s === 'loading');
}

function render() {
  const all = candidates();
  renderChips(all);
  state.list = sorted(state.source === 'all' ? all : all.filter((v) => v.source === state.source));
  const visible = state.list.slice(0, state.shown);
  const loading = isLoading();

  if (!state.index.length && !state.live.size && !loading) {
    els.grid.innerHTML = empty('還沒有任何影片', '在上面輸入關鍵字，網站會即時去各平台搜尋。');
  } else if (!state.list.length && loading) {
    els.grid.innerHTML = skeletons(12);
  } else if (!state.list.length) {
    els.grid.innerHTML = emptyForQuery();
  } else {
    els.grid.innerHTML = visible.map(card).join('') + (loading ? skeletons(4) : '');
  }

  const parts = [];
  if (state.list.length) parts.push(state.q ? `「${state.q}」找到 ${state.list.length.toLocaleString()} 部影片` : `共 ${state.list.length.toLocaleString()} 部影片`);
  const live = liveSummary();
  if (live) parts.push(live);
  els.status.innerHTML = parts.map((p, i) => `<span class="${i ? 'status-live' : ''}">${esc(p)}</span>`).join('');
  els.status.classList.toggle('is-loading', loading);

  els.more.hidden = state.list.length <= state.shown;
  els.chips.querySelectorAll('.source').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.source === state.source)));
}

function empty(title, body, extra = '') {
  return `<div class="empty"><p class="empty-title">${esc(title)}</p><p>${body}</p>${extra}</div>`;
}

function emptyForQuery() {
  const tips = [];
  if (state.source !== 'all') tips.push(`<button type="button" class="link" data-action="all-sources">改成搜尋全部來源</button>`);
  if (state.downloadOnly) tips.push(`<button type="button" class="link" data-action="allow-all">也顯示不能下載的影片</button>`);
  const body = state.backend
    ? '換個寫法試試，例如改用英文片名，或拿掉幾個字。'
    : '這個網頁版會即時搜尋 Internet Archive、Wikimedia Commons 和 Dailymotion。想搜尋全網，請用<a href="https://github.com/DHoper/vidscope#本機完整版全網即時搜尋" target="_blank" rel="noopener">本機完整版</a>；也可以改用英文片名再搜一次。';
  return empty(`沒有找到「${state.q}」的影片`, body, tips.length ? `<p class="empty-actions">${tips.join('')}</p>` : '');
}

// ---------- 即時搜尋 ----------
let liveTimer = null;
let liveAbort = null;

function scheduleLive(immediate = false) {
  clearTimeout(liveTimer);
  const q = state.q;
  if (q.length < 2) {
    liveAbort?.abort();
    state.liveStatus = {};
    return;
  }
  if (q === state.liveQuery && !isLoading() && Object.keys(state.liveStatus).length) return;
  liveTimer = setTimeout(() => runLive(q), immediate ? 0 : LIVE_DELAY_MS);
}

async function runLive(q) {
  liveAbort?.abort();
  const ctrl = new AbortController();
  liveAbort = ctrl;
  state.live = new Map();
  state.liveQuery = q;

  const add = (src, list) => {
    if (ctrl.signal.aborted) return;
    for (const v of list) state.live.set(v.id, v);
    state.liveStatus[src] = { count: list.length };
    render();
  };
  const fail = (src, e) => {
    if (ctrl.signal.aborted) return;
    state.liveStatus[src] = { error: e?.message || '失敗' };
    render();
  };

  if (state.backend) {
    state.liveStatus = Object.fromEntries(state.backend.sources.map((s) => [s, 'loading']));
    render();
    try {
      const res = await fetch(`api/search?q=${encodeURIComponent(q)}&limit=24`, { signal: ctrl.signal });
      const data = await res.json();
      if (ctrl.signal.aborted) return;
      for (const v of data.results || []) state.live.set(v.id, v);
      state.liveStatus = Object.fromEntries(Object.entries(data.sources || {}).map(([k, s]) => [k, s.error ? { error: s.error } : { count: s.count }]));
      render();
    } catch (e) {
      if (!ctrl.signal.aborted) {
        state.liveStatus = { discover: { error: e.message } };
        render();
      }
    }
    return;
  }

  state.liveStatus = Object.fromEntries(BROWSER_SOURCES.map((a) => [a.name, 'loading']));
  render();
  await Promise.all(
    BROWSER_SOURCES.map((a) =>
      a.search(q, { limit: 24 }).then((list) => add(a.name, list), (e) => fail(a.name, e)),
    ),
  );
}

async function detectBackend() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('api/health', { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch {
    return null;
  }
}

// ---------- 播放器 ----------
function openPlayer(i) {
  const v = state.list[i];
  if (!v) return;
  state.playing = i;
  const embed = safeUrl(v.embedUrl);
  const file = safeUrl(v.fileUrl);
  const page = safeUrl(v.url);
  const dl = safeUrl(v.downloadUrl);
  const thumb = safeUrl(v.thumbnail);

  els.pTitle.textContent = v.title;
  if (embed) {
    els.pMedia.innerHTML = `<iframe src="${esc(embed)}" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  } else if (file) {
    els.pMedia.innerHTML = `<video src="${esc(file)}" controls autoplay playsinline ${thumb ? `poster="${esc(thumb)}"` : ''}></video>`;
  } else {
    els.pMedia.innerHTML = `<div class="no-embed">${thumb ? `<img src="${esc(thumb)}" alt="" referrerpolicy="no-referrer">` : ''}<p>這部影片只能在原始網站播放</p>${page ? `<a class="btn btn-lamp" href="${esc(page)}" target="_blank" rel="noopener">到 ${esc(hostOf(page))} 觀看</a>` : ''}</div>`;
  }

  const meta = [
    `<span class="video-source"><span class="dot" style="background:${color(v.source)}"></span>${esc(siteOf(v))}</span>`,
    channelOf(v) ? `<span>${esc(channelOf(v))}</span>` : '',
    v.publishedAt ? `<span>${esc(fmtDate(v.publishedAt))}</span>` : '',
    v.duration != null ? `<span>片長 ${fmtDuration(v.duration)}</span>` : '',
    v.license ? `<span>授權 ${esc(shortLicense(v.license))}</span>` : '',
  ];
  els.pMeta.innerHTML = meta.filter(Boolean).join('');

  els.pDesc.textContent = v.description || '';
  els.pDesc.classList.remove('is-open');
  els.pDesc.hidden = !v.description;
  els.pActions.innerHTML = [
    dl ? `<a class="btn btn-lamp" href="${esc(dl)}" target="_blank" rel="noopener" download>下載影片</a>` : '',
    page ? `<a class="btn btn-ghost" href="${esc(page)}" target="_blank" rel="noopener">在 ${esc(hostOf(page))} 開啟</a>` : '',
  ].join('');

  els.prev.disabled = i <= 0;
  els.next.disabled = i >= state.list.length - 1;
  if (!els.player.open) els.player.showModal();
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '原始網站';
  }
}

function shortLicense(l) {
  const m = String(l).match(/creativecommons\.org\/(licenses|publicdomain)\/([^/]+)\/?([\d.]*)/i);
  if (m) return m[1] === 'publicdomain' ? '公眾領域' : `CC ${m[2].toUpperCase()} ${m[3]}`.trim();
  return l;
}

els.player.addEventListener('close', () => {
  els.pMedia.innerHTML = '';
  state.playing = -1;
});
els.close.addEventListener('click', () => els.player.close());
els.player.addEventListener('click', (e) => { if (e.target === els.player) els.player.close(); });
els.prev.addEventListener('click', () => openPlayer(state.playing - 1));
els.next.addEventListener('click', () => openPlayer(state.playing + 1));
els.pDesc.addEventListener('click', () => els.pDesc.classList.toggle('is-open'));
els.player.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowLeft' && !els.prev.disabled) openPlayer(state.playing - 1);
  if (e.key === 'ArrowRight' && !els.next.disabled) openPlayer(state.playing + 1);
});

// ---------- 事件 ----------
let typeTimer;
els.q.addEventListener('input', () => {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => {
    setQuery(els.q.value.trim(), false);
  }, 120);
});
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  setQuery(els.q.value.trim(), true);
  els.q.blur();
});
els.suggest.addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  els.q.value = b.dataset.q;
  setQuery(b.dataset.q, true);
});
els.chips.addEventListener('click', (e) => {
  const b = e.target.closest('.source');
  if (!b) return;
  state.source = b.dataset.source;
  state.shown = PAGE_SIZE;
  syncUrl();
  render();
});
els.downloadOnly.addEventListener('change', () => {
  state.downloadOnly = els.downloadOnly.checked;
  state.shown = PAGE_SIZE;
  render();
});
els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  render();
});
els.more.addEventListener('click', () => {
  state.shown += PAGE_SIZE;
  render();
});
els.grid.addEventListener('click', (e) => {
  const hit = e.target.closest('.video-hit');
  if (hit) return openPlayer(Number(hit.dataset.i));
  const act = e.target.closest('[data-action]');
  if (act?.dataset.action === 'all-sources') { state.source = 'all'; syncUrl(); render(); }
  if (act?.dataset.action === 'allow-all') { state.downloadOnly = false; els.downloadOnly.checked = false; render(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, textarea, select') && !els.player.open) {
    e.preventDefault();
    els.q.focus();
    els.q.select();
  }
});

// 捲到底自動載入更多
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.list.length > state.shown) {
    state.shown += PAGE_SIZE;
    render();
  }
}, { rootMargin: '600px' }).observe(els.sentinel);

function setQuery(q, immediate) {
  const changed = q !== state.q;
  state.q = q;
  if (changed) {
    state.shown = PAGE_SIZE;
    if (q !== state.liveQuery) {
      state.live = new Map();
      state.liveStatus = {};
    }
  }
  syncUrl();
  scheduleLive(immediate);
  render();
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.source !== 'all') p.set('source', state.source);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// ---------- 啟動 ----------
async function load() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.source = p.get('source') || 'all';
  els.q.value = state.q;
  els.grid.innerHTML = skeletons(12);

  const bust = `?t=${Math.floor(Date.now() / 600000)}`;
  const [videos, meta, backend] = await Promise.all([
    fetch(`data/videos.json${bust}`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(`data/meta.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    detectBackend(),
  ]);
  state.index = Array.isArray(videos) ? videos : [];
  state.meta = meta;
  state.backend = backend;

  const mode = backend
    ? (backend.searxng ? '本機完整版，搜尋時會即時搜尋全網' : '本機版，搜尋時會即時搜尋各平台')
    : '網頁版，搜尋時會即時搜尋 Internet Archive、Wikimedia Commons 和 Dailymotion';
  const updated = meta?.updatedAt ? `索引更新於 ${new Date(meta.updatedAt).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  els.updated.textContent = [mode, updated].filter(Boolean).join('。');

  renderSuggest();
  scheduleLive(true);
  render();
}

load();
