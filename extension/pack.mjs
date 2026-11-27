// 把擴充功能打包成 dist/vidscope-extension.zip，給使用者下載。
// 用法：node extension/sync.mjs && node extension/pack.mjs
// 需要系統有 zip 指令（macOS、Linux 內建；Windows 可用 Git Bash 或 WSL）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(ROOT, 'dist', 'vidscope-extension.zip');
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, '.', '-x', 'sync.mjs', 'pack.mjs', 'package.json'], {
  cwd: join(ROOT, 'extension'),
  stdio: 'inherit',
});
console.log(`已輸出 ${out}`);
