// Pixabay 免費素材影片。需要環境變數 PIXABAY_API_KEY。授權允許下載。
import { getJson } from '../lib/http.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'pixabay';
export const label = 'Pixabay';
export const needs = ['PIXABAY_API_KEY'];

export async function search(query, { limit = 20 } = {}) {
  const params = new URLSearchParams({
    key: process.env.PIXABAY_API_KEY, q: query, per_page: String(Math.max(3, Math.min(limit, 200))),
  });
  const data = await getJson(`https://pixabay.com/api/videos/?${params}`);
  return (data.hits || []).map((h) => {
    const file = h.videos?.medium || h.videos?.small || h.videos?.large;
    const thumb =
      file?.thumbnail ||
      (h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : null);
    return makeVideo({
      source: name, sourceId: h.id, query,
      title: h.tags ? h.tags.split(',').map((s) => s.trim()).join('、') : `Pixabay 影片 ${h.id}`,
      channel: h.user,
      url: h.pageURL,
      fileUrl: file?.url,
      downloadUrl: file?.url,
      thumbnail: thumb,
      duration: h.duration,
      license: 'Pixabay Content License',
    });
  });
}
