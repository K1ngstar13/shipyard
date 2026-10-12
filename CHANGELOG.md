# 2.3.2 — editable drafts, current artwork, and reliable restarting

- Clickable editing steps and Edit buttons in review; Edit listing opens at Listing.
- Save local drafts with staged files, icons, screenshots, privacy, and pricing.
- Save edits to GitHub without starting a build or a store upload.
- Detect the current HTML title on replacement; preserve manual edits during slow loads.
- Review banners use current values, and source replacements clear old artwork.
- Load existing full-resolution screenshots for removal and reordering; accept uploaded PNGs.
- Start Shipyard.command stops verified older Shipyard processes and closes their separate Terminal windows.
- Open the browser only after the current version is listening; use a free port when another project owns 4173.
- Include the renamed Block Pets source while preserving elevatr.llc.blockpals.
- Release packaging requires the launchers and checks the displayed version.

# 2.3.1 — recorded screenshots and store setup fixes

- Capture actual PNGs in an isolated preview and use them in review and both store uploads.
- Preserve gameplay/canvas imagery instead of relying on click replay; failed capture no longer creates a placeholder.
- Remove surplus screenshots when a smaller selection is saved and prevent stale preview responses from replacing current images.
- Fix all seven wizard steps advancing in order.
- Check missing store secrets before preparing assets, with explicit setup steps in the workflow summary.
- Patch sharp, update artifact actions, flatten source icons and transfer the prepared icon to native build jobs.
- Refresh dependencies when launching an upgraded version. Start Shipyard.command remains included.

# Shipyard versions

The version is in `VERSION`, in `package.json`, and in the top-left of the control panel.
When a zip and your repo disagree, the higher number is newer.

## How to update

Replace everything **except** `games/` and `shipyard.config.json`. Those two are yours:
your games, their listings, icons, previews, and your publisher details. Everything else
is replaceable code.

---

## 2.3.0 — 11 Oct 2026

- **Privacy pages can publish to your own website's repo.** Set Website repo in the
  Publisher sheet and each build writes `apps/<slug>/privacy.html` into it, plus an index
  of every app, so the live URL is on your domain. Skips the write when nothing changed.
- Each game's default privacy URL is now its own page rather than the company-wide policy,
  which is what the stores compare against your questionnaire answers.

## 2.2.0 — 11 Oct 2026

- **Per-app privacy.** Step 5 of the wizard asks what each app does with data, after
  reading the game's own code and ticking what it finds — analytics, ads, crash reporting,
  sign-in, location, camera, contacts, messaging, purchases, server calls.
- Every build writes that app's own privacy page, publishes it at
  `/apps/<slug>/privacy.html`, and generates `privacy-answers.md` with the exact wording
  for Apple's App Privacy and Google's Data safety questionnaires.
- Preflight blocks a submission when the answers contradict the code. Undeclared analytics
  or location stops the build instead of reaching a reviewer.
- `app-privacy-links.html` is generated each build: a paste-in block linking every app's
  page, for the company policy page on your own site.

## 2.1.0 — 11 Oct 2026

- The upload wizard is six steps instead of four: the game, the app icon, screenshots,
  the store listing, price and release, then check and send.
- **Screen recorder.** Play the game in the preview and press "Use this screen as a
  screenshot". Your taps are recorded as a route, and the build replays it in a real
  browser to take full-resolution shots. No more guessing tap coordinates.
- The preview stays on screen across the icon and screenshot steps instead of being
  stuck to one of them.
- `Start Shipyard` now shuts down any Shipyard already running before it starts.
- Every release carries a version: `VERSION`, `package.json`, the panel header, and the
  zip filename.

## 2.0.0 — 11 Oct 2026

- Preview runs the game at a real 390 × 844 phone viewport and scales it down, so games
  no longer reflow into a cramped 258px screen and lose their title art.
- Colours reported by games as `rgb()` are converted before reaching the canvas. This was
  producing a "could not be parsed as a color" error and blocking the screen crop.
- Icon designer: finds logos, marks, emblems, and emoji in the running game, samples the
  palette from that artwork, and offers finished icons in three styles with size and
  position controls.
- Connecting a repo now exits demo mode, so Save writes to GitHub instead of the browser.
- Publisher details survive an accidental close, and the backdrop only closes a sheet when
  the press and release both land on it.
- No more broken-image placeholders before an icon exists.

## 1.0.0 — 10 Oct 2026

- First version: upload a zip or HTML file, drafted store listing, Capacitor packaging,
  fastlane upload to TestFlight and Google Play, preflight rejection checks, app launcher
  with per-app home-screen icons, and the double-click launcher.
