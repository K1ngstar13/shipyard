// App Store Connect automation: bundle IDs, the app record, App Store name sync,
// the bundle ID lock, and TestFlight distribution. Runs in GitHub Actions with the
// ASC_* secrets and records what it finds in games/<slug>/release.json, which the
// panel reads to show TestFlight status and the next thing to do.
//
// Usage:
//   node scripts/appstore.mjs prepare <slug> [destination]        before a native build
//   node scripts/appstore.mjs testflight <slug> <build> [minutes]  after the upload
//   node scripts/appstore.mjs status <slug|--pending>              refresh on demand or on a schedule
// Add --commit to commit release.json back to the repo as it changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, loadGame, loadRelease, releasePath } from './lib.mjs';

const API = 'https://api.appstoreconnect.apple.com';
const FINAL_STATES = new Set(['available', 'failed', 'expired']);

// ---------- API client ----------

export class AppStoreError extends Error {
  constructor(status, errors) {
    const detail = (errors || []).map((e) => e.detail || e.title).filter(Boolean).join(' ');
    super(detail || `App Store Connect answered ${status}`);
    this.status = status;
    this.errors = errors || [];
  }
}

function signToken({ keyId, issuerId, privateKey }, now) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64({ iss: issuerId, iat: now, exp: now + 1140, aud: 'appstoreconnect-v1' })}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

export function appStoreClient({ keyId, issuerId, p8, fetchImpl = fetch, sleep = defaultSleep, base = API }) {
  // Secrets pasted with literal "\n" sequences still parse.
  const privateKey = crypto.createPrivateKey(String(p8).replace(/\\n/g, '\n').trim());
  let token = '', expires = 0;
  const bearer = () => {
    const now = Math.floor(Date.now() / 1000);
    if (now > expires - 60) { token = signToken({ keyId, issuerId, privateKey }, now); expires = now + 1140; }
    return token;
  };
  async function request(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(base + url, {
        method,
        headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(3000 * (attempt + 1)); continue; }
      const text = await res.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
      if (!res.ok) throw new AppStoreError(res.status, json.errors);
      return json;
    }
  }
  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    patch: (url, body) => request('PATCH', url, body),
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const q = encodeURIComponent;

// ---------- App Store Connect lookups ----------

export async function findBundleId(api, identifier) {
  const { data = [] } = await api.get(`/v1/bundleIds?filter[identifier]=${q(identifier)}&limit=200`);
  return data.find((b) => b.attributes?.identifier === identifier) || null;
}

/**
 * The description Apple shows beside the ID ("QuackDoku - elevatr.llc.quackdoku" in the
 * New App form). Apple allows only letters, numbers, and spaces here.
 */
export function bundleDescription(appName) {
  return String(appName || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Game';
}

export async function registerBundleId(api, identifier, appName) {
  const { data } = await api.post('/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier, name: bundleDescription(appName), platform: 'IOS' } } });
  return data;
}

/** Earlier versions described IDs as "Shipyard <name>". Tidy that to the plain game name. */
async function tidyBundleDescription(api, bundle, appName) {
  const wanted = bundleDescription(appName);
  if (!/^Shipyard /.test(bundle.attributes?.name || '') || bundle.attributes.name === wanted) return false;
  try {
    await api.patch(`/v1/bundleIds/${q(bundle.id)}`, { data: { type: 'bundleIds', id: bundle.id, attributes: { name: wanted } } });
    return true;
  } catch {
    return false; // cosmetic only; the identifier is what matters
  }
}

export async function findApp(api, bundleId) {
  const { data = [] } = await api.get(`/v1/apps?filter[bundleId]=${q(bundleId)}&limit=20`);
  return data.find((a) => a.attributes?.bundleId === bundleId) || null;
}

export async function findAppNamed(api, name) {
  const { data = [] } = await api.get(`/v1/apps?filter[name]=${q(name)}&limit=20`);
  const wanted = name.trim().toLowerCase();
  return data.find((a) => String(a.attributes?.name || '').trim().toLowerCase() === wanted) || null;
}

export async function firstBuild(api, appId) {
  const { data = [] } = await api.get(`/v1/builds?filter[app]=${q(appId)}&sort=uploadedDate&limit=1`);
  return data[0] || null;
}

async function latestBuild(api, appId) {
  const { data = [] } = await api.get(`/v1/builds?filter[app]=${q(appId)}&sort=-uploadedDate&limit=1`);
  return data[0] || null;
}

async function buildNumbered(api, appId, number) {
  const { data = [] } = await api.get(`/v1/builds?filter[app]=${q(appId)}&filter[version]=${q(number)}&sort=-uploadedDate&limit=5`);
  return data.find((b) => String(b.attributes?.version) === String(number)) || null;
}

/** The App Store name as App Store Connect has it, from the editable app info when there is one. */
export async function appNameLocalization(api, appId, locale) {
  const { data: infos = [] } = await api.get(`/v1/apps/${q(appId)}/appInfos?limit=10`);
  const live = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_INFO']);
  const info = infos.find((i) => !live.has(i.attributes?.appStoreState || i.attributes?.state)) || infos[0];
  if (!info) return null;
  const { data: locs = [] } = await api.get(`/v1/appInfos/${q(info.id)}/appInfoLocalizations?limit=50`);
  return locs.find((l) => l.attributes?.locale === locale) || locs[0] || null;
}

// ---------- TestFlight ----------

export async function ensureInternalGroup(api, appId, name) {
  const { data = [] } = await api.get(`/v1/betaGroups?filter[app]=${q(appId)}&limit=200`);
  const internal = data.filter((g) => g.attributes?.isInternalGroup);
  const found = internal.find((g) => g.attributes?.name === name) || internal[0];
  if (found) return found;
  const created = await api.post('/v1/betaGroups', {
    data: {
      type: 'betaGroups',
      attributes: { name, isInternalGroup: true, hasAccessToAllBuilds: false },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  });
  return created.data;
}

async function groupTesters(api, groupId) {
  const { data = [] } = await api.get(`/v1/betaGroups/${q(groupId)}/betaTesters?limit=200`);
  return data.map((t) => String(t.attributes?.email || '').toLowerCase()).filter(Boolean);
}

/** Everyone on the App Store Connect team, when the key may list users. Internal testers must be team members. */
async function teamEmails(api) {
  try {
    const { data = [] } = await api.get('/v1/users?limit=200');
    return data.map((u) => u.attributes?.username).filter((e) => /@/.test(e || ''));
  } catch {
    return [];
  }
}

export async function testerEmails(api, config) {
  const listed = config.testflight?.testers;
  if (Array.isArray(listed) && listed.length) return [...new Set(listed.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const team = await teamEmails(api);
  // Last resort: the publisher contacts, which only work if they are App Store Connect users.
  const fallback = [config.review?.email, config.contactEmail];
  return [...new Set((team.length ? team : fallback).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
}

async function addTesters(api, groupId, emails, present) {
  const problems = [];
  for (const email of emails) {
    if (present.includes(email)) continue;
    try {
      const { data = [] } = await api.get(`/v1/betaTesters?filter[email]=${q(email)}&limit=5`);
      const tester = data.find((t) => String(t.attributes?.email || '').toLowerCase() === email);
      if (tester) {
        await api.post(`/v1/betaGroups/${q(groupId)}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: tester.id }] });
      } else {
        await api.post('/v1/betaTesters', {
          data: {
            type: 'betaTesters',
            attributes: { email },
            relationships: { betaGroups: { data: [{ type: 'betaGroups', id: groupId }] } },
          },
        });
      }
    } catch (err) {
      const hint = /cannot be assigned/i.test(err.message)
        ? ' Apple won’t create a brand-new internal tester through the API. Add yourself once in TestFlight → Elevatr Internal Testing → Testers (+); Shipyard then reuses that tester for every app.'
        : '';
      problems.push(`${email}: ${err.message}.${hint}`);
    }
  }
  return problems;
}

async function addBuildToGroup(api, groupId, buildId) {
  try {
    await api.post(`/v1/betaGroups/${q(groupId)}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
  } catch (err) {
    if (err.status !== 409) throw err; // already in the group
  }
}

export function testerGroupName(config) {
  return config.testflight?.group || `${(config.companyName || 'Shipyard').split(' ')[0]} Internal Testing`;
}

/**
 * Makes sure the app has the internal group with your testers in it. Runs as soon as the
 * app record exists, so the group is ready before the first build finishes processing.
 */
export async function ensureTesterGroup(api, appId, config) {
  const name = testerGroupName(config);
  const problems = [];
  let group = null, testers = [];
  try {
    group = await ensureInternalGroup(api, appId, name);
  } catch (err) {
    problems.push(`Couldn't create ${name}: ${err.message}`);
    return { group, testers, problems };
  }
  testers = await groupTesters(api, group.id).catch(() => []);
  const failed = await addTesters(api, group.id, await testerEmails(api, config), testers);
  if (failed.length) problems.push(`Couldn't add tester ${failed.join('; ')}`);
  testers = await groupTesters(api, group.id).catch(() => testers);
  return { group, testers, problems };
}

/** Turns what Apple reports into one status line and, when needed, the next thing to do. */
export function describeTestflight({ build, buildNumber, betaState, inGroup, testers = [], group, appUrl, problems = [] }) {
  const n = build?.attributes?.version || buildNumber;
  const processing = build?.attributes?.processingState;
  const tf = appUrl ? `${appUrl}/testflight/ios` : 'https://appstoreconnect.apple.com/apps';
  if (!build) {
    return { state: 'uploaded', label: `Build ${n} uploaded, waiting for Apple to list it`, detail: 'A new build usually appears in App Store Connect within a few minutes.', next: null };
  }
  if (build.attributes?.expired || betaState === 'EXPIRED') {
    return { state: 'expired', label: `Build ${n} has expired`, detail: 'TestFlight builds last 90 days.', next: { title: 'Send a new build', detail: 'Choose Send to my phone in Shipyard.', blocking: true } };
  }
  if (processing === 'FAILED' || processing === 'INVALID' || betaState === 'PROCESSING_EXCEPTION') {
    return {
      state: 'failed', label: `Apple rejected build ${n} during processing`, detail: 'Apple emails the account holder the exact reason.',
      next: { title: 'Read Apple’s email about this build', detail: 'Fix what it names, then send the game again. The next build gets a new number automatically.', url: tf, blocking: true },
    };
  }
  if (processing === 'PROCESSING' || betaState === 'PROCESSING' || betaState === 'IN_EXPORT_COMPLIANCE_REVIEW' || !processing) {
    return { state: 'processing', label: `Apple is processing build ${n}`, detail: 'This usually takes 5–30 minutes. Shipyard adds it to TestFlight when it finishes.', next: null };
  }
  if (betaState === 'MISSING_EXPORT_COMPLIANCE') {
    return {
      state: 'needs-compliance', label: `Build ${n} needs an export compliance answer`, detail: problems.join(' ') || 'Shipyard tried to answer it automatically and Apple did not accept the change.',
      next: { title: 'Answer export compliance', detail: 'Open the build in TestFlight, choose Manage, then “None of the algorithms mentioned above”.', url: tf, blocking: true },
    };
  }
  if (!inGroup) {
    return {
      state: 'ready', label: `Build ${n} is ready but not yet in a tester group`, detail: problems.join(' '),
      next: { title: `Add build ${n} to ${group || 'an internal group'}`, detail: 'In TestFlight, open the group and add the build. Shipyard retries on the next check.', url: tf, blocking: true },
    };
  }
  if (!testers.length) {
    return {
      state: 'ready', label: `Build ${n} is in ${group} with no testers`, detail: problems.join(' '),
      next: { title: `Add yourself to ${group}`, detail: 'Internal testers must be users on your App Store Connect team. Add your Apple ID under Internal Testing, or list it in shipyard.config.json → testflight.testers.', url: tf, blocking: true },
    };
  }
  return {
    state: 'available', label: `On TestFlight: build ${n} for ${testers.length} tester${testers.length === 1 ? '' : 's'}`, detail: problems.join(' '),
    next: { title: 'Install it on your iPhone', detail: `Open the TestFlight app signed in as ${testers.slice(0, 3).join(', ')} and tap Install. The first time, accept the TestFlight email invite.`, blocking: false },
  };
}

/** One pass: find the build, answer compliance, put it in the internal group with testers, describe the result. */
export async function reconcileTestflight(api, { appId, appUrl, buildNumber, config }) {
  const build = buildNumber ? await buildNumbered(api, appId, buildNumber) : await latestBuild(api, appId);
  const problems = [];
  let betaState = null;
  if (build) {
    try {
      const { data } = await api.get(`/v1/builds/${q(build.id)}/buildBetaDetail`);
      betaState = data?.attributes?.internalBuildState || null;
    } catch { /* processing state alone still tells most of the story */ }
    if (betaState === 'MISSING_EXPORT_COMPLIANCE') {
      try {
        await api.patch(`/v1/builds/${q(build.id)}`, { data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } } });
        betaState = 'READY_FOR_BETA_TESTING';
      } catch (err) { problems.push(err.message); }
    }
  }
  const usable = build && build.attributes?.processingState === 'VALID' && !build.attributes?.expired
    && !['MISSING_EXPORT_COMPLIANCE', 'PROCESSING', 'PROCESSING_EXCEPTION', 'EXPIRED', 'IN_EXPORT_COMPLIANCE_REVIEW'].includes(betaState);
  const groupName = testerGroupName(config);
  let group = null, inGroup = false, testers = [];
  if (usable) {
    const setup = await ensureTesterGroup(api, appId, config);
    ({ group, testers } = setup);
    problems.push(...setup.problems);
    if (group) {
      try {
        if (!group.attributes?.hasAccessToAllBuilds) await addBuildToGroup(api, group.id, build.id);
        inGroup = true;
      } catch (err) { problems.push(`Couldn't add the build to ${groupName}: ${err.message}`); }
    }
  }
  const status = describeTestflight({ build, buildNumber, betaState, inGroup, testers, group: group?.attributes?.name || groupName, appUrl, problems });
  return {
    ...status,
    build: String(build?.attributes?.version || buildNumber || ''),
    processingState: build?.attributes?.processingState || null,
    betaState,
    group: group?.attributes?.name || groupName,
    testers,
  };
}

// ---------- Bundle ID lock ----------

export function lockReason(bundleId, buildNumber, uploadedAt) {
  const when = uploadedAt ? ` on ${String(uploadedAt).slice(0, 10)}` : '';
  const which = buildNumber ? `Build ${buildNumber}` : 'A build';
  return `${which} was uploaded to App Store Connect with ${bundleId}${when}. ` +
    'Apple ties the app record, its TestFlight builds, and every future update to this ID, and it can never be changed or reused. ' +
    'Players never see it; they see the App Store name and the home-screen name, which you can still change.';
}

function lock(release, bundleId, buildNumber, uploadedAt) {
  if (release.bundleIdLocked && release.bundleId === bundleId) return release;
  return { ...release, bundleId, bundleIdLocked: true, lock: { since: uploadedAt || new Date().toISOString(), build: String(buildNumber || ''), reason: lockReason(bundleId, buildNumber, uploadedAt) } };
}

// ---------- Commands ----------

export async function prepare(api, game, destination = 'testers') {
  const { config } = game;
  let release = { ...game.release, bundleId: game.release.bundleId || game.bundleId };
  const steps = [];

  if (game.release.bundleIdLocked && game.release.bundleId && game.release.bundleId !== game.bundleId) {
    release.next = {
      title: `Put the App ID back to ${game.release.bundleId}`,
      detail: `game.json says ${game.bundleId}, but ${game.release.lock?.reason || 'this game already has builds in App Store Connect under the locked ID.'}`,
      blocking: true,
    };
    return { ok: false, release, steps, message: release.next.detail };
  }

  release.bundleId = game.bundleId;
  const bundle = await findBundleId(api, game.bundleId);
  if (bundle) {
    steps.push(`Bundle ID ${game.bundleId} is registered.`);
    if (await tidyBundleDescription(api, bundle, game.name)) steps.push(`Renamed its description to “${bundleDescription(game.name)}”.`);
  } else { await registerBundleId(api, game.bundleId, game.name); steps.push(`Registered bundle ID ${game.bundleId} with Apple.`); }

  const app = await findApp(api, game.bundleId);
  if (!app) {
    const other = await findAppNamed(api, game.name).catch(() => null);
    release.appStoreConnect = null;
    release.next = other
      ? {
        title: `“${game.name}” in App Store Connect uses ${other.attributes.bundleId}`,
        detail: `Your App Store Connect app with this name was created with ${other.attributes.bundleId}, not ${game.bundleId}. Set the App ID in Shipyard (step 6) to ${other.attributes.bundleId}, then send again.`,
        url: `https://appstoreconnect.apple.com/apps/${other.id}`,
        blocking: true,
      }
      : {
        title: 'Create the App Store Connect record (one time)',
        detail: `Apple only lets the account holder create the record, and only on the website. In the Bundle ID list Apple shows a description, a dash, then the ID: choose the entry ending in ${game.bundleId}. If Apple says the name is taken, rename the game in Shipyard; the App ID follows the name until the first upload.`,
        url: 'https://appstoreconnect.apple.com/apps',
        fields: { Platform: 'iOS', Name: game.name, 'Primary language': languageLabel(config.language), 'Bundle ID': game.bundleId, SKU: game.slug, 'User access': 'Full access' },
        blocking: true,
      };
    steps.push(release.next.title);
    return { ok: destination === 'build-only', release, steps, message: release.next.title };
  }

  const appUrl = `https://appstoreconnect.apple.com/apps/${app.id}`;
  release.appStoreConnect = { appId: app.id, name: app.attributes?.name || '', sku: app.attributes?.sku || '', url: appUrl };
  release.next = null;
  steps.push(`Found ${app.attributes?.name || 'the app'} in App Store Connect.`);

  // Keep App Store Connect's name in step with Shipyard's.
  const loc = await appNameLocalization(api, app.id, config.language || 'en-US').catch(() => null);
  const current = loc?.attributes?.name || app.attributes?.name || '';
  if (loc && current !== game.name) {
    try {
      await api.patch(`/v1/appInfoLocalizations/${q(loc.id)}`, { data: { type: 'appInfoLocalizations', id: loc.id, attributes: { name: game.name } } });
      release.name = { appStore: game.name, synced: true, note: `Renamed in App Store Connect from “${current}”.` };
      release.appStoreConnect.name = game.name;
      steps.push(`Renamed the App Store Connect app from “${current}” to “${game.name}”.`);
    } catch (err) {
      const taken = /already|in use|being used|not available|unavailable/i.test(err.message);
      release.name = {
        appStore: current, wanted: game.name, synced: false,
        problem: taken
          ? `Apple says “${game.name}” is already used by another app. App Store Connect keeps “${current}” until you pick a different name in Shipyard.`
          : `App Store Connect kept “${current}”: ${err.message} It can be renamed while a version is being prepared.`,
      };
      steps.push(release.name.problem);
    }
  } else {
    release.name = { appStore: current || game.name, synced: true };
  }

  const testerSetup = await ensureTesterGroup(api, app.id, config);
  if (testerSetup.group) {
    steps.push(`TestFlight group ${testerSetup.group.attributes?.name}: ${testerSetup.testers.length ? testerSetup.testers.join(', ') : 'no testers yet'}.`);
  }
  steps.push(...testerSetup.problems);

  const first = await firstBuild(api, app.id);
  if (first) {
    release = lock(release, game.bundleId, first.attributes?.version, first.attributes?.uploadedDate);
    steps.push(`App ID ${game.bundleId} is locked: builds already exist in App Store Connect.`);
  }
  return { ok: true, release, steps, app, appUrl };
}

export async function testflight(api, game, buildNumber, { waitMinutes = 60, sleep = defaultSleep, pollSeconds = 60, onUpdate = () => {} } = {}) {
  let release = { ...game.release };
  const app = await findApp(api, game.bundleId);
  if (!app) throw new Error(`No App Store Connect app uses ${game.bundleId}.`);
  const appUrl = `https://appstoreconnect.apple.com/apps/${app.id}`;
  release.appStoreConnect = { ...(release.appStoreConnect || {}), appId: app.id, name: app.attributes?.name || release.appStoreConnect?.name || '', url: appUrl };
  release = lock(release, game.bundleId, buildNumber, new Date().toISOString());
  const deadline = Date.now() + waitMinutes * 60000;
  let last = '';
  for (;;) {
    const status = await reconcileTestflight(api, { appId: app.id, appUrl, buildNumber, config: game.config });
    release.testflight = { ...status, version: game.version, checkedAt: new Date().toISOString() };
    const key = `${status.state}|${status.label}|${status.testers.join(',')}`;
    if (key !== last) { last = key; await onUpdate(release); }
    if (FINAL_STATES.has(status.state) || status.state === 'needs-compliance' || (status.state === 'ready' && status.next?.blocking)) return release;
    if (Date.now() + pollSeconds * 1000 > deadline) {
      release.testflight.detail = 'Apple is taking longer than usual. Shipyard checks again every hour, or tap Check TestFlight now in the panel.';
      await onUpdate(release);
      return release;
    }
    await sleep(pollSeconds * 1000);
  }
}

export async function status(api, game) {
  const prep = await prepare(api, game, 'build-only');
  let release = prep.release;
  if (prep.app) {
    const tf = await reconcileTestflight(api, { appId: prep.app.id, appUrl: prep.appUrl, buildNumber: game.release.testflight?.build || null, config: game.config });
    if (tf.processingState || game.release.testflight) release.testflight = { ...tf, version: game.release.testflight?.version || game.version, checkedAt: new Date().toISOString() };
  }
  return release;
}

function languageLabel(code = 'en-US') {
  return { 'en-US': 'English (U.S.)', 'en-GB': 'English (U.K.)', 'es-MX': 'Spanish (Mexico)', 'fr-FR': 'French', 'de-DE': 'German' }[code] || code;
}

// ---------- Files, commits, summaries ----------

export function writeRelease(slug, release) {
  const clean = Object.fromEntries(Object.entries({ ...release, updatedAt: new Date().toISOString() }).filter(([, v]) => v !== undefined));
  if (clean.testflight) clean.testflight = Object.fromEntries(Object.entries(clean.testflight).filter(([, v]) => v !== undefined));
  fs.writeFileSync(releasePath(slug), JSON.stringify(clean, null, 2) + '\n');
}

function commitRelease(slug, message) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' }).toString();
  const file = path.relative(ROOT, releasePath(slug));
  git('add', file);
  try { git('diff', '--cached', '--quiet'); return; } catch { /* there is a change */ }
  git('-c', 'user.name=Shipyard', '-c', 'user.email=shipyard@users.noreply.github.com', 'commit', '-m', message);
  const branch = process.env.GITHUB_REF_NAME || git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  for (let attempt = 1; ; attempt++) {
    try {
      // On a clash in this file, the status just fetched from Apple wins.
      git('pull', '--rebase', '-X', 'theirs', '--autostash', 'origin', branch);
      git('push', 'origin', `HEAD:${branch}`);
      return;
    } catch (err) {
      if (attempt >= 4) { console.warn(`Couldn't push ${file}: ${err.message}`); return; }
      execFileSync('sleep', [String(attempt * 3)]);
    }
  }
}

function summarize(game, release, steps = []) {
  const lines = [`## App Store Connect: ${game.name}`, ''];
  for (const s of steps) lines.push(`- ${s}`);
  if (release.bundleIdLocked) lines.push(`- 🔒 App ID ${release.bundleId} is locked.`);
  if (release.testflight) lines.push(`- **TestFlight:** ${release.testflight.label}${release.testflight.detail ? ` — ${release.testflight.detail}` : ''}`);
  const next = release.next || release.testflight?.next;
  if (next) {
    lines.push('', `### ${next.blocking ? 'Next step' : 'Then'}: ${next.title}`, '', next.detail || '');
    if (next.fields) lines.push('', '| Field | Value |', '| --- | --- |', ...Object.entries(next.fields).map(([k, v]) => `| ${k} | \`${v}\` |`));
    if (next.url) lines.push('', next.url);
  }
  const text = lines.join('\n') + '\n';
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

function clientFromEnv() {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 } = process.env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_P8) return null;
  return appStoreClient({ keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID, p8: ASC_KEY_P8 });
}

function pendingSlugs() {
  const dir = path.join(ROOT, 'games');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .filter((slug) => {
      const r = loadRelease(slug);
      return r.testflight && !FINAL_STATES.has(r.testflight.state);
    });
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const [command, target, extra] = args.filter((a) => a !== '--commit');
  const api = clientFromEnv();
  if (!api) {
    const level = command === 'status' ? 'notice' : 'error';
    console.error(`::${level}::ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 are needed. See docs/SETUP.md, step 5.`);
    process.exit(command === 'status' ? 0 : 1);
  }
  const save = (game, release, message) => { writeRelease(game.slug, release); if (commit) commitRelease(game.slug, message); };

  if (command === 'prepare') {
    const game = loadGame(target);
    const result = await prepare(api, game, extra || 'testers');
    save(game, result.release, `App Store Connect status for ${game.slug}`);
    summarize(game, result.release, result.steps);
    if (!result.ok) { console.error(`::error::${result.message}`); process.exit(1); }
  } else if (command === 'testflight') {
    const game = loadGame(target);
    const minutes = Number(args.find((a, i) => args[i - 1] === '--wait') || process.env.TESTFLIGHT_WAIT_MINUTES || 60);
    const release = await testflight(api, game, extra, {
      waitMinutes: minutes,
      onUpdate: (r) => save(game, r, `TestFlight status for ${game.slug}: ${r.testflight?.state || 'uploaded'}`),
    });
    summarize(game, release);
    if (release.testflight?.state === 'failed') process.exit(1);
  } else if (command === 'status') {
    const slugs = target === '--pending' || !target ? pendingSlugs() : [target];
    if (!slugs.length) console.log('No game is waiting on TestFlight.');
    for (const slug of slugs) {
      const game = loadGame(slug);
      try {
        const release = await status(api, game);
        save(game, release, `TestFlight status for ${slug}`);
        summarize(game, release);
      } catch (err) {
        console.error(`::warning::${slug}: ${err.message}`);
      }
    }
  } else {
    console.error('Use: prepare <slug> [destination] | testflight <slug> <build> | status <slug|--pending>  [--commit]');
    process.exit(1);
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
