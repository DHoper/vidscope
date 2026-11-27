// Vimeo API。需要環境變數 VIMEO_TOKEN（在 developer.vimeo.com 建立 App 取得的 access token）。
// 只有創作者開放下載、且 API 有回傳下載連結時才提供下載。
import { env, getJson } from '../lib/http.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'vimeo';
export const label = 'Vimeo';
export const needs = ['VIMEO_TOKEN'];

export async function search(query, { limit = 20 } = {}) {
  const params = new URLSearchParams({ query, per_page: String(Math.min(limit, 100)), sort: 'date', direction: 'desc' });
  const data = await getJson(`https://api.vimeo.com/videos?${params}`, {
    headers: { Authorization: `bearer ${env.VIMEO_TOKEN}`, Accept: 'application/vnd.vimeo.*+json;version=3.4' },
  });
  return (data.data || []).map((v) => {
    const id = (v.uri || '').split('/').pop();
    const sizes = v.pictures?.sizes || [];
    const thumb = (sizes.find((s) => s.width >= 480) || sizes[sizes.length - 1])?.link;
    const dl = Array.isArray(v.download) && v.download.length ? v.download[0].link : null;
    return makeVideo({
      source: name, sourceId: id, query,
      title: v.name, description: v.description, channel: v.user?.name,
      url: v.link,
      embedUrl: `https://player.vimeo.com/video/${id}`,
      downloadUrl: dl,
      thumbnail: thumb,
      duration: v.duration,
      publishedAt: v.created_time,
      license: v.license || null,
    });
  });
}
