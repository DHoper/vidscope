// YouTube Data API v3。需要環境變數 YOUTUBE_API_KEY。
// 注意配額：search.list 每次耗 100 單位，免費每日 10,000 單位。
// 只提供嵌入播放，不提供下載（YouTube 服務條款禁止）。
import { env, getJson } from '../lib/http.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'youtube';
export const label = 'YouTube';
export const needs = ['YOUTUBE_API_KEY'];

export async function search(query, { limit = 20 } = {}) {
  const key = env.YOUTUBE_API_KEY;
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', q: query, maxResults: String(Math.min(limit, 50)),
    order: 'date', key,
  });
  const data = await getJson(`https://www.googleapis.com/youtube/v3/search?${params}`);
  return (data.items || [])
    .filter((it) => it.id && it.id.videoId)
    .map((it) => {
      const s = it.snippet || {};
      const id = it.id.videoId;
      return makeVideo({
        source: name, sourceId: id, query,
        title: s.title, description: s.description, channel: s.channelTitle,
        url: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}`,
        thumbnail: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || s.thumbnails?.default?.url,
        publishedAt: s.publishedAt,
      });
    });
}
