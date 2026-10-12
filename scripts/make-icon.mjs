// Makes games/<slug>/icon.png from the game itself when you haven't supplied one.
//
// It opens the game on a virtual phone, looks for a logo element to crop, and falls
// back to the top of the title screen. If a browser isn't available it draws a plain
// tile from the game's name and colour, so a missing icon never blocks a build.
//
// Usage: node scripts/make-icon.mjs <game-slug> [--force]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { loadGame, slugArg, readableTextColor } from './lib.mjs';

const slug = slugArg();
const force = process.argv.includes('--force');
const game = loadGame(slug);
const target = game.paths.icon;

if (fs.existsSync(target) && !force) {
  const meta = await sharp(target).metadata();
  if (meta.hasAlpha) {
    const png = await sharp(target).flatten({ background: game.backgroundColor }).removeAlpha().png().toBuffer();
    fs.writeFileSync(target, png);
    console.log('✔ preserved app artwork and removed source-icon transparency');
  } else console.log('✔ icon.png already exists, keeping it');
  process.exit(0);
}

const SIZE = 1024;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};

function serve(root) {
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(root, path.normalize(pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Last resort: the game's initials on its own background colour. */
async function letterTile(reason) {
  const bg = game.backgroundColor;
  const fg = readableTextColor(bg);
  const initials = (game.name || slug).split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="${fg}"
      font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${initials.length > 1 ? 420 : 560}"
      font-weight="bold">${initials}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).flatten({ background: bg }).removeAlpha().png().toFile(target);
  console.log(`✔ wrote a plain ${initials} tile (${reason}). Upload your own icon in the panel to replace it.`);
}

if (!fs.existsSync(path.join(game.paths.www, 'index.html'))) {
  await letterTile('no index.html to screenshot');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  await letterTile('no browser available here');
  process.exit(0);
}

let server;
let browser;
try {
  server = await serve(game.paths.www);
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(Number(process.env.ICON_WAIT || 3000));

  // Prefer a real logo: the biggest roughly-square image, canvas, or background image
  // in the upper half of the title screen.
  const candidate = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best = null;
    for (const el of document.querySelectorAll('img, svg, canvas, picture, [style*="background-image"], [class*="logo"], [id*="logo"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 56 || r.height < 56) continue;
      if (r.top > vh * 0.75 || r.left < -r.width || r.left > vw) continue;
      const ratio = r.width / r.height;
      if (ratio < 0.35 || ratio > 2.8) continue;
      const area = r.width * r.height;
      if (area > vw * vh * 0.8) continue; // a full-page background isn't a logo
      if (!best || area > best.area) best = { x: r.left, y: r.top, width: r.width, height: r.height, area };
    }
    return best;
  });

  const clip = (() => {
    if (candidate) {
      // Square crop centred on the logo, with a little breathing room.
      const side = Math.min(Math.max(candidate.width, candidate.height) * 1.25, 430, 932);
      const cx = candidate.x + candidate.width / 2;
      const cy = candidate.y + candidate.height / 2;
      return {
        x: Math.max(0, Math.min(cx - side / 2, 430 - side)),
        y: Math.max(0, Math.min(cy - side / 2, 932 - side)),
        width: side,
        height: side,
      };
    }
    // No logo found: take the top of the title screen, where names usually sit.
    return { x: 0, y: Math.round(932 * 0.08), width: 430, height: 430 };
  })();

  const shot = await page.screenshot({ type: 'png', clip });
  await sharp(shot)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .flatten({ background: game.backgroundColor })
    .removeAlpha()
    .png()
    .toFile(target);

  console.log(`✔ icon made from the game's ${candidate ? 'logo' : 'title screen'} (${Math.round(clip.width)}×${Math.round(clip.height)} crop)`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n**App icon** was generated from ${game.name}'s own ${candidate ? 'logo' : 'title screen'}. Upload your own in the panel to replace it.\n`);
  }
} catch (err) {
  await letterTile(`screenshot failed: ${err.message}`);
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
