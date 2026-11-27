// 簡易 robots.txt 解析：只處理 User-agent / Allow / Disallow
import { fetchWithTimeout } from './http.mjs';

const cache = new Map();

export async function isAllowed(pageUrl, agent = 'VidscopeBot') {
  const u = new URL(pageUrl);
  const origin = u.origin;
  if (!cache.has(origin)) cache.set(origin, await loadRules(origin, agent));
  const rules = cache.get(origin);
  const path = u.pathname + u.search;

  // 最長符合的規則優先
  let best = null;
  for (const r of rules) {
    if (matches(path, r.path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best ? best.allow : true;
}

async function loadRules(origin, agent) {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, {}, 8000);
    if (!res.ok) return [];
    return parse(await res.text(), agent);
  } catch {
    return [];
  }
}

export function parse(text, agent) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current) continue;
      if (key === 'allow' || key === 'disallow') {
        if (key === 'disallow' && value === '') continue;
        current.rules.push({ allow: key === 'allow', path: value });
      }
    }
  }
  const a = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function matches(path, pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    '^' + body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''),
  );
  return re.test(path);
}
