import fs from 'node:fs';
export function missingStoreSecrets(platforms, destination, env = process.env) {
  if (destination === 'previews') return [];
  const missing = [];
  if (platforms !== 'android') for (const name of ['ASC_KEY_ID','ASC_ISSUER_ID','ASC_KEY_P8','MATCH_PASSWORD','SHIPYARD_TOKEN']) if (!env[name]?.trim()) missing.push(name);
  if (platforms !== 'ios') {
    for (const name of ['ANDROID_KEYSTORE_BASE64','ANDROID_KEYSTORE_PASSWORD']) if (!env[name]?.trim()) missing.push(name);
    if (destination !== 'build-only' && !env.PLAY_JSON_KEY?.trim()) missing.push('PLAY_JSON_KEY');
  }
  return missing;
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const platforms = process.argv[2] || process.env.PLATFORMS || 'both';
  const destination = process.argv[3] || process.env.DESTINATION || 'testers';
  const missing = missingStoreSecrets(platforms, destination);
  if (missing.length) {
    const message = `Store connection is incomplete. Missing repository secrets: ${missing.join(', ')}. No native build or upload started.`;
    console.error(`::error::${message}`);
    const help = `## Store setup required\n\n${message}\n\n1. Run **One-time setup** (leave Android key replacement off) to create missing MATCH_PASSWORD and Android upload-key secrets.\n2. Add Apple’s team API key as ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8.\n3. Add the Google Play service-account JSON as PLAY_JSON_KEY.\n4. Select **App Store only** when testing iOS before Google is ready.\n\nSee docs/STORE-CONNECTION.md. Secret values are never printed.\n`;
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, help);
    process.exitCode = 1;
  } else console.log(destination === 'previews' ? 'Preview-only run: store keys are not required.' : 'Required store secret names are present. Credentials are validated by the store during upload.');
}
