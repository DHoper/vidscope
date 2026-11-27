// Wikimedia Commons。不需要金鑰，內容皆為自由授權，可下載。
import { getJson } from '../lib/http.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'wikimedia';
export const label = 'Wikimedia Commons';
export const needs = [];

export async function search(query, { limit = 20 } = {}) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: `filetype:video ${query}`, gsrnamespace: '6', gsrlimit: String(limit),
    prop: 'imageinfo', iiprop: 'url|mime|extmetadata|timestamp|user', iiurlwidth: '480',
  });
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const pages = Object.values(data.query?.pages || {});
  return pages
    .map((p) => {
      const info = p.imageinfo?.[0];
      if (!info) return null;
      const meta = info.extmetadata || {};
      return makeVideo({
        source: name, sourceId: p.pageid, query,
        title: (p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
        description: meta.ImageDescription?.value,
        channel: meta.Artist?.value || info.user,
        url: info.descriptionurl,
        fileUrl: info.url,
        downloadUrl: info.url,
        thumbnail: info.thumburl,
        publishedAt: meta.DateTimeOriginal?.value || info.timestamp,
        license: meta.LicenseShortName?.value,
      });
    })
    .filter(Boolean);
}
