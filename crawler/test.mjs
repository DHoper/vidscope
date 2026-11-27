// 離線測試：不連網，只測解析邏輯。用法：node crawler/test.mjs
import assert from 'node:assert/strict';
import { extractVideos } from './adapters/web.mjs';
import { parse } from './lib/robots.mjs';
import { toSeconds } from './lib/normalize.mjs';

// 時長解析
assert.equal(toSeconds('PT1H2M3S'), 3723);
assert.equal(toSeconds('PT45S'), 45);
assert.equal(toSeconds('12:34'), 754);
assert.equal(toSeconds('1:02:03'), 3723);
assert.equal(toSeconds(90.4), 90);
assert.equal(toSeconds('abc'), null);

// JSON-LD VideoObject（包在 @graph 裡）
const html1 = `<html><head><title>T</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
{"@type":"VideoObject","name":"Ocean","description":"Waves","thumbnailUrl":["/t.jpg"],
"contentUrl":"/v/ocean.mp4","uploadDate":"2026-01-02","duration":"PT2M","author":{"name":"Alice"}}]}</script>
</head><body><a href="/v/ocean.mp4" download>下載</a></body></html>`;
const v1 = extractVideos(html1, 'https://example.com/page');
assert.equal(v1.length, 1);
assert.equal(v1[0].title, 'Ocean');
assert.equal(v1[0].fileUrl, 'https://example.com/v/ocean.mp4');
assert.equal(v1[0].downloadUrl, 'https://example.com/v/ocean.mp4');
assert.equal(v1[0].thumbnail, 'https://example.com/t.jpg');
assert.equal(v1[0].duration, 120);
assert.equal(v1[0].channel, 'Alice');

// Open Graph 嵌入影片，沒有下載連結
const html2 = `<meta property="og:title" content="Talk &amp; Demo">
<meta property="og:video" content="https://player.example.org/embed/9">
<meta property="og:image" content="https://cdn.example.org/9.jpg">`;
const v2 = extractVideos(html2, 'https://example.org/talk');
assert.equal(v2.length, 1);
assert.equal(v2[0].title, 'Talk & Demo');
assert.equal(v2[0].embedUrl, 'https://player.example.org/embed/9');
assert.equal(v2[0].fileUrl, null);
assert.equal(v2[0].downloadUrl, null);

// <video> 標籤
const html3 = `<title>Clip</title><video poster="p.png"><source src="clip.webm" type="video/webm"></video>`;
const v3 = extractVideos(html3, 'https://site.test/a/');
assert.equal(v3.length, 1);
assert.equal(v3[0].fileUrl, 'https://site.test/a/clip.webm');
assert.equal(v3[0].thumbnail, 'https://site.test/a/p.png');
assert.equal(v3[0].downloadUrl, null);

// 沒有影片的頁面
assert.equal(extractVideos('<html><body>hi</body></html>', 'https://x.test/').length, 0);

// robots.txt
const rules = parse('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: OtherBot\nDisallow: /', 'VidscopeBot');
assert.deepEqual(rules, [
  { allow: false, path: '/private' },
  { allow: true, path: '/private/ok' },
]);

console.log('全部測試通過');
