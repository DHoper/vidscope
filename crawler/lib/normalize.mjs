// 所有來源統一轉成這個格式，前端只認這個格式
//
// {
//   id:          `${source}:${原始 id}`，全域唯一
//   source:      來源代號，例如 youtube / archive / web
//   title, description, channel
//   url:         原始頁面網址
//   embedUrl:    可嵌入的播放器網址（iframe），沒有則為 null
//   fileUrl:     可直接播放的影片檔網址（<video>），沒有則為 null
//   downloadUrl: 來源本身提供的下載網址，沒有則為 null
//   thumbnail, duration（秒）, publishedAt（ISO 字串）
//   license:     授權說明，未知則為 null
//   query:       是用哪個關鍵字抓到的
//   fetchedAt:   抓取時間
// }

export function makeVideo(fields) {
  const v = {
    id: `${fields.source}:${fields.sourceId}`,
    source: fields.source,
    title: clean(fields.title) || '(無標題)',
    description: clean(fields.description).slice(0, 500),
    channel: clean(fields.channel) || null,
    url: fields.url || null,
    embedUrl: fields.embedUrl || null,
    fileUrl: fields.fileUrl || null,
    downloadUrl: fields.downloadUrl || null,
    thumbnail: fields.thumbnail || null,
    duration: toSeconds(fields.duration),
    publishedAt: toIso(fields.publishedAt),
    license: fields.license || null,
    query: fields.query || null,
    fetchedAt: new Date().toISOString(),
  };
  return v;
}

function clean(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(d) {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// 支援數字秒數、"12:34"、"1:02:03"、ISO 8601 "PT1H2M3S"
export function toSeconds(d) {
  if (d == null || d === '') return null;
  if (typeof d === 'number') return Math.round(d);
  const s = String(d).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const iso = s.match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return (Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Math.round(Number(iso[3] || 0));
  }
  const parts = s.split(':').map(Number);
  if (parts.length > 1 && parts.every((n) => !Number.isNaN(n))) {
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  return null;
}
