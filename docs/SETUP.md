# Setup

Do this once. After it, adding a game takes a few minutes and shipping takes one tap.

Times are rough. Apple's account approval and Google's identity verification both involve waiting on them, so start those first and do the rest while you wait.

---

## 1. Developer accounts (start today, they take days)

**Apple — $99/year.** Enroll at [developer.apple.com/programs](https://developer.apple.com/programs/). Use the Apple Developer app on your iPhone if you have one; enrollment there is faster. Approval usually takes 1–3 days.

Enroll as an **individual** unless you have a registered LLC with a D-U-N-S number. Individual is faster, and your games will be listed under your personal name.

**Google — $25 once.** Sign up at [play.google.com/console/signup](https://play.google.com/console/signup). Google verifies your identity with a government ID and, for personal accounts, an address check. This takes anywhere from a day to two weeks.

**Important choice here.** Google's "12 testers for 14 days" rule applies only to *personal* accounts created after November 13, 2023. Those accounts must run a closed test with at least 12 testers, opted in continuously for at least 14 days, before they can apply for production access. Organization accounts registered to a legal business entity are exempt.

If you already have an LLC, register as an organization and skip the rule entirely. If you don't, register as an individual and plan on the 14-day test — it's a one-time gate on your first app, not on every game.

---

## 2. Your repo

1. Create a new GitHub repo named `shipyard`. **Public** is strongly recommended: GitHub Actions is free for public repos, and macOS build minutes on a private repo cost 10× normal.
2. Upload this project's files to it.
3. Create a second, **private** repo named `shipyard-certs`. It will hold your Apple certificates, encrypted. Never make this one public.
4. Leave `shipyard.config.json` alone for now — you fill it from the panel's **Publisher** sheet in step 7, which also rewrites your privacy and support pages. The preflight check refuses to submit anything to a store while placeholders remain.

---

## 3. GitHub token

Shipyard's panel and its setup workflow both talk to GitHub with one token.

1. Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Name: `shipyard`. Expiration: 1 year.
3. Repository access: **Only select repositories** → pick both `shipyard` and `shipyard-certs`.
4. Permissions → Repository permissions:
   - Contents: **Read and write**
   - Actions: **Read and write**
   - Secrets: **Read and write**
   - Metadata: Read-only (added automatically)
5. Generate, and copy the token. You can't see it again.
6. In your `shipyard` repo: **Settings → Secrets and variables → Actions → New repository secret**. Name it `SHIPYARD_TOKEN`, paste the token.
7. Keep the token handy — you'll paste it into the panel later too.

---

## 4. Run the setup workflow

In your repo: **Actions → One-time setup → Run workflow**.

It creates and stores two things you never have to see:

- `MATCH_PASSWORD` — the passphrase that encrypts your Apple certificates.
- `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD` — your Android upload key.

**Your Android upload key is irreplaceable-ish.** If you lose it, you can ask Google to reset it, but it's a support ticket and a wait. Download the run's `android-upload-certificate` artifact and keep it somewhere safe. Also: after your first app is live, don't run this workflow again with "replace Android key" turned on unless Google has told you to.

---

## 5. Apple keys

### App Store Connect API key

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. **Team Keys → +**. Name: `Shipyard`. Access: **Admin** (lets Shipyard add your whole team as TestFlight testers) or **App Manager** (then list your Apple ID under `testflight.testers`).
3. Download the `.p8` file. It downloads exactly once.
4. Add three repository secrets in GitHub:
   - `ASC_KEY_ID` — the Key ID column (10 characters).
   - `ASC_ISSUER_ID` — the Issuer ID at the top of that page (a long UUID).
   - `ASC_KEY_P8` — the entire contents of the `.p8` file, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.

### Team ID

Find it at [developer.apple.com/account](https://developer.apple.com/account) under Membership details. Put it in `shipyard.config.json` as `appleTeamId`, and set `matchGitUrl` to your `shipyard-certs` repo URL.

You don't create certificates or provisioning profiles yourself. The first iOS build creates them, encrypts them into `shipyard-certs`, and reuses them forever after.

---

## 6. Google Play key

1. [Play Console → Setup → API access](https://play.google.com/console/developers/api-access).
2. Link a Google Cloud project when prompted (create one if you don't have one).
3. **Create new service account** → follow the link to Google Cloud → **Create service account** → name it `shipyard` → Done.
4. On the service account, **Keys → Add key → Create new key → JSON**. It downloads a JSON file.
5. Back in Play Console, on the API access page, **Grant access** to that service account with these permissions: *Release apps to testing tracks*, *Manage production releases*, *Manage store presence*, *View app information*.
6. Add a repository secret `PLAY_JSON_KEY` with the whole contents of that JSON file.

Google's permission changes take a few minutes to take effect. If the first Android upload fails with a permissions error, wait ten minutes and run it again.

---

## 7. Put the panel online

The panel is a static page. Cloudflare Pages is free and takes two minutes:

1. [Cloudflare Pages](https://pages.cloudflare.com) → **Create a project → Connect to Git** → your `shipyard` repo.
2. Build command: leave empty. Build output directory: `site`.
3. Deploy. You'll get a URL like `shipyard-xyz.pages.dev`.
4. Open the URL on your phone and **Add to Home Screen**. It behaves like an app from then on.
5. Connect it to your repo, then open the **Publisher** sheet (person icon) and fill in your company name, app ID prefix, this site's URL, contact email, review contact, and Apple Team ID. That writes `shipyard.config.json` and your privacy and support pages, which live at `/privacy.html` and `/support.html`. Both stores require working links to those.

Your GitHub token is stored only in that phone's browser storage. It is never sent anywhere except GitHub. If you lose the phone, revoke the token on GitHub and the panel is inert.

---

## 8. First game, first release

Add a game in the panel, then:

### Android, first time only

1. Ship it with destination **Build only**. Download the `android-build` artifact from the run.
2. [Play Console → Create app](https://play.google.com/console). Name it, pick **Game** and **Free**, accept the declarations.
3. **Test and release → Testing → Internal testing → Create new release**. Upload the `.aab` by hand. This registers your upload key with Google.
4. Work through the **Dashboard** setup tasks. The ones with real questions:
   - **Content rating** — a questionnaire. For a normal casual game, answer no to everything about violence, sex, drugs, gambling, and user interaction.
   - **Data safety** — "Does your app collect or share any required user data types?" For a self-contained game with no analytics: **No**.
   - **Ads** — No.
   - **Target audience** — if you pick an age range that includes under-13s, you take on extra Families policy requirements. Choosing 13+ is simpler unless you genuinely want the kids' audience.
   - **Privacy policy** — your Pages URL.
5. After that, Shipyard handles every future upload for this game.

### Price, if the game is paid

Free games skip this entirely. For a paid one, finish **Agreements, Tax, and Banking** in App Store Connect and the **Payments profile** in Play Console first, then set the price on each app's pricing page. Neither store exposes an API for it, so Shipyard records your choice and reminds you rather than pretending to do it.

### iOS, first time only

1. Choose **Send to my phone**. Shipyard registers the bundle ID with Apple, then stops in seconds and shows **Create the App Store Connect record** in the game sheet, with each value and a Copy button.
2. [App Store Connect → Apps → + → New App](https://appstoreconnect.apple.com/apps). Paste those values in. If Apple says the name is taken, rename the game in Shipyard (the App ID follows) and send again.
3. Send to my phone again. Shipyard builds, uploads, waits for Apple, adds the build to your internal TestFlight group, and adds you as a tester. Details: [STORE-CONNECTION.md](STORE-CONNECTION.md).

### The 12-tester rule, if it applies to you

Ship to **Closed test**. In Play Console, create a closed testing track, add 12 email addresses, and share the opt-in link. The 12 must be distinct Google accounts that joined through your opt-in link and installed on a real device; emulators and duplicate accounts don't count. They must stay opted in for 14 continuous days — if a tester drops out mid-cycle their time stops counting, and falling below 12 breaks the window.

Recruit 14 or 15 so a couple dropping out doesn't reset you. Friends, family, coworkers. Ask them to actually open the game a few times; Google added engagement checks in 2026 and rejects applications where testers never really played.

After 14 days, apply for production access on the Play Console dashboard. Google says that review usually takes seven days or less. Once granted, it applies to your whole account — later games skip straight to production.

---

## Every secret, in one list

| Secret | From | Used for |
| --- | --- | --- |
| `SHIPYARD_TOKEN` | GitHub fine-grained token | Panel and setup workflow |
| `MATCH_PASSWORD` | Setup workflow | Encrypting Apple certificates |
| `ANDROID_KEYSTORE_BASE64` | Setup workflow | Signing Android builds |
| `ANDROID_KEYSTORE_PASSWORD` | Setup workflow | Signing Android builds |
| `ASC_KEY_ID` | App Store Connect | Apple uploads |
| `ASC_ISSUER_ID` | App Store Connect | Apple uploads |
| `ASC_KEY_P8` | App Store Connect | Apple uploads |
| `PLAY_JSON_KEY` | Google Cloud service account | Google Play uploads |

---

## When something breaks

**"Missing repository secrets"** — the workflow names exactly which ones. Add them and run again.

**iOS: "Create the App Store Connect record"** — create the app record with the values shown in the game sheet (step 8). One-time, per game.

**TestFlight says "Add yourself to …"** — internal testers must be users on your App Store Connect team. Put your Apple ID in `shipyard.config.json` → `testflight.testers`, or use an Admin API key so Shipyard can add the whole team.

**"The App ID is locked"** — a build was already uploaded with the old ID, and Apple never lets it change. Put the ID back; renaming the game is still fine.

**Android: "draft app" or "Only releases with status draft may be created"** — the app is still a draft in Play Console. Finish the setup tasks and roll out the first release by hand. Shipyard saves the release as a draft in the meantime.

**Android: permission denied on upload** — the service account's Play Console permissions haven't propagated, or the grant in step 6 was missed. Wait ten minutes, then check the grant.

**iOS build fails in signing** — usually `appleTeamId` in `shipyard.config.json` doesn't match the team the API key belongs to, or `matchGitUrl` points at a repo the token can't reach.

**Apple's toolchain requirement** — since April 28, 2026, App Store Connect only accepts builds made with Xcode 26 or later and the iOS 26 SDK. The workflow uses GitHub's `macos-26` runner, which ships Xcode 26, so this is handled. When Apple moves the baseline again next spring, bump `runs-on` in `.github/workflows/ship.yml`.

**Google's target API requirement** — since August 31, 2026, new apps and updates must target Android 16 (API level 36) or higher. `prepare-app.mjs` forces `targetSdkVersion` to at least 36. Raise `MIN_ANDROID_TARGET_SDK` in that file when Google moves it again.
