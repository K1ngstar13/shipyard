// Turns games/<slug>/www into a native iOS or Android project using Capacitor.
//
// Usage: node scripts/prepare-app.mjs <game-slug> <ios|android>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import {
  ROOT, loadGame, slugArg, fail, walk, buildNumber,
  flatIcon, paddedIcon, roundIcon, splashImage, cornerColor,
} from './lib.mjs';

const CAPACITOR_VERSION = '^8.5.1';
const APP_PLUGIN_VERSION = '^8.1.1';
const MIN_ANDROID_TARGET_SDK = 36; // Google Play requirement since Aug 31, 2026

const slug = slugArg();
const platform = process.argv[3];
if (!['ios', 'android'].includes(platform)) fail('Second argument must be "ios" or "android".');
if (platform === 'ios' && process.platform !== 'darwin') fail('iOS projects can only be prepared on macOS (the GitHub workflow uses a Mac runner).');

const game = loadGame(slug);
const appDir = path.join(game.build, 'app');
const run = (cmd, args, cwd = appDir) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
};

// ---------- 1. Fresh Capacitor workspace ----------
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

const deps = {
  '@capacitor/core': CAPACITOR_VERSION,
  '@capacitor/cli': CAPACITOR_VERSION,
  '@capacitor/app': APP_PLUGIN_VERSION,
  [`@capacitor/${platform}`]: CAPACITOR_VERSION,
};
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: `shipyard-${slug}`, private: true, dependencies: deps }, null, 2),
);

fs.writeFileSync(
  path.join(appDir, 'capacitor.config.json'),
  JSON.stringify(
    {
      appId: game.bundleId,
      appName: game.displayName,
      webDir: 'www',
      backgroundColor: game.backgroundColor,
      loggingBehavior: 'none',
      ios: { scrollEnabled: false, contentInset: 'never' },
      android: { webContentsDebuggingEnabled: false },
      plugins: {
        SystemBars: { hidden: game.hideStatusBar, insetsHandling: 'css' },
      },
    },
    null,
    2,
  ),
);

// ---------- 2. Copy the game and inject the bridge ----------
const webDir = path.join(appDir, 'www');
fs.cpSync(game.paths.www, webDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'native', 'shipyard-bridge.js'), path.join(webDir, 'shipyard-bridge.js'));

const indexPath = path.join(webDir, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const inject = [];
if (!/name=["']viewport["']/i.test(html)) {
  inject.push('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">');
}
inject.push('<script src="shipyard-bridge.js"></script>');
const block = inject.join('\n');
// Goes after <meta charset> when there is one, so the encoding declaration stays first.
const charset = /<meta[^>]+charset[^>]*>/i;
const head = /<head[^>]*>/i;
if (charset.test(html)) html = html.replace(charset, (tag) => `${tag}\n${block}`);
else if (head.test(html)) html = html.replace(head, (tag) => `${tag}\n${block}`);
else html = `${block}\n${html}`;
fs.writeFileSync(indexPath, html);

// ---------- 3. Install Capacitor and add the native platform ----------
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error']);
run('npx', ['cap', 'add', platform]);

// ---------- 4. Icons and splash screens ----------
const iconBg = game.raw.iconBackgroundColor || (await cornerColor(game.paths.icon));
const splashBg = game.backgroundColor;

async function replacePngs(files, render) {
  for (const file of files) {
    const { width, height } = await sharp(file).metadata();
    fs.writeFileSync(file, await render(width, height, path.basename(file)));
  }
}

if (platform === 'ios') {
  const assets = path.join(appDir, 'ios', 'App', 'App', 'Assets.xcassets');
  await replacePngs(walk(path.join(assets, 'AppIcon.appiconset')).filter((f) => f.endsWith('.png')),
    (w) => flatIcon(game.paths.icon, w, iconBg));
  await replacePngs(walk(path.join(assets, 'Splash.imageset')).filter((f) => f.endsWith('.png')),
    (w, h) => splashImage(game.paths.icon, w, h, splashBg));
} else {
  const res = path.join(appDir, 'android', 'app', 'src', 'main', 'res');
  const pngs = walk(res).filter((f) => f.endsWith('.png'));
  await replacePngs(pngs.filter((f) => /ic_launcher_foreground\.png$/.test(f)),
    (w) => paddedIcon(game.paths.icon, w, 0.8, iconBg));
  await replacePngs(pngs.filter((f) => /ic_launcher_round\.png$/.test(f)),
    (w) => roundIcon(game.paths.icon, w, iconBg));
  await replacePngs(pngs.filter((f) => /ic_launcher\.png$/.test(f)),
    (w) => flatIcon(game.paths.icon, w, iconBg));
  await replacePngs(pngs.filter((f) => /splash\.png$/.test(f)),
    (w, h) => splashImage(game.paths.icon, w, h, splashBg));

  const bgXml = path.join(res, 'values', 'ic_launcher_background.xml');
  fs.writeFileSync(bgXml,
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${iconBg.toUpperCase()}</color>\n</resources>\n`);
}

// ---------- 5. Platform settings ----------
if (platform === 'android') {
  const androidDir = path.join(appDir, 'android');

  // Target SDK: never below Google Play's current requirement.
  const varsFile = path.join(androidDir, 'variables.gradle');
  let vars = fs.readFileSync(varsFile, 'utf8');
  for (const key of ['compileSdkVersion', 'targetSdkVersion']) {
    vars = vars.replace(new RegExp(`(${key}\\s*=\\s*)(\\d+)`), (_, prefix, n) => `${prefix}${Math.max(Number(n), MIN_ANDROID_TARGET_SDK)}`);
  }
  fs.writeFileSync(varsFile, vars);

  // Orientation
  const manifestFile = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  let manifest = fs.readFileSync(manifestFile, 'utf8');
  const androidOrientation = { portrait: 'portrait', landscape: 'landscape' }[game.orientation];
  if (androidOrientation && !manifest.includes('android:screenOrientation')) {
    manifest = manifest.replace('android:name=".MainActivity"',
      `android:name=".MainActivity"\n            android:screenOrientation="${androidOrientation}"`);
  }
  fs.writeFileSync(manifestFile, manifest);

  // Version + upload-key signing (key comes from GitHub secrets at build time).
  const gradleFile = path.join(androidDir, 'app', 'build.gradle');
  fs.appendFileSync(gradleFile, `
// ---- Added by Shipyard ----
android {
    defaultConfig {
        versionCode ${Number(buildNumber())}
        versionName "${game.version}"
    }
    signingConfigs {
        shipyardUpload {
            if (System.getenv("ANDROID_KEYSTORE_PATH")) {
                storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: "upload"
                keyPassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            if (System.getenv("ANDROID_KEYSTORE_PATH")) {
                signingConfig signingConfigs.shipyardUpload
            }
        }
    }
}
`);
  fs.chmodSync(path.join(androidDir, 'gradlew'), 0o755);
}

if (platform === 'ios') {
  const plist = path.join(appDir, 'ios', 'App', 'App', 'Info.plist');
  const orientations = {
    portrait: ['UIInterfaceOrientationPortrait'],
    landscape: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    any: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  }[game.orientation];
  const plutil = (...args) => execFileSync('plutil', [...args, plist], { stdio: 'inherit' });
  plutil('-replace', 'UISupportedInterfaceOrientations', '-json', JSON.stringify(orientations));
  plutil('-replace', 'UISupportedInterfaceOrientations~ipad', '-json', JSON.stringify(orientations));
  // No custom encryption: skips the export-compliance question that otherwise blocks submission.
  plutil('-replace', 'ITSAppUsesNonExemptEncryption', '-bool', 'NO');
  plutil('-replace', 'UIRequiredDeviceCapabilities', '-json', '["arm64"]');
  plutil('-replace', 'CFBundleDisplayName', '-string', game.displayName);
}

// ---------- 6. Sync web files + plugins into the native project ----------
run('npx', ['cap', 'sync', platform]);

console.log(`\n✔ ${platform} project ready at ${path.relative(ROOT, path.join(appDir, platform))}`);
