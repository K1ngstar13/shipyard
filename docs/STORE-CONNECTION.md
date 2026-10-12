# Install this fix

This package is Shipyard 2.3.1. The connected GitHub integration allowed reading the failed run but refused branch creation (403), so no repository change or PR was created automatically.

Close the old Shipyard Terminal window/server. Keep a backup of your current folder. To update locally, use the new package’s code and Start Shipyard.command. Preserve your existing games folders and shipyard.config.json if you have newer local changes.

To update GitHub too, open your shipyard repository in GitHub Desktop, copy the new code into that checkout (including the hidden .github folder; Finder Cmd+Shift+Period shows hidden files), review the changes, commit and Push origin. Keep the repository's own .git folder. The new workflow checks only apply after this push. New captured game PNGs are saved through Shipyard when you click Save, as before.

# Getting Block Pals into TestFlight

The failed run 38180709792 completed its preview-assets job. Both store jobs stopped at their secret checks before native compilation, signing or uploading. It was not a TestFlight app-launch failure.

Missing in that run:

| Store | Missing repository secrets |
| --- | --- |
| Apple | ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, MATCH_PASSWORD |
| Google | ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, PLAY_JSON_KEY |

SHIPYARD_TOKEN was present in the Apple job. Presence alone does not confirm the token's permissions.

1. Open https://github.com/K1ngstar13/shipyard/actions/workflows/setup.yml and run **One-time setup** on main. Keep **replace Android key** unchecked. It creates missing MATCH_PASSWORD and Android upload-key secrets; it does not create Apple/Google API credentials. It requires SHIPYARD_TOKEN with repository Secrets read/write permission. Keep the generated signing credentials backed up securely.
2. Once Apple membership and App Store Connect access are active, open **Users and Access → Integrations → App Store Connect API**. The Account Holder requests API access if prompted. Create a team key with permissions for this pipeline's app management and certificate/profile creation (an Admin key on your own team supports those signing operations). Download its .p8 file once.
3. Open https://github.com/K1ngstar13/shipyard/settings/secrets/actions. Add ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8. The last value is the entire .p8 file with BEGIN/END lines. Keep private keys in GitHub secrets, never in source files or screenshots.
4. Confirm Publisher contains the real Apple Team ID and the private shipyard-certs repository URL, and that SHIPYARD_TOKEN can read/write that repository. Register `elevatr.llc.blockpals` in Apple Developer Identifiers and create its matching App Store Connect app record if you have not already done so. Preserve the existing bundle ID.
5. Start Shipyard 2.3.1 with **Start Shipyard.command**. Choose **App Store only → Send to my phone**. Google keys are not required for an iOS-only run. Wait for the new GitHub run to succeed and for Apple to process the build. Add it to your TestFlight group and install from TestFlight.
6. For Android, create a Google Cloud service account, enable Google Play Android Developer API, grant that account the appropriate Play Console Users and permissions access, and add its JSON as PLAY_JSON_KEY. Complete the first app/bundle and signing setup in Play Console as described in SETUP.md.

The new workflow reports missing secret names in its first check and run summary. It cannot fabricate store credentials or guarantee the credentials are valid merely because their names exist.

# Your selected screenshots

After upgrading, open the game editor, upload the game file if the preview is not loaded, and record the screens again. Older versions kept tap routes and placeholder thumbnails, not the actual image pixels; the screenshot of your desktop cannot recover the full-resolution frames from that session.

New recordings have visible PNG thumbnails. Review shows those same images in the same order. Saving writes them to both `store/screenshots/apple` and `store/screenshots/google`, which the store build uses instead of replayed taps. Removing an image removes it from the new selection; saving a smaller selection deletes older surplus images. Failed captures are not added as placeholders.

Use at least two useful screenshots for Google Play. Inspect the generated store asset files before submission, especially for fonts and rendering that differ on native devices.

# Warnings addressed

- Updated sharp 0.35.4 to the patched 0.35.5; npm audit reports zero vulnerabilities for this lockfile.
- Updated upload/download artifact actions to current Node 24 versions.
- Existing transparent source icons are flattened without changing their artwork, and that prepared icon is passed to both native build jobs.
- SVG/XML namespace URLs are excluded from the insecure HTTP-link warning. Actual insecure resource links still warn.
- External Google Fonts and the $0.99 price reminder remain relevant. Check offline rendering and set paid-app price in each store console.

# Verification

Browser tests use the actual Block Pals HTML from this repository. They check two real captured PNGs including its gameplay canvas, 1290 × 2796 size, review ordering/removal, isolation from the publishing token, screenshot file upload bodies, deletion of surplus files, and the actual store-assets outputs matching recorded image pixels. Separate tests cover store-secret requirements for previews, iOS and Android build-only.

The seven-step wizard navigation is covered; it previously skipped the listing/privacy/price steps. Static syntax and site build checks also pass. Apple/Google native builds and uploads remain unverified until the missing credentials are supplied. No store submission was made as part of these fixes.
