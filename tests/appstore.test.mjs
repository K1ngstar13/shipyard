import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { appStoreClient, prepare, testflight, describeTestflight, AppStoreError } from '../scripts/appstore.mjs';
import { checkAppStoreName } from '../scripts/name-check.mjs';
import '../site/naming.js';

const N = globalThis.ShipyardNaming;
const p8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const config = { companyName: 'Elevatr LLC', bundlePrefix: 'elevatr.llc', language: 'en-US', review: { email: 'king@elevatr.llc' }, testflight: { group: 'Elevatr Internal Testing', testers: [] } };

/** A small in-memory App Store Connect. */
function fakeAppStore({ apps = [], builds = [], groups = [], users = ['king@elevatr.llc'], takenNames = [] } = {}) {
  const db = { bundleIds: [], apps, builds, groups, testers: [], groupBuilds: [], groupTesters: [], locs: {}, calls: [] };
  for (const app of apps) db.locs[app.id] = { id: `loc-${app.id}`, attributes: { locale: 'en-US', name: app.attributes.name } };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetchImpl = async (url, init) => {
    const u = new URL(url), p = u.pathname, f = (k) => u.searchParams.get(`filter[${k}]`), m = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    db.calls.push(`${m} ${p}`);
    assert.match(init.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    if (m === 'GET' && p === '/v1/bundleIds') return json(200, { data: db.bundleIds.filter((b) => b.attributes.identifier.includes(f('identifier'))) });
    if (m === 'PATCH' && p.startsWith('/v1/bundleIds/')) { const b = db.bundleIds.find((x) => x.id === p.split('/').pop()); b.attributes.name = body.data.attributes.name; return json(200, { data: b }); }
    if (m === 'POST' && p === '/v1/bundleIds') { const b = { id: `b${db.bundleIds.length}`, attributes: body.data.attributes }; db.bundleIds.push(b); return json(201, { data: b }); }
    if (m === 'GET' && p === '/v1/apps') return json(200, { data: db.apps.filter((a) => (!f('bundleId') || a.attributes.bundleId === f('bundleId')) && (!f('name') || a.attributes.name === f('name'))) });
    let r;
    if (m === 'GET' && (r = p.match(/^\/v1\/apps\/(\w+)\/appInfos$/))) return json(200, { data: [{ id: `info-${r[1]}`, attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] });
    if (m === 'GET' && (r = p.match(/^\/v1\/appInfos\/info-(\w+)\/appInfoLocalizations$/))) return json(200, { data: [db.locs[r[1]]] });
    if (m === 'PATCH' && (r = p.match(/^\/v1\/appInfoLocalizations\/loc-(\w+)$/))) {
      if (takenNames.includes(body.data.attributes.name)) return json(409, { errors: [{ detail: 'The app name you entered is already being used.' }] });
      db.locs[r[1]].attributes.name = body.data.attributes.name; return json(200, { data: db.locs[r[1]] });
    }
    if (m === 'GET' && p === '/v1/builds') {
      let list = db.builds.filter((b) => b.app === f('app') && (!f('version') || b.attributes.version === f('version')));
      list = [...list].sort((a, b) => a.attributes.uploadedDate.localeCompare(b.attributes.uploadedDate));
      if (u.searchParams.get('sort') === '-uploadedDate') list.reverse();
      return json(200, { data: list.slice(0, Number(u.searchParams.get('limit') || 50)) });
    }
    if (m === 'GET' && (r = p.match(/^\/v1\/builds\/(\w+)\/buildBetaDetail$/))) return json(200, { data: { attributes: { internalBuildState: db.builds.find((b) => b.id === r[1]).beta } } });
    if (m === 'PATCH' && (r = p.match(/^\/v1\/builds\/(\w+)$/))) { const b = db.builds.find((x) => x.id === r[1]); b.attributes.usesNonExemptEncryption = false; b.beta = 'READY_FOR_BETA_TESTING'; return json(200, { data: b }); }
    if (m === 'GET' && p === '/v1/betaGroups') return json(200, { data: db.groups.filter((g) => g.app === f('app')) });
    if (m === 'POST' && p === '/v1/betaGroups') { const g = { id: `g${db.groups.length}`, app: body.data.relationships.app.data.id, attributes: body.data.attributes }; db.groups.push(g); return json(201, { data: g }); }
    if (m === 'POST' && (r = p.match(/^\/v1\/betaGroups\/(\w+)\/relationships\/builds$/))) { db.groupBuilds.push([r[1], body.data[0].id]); return json(204); }
    if (m === 'GET' && (r = p.match(/^\/v1\/betaGroups\/(\w+)\/betaTesters$/))) return json(200, { data: db.groupTesters.filter(([g]) => g === r[1]).map(([, t]) => db.testers.find((x) => x.id === t)) });
    if (m === 'GET' && p === '/v1/users') return json(200, { data: users.map((e, i) => ({ id: `u${i}`, attributes: { username: e } })) });
    if (m === 'GET' && p === '/v1/betaTesters') return json(200, { data: db.testers.filter((t) => t.attributes.email === f('email')) });
    if (m === 'POST' && p === '/v1/betaTesters') {
      if (!users.includes(body.data.attributes.email)) return json(409, { errors: [{ detail: 'Internal testers must be App Store Connect users.' }] });
      const t = { id: `t${db.testers.length}`, attributes: { email: body.data.attributes.email } }; db.testers.push(t);
      db.groupTesters.push([body.data.relationships.betaGroups.data[0].id, t.id]); return json(201, { data: t });
    }
    return json(404, { errors: [{ detail: `No fake for ${m} ${p}` }] });
  };
  return { db, api: appStoreClient({ keyId: 'KEY1234567', issuerId: 'issuer', p8, fetchImpl, sleep: async () => {} }) };
}

const game = (overrides = {}) => ({ slug: 'quackdoku', name: 'QuackDoku', bundleId: 'elevatr.llc.quackdoku', version: '1.0.0', config, release: {}, ...overrides });
const app = (id, name, bundleId) => ({ id, attributes: { name, bundleId, sku: 'quackdoku' } });

test('names: bundle ID, home-screen name, and conflicts follow one set of rules', () => {
  assert.equal(N.bundleIdFor('elevatr.llc', 'Block Pets'), 'elevatr.llc.blockpets');
  assert.equal(N.bundleIdFor('elevatr.llc', '2048 Ducks!'), 'elevatr.llc.g2048ducks');
  assert.equal(N.defaultDisplayName('QuackDoku'), 'QuackDoku');
  assert.equal(N.defaultDisplayName('QuackDoku: Duck Sudoku Puzzles'), 'QuackDoku');
  assert.equal(N.defaultDisplayName('An Extremely Long Name'), 'An Extremely Long Name');
  assert(N.displayNameMatches('QuackDoku', 'QuackDoku: Duck Sudoku'));
  assert(!N.displayNameMatches('Ducks', 'QuackDoku'));
  const results = [
    { trackName: 'Block Pals', sellerName: 'Other Studio', bundleId: 'com.other.blockpals', trackViewUrl: 'https://apps.apple.com/app/id1' },
    { trackName: 'Block Pals Deluxe', sellerName: 'Someone', bundleId: 'com.someone.bpd' },
    { trackName: 'QuackDoku', sellerName: 'Elevatr LLC', bundleId: 'elevatr.llc.quackdoku' },
  ];
  const taken = N.findConflicts('block pals!', results, { companyName: 'Elevatr LLC', bundlePrefix: 'elevatr.llc' });
  assert.deepEqual(taken.exact.map((x) => x.seller), ['Other Studio']);
  assert.deepEqual(taken.similar.map((x) => x.name), ['Block Pals Deluxe']);
  assert.deepEqual(N.findConflicts('QuackDoku', results, { companyName: 'Elevatr LLC' }).exact, [], 'our own live app is never a conflict');
  const ideas = N.nameSuggestions('Block Pals', { category: 'Board', companyName: 'Elevatr LLC' });
  assert(ideas.includes('Block Pals by Elevatr') && ideas.every((i) => i.length <= 30 && i !== 'Block Pals'));
});

test('name check searches the App Store and reports when it cannot', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/itunes\.apple\.com\/search\?term=Block%20Pals&entity=software/);
    return new Response(JSON.stringify({ results: [{ trackName: 'Block Pals', sellerName: 'Other Studio' }] }));
  };
  const result = await checkAppStoreName('Block Pals', { config, fetchImpl });
  assert(result.checked && result.exact.length === 1);
  const offline = await checkAppStoreName('Block Pals', { config, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([offline.checked, offline.error], [false, 'offline']);
});

test('first ship of a new game registers its bundle ID and asks for the app record with exact values', async () => {
  const { db, api } = fakeAppStore();
  const result = await prepare(api, game(), 'testers');
  assert.equal(result.ok, false);
  assert.equal(db.bundleIds[0].attributes.identifier, 'elevatr.llc.quackdoku');
  assert.equal(db.bundleIds[0].attributes.platform, 'IOS');
  assert.equal(result.release.next.title, 'Create the App Store Connect record (one time)');
  assert.deepEqual(result.release.next.fields, { Platform: 'iOS', Name: 'QuackDoku', 'Primary language': 'English (U.S.)', 'Bundle ID': 'elevatr.llc.quackdoku', SKU: 'quackdoku', 'User access': 'Full access' });
  assert(!result.release.bundleIdLocked, 'nothing is locked before an upload');
  assert.equal((await prepare(api, game(), 'build-only')).ok, true, 'build-only still builds without the record');
});

test('an app record made with another bundle ID is pointed out instead of a second record', async () => {
  const { api } = fakeAppStore({ apps: [app('77', 'QuackDoku', 'elevatr.llc.quackdokugame')] });
  const result = await prepare(api, game(), 'testers');
  assert.equal(result.ok, false);
  assert.match(result.release.next.detail, /Set the App ID in Shipyard \(step 6\) to elevatr\.llc\.quackdokugame/);
});

test('renaming syncs the App Store Connect name; an existing build locks the bundle ID; a taken name is reported', async () => {
  const builds = [{ id: 'B1', app: '6821781861', attributes: { version: '101', processingState: 'VALID', uploadedDate: '2026-10-12T04:20:36Z' }, beta: 'READY_FOR_BETA_TESTING' }];
  const { db, api } = fakeAppStore({ apps: [app('6821781861', 'Block Pals', 'elevatr.llc.blockpals')], builds, takenNames: ['Block Party'] });
  const pets = game({ slug: 'block-pals', name: 'Block Pets', bundleId: 'elevatr.llc.blockpals' });
  const result = await prepare(api, pets, 'testers');
  assert.equal(result.ok, true);
  assert.equal(db.locs['6821781861'].attributes.name, 'Block Pets');
  assert.equal(result.release.name.note, 'Renamed in App Store Connect from “Block Pals”.');
  assert.equal(result.release.bundleIdLocked, true);
  assert.match(result.release.lock.reason, /^Build 101 was uploaded to App Store Connect with elevatr\.llc\.blockpals on 2026-10-12\./);

  const taken = await prepare(api, { ...pets, name: 'Block Party', release: result.release }, 'testers');
  assert.equal(taken.ok, true, 'a taken name does not stop a tester build');
  assert.equal(taken.release.name.synced, false);
  assert.match(taken.release.name.problem, /“Block Party” is already used by another app/);

  const moved = await prepare(api, { ...pets, bundleId: 'elevatr.llc.blockpets', release: result.release }, 'testers');
  assert.equal(moved.ok, false, 'a locked bundle ID cannot be changed');
  assert.match(moved.release.next.title, /Put the App ID back to elevatr\.llc\.blockpals/);
});

test('TestFlight: waits for processing, answers compliance, creates the group, adds build and testers', async () => {
  const builds = [];
  const { db, api } = fakeAppStore({ apps: [app('A1', 'QuackDoku', 'elevatr.llc.quackdoku')], builds });
  const updates = [];
  let polls = 0;
  const sleep = async () => {
    polls++;
    if (polls === 1) builds.push({ id: 'B9', app: 'A1', attributes: { version: '111', processingState: 'PROCESSING', uploadedDate: '2026-10-13T00:00:00Z' }, beta: 'PROCESSING' });
    if (polls === 2) Object.assign(builds[0], { attributes: { ...builds[0].attributes, processingState: 'VALID' }, beta: 'MISSING_EXPORT_COMPLIANCE' });
  };
  const release = await testflight(api, game(), '111', { sleep, pollSeconds: 1, waitMinutes: 5, onUpdate: (r) => updates.push(r.testflight.state) });
  assert.deepEqual(updates, ['uploaded', 'processing', 'available']);
  assert.equal(release.bundleIdLocked, true, 'the first upload locks the bundle ID');
  assert.equal(builds[0].attributes.usesNonExemptEncryption, false);
  assert.deepEqual(db.groups.map((g) => [g.attributes.name, g.attributes.isInternalGroup]), [['Elevatr Internal Testing', true]]);
  assert.deepEqual(db.groupBuilds, [['g0', 'B9']]);
  assert.deepEqual(release.testflight.testers, ['king@elevatr.llc']);
  assert.equal(release.testflight.label, 'On TestFlight: build 111 for 1 tester');
  assert.equal(release.testflight.next.blocking, false);
});

test('TestFlight reuses the existing internal group and says exactly what is missing', async () => {
  const builds = [{ id: 'B2', app: 'A1', attributes: { version: '121', processingState: 'VALID', uploadedDate: '2026-10-13T00:00:00Z' }, beta: 'READY_FOR_BETA_TESTING' }];
  const groups = [{ id: 'gx', app: 'A1', attributes: { name: 'Elevatr Internal Testing', isInternalGroup: true, hasAccessToAllBuilds: false } }];
  const { db, api } = fakeAppStore({ apps: [app('A1', 'QuackDoku', 'elevatr.llc.quackdoku')], builds, groups, users: [] });
  const release = await testflight(api, game({ config: { ...config, testflight: { testers: ['friend@example.com'] } } }), '121', { sleep: async () => {} });
  assert.equal(db.groups.length, 1);
  assert.deepEqual(db.groupBuilds, [['gx', 'B2']]);
  assert.equal(release.testflight.state, 'ready');
  assert.equal(release.testflight.next.title, 'Add yourself to Elevatr Internal Testing');
  assert.match(release.testflight.detail, /friend@example\.com: Internal testers must be App Store Connect users/);
});

test('status wording covers every Apple state', () => {
  const b = (processingState, extra = {}) => ({ attributes: { version: '5', processingState, ...extra } });
  assert.equal(describeTestflight({ buildNumber: '5' }).state, 'uploaded');
  assert.equal(describeTestflight({ build: b('PROCESSING') }).state, 'processing');
  assert.equal(describeTestflight({ build: b('FAILED'), appUrl: 'https://x/apps/1' }).next.url, 'https://x/apps/1/testflight/ios');
  assert.equal(describeTestflight({ build: b('VALID', { expired: true }) }).state, 'expired');
  assert.equal(describeTestflight({ build: b('VALID'), betaState: 'MISSING_EXPORT_COMPLIANCE' }).state, 'needs-compliance');
  assert.equal(describeTestflight({ build: b('VALID'), betaState: 'READY_FOR_BETA_TESTING', inGroup: false, group: 'G' }).next.title, 'Add build 5 to G');
  assert.equal(new AppStoreError(409, [{ detail: 'Taken.' }]).message, 'Taken.');
});

test('API token is an ES256 JWT that verifies against the key, as App Store Connect requires', async () => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let auth = '';
  const api = appStoreClient({ keyId: 'KEY1234567', issuerId: 'iss-uuid', p8: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'),
    fetchImpl: async (url, init) => { auth = init.headers.Authorization; return new Response('{"data":[]}'); } });
  await api.get('/v1/apps');
  const [h, p, sig] = auth.slice(7).split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url')), payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.equal(payload.iss, 'iss-uuid'); assert.equal(payload.aud, 'appstoreconnect-v1');
  assert(payload.exp - payload.iat <= 1200, 'Apple refuses tokens that live longer than 20 minutes');
  assert(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('bundle ID description is just the game name, and old "Shipyard …" descriptions are tidied', async () => {
  const { db, api } = fakeAppStore();
  await prepare(api, game(), 'testers');
  assert.equal(db.bundleIds[0].attributes.name, 'QuackDoku');
  db.bundleIds[0].attributes.name = 'Shipyard QuackDoku';
  const again = await prepare(api, game(), 'testers');
  assert.equal(db.bundleIds[0].attributes.name, 'QuackDoku');
  assert(again.steps.includes('Renamed its description to “QuackDoku”.'));
  assert.match(again.release.next.detail, /choose the entry ending in elevatr\.llc\.quackdoku/);
});

test('as soon as the app record exists, Elevatr Internal Testing is ready with you in it, before any build', async () => {
  const { db, api } = fakeAppStore({ apps: [app('A7', 'QuackDoku', 'elevatr.llc.quackdoku')], users: ['kingr13@hotmail.com'] });
  const me = { ...config, testflight: { group: 'Elevatr Internal Testing', testers: ['kingr13@hotmail.com'] } };
  const result = await prepare(api, game({ config: me }), 'testers');
  assert.equal(result.ok, true);
  assert.deepEqual(db.groups.map((g) => [g.app, g.attributes.name, g.attributes.isInternalGroup]), [['A7', 'Elevatr Internal Testing', true]]);
  assert(result.steps.includes('TestFlight group Elevatr Internal Testing: kingr13@hotmail.com.'));
  await prepare(api, game({ config: me }), 'testers');
  assert.equal(db.groups.length, 1, 'running again reuses the group');
  assert.equal(db.groupTesters.length, 1, 'and never adds you twice');
});
