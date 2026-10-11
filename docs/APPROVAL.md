# Getting approved

Most rejections come from a short list of mistakes, and almost all of them are avoidable before you submit. `scripts/preflight.mjs` checks for the mechanical ones automatically. This page covers the judgment calls it can't make for you.

## The one that rejects the most HTML games

**Apple guideline 4.2, "minimum functionality."** Apple rejects apps that are a website in a wrapper, or that are too thin to justify being an app. Wrapped web games get extra scrutiny because so many of them are exactly that.

What keeps you on the right side of it:

- **Everything ships inside the app.** No loading the game from a URL, no iframe pointing at your site, no CDN script tags. Preflight fails the build on the first two and warns on the third. Reviewers test in airplane mode.
- **It must work with no internet at all.** Turn off wifi and cellular on your phone, open the TestFlight build, play a full session. If anything breaks, fix it before submitting.
- **It has to feel like an app.** Native splash screen and icon (Shipyard does both), no browser chrome, no pinch-zoom or text-selection (the bridge handles those), no visible scrollbars, and it should respond to a tap immediately.
- **Enough substance to be worth a download.** A single screen with one button is a rejection. Levels, progression, unlockables, save state — any of that clears the bar. Your games already have this; just make sure the reviewer can *see* it within about a minute of opening.

## Screenshots

**Apple guideline 2.3.3:** screenshots must show the app in use. A title screen and a logo is the single most common metadata rejection.

Shipyard captures from the real game on a virtual phone, following the `screenshots` steps in `game.json`:

```json
"screenshots": [
  { "wait": 2500 },
  { "tap": [0.5, 0.62], "wait": 2000 },
  { "tap": [0.5, 0.5], "wait": 1500 },
  { "tap": [0.5, 0.5], "wait": 1500 }
]
```

`tap` is `[x, y]` as fractions of the screen, so `[0.5, 0.62]` is centre-horizontally, 62% down. Each step waits, taps if told to, then takes a shot. Identical shots are dropped automatically, which is how you find out your taps missed the button.

Write steps that reach real gameplay: past the title screen, into a level, with a score or progress visible. Download the `store-assets` artifact from the run and actually look at them before you submit.

If the taps can't get where you need, hand-made screenshots in `games/<slug>/store/screenshots/apple/` and `.../google/` are used instead. Apple wants 1290×2796 (or 2796×1290 landscape); Google wants at least two, at least 1080px on the long edge.

## Store text

- **Never name another game.** "Like Tetris but with ducks" in your description or keywords is a trademark rejection from both stores. Preflight blocks a list of the common ones, but the list isn't exhaustive — describe your game on its own terms.
- **Never mention the other store.** Apple's guideline 2.3.10 rejects listings that say "Android" or "Google Play." Preflight blocks these.
- **No ranking claims.** "#1 puzzle game," "best duck game" — Google's metadata policy rejects claims it can't verify.
- **Keywords are comma-separated with no spaces**, 100 bytes total, and shouldn't repeat words already in your app name — Apple indexes the name separately, so repeating wastes the budget.

## Age rating and data

For a self-contained game with no ads, no analytics, no accounts, and no user-to-user features, the honest answers are all the easy ones: no data collected, no ads, no third-party content. Answer truthfully — a wrong data-safety declaration is a policy strike on Google and a rejection on Apple.

The moment you add analytics, ads, or a leaderboard, both declarations change and your privacy policy needs updating. `site/privacy.html` is written for the no-collection case; rewrite it if that changes.

## In-app purchases

If you ever want to sell anything — hats for the duck, coin packs, remove-ads — it must go through Apple's In-App Purchase and Google Play Billing. Linking to PayPal, Ko-fi, Patreon, or your own checkout is an instant Apple rejection under 3.1.1, and preflight fails the build if it finds those links.

Shipyard doesn't set up IAP. That's a real piece of work per game: products configured in both consoles, a billing plugin, receipt handling. Ship free games first.

## Review notes

`game.json` can carry `reviewNotes`, sent to Apple with every submission. The default says there's no login, everything works offline, and nothing is collected — which is what reviewers most often want to know. If your game has anything non-obvious (a level select that needs unlocking, a gesture that isn't discoverable), spell it out there. A reviewer who can't figure out your game rejects it.

## Timing

Apple's review is usually under 24 hours now, sometimes a few hours. Google's first review of a new app can take up to seven days; later updates are usually much faster. Neither gets faster by resubmitting, and repeatedly resubmitting the same rejected build hurts.

## If you're rejected

You get a message in App Store Connect's Resolution Center or an email from Google. Both name the guideline. Fix the actual problem, bump the version in the panel, and ship again — Shipyard uploads a new build against the same app record.

If you think the rejection is wrong, Apple's Resolution Center lets you reply and make the case. That is often faster than changing your game. Be specific and unemotional, and point to exactly where in the app the reviewer can see the thing they missed.
