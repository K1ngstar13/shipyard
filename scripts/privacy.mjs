// Per-app privacy: what the app actually does, written as a page Apple and Google can
// read, plus the answers you paste into their questionnaires.
//
// A company-wide policy can't do this job. Both stores ask per app, and the answers have
// to match the binary you submit. So each game carries its own `privacy` block in
// game.json, and everything below is generated from it.
import fs from 'node:fs';
import path from 'node:path';
import { walk } from './lib.mjs';

/** Things worth noticing in a game's own code, so the questions start from evidence. */
export const SIGNALS = [
  { key: 'analytics', label: 'Analytics', test: /google-analytics|googletagmanager|gtag\(|mixpanel|amplitude|posthog|plausible\.io|segment\.com|firebase\/analytics|matomo/i },
  { key: 'crashReports', label: 'Crash reporting', test: /sentry\.io|bugsnag|crashlytics|rollbar/i },
  { key: 'ads', label: 'Advertising', test: /admob|adsbygoogle|applovin|unityads|ironsource|vungle|adsense|doubleclick/i },
  { key: 'accounts', label: 'Accounts or sign-in', test: /firebase\/auth|signInWith|type=["']password["']|auth0|supabase\.auth|oauth/i },
  { key: 'location', label: 'Location', test: /navigator\.geolocation|watchPosition|getCurrentPosition/i },
  { key: 'cameraMic', label: 'Camera or microphone', test: /getUserMedia|MediaRecorder|navigator\.mediaDevices/i },
  { key: 'contacts', label: 'Contacts', test: /navigator\.contacts|ContactsManager/i },
  { key: 'userContent', label: 'Messages or shared content', test: /new WebSocket|socket\.io|firebase\/(firestore|database)|supabase\.from/i },
  { key: 'purchases', label: 'Purchases', test: /in-?app ?purchase|RevenueCat|StoreKit|BillingClient/i },
  { key: 'network', label: 'Talks to a server', test: /fetch\(\s*["'`]https?:|XMLHttpRequest|axios\./i },
];

export const DEFAULT_PRIVACY = {
  analytics: false, crashReports: false, ads: false, accounts: false, location: false,
  cameraMic: false, contacts: false, userContent: false, purchases: false, network: false,
  childrenAudience: 'no', thirdParties: '', notes: '',
};

/** Scan a game's own files for the signals above. */
export function detectSignals(wwwDir) {
  const files = walk(wwwDir).filter((f) => /\.(html?|m?js|css|json)$/i.test(f) && fs.statSync(f).size < 4e6);
  const code = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const found = {};
  for (const signal of SIGNALS) found[signal.key] = signal.test.test(code);
  return found;
}

const collects = (privacy) => SIGNALS.some((s) => s.key !== 'network' && privacy[s.key]);

/** Plain-language lines describing what the app does, used in the page and the answers. */
function practices(privacy) {
  const lines = [];
  if (privacy.accounts) lines.push('You can create an account or sign in. We store the identifier you sign in with so your progress follows you.');
  if (privacy.analytics) lines.push('We use analytics to count how often screens are opened and which features get used. These are aggregate counts, not a profile of you.');
  if (privacy.crashReports) lines.push('When the app crashes, a report is sent containing the error, the device model, and the operating system version.');
  if (privacy.ads) lines.push('The app shows advertising. Ad providers may use a device advertising identifier to choose and measure ads.');
  if (privacy.location) lines.push('The app asks for your location, and only while you are using the feature that needs it. It is not stored after that.');
  if (privacy.cameraMic) lines.push('The app asks to use the camera or microphone for a feature you start yourself. Nothing is recorded or uploaded unless you choose to save it.');
  if (privacy.contacts) lines.push('The app asks for access to your contacts for a feature you start yourself.');
  if (privacy.userContent) lines.push('The app lets you send or share content with other people. What you send is stored so it can be delivered.');
  if (privacy.purchases) lines.push('The app offers purchases. Payment is handled entirely by Apple or Google; we never see your card details.');
  if (privacy.network && !collects(privacy)) lines.push('The app contacts a server for content, but sends nothing that identifies you.');
  return lines;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A standalone page for one app. This is the URL you give the stores. */
export function privacyPage(game, config) {
  const privacy = { ...DEFAULT_PRIVACY, ...(game.raw.privacy || {}) };
  const company = config.companyName || 'the publisher';
  const email = (config.review && config.review.email) || config.contactEmail || '';
  const site = (config.siteUrl || '').replace(/\/+$/, '');
  const list = practices(privacy);
  const nothing = !collects(privacy);
  const updated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const childrenLine = {
    yes: `${game.name} is directed to children. We do not collect personal information from anyone, and we do not allow advertising or tracking in it.`,
    mixed: `${game.name} is suitable for all ages and is not directed primarily at children.`,
    no: `${game.name} is not directed to children under 13.`,
  }[privacy.childrenAudience] || '';

  const third = (privacy.thirdParties || '').trim();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(game.name)} — Privacy</title>
<style>
  body { margin: 0; background: #F3F6FB; color: #172340; font: 17px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 48px 20px 64px; }
  h1 { font-size: 38px; line-height: 1.05; margin: 0 0 6px; }
  h2 { font-size: 20px; margin: 30px 0 6px; }
  p, li { max-width: 64ch; }
  .muted { color: #52607C; }
  a { color: #2E5BBA; }
  ul { padding-left: 20px; }
</style>
</head>
<body>
<main>
  <h1>${esc(game.name)}</h1>
  <p class="muted">Privacy details for this app, published by ${esc(company)}. Last updated ${esc(updated)}.</p>
  ${site ? `<p>This page covers ${esc(game.name)} specifically. Our company-wide policy is at <a href="${esc(site)}/privacy.html">${esc(site.replace(/^https?:\/\//, ''))}/privacy.html</a>, and this page takes precedence for anything about this app.</p>` : ''}

  <h2>What this app collects</h2>
  ${nothing
    ? `<p><strong>Nothing.</strong> ${esc(game.name)} does not collect, store, or share any personal information. There are no accounts, no advertising, no analytics, and no tracking of any kind.</p>
  <p>Your progress, settings, and unlocked items are saved only on your device. They never leave it, and we cannot see them.</p>`
    : `<ul>\n${list.map((line) => `    <li>${esc(line)}</li>`).join('\n')}\n  </ul>`}

  <h2>What this app never does</h2>
  <ul>
    ${!privacy.ads ? '<li>No advertising.</li>' : ''}
    ${!privacy.analytics ? '<li>No analytics or usage tracking.</li>' : ''}
    ${!privacy.location ? '<li>No access to your location.</li>' : ''}
    ${!privacy.cameraMic ? '<li>No access to your camera, microphone, or photos.</li>' : ''}
    ${!privacy.contacts ? '<li>No access to your contacts.</li>' : ''}
    <li>We never sell your information, and we never use it for advertising across other companies' apps.</li>
  </ul>

  ${third ? `<h2>Third parties</h2>\n  <p>This app uses: ${esc(third)}. Each handles data under its own privacy policy.</p>` : ''}

  <h2>Children</h2>
  <p>${esc(childrenLine)}${nothing ? ' Because the app collects no personal information from anyone, it collects none from children.' : ''}</p>

  <h2>Keeping and deleting data</h2>
  <p>${nothing
    ? 'There is nothing stored on our side to delete. Uninstalling the app removes everything it saved on your device.'
    : `We keep what is described above only as long as it is needed for the app to work. To ask for your data to be deleted, email ${esc(email)} with the app name and we will action it within 30 days.`}</p>

  <h2>Changes</h2>
  <p>If this app adds a feature that changes any of the above, this page is updated before that version is released, and the store listing's privacy answers are updated with it.</p>

  <h2>Contact</h2>
  <p>${esc(company)}${email ? ` — <a href="mailto:${esc(email)}">${esc(email)}</a>` : ''}</p>
</main>
</body>
</html>
`;
}

/** The exact answers to paste into App Store Connect and Play Console. */
export function storeAnswers(game, config) {
  const privacy = { ...DEFAULT_PRIVACY, ...(game.raw.privacy || {}) };
  const nothing = !collects(privacy);
  const url = `${(config.siteUrl || '').replace(/\/+$/, '')}/apps/${game.slug}/privacy.html`;

  const appleRows = [
    ['Contact Info', privacy.accounts ? 'Collected — Email Address, for App Functionality, linked to the user, not used for tracking' : 'Not Collected'],
    ['Identifiers', privacy.ads ? 'Collected — Device ID, for Third-Party Advertising, not linked, used for tracking' : privacy.accounts ? 'Collected — User ID, for App Functionality, linked to the user, not used for tracking' : 'Not Collected'],
    ['Usage Data', privacy.analytics ? 'Collected — Product Interaction, for Analytics, not linked to the user, not used for tracking' : 'Not Collected'],
    ['Diagnostics', privacy.crashReports ? 'Collected — Crash Data and Performance Data, for App Functionality, not linked to the user' : 'Not Collected'],
    ['Location', privacy.location ? 'Collected — Precise Location, for App Functionality, not linked to the user' : 'Not Collected'],
    ['User Content', privacy.userContent ? 'Collected — for App Functionality, linked to the user' : 'Not Collected'],
    ['Purchases', privacy.purchases ? 'Collected — Purchase History, for App Functionality, linked to the user' : 'Not Collected'],
    ['Contacts', privacy.contacts ? 'Collected — for App Functionality, linked to the user' : 'Not Collected'],
  ];

  const googleRows = [
    ['Does your app collect or share any of the required user data types?', nothing ? 'No' : 'Yes'],
    ['Is all of the user data collected by your app encrypted in transit?', nothing ? 'Not applicable' : 'Yes'],
    ['Do you provide a way for users to request that their data is deleted?', nothing ? 'Not applicable' : 'Yes — by email, within 30 days'],
    ['Data types collected', nothing ? 'None' : [
      privacy.accounts && 'Personal info: Email address, User IDs',
      privacy.analytics && 'App activity: App interactions',
      privacy.crashReports && 'App info and performance: Crash logs, Diagnostics',
      privacy.ads && 'Device or other IDs',
      privacy.location && 'Location: Approximate or precise location',
      privacy.userContent && 'Messages or Photos and videos, depending on the feature',
      privacy.purchases && 'Financial info: Purchase history',
    ].filter(Boolean).join('; ')],
    ['Is any data shared with third parties?', privacy.ads || privacy.analytics ? 'Yes — with the providers named in the policy' : 'No'],
    ['Advertising ID used?', privacy.ads ? 'Yes' : 'No'],
    ['Target audience', { yes: 'Children', mixed: 'All ages, not primarily children', no: '13 and over' }[privacy.childrenAudience] || '13 and over'],
    ['App access', 'All functionality is available without any special access, login, or credentials'],
  ];

  return `# ${game.name} — store privacy answers

Generated from this app's own settings. These must match what the app actually does;
if you change a feature, change the answers in the panel and regenerate.

**Privacy policy URL for both stores:** ${url}

---

## App Store Connect → App Privacy

For each category below, answer in the App Privacy section of the app record.

| Data type | Answer |
| --- | --- |
${appleRows.map(([a, b]) => `| ${a} | ${b} |`).join('\n')}

${nothing ? '**Summary:** choose "Data Not Collected" and Apple skips the rest of the questionnaire.\n' : ''}
Also under App Review Information: **Sign-in required — ${privacy.accounts ? 'Yes, supply a demo account' : 'No'}**.

---

## Play Console → App content → Data safety

${googleRows.map(([a, b]) => `**${a}**\n\n${b}\n`).join('\n')}

---

## Also set once per app

- **Content rating questionnaire** — answer honestly; for a game with no violence, gambling, or user interaction, everything is "No".
- **Ads declaration** — ${privacy.ads ? 'Yes, this app contains ads.' : 'No, this app does not contain ads.'}
- **Government apps / financial features / health** — No.
`;
}

export function writePrivacyArtifacts(game, config, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'privacy.html'), privacyPage(game, config));
  fs.writeFileSync(path.join(outDir, 'privacy-answers.md'), storeAnswers(game, config));
}
