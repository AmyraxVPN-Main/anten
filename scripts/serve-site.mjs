/* language: JavaScript (ES2022) | file: scripts/serve-site.mjs | runtime: Node 20+
   preview the static build exactly like a project page: http://127.0.0.1:8799/anten/
   usage: node scripts/build-site.mjs && node scripts/serve-site.mjs */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DIR = path.resolve(process.argv[2] || 'site');
const PREFIX = process.argv[3] || '/anten';
const PORT = Number(process.env.PORT || 8799);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === PREFIX) rel = '/';
    else if (rel.startsWith(`${PREFIX}/`)) rel = rel.slice(PREFIX.length);
    else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('outside prefix');
    }
    const file = path.join(DIR, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`static preview: http://127.0.0.1:${PORT}${PREFIX}/`);
  });
