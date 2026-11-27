// Dailymotion 公開 API。不需要金鑰。只提供嵌入播放。
import { getJson } from '../lib/http.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'dailymotion';
export const label = 'Dailymotion';
export const needs = [];

export async function search(query, { limit = 20 } = {}) {
  const params = new URLSearchParams({
    search: query, limit: String(Math.min(limit, 100)), sort: 'recent',
    fields: 'id,title,description,thumbnail_480_url,duration,created_time,owner.screenname,url',
  });
  const data = await getJson(`https://api.dailymotion.com/videos?${params}`);
  return (data.list || []).map((v) =>
    makeVideo({
      source: name, sourceId: v.id, query,
      title: v.title, description: v.description, channel: v['owner.screenname'],
      url: v.url,
      embedUrl: `https://www.dailymotion.com/embed/video/${v.id}`,
      thumbnail: v.thumbnail_480_url,
      duration: v.duration,
      publishedAt: v.created_time ? new Date(v.created_time * 1000).toISOString() : null,
    }),
  );
}
