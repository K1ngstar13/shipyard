# Start here

The exact order, start to first approval. Steps 1 and 2 need nothing but this folder. Everything after needs accounts.

---

## 1. Run Shipyard

Double-click **Start Shipyard.command** (Windows: **Start Shipyard.bat**).

It installs what's missing the first time, builds, starts the server, and opens your browser. Leave the window open while you work; close it to stop.

Two things macOS may do the first time:

- **"cannot be opened because it is from an unidentified developer"** — right-click the file, choose **Open**, then **Open** again. Once only.
- **Opens in a text editor instead of running** — the executable bit was lost in the download. Open Terminal once and run `chmod +x "/path/to/shipyard/Start Shipyard.command"`, or drag the file into Terminal after typing `chmod +x ` and a space.

If Node.js isn't installed, the window tells you and links to nodejs.org. Install the LTS build, double-click again.

Where things live once it's running:

| | |
| --- | --- |
| Control panel | `http://localhost:4173/panel.html` |
| Your app icons | `http://localhost:4173/launcher.html` |

## 2. Try the flow with no accounts

In the panel, choose **Try the upload flow without connecting**. Upload a game, watch it get read and drafted, edit the listing, reach the review screen. The last button stops and says nothing was saved — that's the demo, not a failure. Publisher details you enter during the demo save to that browser so the app IDs look right.

This is the step for finding out whether a game zips cleanly. Nothing here costs anything.

---

## 3. Accounts (start these now; they involve waiting)

**Apple Developer Program, $99/year.** [developer.apple.com/programs](https://developer.apple.com/programs/). Enroll as an individual unless you have an LLC with a D-U-N-S number. Approval takes 1–3 days.

**Google Play Console, $25 once.** [play.google.com/console/signup](https://play.google.com/console/signup). Identity verification takes a day to two weeks.

One decision that matters: a personal Play account created after November 13, 2023 must run a closed test with 12 testers for 14 straight days before it can publish anything. Organization accounts registered to a business entity are exempt. If Elevatr LLC is registered, sign up as an organization and the rule never applies to you.

## 4. GitHub

1. New repo named `shipyard`. **Public** — Actions is free on public repos, and macOS build minutes cost 10× on private ones.
2. Upload this project's files to it.
3. Second repo, **private**, named `shipyard-certs`. Leave it empty. Your Apple certificates get stored there encrypted.
4. **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.** Name `shipyard`, expiration 1 year, repository access **Only select repositories** → both repos. Permissions: Contents **Read and write**, Actions **Read and write**, Secrets **Read and write**.
5. Copy the token. In `shipyard` → **Settings → Secrets and variables → Actions → New repository secret** → name `SHIPYARD_TOKEN`, paste.

## 5. Signing keys

In the repo: **Actions → One-time setup → Run workflow.**

It creates `MATCH_PASSWORD` and your Android upload key as secrets. Download the run's `android-upload-certificate` artifact and keep it somewhere safe.

## 6. Apple keys

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. **Team Keys → +**, name `Shipyard`, access **App Manager**. Download the `.p8`. It downloads once.
3. Add three repository secrets:
   - `ASC_KEY_ID` — the Key ID, 10 characters
   - `ASC_ISSUER_ID` — the Issuer ID at the top of that page
   - `ASC_KEY_P8` — the whole `.p8` file contents, including the BEGIN and END lines
4. Note your Team ID from [developer.apple.com/account](https://developer.apple.com/account) → Membership details. You'll paste it into the panel in step 8.

## 7. Google key

1. [Play Console → Setup → API access](https://play.google.com/console/developers/api-access), link a Google Cloud project.
2. **Create new service account** → in Google Cloud, create one named `shipyard` → **Keys → Add key → Create new key → JSON**.
3. Back in Play Console, **Grant access** to that service account: *Release apps to testing tracks*, *Manage production releases*, *Manage store presence*, *View app information*.
4. Repository secret `PLAY_JSON_KEY` = the whole JSON file.

## 8. Put the launcher and panel online

Two Cloudflare Pages projects, both pointed at this repo:

| Project | Build command | Output directory |
| --- | --- | --- |
| Apps | `npm ci && node scripts/build-site.mjs apps` | `site-dist` |
| Panel | `npm ci && node scripts/build-site.mjs panel` | `site-dist` |

Separate projects on purpose: your games then never share a web origin with the browser storage holding your GitHub token.

Open the **panel** URL on your phone, Add to Home Screen, connect it to your repo, then open **Publisher** (person icon) and fill in: company name, app ID prefix (`llc.elevatr`), the **apps** project URL as your website, contact email, review contact name and phone, and the Apple Team ID from step 6. Saving writes your config and rewrites your privacy and support pages.

## 9. First game

Upload it in the panel, then:

**Previews.** Ship with **Build previews only**. Two minutes, no store accounts needed. It captures screenshots from the real game, makes an app icon from your game's title screen if you didn't supply one, and commits both back so you can look at them in the panel. Redo this until the screenshots show real gameplay — adjust the screenshot taps in the panel if they're landing on the wrong button.

**Google Play, once per game.**
1. Ship with **Just make the files**, download the `android-build` artifact.
2. [Play Console → Create app](https://play.google.com/console), name it, Game, Free.
3. **Testing → Internal testing → Create new release**, upload the `.aab` by hand. This registers your upload key.
4. Work through the Dashboard setup tasks: content rating questionnaire, data safety (no data collected, for a self-contained game), ads (no), target audience, privacy policy URL (your apps site `/privacy.html`).

**App Store, once per game.**
1. [App Store Connect → Apps → + → New App](https://appstoreconnect.apple.com/apps). Bundle ID: the one matching your app ID — if it isn't in the list, ship **Just make the files** once first, which registers it. SKU: the folder name.
2. In the app, fill App Privacy, Age Rating, and Pricing. These are questionnaires; no API can answer them for you.

**Then.** Ship **Send to my phone** and play it through TestFlight. When it's right, ship **Submit for approval**. Every update after that is: bump version, ship, done.

**If the 12-tester rule applies**, ship **Closed test**, add 12 real testers in Play Console, keep them opted in 14 straight days with actual play sessions, then apply for production access from the Dashboard.

---

## Where things live

| Thing | Path |
| --- | --- |
| Your games | `games/<slug>/` |
| Generated icon and previews | `games/<slug>/store/previews/`, `games/<slug>/icon.png` |
| Publisher details | `shipyard.config.json`, edited from the panel |
| Build pipeline | `.github/workflows/ship.yml` |
| Rejection playbook | `docs/APPROVAL.md` |
| Testing levels and the launcher | `docs/TESTING.md` |
