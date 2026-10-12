Read [STORE-CONNECTION.md](docs/STORE-CONNECTION.md) for the failed TestFlight run, missing keys, and recording screenshots after upgrading.

# Shipyard

Upload a game from your phone. Shipyard reads it, drafts the whole store listing, plays it back to you in a phone frame, captures screenshots of real gameplay, and sends it to TestFlight, Google Play, or straight into store review.

One repo holds every game, each in its own folder. You never make a second one.

## The honest answer about "fully automatic"

Everything after a game's first release is automatic. The first release of each game needs a few manual steps, because Apple and Google deliberately don't allow them to be automated:

| Step | Automatic? |
| --- | --- |
| Wrapping a game into a native app | Yes |
| Signing, versioning, building | Yes |
| Screenshots, icons, feature graphic | Yes |
| Store text in both stores' formats | Yes |
| Upload to TestFlight / Google Play | Yes |
| Submitting for review | Yes |
| Drafting the listing from the game itself | Yes |
| Making the app icon from the game's title screen | Yes |
| Creating the app record in App Store Connect | No, once per game (~3 min) |
| First Google Play upload and content ratings | No, once per game (~15 min) |
| Developer accounts and signing keys | No, once ever (~1 hour) |
| Setting the price of a paid app | No, once per app, in each console |
| Google's 12-testers-for-14-days rule | No, once per account |

There is no way around those. Apple's API has no endpoint for creating an app record, and Google requires a human-signed content rating questionnaire. Every service that claims full automation is doing these same steps by hand somewhere.

What Shipyard removes is everything you'd otherwise repeat for every game and every update: Xcode, Android Studio, certificates, provisioning profiles, keystores, screenshot sessions, metadata typing, and the upload dance.

## How it fits together

```
Your phone (the Shipyard panel)
        │  saves the game into your repo
        ▼
GitHub repo ──► GitHub Actions ──► preflight  ──► native build ──► store upload
  games/            (free for       (catches         (Capacitor)     (fastlane)
  scripts/           public repos)   rejections)
```

Nothing runs on your computer. The panel is a web page you can add to your home screen; the build machines are GitHub's.

## Repo layout

```
shipyard.config.json          Your name, team IDs, review contact
site/                         The control panel + privacy and support pages
  index.html                  The app you use
  privacy.html                Required by both stores
  support.html                Required by both stores
  site-config.js              Your company name and contact email
games/
  sample-duck/                One folder per game
    game.json                 Name, app ID, version, orientation, screenshot taps
    icon.png                  1024×1024
    www/index.html            The game itself
    store/                    description.txt, keywords.txt, subtitle.txt, …
      screenshots/            Optional hand-made screenshots
      previews/               Generated screenshots and banner, shown in the panel
scripts/
  preflight.mjs               Rejection linter
  prepare-app.mjs             HTML → native iOS/Android project
  store-assets.mjs            Screenshots, graphics, metadata
native/shipyard-bridge.js     Makes a web game behave like a native app
fastlane/Fastfile             Build, sign, upload, submit
.github/workflows/
  setup.yml                   One-time: creates your signing secrets
  ship.yml                    The button
scripts/build-site.mjs        Builds site-dist: launcher, playable games, manifests, apps.json
scripts/serve.mjs             Local server for testing
site/launcher.html            Your app icons, one tap each
site/play.html                One app full screen, installable to the home screen
Start Shipyard.command        Double-click to run everything locally (macOS)
Start Shipyard.bat            The same, on Windows
docs/
  START-HERE.md               The exact order, start to first approval
  SETUP.md                    Accounts, keys, secrets in more detail
  TESTING.md                  How to test without accounts, and the launcher
  APPROVAL.md                 Why games get rejected and how to avoid it
marketing/                    Store copy templates and a launch checklist
```

## Start here

Double-click **Start Shipyard.command** (Windows: **Start Shipyard.bat**). It installs what's missing, builds, starts the server, and opens the panel. No terminal.

Then pick **Try the upload flow without connecting** and run a game through the whole wizard with no accounts and no repo.

`docs/START-HERE.md` is the exact order for everything after that, including Apple and Google.

## Getting started

1. Work through `docs/START-HERE.md` once. Budget about an hour, plus $99/year for Apple and $25 once for Google.
2. Open the panel, connect it to your repo.
3. Add a game, ship it to **Testers**, and install it on your phone.
4. When it plays well, ship it to **Store review**.

## The upload flow

Tap **Upload a game** and the panel walks four steps:

1. **The game.** Drop a zip or a single `.html` file. Shipyard unpacks it, works out what kind of game it is, finds an icon inside if there is one, and flags anything that would get it rejected before a build ever runs.
2. **The listing.** Your game plays in a phone frame on the same screen while you check the drafted name, subtitle, description, keywords, category, orientation, and background colour. Every field is editable, with live character counts against each store's limit. The app icon is designed here too: Shipyard finds the logos, marks, and emblems in the running game, samples your palette from them, and lays out finished icons you pick from and adjust before anything ships.
3. **Price and release.** Free or paid, app ID, version, which stores.
4. **Check and send.** A summary, your previews if they exist, and one button.

The drafting is read from your game's own content — title, headings, button labels, instructions, colours, and the words in your code. It gets you a sensible listing in seconds; it is not a replacement for a pass of your own writing. `marketing/LISTING-TEMPLATES.md` is there for that.

## The five destinations

- **Build previews only** — captures screenshots and the store banner and commits them back, so you can look before committing to anything. Two minutes.
- **Send to my phone** — TestFlight and Google Play internal testing. Fastest loop; use this constantly.
- **Closed test** — the track that satisfies Google's 12-tester rule.
- **Submit for approval** — sends build, listing, and previews to both stores.
- **Just make the files** — produces the `.ipa` and `.aab` without uploading. Needed for a game's very first Google Play upload.

## Launcher and app icons

The site build turns every game into a playable, installable web app alongside its store release. `/launcher.html` shows one icon per app, `/play.html?g=<slug>` opens one full screen, and each carries its own manifest so **Add to Home Screen** gives it a real icon and a full-screen launch. `/apps.json` is the machine-readable index Elevatr Launchpad can read to render launch buttons.

## Publisher details

The person icon at the top holds your company name, app ID prefix, website, contact email, Apple Team ID, and the review contact Apple requires. Set it once and every game picks it up. Saving it also rewrites your privacy and support pages.

## Price

Both stores require price to be set by hand, once per app, in their own console, after your tax and banking forms are complete. Neither offers an API for it. Shipyard records what you chose and reminds you where to go. Free games skip all of it, which is why your first few should be free.

## What the bridge adds to your games

Every packaged game gets `shipyard-bridge.js` injected automatically:

- Audio suspends when the app is backgrounded and resumes when it returns. Sound that keeps playing after you switch apps is a common rejection.
- The Android back button minimizes the app instead of killing it. A game can handle it instead with `window.shipyardBack = () => true`.
- Pinch-zoom, text selection, long-press menus, and pull-to-refresh bounce are off.
- Your game can listen for `shipyard:pause` and `shipyard:resume` on `window`.

## Cost

- Apple Developer Program: $99/year.
- Google Play Console: $25, one time.
- GitHub Actions: free for public repos. On a private repo, macOS minutes bill at 10× — roughly $0.60–$1.20 per iOS build. Making the repo public is the cheap path, and your games' source is already shipped to players anyway.
