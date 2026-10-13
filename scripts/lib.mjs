// Shared helpers for Shipyard scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import '../site/naming.js';

export const naming = globalThis.ShipyardNaming;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Store field limits (App Store Connect + Google Play Console).
export const LIMITS = {
  name: 30,
  subtitle: 30,
  keywords: 100,
  promotionalText: 170,
  description: 4000,
  shortDescription: 80,
  releaseNotes: 4000,
};

export const APPLE_GAME_SUBCATEGORIES = [
  'GAMES_ACTION', 'GAMES_ADVENTURE', 'GAMES_BOARD', 'GAMES_CARD', 'GAMES_CASINO',
  'GAMES_CASUAL', 'GAMES_FAMILY', 'GAMES_MUSIC', 'GAMES_PUZZLE', 'GAMES_RACING',
  'GAMES_ROLE_PLAYING', 'GAMES_SIMULATION', 'GAMES_SPORTS', 'GAMES_STRATEGY',
  'GAMES_TRIVIA', 'GAMES_WORD',
];

export const DESTINATIONS = ['previews', 'build-only', 'testers', 'closed-test', 'review'];

export function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

export function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

export function writeText(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `${value ?? ''}`.trim() + '\n');
}

export function loadConfig() {
  const file = path.join(ROOT, 'shipyard.config.json');
  if (!fs.existsSync(file)) fail('shipyard.config.json is missing from the repo root.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function slugArg() {
  const slug = process.argv[2];
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug)) {
    fail('Pass the game folder name, for example: node scripts/preflight.mjs quackie-pond');
  }
  return slug;
}

/** What App Store Connect knows about a game, written by scripts/appstore.mjs. */
export function releasePath(slug) {
  return path.join(ROOT, 'games', slug, 'release.json');
}

export function loadRelease(slug) {
  try {
    return JSON.parse(fs.readFileSync(releasePath(slug), 'utf8'));
  } catch {
    return {};
  }
}

export function buildNumber() {
  return process.env.BUILD_NUMBER || '1';
}

export function loadGame(slug) {
  const config = loadConfig();
  const dir = path.join(ROOT, 'games', slug);
  const file = path.join(dir, 'game.json');
  if (!fs.existsSync(file)) fail(`games/${slug}/game.json was not found.`);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`games/${slug}/game.json is not valid JSON: ${err.message}`);
  }

  const site = (config.siteUrl || '').replace(/\/+$/, '');
  const store = (name) => readText(path.join(dir, 'store', name));

  const name = (raw.name || '').trim();
  return {
    slug,
    dir,
    config,
    raw,
    name,
    displayName: (raw.displayName || '').trim() || naming.defaultDisplayName(name),
    release: loadRelease(slug),
    bundleId: (raw.bundleId || '').trim(),
    version: (raw.version || '1.0.0').trim(),
    orientation: raw.orientation || 'portrait',
    backgroundColor: raw.backgroundColor || '#000000',
    hideStatusBar: raw.hideStatusBar !== false,
    appleSubcategory: raw.appleSubcategory || 'GAMES_CASUAL',
    pricing: raw.pricing || { model: 'free', price: '0' },
    privacyUrl: raw.privacyUrl || `${site}/privacy.html`,
    supportUrl: raw.supportUrl || `${site}/support.html`,
    marketingUrl: raw.marketingUrl || '',
    copyright: raw.copyright || `${new Date().getFullYear()} ${config.companyName || ''}`.trim(),
    screenshotSteps: Array.isArray(raw.screenshots) ? raw.screenshots : null,
    text: {
      subtitle: store('subtitle.txt'),
      promotionalText: store('promotional_text.txt'),
      description: store('description.txt'),
      shortDescription: store('short_description.txt'),
      keywords: store('keywords.txt'),
      releaseNotes: store('release_notes.txt'),
    },
    paths: {
      www: path.join(dir, 'www'),
      icon: path.join(dir, 'icon.png'),
      customScreenshots: path.join(dir, 'store', 'screenshots'),
    },
    build: path.join(ROOT, 'build', slug),
  };
}

export function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ---------- Images ----------

export function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function readableTextColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#14213a' : '#ffffff';
}

/** Square icon with no transparency (required by Apple). */
export async function flatIcon(iconPath, size, background) {
  return sharp(iconPath)
    .resize(size, size, { fit: 'cover' })
    .flatten({ background })
    .png()
    .toBuffer();
}

/** Icon centered on a transparent canvas (Android adaptive foreground layer). */
export async function paddedIcon(iconPath, size, scale, background) {
  const inner = Math.round(size * scale);
  const icon = await flatIcon(iconPath, inner, background);
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: icon, gravity: 'center' }])
    .png()
    .toBuffer();
}

export async function roundIcon(iconPath, size, background) {
  const flat = await flatIcon(iconPath, size, background);
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  return sharp(flat).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

export async function splashImage(iconPath, width, height, background) {
  const inner = Math.round(Math.min(width, height) * 0.28);
  const icon = await sharp(iconPath).resize(inner, inner, { fit: 'cover' }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: icon, gravity: 'center' }])
    .flatten({ background })
    .removeAlpha()
    .png()
    .toBuffer();
}

export async function cornerColor(iconPath) {
  const { data } = await sharp(iconPath)
    .extract({ left: 2, top: 2, width: 1, height: 1 })
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return '#' + [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Stores reject transparency in screenshots and store graphics.
export async function flattenScreenshot(buffer, background) {
  return sharp(buffer).flatten({ background }).removeAlpha().png().toBuffer();
}
