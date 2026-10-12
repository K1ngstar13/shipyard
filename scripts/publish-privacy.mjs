// Pushes a game's privacy page into your website's own repo, so the live URL is on your
// domain instead of the site Shipyard builds.
//
// Set `siteRepo` in shipyard.config.json (and `siteRepoBranch` / `siteRepoPath` if the
// defaults don't fit). Needs SHIPYARD_TOKEN to have Contents write on that repo too.
// Does nothing, quietly, when siteRepo isn't set.
//
// Usage: node scripts/publish-privacy.mjs <game-slug>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadGame, slugArg, fail } from './lib.mjs';
import { privacyPage } from './privacy.mjs';

const slug = slugArg();
const config = loadConfig();
const repo = (config.siteRepo || '').trim();

if (!repo) {
  console.log('No siteRepo set, so the privacy page stays on the Shipyard site. Nothing to do.');
  process.exit(0);
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`siteRepo should look like owner/repo, got "${repo}".`);

const token = process.env.SHIPYARD_TOKEN;
if (!token) fail('SHIPYARD_TOKEN is missing, so the website repo cannot be written to.');

const branch = config.siteRepoBranch || 'main';
const base = (config.siteRepoPath || 'apps').replace(/^\/+|\/+$/g, '');
const game = loadGame(slug);

async function gh(route, options = {}) {
  const res = await fetch(`https://api.github.com${route}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(data?.message || `GitHub returned ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function putFile(filePath, content, message) {
  let sha;
  try {
    const existing = await gh(`/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`);
    sha = existing.sha;
    const current = Buffer.from(existing.content || '', 'base64').toString('utf8');
    // Only the date line changes between builds; don't commit noise.
    const strip = (text) => text.replace(/Last updated [^<]*/g, '');
    if (strip(current) === strip(content)) {
      console.log(`✔ ${filePath} is already current`);
      return false;
    }
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await gh(`/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  console.log(`✔ wrote ${repo}/${filePath}`);
  return true;
}

/** An index of every app that has a page in the website repo. */
async function rebuildIndex() {
  let entries = [];
  try {
    const listing = await gh(`/repos/${repo}/contents/${base}?ref=${encodeURIComponent(branch)}`);
    entries = (Array.isArray(listing) ? listing : []).filter((item) => item.type === 'dir').map((item) => item.name);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!entries.includes(slug)) entries.push(slug);
  entries.sort();

  const title = (name) => {
    if (name === slug) return game.name;
    const local = path.join(process.cwd(), 'games', name, 'game.json');
    try { return JSON.parse(fs.readFileSync(local, 'utf8')).name || name; } catch { return name; }
  };
  const rows = entries.map((name) => `  <li><a href="/${base}/${name}/privacy.html">${title(name)}</a></li>`).join('\n');

  return putFile(`${base}/index.html`, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App privacy details</title>
<style>
  body { margin: 0; background: #F3F6FB; color: #172340; font: 17px/1.6 system-ui, -apple-system, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 48px 20px; }
  h1 { font-size: 38px; margin: 0 0 6px; }
  .muted { color: #52607C; }
  a { color: #2E5BBA; }
  ul { padding-left: 20px; }
</style>
</head>
<body>
<main>
  <h1>App privacy details</h1>
  <p class="muted">Each app published by ${game.config.companyName || ''} has its own page describing exactly what that app does.</p>
  <ul>
${rows}
  </ul>
  <p>Our company-wide policy is at <a href="/privacy.html">/privacy.html</a>.</p>
</main>
</body>
</html>
`, 'Update app privacy index');
}

const target = `${base}/${slug}/privacy.html`;
try {
  await putFile(target, privacyPage(game, config), `Privacy details for ${game.name}`);
  await rebuildIndex();
  const site = (config.siteUrl || '').replace(/\/+$/, '');
  console.log(`\nLive at ${site}/${base}/${slug}/privacy.html once your site redeploys.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n**Privacy page** published to \`${repo}\` at \`${target}\`.\n`);
  }
} catch (err) {
  if (err.status === 404) {
    fail(`Couldn't reach ${repo}. Check the name, and that SHIPYARD_TOKEN includes that repo with Contents write.`);
  }
  if (err.status === 403) {
    fail(`${repo} refused the write (${err.message}). The token needs Contents read and write on that repo.`);
  }
  throw err;
}
