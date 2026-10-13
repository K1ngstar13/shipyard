// Approval preflight: catches the most common App Store / Google Play rejection
// causes before spending build minutes. Exits 1 if anything blocks shipping.
//
// Usage: node scripts/preflight.mjs <game-slug> [destination]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ROOT, LIMITS, APPLE_GAME_SUBCATEGORIES, DESTINATIONS, loadGame, slugArg, walk, readText, naming,
} from './lib.mjs';
import { checkAppStoreName, describeConflict } from './name-check.mjs';

const slug = slugArg();
const destination = process.argv[3] || 'testers';
if (!DESTINATIONS.includes(destination)) {
  console.error(`Unknown destination "${destination}". Use one of: ${DESTINATIONS.join(', ')}`);
  process.exit(1);
}
const forStores = destination === 'review';
const game = loadGame(slug);
const { config, text } = game;

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
/** Blocks store review, but only warns for tester builds. */
const reviewBlocker = (msg) => (forStores ? err(msg) : warn(msg));

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const hasWord = (haystack, word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);

// ---------- Config ----------
const placeholders = ['you@example.com', 'ABCDE12345', 'YourLastName', 'your-shipyard-site', '555 0100'];
const configText = JSON.stringify(config);
for (const p of placeholders) {
  if (configText.includes(p)) {
    const msg = `shipyard.config.json still contains the placeholder "${p}". Fill in your real details.`;
    if (p === 'ABCDE12345') warn(`${msg} (needed for iOS builds)`);
    else reviewBlocker(msg);
  }
}
const siteConfig = readText(path.join(ROOT, 'site', 'site-config.js'));
if (siteConfig.includes('you@example.com')) {
  reviewBlocker('site/site-config.js still has the placeholder email. Your privacy and support pages must show a real contact.');
}

// ---------- game.json ----------
if (!game.name) err('game.json needs a "name".');
else if (game.name.length > LIMITS.name) err(`Name is ${game.name.length} characters. Both stores allow ${LIMITS.name}.`);

// ---------- Names and the App ID ----------
const { release } = game;
if (!game.displayName) err('The home-screen name is empty.');
else if ([...game.displayName].length > LIMITS.name) err(`Home-screen name is ${[...game.displayName].length} characters. Keep it to ${naming.HOME_SCREEN_FIT}, and never over ${LIMITS.name}.`);
else {
  if ([...game.displayName].length > naming.HOME_SCREEN_FIT) warn(`Home-screen name "${game.displayName}" is ${[...game.displayName].length} characters. iPhone shows about ${naming.HOME_SCREEN_FIT} under the icon and cuts the rest off with "…". Set a shorter home-screen name on Listing (step 4).`);
  if (game.name && !naming.displayNameMatches(game.displayName, game.name)) reviewBlocker(`Home-screen name "${game.displayName}" doesn't come from the App Store name "${game.name}". Apple rejects apps whose home-screen name differs from their store name.`);
}

if (release.bundleIdLocked && release.bundleId && release.bundleId !== game.bundleId) {
  err(`The App ID is locked to ${release.bundleId}, but game.json says ${game.bundleId}. ${release.lock?.reason || ''} Put it back on Price (step 6).`.trim());
}
const ownRecord = release.appStoreConnect?.appId && release.name?.appStore === game.name;
if (game.name && destination !== 'build-only' && !ownRecord) {
  const check = await checkAppStoreName(game.name, { config, ownBundleIds: [game.bundleId] });
  if (!check.checked) warn(`Couldn't search the App Store for other apps named "${game.name}" (${check.error}). App Store Connect still checks when the record is created.`);
  else if (check.exact.length) {
    // With a record already in App Store Connect, tester builds still work under its current name.
    const report = destination === 'previews' ? warn : release.appStoreConnect?.appId ? reviewBlocker : err;
    report(describeConflict(game.name, check.exact));
  }
  else if (check.similar.length) warn(`Similar App Store names exist: ${check.similar.map((s) => `"${s.name}" (${s.seller})`).join(', ')}. Fine to keep, but a more distinctive name is easier to find.`);
}
if (release.name && release.name.synced === false && release.name.problem) reviewBlocker(release.name.problem);

if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(game.bundleId)) {
  err(`bundleId "${game.bundleId}" is invalid. Use lowercase letters, numbers, and dots, like ${config.bundlePrefix || 'com.yourname'}.${slug.replace(/-/g, '')}. No dashes (Android rejects them).`);
}
if (!/^\d+\.\d+\.\d+$/.test(game.version)) err(`version "${game.version}" must look like 1.0.0.`);
if (!['portrait', 'landscape', 'any'].includes(game.orientation)) err('orientation must be "portrait", "landscape", or "any".');
if (!/^#[0-9a-fA-F]{6}$/.test(game.backgroundColor)) err('backgroundColor must be a 6-digit hex color like #8FD3F4.');
if (!APPLE_GAME_SUBCATEGORIES.includes(game.appleSubcategory)) {
  err(`appleSubcategory must be one of: ${APPLE_GAME_SUBCATEGORIES.join(', ')}`);
}
for (const [label, url] of [['privacyUrl', game.privacyUrl], ['supportUrl', game.supportUrl]]) {
  if (!/^https:\/\/[^\s]+\.[^\s]+/.test(url)) err(`${label} must be a working https:// link (got "${url}").`);
}

// ---------- Icon ----------
if (!fs.existsSync(game.paths.icon)) {
  err('icon.png is missing. Add a 1024×1024 PNG next to game.json.');
} else {
  const meta = await sharp(game.paths.icon).metadata();
  if (meta.width !== meta.height) err(`icon.png is ${meta.width}×${meta.height}. It must be square.`);
  else if (meta.width < 1024) err(`icon.png is ${meta.width}px. It must be at least 1024×1024.`);
  if (meta.hasAlpha) warn('icon.png has transparency. Shipyard fills it with backgroundColor, because Apple rejects transparent icons.');
}

// ---------- Web build ----------
const www = game.paths.www;
const index = path.join(www, 'index.html');
if (!fs.existsSync(index)) {
  err(`games/${slug}/www/index.html is missing. The game's entry file must be named index.html.`);
} else {
  const files = walk(www);
  const totalMb = files.reduce((sum, f) => sum + fs.statSync(f).size, 0) / 1e6;
  if (totalMb > 150) warn(`The game is ${totalMb.toFixed(0)} MB. Google Play's limit is 200 MB compressed, and big downloads get fewer installs.`);

  const codeFiles = files.filter((f) => /\.(html?|js|mjs|css)$/i.test(f));
  const code = codeFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  if (/<iframe[^>]+src=["']https?:/i.test(code)) {
    err('The game loads a website in an iframe. Apple rejects apps that are just a website (guideline 4.2). Bundle the game files instead.');
  }
  if (/(window\.)?location(\.href)?\s*=\s*["']https?:/i.test(code)) {
    err('The game redirects to an external website on load. Apple rejects this (guideline 4.2). Keep everything inside the app.');
  }
  const remoteAssets = [...code.matchAll(/<(?:script|link)[^>]+(?:src|href)=["'](https?:\/\/[^"']+)/gi)].map((m) => m[1]);
  const risky = remoteAssets.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
  if (risky.length) {
    warn(`The game loads code from the internet (${[...new Set(risky)].slice(0, 3).join(', ')}). Download these files into www/ so the game works offline. Reviewers often test in airplane mode.`);
  }
  if (/fonts\.(googleapis|gstatic)\.com/.test(code)) {
    warn('The game uses Google Fonts from the internet. Fonts fall back to system fonts offline; bundle the font files for a consistent look.');
  }
  if (/http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org\/(?:2000\/svg|1999\/xhtml|1999\/xlink))/i.test(code)) {
    warn('The game references plain http:// links. iOS blocks insecure requests; use https:// or bundle the files.');
  }
  const payments = ['paypal.me', 'paypal.com', 'buymeacoffee', 'ko-fi.com', 'patreon.com', 'cash.app', 'venmo.com', 'stripe.com'];
  const found = payments.filter((p) => code.toLowerCase().includes(p));
  if (found.length) {
    err(`The game links to outside payments (${found.join(', ')}). Apple requires In-App Purchase for digital goods and tips (guideline 3.1.1). Remove these links.`);
  }
  if (!/name=["']viewport["']/i.test(fs.readFileSync(index, 'utf8'))) {
    warn('index.html has no viewport tag. Shipyard adds one that disables pinch-zoom.');
  }
}

// ---------- Store text ----------
const checkLength = (label, value, limit, useBytes = false) => {
  const len = useBytes ? bytes(value) : [...value].length;
  if (len > limit) err(`${label} is ${len} ${useBytes ? 'bytes' : 'characters'}. The limit is ${limit}.`);
};

if (!text.description) reviewBlocker('store/description.txt is empty. Both stores require a description.');
if (text.description && text.description.length < 200) warn('The description is very short. 2–4 short paragraphs about what players do converts better.');
if (!text.shortDescription) reviewBlocker('store/short_description.txt is empty. Google Play requires it (80 characters max).');
if (!text.subtitle) warn('store/subtitle.txt is empty. The App Store subtitle is prime search space; use it.');
if (!text.keywords) warn('store/keywords.txt is empty. App Store keywords drive search; add comma-separated words.');

checkLength('Subtitle', text.subtitle, LIMITS.subtitle);
checkLength('Promotional text', text.promotionalText, LIMITS.promotionalText);
checkLength('Description', text.description, LIMITS.description);
checkLength('Short description', text.shortDescription, LIMITS.shortDescription);
checkLength('Keywords', text.keywords, LIMITS.keywords, true);
checkLength('Release notes', text.releaseNotes, LIMITS.releaseNotes);

if (/,\s/.test(text.keywords)) warn('Keywords have spaces after commas. Remove them; spaces count against the 100-byte limit.');
const nameWords = game.name.toLowerCase().split(/\s+/);
const repeated = text.keywords.toLowerCase().split(',').map((k) => k.trim()).filter((k) => nameWords.includes(k));
if (repeated.length) warn(`Keywords repeat words from the name (${repeated.join(', ')}). Apple already indexes the name; use the space for new words.`);

const allAppleText = [game.name, text.subtitle, text.promotionalText, text.description, text.keywords, text.releaseNotes].join('\n');
const allGoogleText = [game.name, text.shortDescription, text.description, text.releaseNotes].join('\n');

for (const word of ['android', 'google play', 'play store']) {
  if (hasWord(allAppleText, word)) err(`Store text mentions "${word}". Apple rejects listings that mention other platforms (guideline 2.3.10).`);
}
for (const word of ['iphone', 'ipad', 'app store', 'apple']) {
  if (hasWord(allGoogleText, word)) warn(`Store text mentions "${word}". Google Play listings shouldn't reference other stores.`);
}

const placeholderText = ['lorem ipsum', 'todo', 'tbd', 'coming soon', 'test version', 'beta version', 'placeholder'];
for (const word of placeholderText) {
  if (hasWord(allAppleText, word)) err(`Store text contains "${word}". Unfinished-looking listings get rejected (guideline 2.1).`);
}

// Other companies' trademarks: an instant metadata rejection when used in keywords.
const trademarks = [
  'tetris', 'block blast', 'candy crush', 'cookie clicker', 'meowdoku', 'wordle', 'minecraft', 'roblox',
  'fortnite', 'pokemon', 'pokémon', 'nintendo', 'disney', 'angry birds', 'flappy bird', 'among us',
];
for (const tm of trademarks) {
  if (hasWord(text.keywords, tm)) err(`Keywords include "${tm}", another company's trademark. Apple and Google reject this.`);
  else if (hasWord(allAppleText, tm)) err(`Store text mentions "${tm}", another company's trademark. Describe your game on its own terms.`);
}
for (const hype of ['#1', 'best game', 'number one', 'free download', 'top rated']) {
  if (allGoogleText.toLowerCase().includes(hype)) warn(`Store text says "${hype}". Google Play's metadata policy rejects unverifiable ranking claims.`);
}

// ---------- Price ----------
if (game.pricing.model === 'paid') {
  warn(`This game is marked as $${game.pricing.price}. Price has to be set by hand in App Store Connect and Play Console, once per app, after your tax and banking forms are complete. Neither store allows it over an API.`);
}

// ---------- Screenshots ----------
const custom = (store) => walk(path.join(game.paths.customScreenshots, store)).filter((f) => /\.png$/i.test(f));
if (!game.screenshotSteps && !custom('apple').length) {
  reviewBlocker('No screenshot plan. Add "screenshots" steps to game.json (taps that reach real gameplay) or put PNGs in store/screenshots/apple and store/screenshots/google. Title-screen-only screenshots get rejected (guideline 2.3.3).');
}
if (custom('google').length === 1) err('Google Play needs at least 2 screenshots; store/screenshots/google has 1.');

// ---------- Report ----------
const lines = [];
lines.push(`## Preflight: ${game.name || slug} → ${destination}`);
if (!errors.length && !warnings.length) lines.push('\nAll checks passed.');
if (errors.length) lines.push('\n### Must fix', ...errors.map((e) => `- ❌ ${e}`));
if (warnings.length) lines.push('\n### Worth fixing', ...warnings.map((w) => `- ⚠️ ${w}`));
const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

process.exit(errors.length ? 1 : 0);
