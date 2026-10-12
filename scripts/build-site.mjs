// Assembles site-dist/ — what actually gets deployed.
//
//   node scripts/build-site.mjs apps     launcher + every game + manifests + apps.json
//   node scripts/build-site.mjs panel    the control panel + privacy and support pages
//   node scripts/build-site.mjs all      both, for testing on your own machine
//
// Keep "apps" and "panel" on separate hosts in production: your games then never
// share an origin with the browser storage holding your GitHub token.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, loadGame, fail, flatIcon, paddedIcon, cornerColor } from './lib.mjs';
import { privacyPage } from './privacy.mjs';

const target = process.argv[2] || 'all';
if (!['apps', 'panel', 'all'].includes(target)) fail('Pass apps, panel, or all.');

const OUT = path.join(ROOT, 'site-dist');
const SITE = path.join(ROOT, 'site');
const config = loadConfig();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copy = (name, as = name) => {
  const from = path.join(SITE, name);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, as), { recursive: true });
};

// Privacy and support go on both: the stores link to them, and they must always answer.
copy('site-config.js');
copy('vendor');
copy('privacy.html');
copy('support.html');

if (target === 'panel' || target === 'all') {
  copy('index.html', target === 'all' ? 'panel.html' : 'index.html');
}

const apps = [];

if (target === 'apps' || target === 'all') {
  copy('launcher.html', target === 'all' ? 'launcher.html' : 'index.html');
  copy('play.html');

  const gamesDir = path.join(ROOT, 'games');
  const slugs = fs.existsSync(gamesDir)
    ? fs.readdirSync(gamesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name).sort()
    : [];

  for (const slug of slugs) {
    const game = loadGame(slug);
    if (!fs.existsSync(path.join(game.paths.www, 'index.html'))) {
      console.warn(`• skipping ${slug}: no www/index.html`);
      continue;
    }
    const appDir = path.join(OUT, 'apps', slug);
    fs.cpSync(game.paths.www, appDir, { recursive: true });

    const iconBg = game.raw.iconBackgroundColor || (fs.existsSync(game.paths.icon) ? await cornerColor(game.paths.icon) : game.backgroundColor);
    if (fs.existsSync(game.paths.icon)) {
      fs.writeFileSync(path.join(appDir, 'icon-192.png'), await flatIcon(game.paths.icon, 192, iconBg));
      fs.writeFileSync(path.join(appDir, 'icon-512.png'), await flatIcon(game.paths.icon, 512, iconBg));
      // Maskable: Android crops icons to its own shape, so keep the art inside 80%.
      fs.writeFileSync(path.join(appDir, 'icon-maskable.png'), await paddedIcon(game.paths.icon, 512, 0.8, iconBg));
    }

    const manifest = {
      name: game.name,
      short_name: game.name.slice(0, 12),
      description: game.text.shortDescription || undefined,
      start_url: `../../play.html?g=${slug}`,
      scope: '../../',
      display: 'fullscreen',
      display_override: ['fullscreen', 'standalone'],
      orientation: game.orientation === 'any' ? 'any' : game.orientation,
      background_color: game.backgroundColor,
      theme_color: game.backgroundColor,
      icons: fs.existsSync(game.paths.icon) ? [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ] : [],
    };
    fs.writeFileSync(path.join(appDir, 'app.webmanifest'), JSON.stringify(manifest, null, 2));

    // Each app gets its own privacy page. This is the URL the stores check.
    fs.writeFileSync(path.join(appDir, 'privacy.html'), privacyPage(game, config));

    const previewsDir = path.join(game.dir, 'store', 'previews', 'thumbs');
    const previews = fs.existsSync(previewsDir)
      ? fs.readdirSync(previewsDir).filter((f) => /^apple-\d+\.jpg$/.test(f)).sort()
      : [];
    if (previews.length) {
      fs.cpSync(previewsDir, path.join(appDir, 'previews'), { recursive: true });
    }

    apps.push({
      slug,
      name: game.name,
      version: game.version,
      tagline: game.text.subtitle || game.text.shortDescription || '',
      launch: `/play.html?g=${slug}`,
      direct: `/apps/${slug}/index.html`,
      manifest: `/apps/${slug}/app.webmanifest`,
      privacy: `/apps/${slug}/privacy.html`,
      icon: fs.existsSync(game.paths.icon) ? `/apps/${slug}/icon-512.png` : null,
      previews: previews.map((f) => `/apps/${slug}/previews/${f}`),
      backgroundColor: game.backgroundColor,
      orientation: game.orientation,
      category: game.appleSubcategory,
      price: game.pricing.model === 'paid' ? `$${game.pricing.price}` : 'Free',
      bundleId: game.bundleId,
    });
    console.log(`✔ ${slug}`);
  }

  // One page listing every app's privacy details, to link from the company site.
  const indexRows = apps.map((app) =>
    `    <li><a href="${app.privacy}">${app.name}</a> — ${app.price}</li>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'app-privacy.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>App privacy details</title>
<style>body{margin:0;background:#F3F6FB;color:#172340;font:17px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:680px;margin:0 auto;padding:48px 20px}h1{font-size:38px;margin:0 0 6px}
.muted{color:#52607C}a{color:#2E5BBA}ul{padding-left:20px}</style></head>
<body><main><h1>App privacy details</h1>
<p class="muted">Each app published by ${config.companyName || ''} has its own page describing exactly what that app does.</p>
<ul>
${indexRows}
</ul>
<p>Our company-wide policy is at <a href="privacy.html">privacy.html</a>.</p>
</main></body></html>
`);

  // A paste-in block for the main company site, so elevatr.llc links to each app's page.
  const base = (config.siteUrl || '').replace(/\/+$/, '');
  fs.writeFileSync(path.join(OUT, 'app-privacy-links.html'),
    `<!-- Paste into your company privacy page. Regenerated on every build. -->\n<h2>App-specific privacy details</h2>\n<p>Each app we publish has its own page describing exactly what that app does:</p>\n<ul>\n`
    + apps.map((app) => `  <li><a href="${base}${app.privacy}">${app.name}</a></li>`).join('\n')
    + `\n</ul>\n`);

  fs.writeFileSync(path.join(OUT, 'apps.json'), JSON.stringify({
    publisher: config.companyName || '',
    generated: new Date().toISOString(),
    apps,
  }, null, 2));
}

console.log(`\nBuilt site-dist (${target}) with ${apps.length} playable app${apps.length === 1 ? '' : 's'}.`);
if (target === 'all') console.log('Local: npm run preview, then open http://localhost:4173 for the launcher and /panel.html for the control panel.');
