// Shared naming rules for the panel (loaded as a script) and the build scripts
// (imported from Node). One source for how a game's App Store name, home-screen
// name, and bundle ID relate, and for how App Store name conflicts are judged.
(function (root) {
  'use strict';

  const HOME_SCREEN_FIT = 12; // roughly what an iPhone home screen shows before "…"
  const NAME_LIMIT = 30;

  const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

  /** Lowercase letters and digits only, accents removed: "Block Pals!" and "block-pals" compare equal. */
  const normalizeName = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');

  /** The bundle ID Shipyard generates from a game's name, e.g. elevatr.llc + "Block Pets" → elevatr.llc.blockpets. */
  function bundleIdFor(prefix, name) {
    const tail = slugify(name).replace(/-/g, '');
    if (!tail) return '';
    return `${prefix || 'com.yourname'}.${tail}`.replace(/\.(\d)/g, '.g$1');
  }

  /** Home-screen name: the full name when it fits, else the part before a colon or dash. */
  function defaultDisplayName(name) {
    const full = String(name || '').trim();
    if ([...full].length <= HOME_SCREEN_FIT) return full;
    const head = full.split(/\s*[:–—|]\s*|\s+-\s+/)[0].trim();
    return head && [...head].length <= HOME_SCREEN_FIT ? head : full;
  }

  /** True when the home-screen name plainly comes from the App Store name, as Apple's reviewers expect. */
  function displayNameMatches(displayName, name) {
    const d = normalizeName(displayName), n = normalizeName(name);
    return Boolean(d) && n.includes(d);
  }

  function itunesSearchUrl(term, country = 'us') {
    return `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&country=${encodeURIComponent(country)}&limit=50`;
  }

  /**
   * Splits App Store search results into apps that already use this exact name
   * (Apple won't let a second app take it) and apps with a similar name. Apps
   * from this publisher, by seller name or bundle prefix, never count against it.
   */
  function findConflicts(name, results, { companyName = '', bundlePrefix = '', ownBundleIds = [] } = {}) {
    const wanted = normalizeName(name);
    const company = normalizeName(companyName);
    const own = new Set(ownBundleIds.filter(Boolean));
    const ours = (r) => (company && [r.sellerName, r.artistName].some((s) => normalizeName(s) === company))
      || own.has(r.bundleId) || (bundlePrefix && String(r.bundleId || '').startsWith(bundlePrefix + '.'));
    const exact = [], similar = [];
    if (!wanted) return { exact, similar };
    for (const r of results || []) {
      const theirs = normalizeName(r.trackName);
      if (!theirs || ours(r)) continue;
      const item = { name: r.trackName, seller: r.sellerName || r.artistName || 'another developer', url: r.trackViewUrl || '', bundleId: r.bundleId || '' };
      if (theirs === wanted) exact.push(item);
      else if (theirs.startsWith(wanted) || wanted.startsWith(theirs)) similar.push(item);
    }
    return { exact, similar: similar.slice(0, 5) };
  }

  /** Alternatives to offer when a name is taken. Each still needs its own check. */
  function nameSuggestions(name, { category = '', companyName = '' } = {}) {
    const base = String(name || '').trim();
    if (!base) return [];
    const word = String(category || '').trim() || 'Game';
    const brand = String(companyName || '').trim().split(/\s+/)[0] || '';
    const ideas = [
      `${base}: ${word} Game`.replace(/ Game Game$/, ' Game'),
      `${base} ${word}`,
      brand ? `${base} by ${brand}` : '',
      `${base} Puzzle Fun`,
      `${base} Go`,
    ];
    const seen = new Set([normalizeName(base)]);
    return ideas.filter((idea) => {
      const key = normalizeName(idea);
      if (!idea || [...idea].length > NAME_LIMIT || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  root.ShipyardNaming = {
    HOME_SCREEN_FIT, NAME_LIMIT, slugify, normalizeName, bundleIdFor, defaultDisplayName,
    displayNameMatches, itunesSearchUrl, findConflicts, nameSuggestions,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
