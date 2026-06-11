// ============================================================
// serve.mjs — 本地静态预览服务器(零依赖)。
// 先尝试生成 config.js(若有 .env),再起 http://localhost:8080。
// 用法: npm run serve  (或 node scripts/serve.mjs)
// ============================================================

import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 8080;

// 启动前尝试生成 config.js(失败不致命,可能你已手动放好)
try {
  await access(join(ROOT, '.env'));
  spawnSync(process.execPath, [join(__dirname, 'generate-config.mjs')], { stdio: 'inherit' });
} catch {
  console.warn('[serve] 未找到 .env,跳过 config.js 生成(确保已有 config.js)');
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

http
  .createServer(async (req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    // 防目录穿越
    const file = join(ROOT, urlPath.replace(/\.\.+/g, ''));
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': (MIME[extname(file)] || 'text/plain') + '; charset=utf-8' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('404 Not Found');
    }
  })
  .listen(PORT, () => console.log(`本地预览 → http://localhost:${PORT}`));
