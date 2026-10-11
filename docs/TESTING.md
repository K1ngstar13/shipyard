# Testing Shipyard

You never need a second repo. One `shipyard` repo holds every game, and the same repo is what you test against. There are three levels, and you can stop at any of them.

## Level 1 — the whole flow, on your computer, no GitHub

Double-click **Start Shipyard.command** (Windows: **Start Shipyard.bat**). If you'd rather use a terminal: `npm install && npm run preview`.

Then open:

- `http://localhost:4173/panel.html` — the control panel
- `http://localhost:4173/launcher.html` — your app icons
- `http://localhost:4173/apps.json` — the machine-readable index

In the panel, choose **Try the upload flow without connecting**. You can drop in a zip, watch it get read and drafted, play the game in the phone frame, edit the listing, set price and stores, and reach the final review screen. The last button stops and tells you nothing was saved. Everything before it behaves exactly as it will for real.

This is the fastest way to see whether a given game zips up cleanly. It costs nothing and touches no accounts.

## Level 2 — a real build, GitHub only, no Apple or Google

Connect the panel to your repo, upload a game, and choose **Build previews only**.

That runs the preflight checks, packages nothing, captures screenshots and the store banner from the real game on a virtual phone, and commits them back so they show up in the panel. It needs no Apple Developer account, no Play Console, no signing keys — just the repo and the token. About two minutes.

It also makes the app icon. If you didn't supply one, the build opens your game on a virtual phone, looks for a logo, and crops an icon from the title screen — then commits it back with the previews so you can look at it in the panel. Upload your own PNG in step 1 any time you want to override it.

Use the included `games/sample-duck` for a dry run if you want to see it work before trusting it with a real game.

## Making the app icon

Step 2 of the upload wizard has an **App icon** block under the phone preview. Press **Design an icon from this game** and Shipyard looks through whatever the game is currently showing:

- Every logo, mark, emblem, icon image, inline SVG, and canvas on screen, ranked by position and size. An app that already has its own mark on the title screen — Tap-In's flag-and-green, for instance — gets found and used directly at full resolution.
- Emoji and single-glyph emblems in the layout.
- A square crop of the whole screen.
- A plain initials tile.
- Your colour palette, sampled from the pixels of that artwork rather than guessed.

You get a row of finished icons to choose from, each shown as a store tile and a round home-screen icon.

### Tweaking

| Control | What it does |
| --- | --- |
| Ideas row | Switches which piece of artwork the icon is built from |
| Style | **Playful** adds a centre glow and a drop shadow with the mark large. **Professional** is a restrained vertical gradient with more margin. **Flat** is a solid colour. |
| Background | Swatches pulled from your own artwork, plus the game's background colour, white, and near-black |
| Size of the mark | How much of the tile the artwork fills |
| Move up and down | Optical centring, since a mark rarely looks centred when it's mathematically centred |
| Look again at this screen | Rescans — so play the preview to a better screen, then press it |

Everything redraws instantly on a canvas, so you can sit and fiddle. Nothing is uploaded until you save.

If the game has no usable artwork on screen, you still get the screen crop and the initials tile, and uploading your own PNG on step 1 overrides all of it. Skip the block entirely and the build crops one for you.

### What this is and isn't

This is a designer, not an image generator. It composes icons out of your game's real artwork and real colours — no model is inventing a logo. That means the result always matches the game, and it's instant and free. If you ever want genuinely drawn-from-scratch icon art, that needs a paid image model and an API key, which is a different piece of plumbing.

## When the in-panel preview is black

The preview frame is deliberately locked down: no storage, no cookies, no service workers. A game that touches those on load can die there while being completely fine as a real app. The panel now reports the error instead of showing a black rectangle, and offers **Open the game in a new tab** — that runs without the sandbox, so if it works there, your game is fine.

Either way the preview is only a convenience. **Build previews only** runs the game in a real browser with none of those limits, which is where your actual screenshots come from.

## Level 3 — an installable build

**Just make the files** produces a real signed `.aab` and `.ipa` you can download from the run. Android needs the one-time setup workflow to have made your upload key; iOS needs the Apple secrets.

**Send to my phone** goes to TestFlight and Play internal testing. This is the loop you'll live in once setup is done.

---

# App icons and one-click launching

Every game gets a launch URL and a real icon, generated by the site build:

| What | Where |
| --- | --- |
| Launcher with all your app icons | `/launcher.html` |
| One app, full screen | `/play.html?g=<slug>` |
| The game's files directly | `/apps/<slug>/index.html` |
| Index of everything | `/apps.json` |
| Per-app install manifest | `/apps/<slug>/app.webmanifest` |

Open a game from the launcher on your phone and use **Add to Home Screen**. Because each app carries its own manifest, you get that game's icon, its name, and a full-screen launch with no browser bar — the same as a store install, without the store.

Adding a game in the panel is all it takes. The next site build picks it up and it appears on the launcher.

## Elevatr Launchpad integration

`apps.json` is the contract. Fetch it and you have everything needed to render a launch button per product:

```json
{
  "publisher": "Elevatr LLC",
  "generated": "2026-10-10T23:34:23.757Z",
  "apps": [
    {
      "slug": "quackie-pond",
      "name": "Quackie Pond",
      "version": "1.0.0",
      "tagline": "Cozy idle duck pond",
      "launch": "/play.html?g=quackie-pond",
      "direct": "/apps/quackie-pond/index.html",
      "manifest": "/apps/quackie-pond/app.webmanifest",
      "icon": "/apps/quackie-pond/icon-512.png",
      "previews": ["/apps/quackie-pond/previews/apple-01.jpg"],
      "backgroundColor": "#8FD3F4",
      "orientation": "portrait",
      "price": "Free",
      "bundleId": "llc.elevatr.quackiepond"
    }
  ]
}
```

In Launchpad: `fetch('https://your-apps-site/apps.json')`, render a tile per app with `icon` and `name`, and point the button at `launch`. The icons and previews are already the right sizes for a grid. Paths are site-absolute, so prefix them with your apps domain.

Launchpad doesn't need to handle zips itself. Upload the zip in Shipyard, and the app shows up in `apps.json` for Launchpad to link and promote.

## Deploying

Two Cloudflare Pages projects, both from this repo, no build output committed:

| Project | Build command | Output | Holds |
| --- | --- | --- | --- |
| Apps | `npm ci && node scripts/build-site.mjs apps` | `site-dist` | Launcher, every playable game, privacy, support |
| Panel | `npm ci && node scripts/build-site.mjs panel` | `site-dist` | The control panel |

Keep them separate. Your games then never share a web origin with the browser storage holding your GitHub token, so a bug in a game can't reach it.

Put the **apps** project's URL in Publisher as your website — that's where the stores' required privacy and support links point. Every push rebuilds both, so a game added from your phone appears on the launcher a minute later.
