// Dailymotion 公開 API。搜尋不需要金鑰。只提供嵌入播放。
// 嵌入播放需要在 Dailymotion Partner HQ 建立播放器，取得 Player ID（例如 x1abc），
// 設成環境變數 DAILYMOTION_PLAYER_ID；沒設定時不嵌入，只連回原始頁面（舊版嵌入網址會回 403）。
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
  const playerId = process.env.DAILYMOTION_PLAYER_ID;
  return (data.list || []).map((v) =>
    makeVideo({
      source: name, sourceId: v.id, query,
      title: v.title, description: v.description, channel: v['owner.screenname'],
      url: v.url,
      embedUrl: playerId ? `https://geo.dailymotion.com/player/${playerId}.html?video=${v.id}` : null,
      thumbnail: v.thumbnail_480_url,
      duration: v.duration,
      publishedAt: v.created_time ? new Date(v.created_time * 1000).toISOString() : null,
    }),
  );
}
