// Pexels 免費素材影片。需要環境變數 PEXELS_API_KEY。授權允許下載。
import { env, getJson } from '../lib/http.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'pexels';
export const label = 'Pexels';
export const needs = ['PEXELS_API_KEY'];

export async function search(query, { limit = 20 } = {}) {
  const params = new URLSearchParams({ query, per_page: String(Math.min(limit, 80)) });
  const data = await getJson(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: env.PEXELS_API_KEY },
  });
  return (data.videos || []).map((v) => {
    const files = (v.video_files || []).filter((f) => f.link);
    // 優先選 HD、寬度不超過 1920 的檔案
    const best =
      files.filter((f) => f.quality === 'hd' && (f.width || 0) <= 1920).sort((a, b) => (b.width || 0) - (a.width || 0))[0] ||
      files[0];
    return makeVideo({
      source: name, sourceId: v.id, query,
      title: titleFromUrl(v.url) || `Pexels 影片 ${v.id}`,
      channel: v.user?.name,
      url: v.url,
      fileUrl: best?.link,
      downloadUrl: best?.link,
      thumbnail: v.image,
      duration: v.duration,
      license: 'Pexels License',
    });
  });
}

// Pexels 網址形如 https://www.pexels.com/video/ocean-waves-at-sunset-1234/
function titleFromUrl(u) {
  const m = (u || '').match(/\/video\/([^/]+?)-\d+\/?$/);
  if (!m) return null;
  const t = m[1].replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
