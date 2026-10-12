// Local panel with no caching and an explicit version check.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'site-dist');
const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const MIME = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.webp':'image/webp', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.mp4':'video/mp4', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf', '.wasm':'application/wasm'};
export function createShipyardServer() {
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end('Invalid path'); return; }
    if (pathname === '/__shipyard') {
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({application:'shipyard', version, pid:process.pid})); return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(dir, '.' + pathname);
    if (!file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/plain'}).end('Not found'); return; }
      res.writeHead(200, {'Content-Type':MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'}).end(data);
    });
  });
}
export async function listenAvailable(server, requestedPort = Number(process.env.PORT || 4173)) {
  for (let offset = 0; offset < 20; offset++) {
    const port = requestedPort === 0 ? 0 : requestedPort + offset;
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.removeListener('listening', onListen); reject(error); };
        const onListen = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListen); server.listen(port, '127.0.0.1');
      });
      return server.address().port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No local port is available. Close the older Shipyard launcher and try again.');
}
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], {stdio:'ignore', detached:true}); child.on('error', () => {}); child.unref();
}
async function main() {
  if (!fs.existsSync(dir)) throw new Error('No site-dist. Run the double-click launcher to build it first.');
  const server = createShipyardServer(); const port = await listenAvailable(server);
  const base = `http://localhost:${port}`;
  console.log(`\nShipyard ${version}\nControl panel ${base}/panel.html\nYour apps     ${base}/launcher.html\nLeave this window open while you work. Close it or press control-C to stop.\n`);
  if (process.argv.includes('--open')) openBrowser(`${base}/panel.html?v=${encodeURIComponent(version)}`);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
