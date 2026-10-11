// Serves site-dist locally so you can test the whole thing without GitHub.
//   npm run preview
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT } from './lib.mjs';

const dir = path.join(ROOT, 'site-dist');
const port = Number(process.env.PORT || 4173);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};

if (!fs.existsSync(dir)) {
  console.error('No site-dist yet. Run: node scripts/build-site.mjs all');
  process.exit(1);
}

http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(dir, path.normalize(pathname));
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => {
  console.log(`\nLauncher      http://localhost:${port}/launcher.html`);
  console.log(`Control panel http://localhost:${port}/panel.html`);
  console.log(`App index     http://localhost:${port}/apps.json\n`);
});
