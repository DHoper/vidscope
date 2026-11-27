// 把擴充功能需要的爬蟲程式複製到 extension/vendor/。
// 改了 crawler/ 底下這些檔案後要重新執行：node extension/sync.mjs
// （擴充功能只能載入自己資料夾裡的檔案，所以不能直接引用 crawler/）
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'lib/http.mjs',
  'lib/normalize.mjs',
  'lib/robots.mjs',
  'adapters/web.mjs',
  'adapters/discover.mjs',
];

for (const f of FILES) {
  const to = join(ROOT, 'extension', 'vendor', f);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(join(ROOT, 'crawler', f), to);
  console.log(`已複製 crawler/${f}`);
}
