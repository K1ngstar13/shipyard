// Builds everything the stores need besides the app binary:
//   build/<slug>/store/apple/metadata     (fastlane deliver format)
//   build/<slug>/store/apple/screenshots  (1290×2796 iPhone screenshots)
//   build/<slug>/store/google/<lang>      (fastlane supply format: text, icon, feature graphic, screenshots)
//
// Screenshots are captured from the real game in a headless phone-sized browser,
// following the "screenshots" steps in game.json. Custom PNGs in
// games/<slug>/store/screenshots/{apple,google}/ are used instead when present.
//
// Usage: node scripts/store-assets.mjs <game-slug>
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { chromium } from 'playwright';
import {
  loadGame, slugArg, writeText, walk, buildNumber,
  flatIcon, flattenScreenshot, readableTextColor,
} from './lib.mjs';

const slug = slugArg();
const game = loadGame(slug);
const { config, text } = game;
const lang = config.language || 'en-US';
const out = path.join(game.build, 'store');
fs.rmSync(out, { recursive: true, force: true });

// ---------- Apple metadata ----------
const appleMeta = path.join(out, 'apple', 'metadata');
const appleLang = path.join(appleMeta, lang);
writeText(appleLang, 'name.txt', game.name);
writeText(appleLang, 'subtitle.txt', text.subtitle);
writeText(appleLang, 'promotional_text.txt', text.promotionalText);
writeText(appleLang, 'description.txt', text.description);
writeText(appleLang, 'keywords.txt', text.keywords.replace(/,\s+/g, ','));
writeText(appleLang, 'support_url.txt', game.supportUrl);
writeText(appleLang, 'privacy_url.txt', game.privacyUrl);
if (game.marketingUrl) writeText(appleLang, 'marketing_url.txt', game.marketingUrl);
writeText(appleLang, 'release_notes.txt', text.releaseNotes || 'Bug fixes and polish.');
writeText(appleMeta, 'copyright.txt', game.copyright);
writeText(appleMeta, 'primary_category.txt', 'GAMES');
writeText(appleMeta, 'primary_first_sub_category.txt', game.appleSubcategory);

const review = config.review || {};
const reviewDir = path.join(appleMeta, 'review_information');
writeText(reviewDir, 'first_name.txt', review.firstName);
writeText(reviewDir, 'last_name.txt', review.lastName);
writeText(reviewDir, 'phone_number.txt', review.phone);
writeText(reviewDir, 'email_address.txt', review.email || config.contactEmail);
writeText(reviewDir, 'notes.txt',
  game.raw.reviewNotes ||
  'No account or login is needed. The whole game is included in the app and works offline. There are no ads, purchases, or data collection.');

// ---------- Google metadata ----------
const googleLang = path.join(out, 'google', lang);
writeText(googleLang, 'title.txt', game.name);
writeText(googleLang, 'short_description.txt', text.shortDescription);
writeText(googleLang, 'full_description.txt', text.description);
const changelog = (text.releaseNotes || `Version ${game.version}`).slice(0, 500);
writeText(path.join(googleLang, 'changelogs'), 'default.txt', changelog);
writeText(path.join(googleLang, 'changelogs'), `${buildNumber()}.txt`, changelog);

const images = path.join(googleLang, 'images');
fs.mkdirSync(images, { recursive: true });
const iconBg = game.raw.iconBackgroundColor || game.backgroundColor;
fs.writeFileSync(path.join(images, 'icon.png'), await flatIcon(game.paths.icon, 512, iconBg));

// ---------- Screenshots + feature graphic ----------
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

const landscape = game.orientation === 'landscape';
const PROFILES = [
  {
    store: 'apple', dir: path.join(out, 'apple', 'screenshots', lang), max: 6, name: (i) => `${i + 1}_iphone.png`,
    viewport: landscape ? { width: 932, height: 430 } : { width: 430, height: 932 }, scale: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  },
  {
    store: 'google', dir: path.join(images, 'phoneScreenshots'), max: 8, name: (i) => `${i + 1}_${lang}.png`,
    viewport: landscape ? { width: 640, height: 360 } : { width: 360, height: 640 }, scale: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  },
];

const DEFAULT_STEPS = [
  { wait: 2500 },
  { tap: [0.5, 0.62], wait: 2000 },
  { tap: [0.5, 0.5], wait: 2000 },
  { tap: [0.5, 0.5], wait: 2000 },
];
const steps = game.screenshotSteps || DEFAULT_STEPS;

const warnings = [];
let server = null;
let browser = null;
let url = null;

/** Started only when a profile actually needs captured screenshots. */
async function ensureBrowser() {
  if (browser) return;
  server = await serve(game.paths.www);
  url = `http://127.0.0.1:${server.address().port}/index.html`;
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
}

try {
  for (const profile of PROFILES) {
    fs.mkdirSync(profile.dir, { recursive: true });
    const expected = { width: profile.viewport.width * profile.scale, height: profile.viewport.height * profile.scale };

    const custom = walk(path.join(game.paths.customScreenshots, profile.store)).filter((f) => /\.png$/i.test(f)).sort();
    if (custom.length) {
      for (const [i, file] of custom.slice(0, profile.max).entries()) {
        const meta = await sharp(file).metadata();
        if (profile.store === 'apple' && (meta.width !== expected.width || meta.height !== expected.height)) {
          warnings.push(`${path.basename(file)} is ${meta.width}×${meta.height}; Apple expects ${expected.width}×${expected.height}.`);
        }
        fs.writeFileSync(path.join(profile.dir, profile.name(i)), await flattenScreenshot(fs.readFileSync(file), game.backgroundColor));
      }
      console.log(`✔ ${profile.store}: using ${Math.min(custom.length, profile.max)} custom screenshots`);
      continue;
    }

    await ensureBrowser();
    const context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.scale,
      isMobile: true,
      hasTouch: true,
      userAgent: profile.userAgent,
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => warnings.push(`Game error while capturing ${profile.store} screenshots: ${e.message}`));
    await page.goto(url, { waitUntil: 'load' });

    const seen = new Set();
    let count = 0;
    for (const step of steps) {
      if (count >= profile.max) break;
      if (Array.isArray(step.tap)) {
        await page.touchscreen.tap(profile.viewport.width * step.tap[0], profile.viewport.height * step.tap[1]);
      }
      if (step.key) await page.keyboard.press(step.key);
      await page.waitForTimeout(step.wait ?? 1200);
      if (step.shot === false) continue;

      const png = await flattenScreenshot(await page.screenshot({ type: 'png' }), game.backgroundColor);
      const hash = crypto.createHash('sha1').update(png).digest('hex');
      if (seen.has(hash)) continue; // skip duplicates when a tap changed nothing
      seen.add(hash);
      fs.writeFileSync(path.join(profile.dir, profile.name(count)), png);
      count += 1;
    }
    await context.close();

    if (count < 2) warnings.push(`Only ${count} distinct ${profile.store} screenshot(s). Add taps to "screenshots" in game.json that reach gameplay. Google Play needs at least 2.`);
    console.log(`✔ ${profile.store}: captured ${count} screenshots at ${expected.width}×${expected.height}`);
  }

  // Feature graphic (Google Play, 1024×500): icon on the left, name and tagline on the right.
  fs.writeFileSync(path.join(images, 'featureGraphic.png'), await featureGraphic());
  console.log('✔ google: feature graphic 1024×500 and icon 512×512');
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}

async function featureGraphic() {
  const W = 1024;
  const H = 500;
  const fg = readableTextColor(game.backgroundColor);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const iconSize = 300;
  const iconX = 74;
  const textX = iconX + iconSize + 58;
  const textWidth = W - textX - 60;

  const titleSize = Math.min(74, Math.floor((textWidth / Math.max(game.name.length, 1)) * 1.62));
  const tagSize = 31;
  // Wrap the tagline by rough character width, since SVG text doesn't wrap.
  const tagline = (text.subtitle || text.shortDescription || '').trim();
  const perLine = Math.max(12, Math.floor(textWidth / (tagSize * 0.52)));
  const lines = [];
  for (const word of tagline.split(/\s+/).filter(Boolean)) {
    if (lines.length && (lines.at(-1) + ' ' + word).length <= perLine) lines[lines.length - 1] += ` ${word}`;
    else if (lines.length < 2) lines.push(word);
  }

  const titleY = lines.length ? 232 : 272;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${game.backgroundColor}"/>
    <text x="${textX}" y="${titleY}" fill="${fg}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif"
      font-size="${titleSize}" font-weight="bold" letter-spacing="-1">${esc(game.name)}</text>
    ${lines.map((line, i) => `<text x="${textX}" y="${titleY + 62 + i * 42}" fill="${fg}" fill-opacity="0.86"
      font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${tagSize}">${esc(line)}</text>`).join('\n')}
  </svg>`;

  const iconRounded = await sharp(await flatIcon(game.paths.icon, iconSize, iconBg))
    .composite([{
      input: Buffer.from(`<svg width="${iconSize}" height="${iconSize}"><rect width="${iconSize}" height="${iconSize}" rx="68" fill="#fff"/></svg>`),
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();

  return sharp(Buffer.from(svg))
    .composite([{ input: iconRounded, left: iconX, top: Math.round((H - iconSize) / 2) }])
    .flatten({ background: game.backgroundColor })
    .removeAlpha()
    .png()
    .toBuffer();
}

// Copy the previews into the game's folder so the control panel can show them.
const previewsDir = path.join(game.dir, 'store', 'previews');
const thumbsDir = path.join(previewsDir, 'thumbs');
fs.rmSync(previewsDir, { recursive: true, force: true });
fs.mkdirSync(thumbsDir, { recursive: true });

const appleShots = walk(path.join(out, 'apple', 'screenshots', lang)).filter((f) => /\.png$/i.test(f)).sort();
for (const [i, file] of appleShots.entries()) {
  const name = `apple-${String(i + 1).padStart(2, '0')}`;
  fs.copyFileSync(file, path.join(previewsDir, `${name}.png`));
  await sharp(file).resize({ width: 320 }).jpeg({ quality: 72 }).toFile(path.join(thumbsDir, `${name}.jpg`));
}
const featureFile = path.join(images, 'featureGraphic.png');
if (fs.existsSync(featureFile)) {
  fs.copyFileSync(featureFile, path.join(previewsDir, 'feature.png'));
  await sharp(featureFile).resize({ width: 640 }).jpeg({ quality: 76 }).toFile(path.join(thumbsDir, 'feature.jpg'));
}
console.log(`✔ previews copied to games/${slug}/store/previews`);

const summary = [`## Store assets: ${game.name}`, '', `Saved to build/${slug}/store, and previews copied into games/${slug}/store/previews so they show in the panel.`];
if (warnings.length) summary.push('', ...warnings.map((w) => `- ⚠️ ${w}`));
console.log(summary.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
