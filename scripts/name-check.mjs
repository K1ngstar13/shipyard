// Is this App Store name already used by someone else's app?
//
// Usage: node scripts/name-check.mjs "<name>"   (or import checkAppStoreName)
//
// Searches Apple's public iTunes Search API, the same catalog shoppers see. It finds
// live apps, so a name another developer has reserved but not released can still be
// refused when the App Store Connect record is created; Shipyard reports that too.
import { naming, loadConfig } from './lib.mjs';

export async function checkAppStoreName(name, { config = {}, ownBundleIds = [], fetchImpl = fetch, timeoutMs = 8000, country = 'us' } = {}) {
  try {
    const res = await fetchImpl(naming.itunesSearchUrl(name, country), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`App Store search answered ${res.status}`);
    const { results = [] } = await res.json();
    const found = naming.findConflicts(name, results, { companyName: config.companyName, bundlePrefix: config.bundlePrefix, ownBundleIds });
    return { checked: true, ...found };
  } catch (err) {
    return { checked: false, exact: [], similar: [], error: err.message };
  }
}

export function describeConflict(name, exact) {
  const first = exact[0];
  return `"${name}" is already the name of ${first.seller}'s app on the App Store${first.url ? ` (${first.url})` : ''}. ` +
    'Apple gives each name to one app only, so App Store Connect will refuse it. Rename the game in Shipyard before its first upload; ' +
    'the App ID is generated from the name and follows it until then.';
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const name = process.argv.slice(2).join(' ').trim();
  if (!name) { console.error('Pass a name, for example: node scripts/name-check.mjs "Block Pets"'); process.exit(1); }
  const result = await checkAppStoreName(name, { config: loadConfig() });
  if (!result.checked) { console.log(`Couldn't check: ${result.error}`); process.exit(2); }
  if (result.exact.length) { console.log(describeConflict(name, result.exact)); process.exit(1); }
  console.log(`No App Store app is named "${name}".`);
  for (const s of result.similar) console.log(`  similar: ${s.name} (${s.seller})`);
}
