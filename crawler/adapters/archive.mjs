// Internet Archive（archive.org）。不需要金鑰。
// Archive 本身提供下載，所以附上下載頁網址。
import { getJson } from '../lib/http.mjs';
import { makeVideo } from '../lib/normalize.mjs';

export const name = 'archive';
export const label = 'Internet Archive';
export const needs = [];

export async function search(query, { limit = 20 } = {}) {
  const params = new URLSearchParams();
  params.set('q', `(${query}) AND mediatype:(movies)`);
  for (const f of ['identifier', 'title', 'description', 'creator', 'publicdate', 'licenseurl', 'runtime']) {
    params.append('fl[]', f);
  }
  params.append('sort[]', 'publicdate desc');
  params.set('rows', String(limit));
  params.set('output', 'json');
  const data = await getJson(`https://archive.org/advancedsearch.php?${params}`);
  return (data.response?.docs || []).map((d) => {
    const id = d.identifier;
    return makeVideo({
      source: name, sourceId: id, query,
      title: d.title, description: Array.isArray(d.description) ? d.description.join(' ') : d.description,
      channel: Array.isArray(d.creator) ? d.creator[0] : d.creator,
      url: `https://archive.org/details/${id}`,
      embedUrl: `https://archive.org/embed/${id}`,
      downloadUrl: `https://archive.org/download/${id}`,
      thumbnail: `https://archive.org/services/img/${id}`,
      duration: d.runtime,
      publishedAt: d.publicdate,
      license: d.licenseurl || null,
    });
  });
}
