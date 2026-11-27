// Vidscope 前端：讀取 data/videos.json 與 data/meta.json，在瀏覽器內搜尋與篩選
const PAGE_SIZE = 60;

const state = {
  all: [],
  meta: null,
  q: '',
  source: 'all',
  downloadOnly: false,
  sort: 'new',
  shown: PAGE_SIZE,
};

const $ = (id) => document.getElementById(id);
const els = {
  q: $('q'), form: $('searchForm'), chips: $('sourceChips'), downloadOnly: $('downloadOnly'),
  sort: $('sort'), status: $('status'), grid: $('grid'), more: $('moreBtn'), updated: $('updated'),
  player: $('player'), pTitle: $('pTitle'), pMedia: $('pMedia'), pMeta: $('pMeta'),
  pDesc: $('pDesc'), pActions: $('pActions'), close: $('closeBtn'),
};

// ---------- 工具 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDuration(sec) {
  if (sec == null) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' });
}

const sourceLabel = (key) => state.meta?.sources?.[key] || key;

// 只接受 http(s) 網址，避免資料裡混進 javascript: 之類的連結
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// ---------- 篩選與排序 ----------
function filtered() {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  let list = state.all.filter((v) => {
    if (state.source !== 'all' && v.source !== state.source) return false;
    if (state.downloadOnly && !safeUrl(v.downloadUrl)) return false;
    if (!terms.length) return true;
    const hay = `${v.title} ${v.description} ${v.channel || ''} ${v.query || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const date = (v) => v.publishedAt || v.fetchedAt || '';
  const dur = (v) => v.duration ?? -1;
  const sorters = {
    new: (a, b) => date(b).localeCompare(date(a)),
    old: (a, b) => date(a).localeCompare(date(b)),
    long: (a, b) => dur(b) - dur(a),
    short: (a, b) => (dur(a) < 0 ? 1e9 : dur(a)) - (dur(b) < 0 ? 1e9 : dur(b)),
  };
  return list.sort(sorters[state.sort]);
}

// ---------- 畫面 ----------
function renderChips() {
  const counts = {};
  for (const v of state.all) counts[v.source] = (counts[v.source] || 0) + 1;
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const chip = (key, label, n) =>
    `<button class="chip" data-source="${esc(key)}" aria-pressed="${state.source === key}">${esc(label)}<span class="n">${n}</span></button>`;
  els.chips.innerHTML =
    chip('all', '全部', state.all.length) + keys.map((k) => chip(k, sourceLabel(k), counts[k])).join('');
}

function card(v, i) {
  const thumb = safeUrl(v.thumbnail);
  return `<button class="card" data-i="${i}">
    <div class="thumb">
      ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div class="noimg" aria-hidden="true">${thumb ? '' : '▶'}</div>
      <span class="badge src">${esc(sourceLabel(v.source))}</span>
      ${safeUrl(v.downloadUrl) ? '<span class="badge dl" title="可下載">↓</span>' : ''}
      ${v.duration != null ? `<span class="badge dur">${fmtDuration(v.duration)}</span>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(v.title)}</div>
      <div class="card-meta">${esc([v.channel, fmtDate(v.publishedAt)].filter(Boolean).join(' · '))}</div>
    </div>
  </button>`;
}

let current = [];
function render() {
  current = filtered();
  const visible = current.slice(0, state.shown);

  if (!state.all.length) {
    els.grid.innerHTML = `<div class="empty"><strong>資料庫還是空的</strong>第一次排程爬取完成後，影片就會出現在這裡。</div>`;
    els.status.textContent = '';
  } else if (!current.length) {
    els.grid.innerHTML = `<div class="empty"><strong>找不到符合的影片</strong>換個關鍵字，或取消篩選條件試試。</div>`;
    els.status.textContent = '';
  } else {
    els.grid.innerHTML = visible.map(card).join('');
    els.status.textContent = `共 ${current.length.toLocaleString()} 部影片${state.q ? `符合「${state.q}」` : ''}`;
  }
  els.more.hidden = current.length <= state.shown;
  els.chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.source === state.source)));
}

// ---------- 播放器 ----------
function openPlayer(v) {
  els.pTitle.textContent = v.title;
  const embed = safeUrl(v.embedUrl);
  const file = safeUrl(v.fileUrl);
  const page = safeUrl(v.url);
  const dl = safeUrl(v.downloadUrl);
  const thumb = safeUrl(v.thumbnail);

  if (embed) {
    els.pMedia.innerHTML = `<iframe src="${esc(embed)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  } else if (file) {
    els.pMedia.innerHTML = `<video src="${esc(file)}" controls autoplay playsinline ${thumb ? `poster="${esc(thumb)}"` : ''}></video>`;
  } else {
    els.pMedia.innerHTML = `<div class="fallback"><div>${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}這部影片無法在本站播放，請前往原始頁面觀看。</div></div>`;
  }

  els.pMeta.textContent = [
    sourceLabel(v.source), v.channel, fmtDate(v.publishedAt), v.duration != null ? fmtDuration(v.duration) : null,
    v.license ? `授權：${v.license}` : null,
  ].filter(Boolean).join(' · ');
  els.pDesc.textContent = v.description || '';
  els.pActions.innerHTML = [
    dl ? `<a class="btn primary" href="${esc(dl)}" target="_blank" rel="noopener" download>↓ 下載</a>` : '',
    page ? `<a class="btn" href="${esc(page)}" target="_blank" rel="noopener">前往原始頁面 ↗</a>` : '',
  ].join('');

  els.player.showModal();
}

function closePlayer() {
  els.player.close();
}
els.player.addEventListener('close', () => { els.pMedia.innerHTML = ''; });
els.close.addEventListener('click', closePlayer);
els.player.addEventListener('click', (e) => { if (e.target === els.player) closePlayer(); });

// ---------- 事件 ----------
let debounce;
els.q.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.q = els.q.value.trim();
    state.shown = PAGE_SIZE;
    syncUrl();
    render();
  }, 150);
});
els.form.addEventListener('submit', (e) => e.preventDefault());
els.chips.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  state.source = btn.dataset.source;
  state.shown = PAGE_SIZE;
  syncUrl();
  render();
});
els.downloadOnly.addEventListener('change', () => { state.downloadOnly = els.downloadOnly.checked; state.shown = PAGE_SIZE; render(); });
els.sort.addEventListener('change', () => { state.sort = els.sort.value; render(); });
els.more.addEventListener('click', () => { state.shown += PAGE_SIZE; render(); });
els.grid.addEventListener('click', (e) => {
  const c = e.target.closest('.card');
  if (c) openPlayer(current[Number(c.dataset.i)]);
});

function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.source !== 'all') p.set('source', state.source);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.source = p.get('source') || 'all';
  els.q.value = state.q;
}

// ---------- 啟動 ----------
async function load() {
  els.status.textContent = '載入中…';
  readUrl();
  const bust = `?t=${Math.floor(Date.now() / 600000)}`; // 每 10 分鐘換一次，避免快取太久
  const [videos, meta] = await Promise.all([
    fetch(`data/videos.json${bust}`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(`data/meta.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.all = Array.isArray(videos) ? videos : [];
  state.meta = meta;
  if (meta?.updatedAt) {
    els.updated.textContent = `資料更新於 ${new Date(meta.updatedAt).toLocaleString('zh-TW')}`;
  }
  if (state.source !== 'all' && !state.all.some((v) => v.source === state.source)) state.source = 'all';
  renderChips();
  render();
}

load();
