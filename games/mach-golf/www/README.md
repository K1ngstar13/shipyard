# Mach Golf

The app includes the Gauge identity package: a branded launch splash, the Mach Golf wordmark in the app header, and matching install icons.

A 6-week swing speed training app. Overspeed protocols, a gym library, a 3:1 tempo
trainer and speed tracking — one HTML file, no backend, no account, no subscription.

## What's in it

| Screen | What it does |
|---|---|
| Today | Shows the day's work from the 6-week block, marks sessions complete, shows your best speed and gain |
| Speed | The full 6-week calendar. Every week, every day, every set of every protocol |
| Gym | 27 exercises across force, rotation, core, upper, mobility and plyo, with cues, reasoning and no-equipment substitutions |
| Tempo | Three-beat metronome (takeaway / top / impact) with an adjustable ratio and swing clock |
| Progress | Speed log, chart, PR, gain over baseline, estimated carry |
| Speed test | 4-step garage wizard: rig, clip, calibrate, measure. Averages 5-10 swings |
| Checklist | Per-week session list with the model's mph value on each line, and a journal |

Guided session player steps through each set with the implement, rep target, cue and an
automatic rest timer with audio cues. Everything works offline once loaded.

## Measuring speed in your garage

Three things you already own: your driver, a tape measure, and your phone. No radar, no
launch monitor, no ball needed — dry swings measure cleanly because there is no impact
deceleration to average across.

    mph = (inches travelled per frame x capture fps) x 0.0568182

### The calibration principle

Calibration happens **in the same frame as the swing**, every session.

**Camera distance cancels exactly.** Move the phone closer and pixels-per-inch of
the tape and pixels of clubhead travel scale by the identical factor. Verified: a
phone at 36, 60 or 120 inches returns 100.000000 mph on the same swing.

**Camera angle does not cancel.** An earlier version of this README claimed it did.
That claim was wrong, and the test backing it was circular — it simulated a uniform
`cos θ` shrink, which is the conclusion it set out to prove. Under real perspective
projection a yawed camera tilts the tape out of the sensor plane, so pixels-per-inch
varies *along* the tape. A single average scale cannot represent a varying one, and a
clubhead measured away from the tape's centre gets scaled by the wrong number.

Measured on a true pinhole render at 20 degrees of yaw, ground truth 100.00 mph:

| low point | 2-point scale | 3-point correction |
|---|---|---|
| centred on the tape | 95.44 mph (−4.6%) | 100.04 mph (+0.04%) |
| 10 in off centre | 88.05 mph (−12.0%) | 100.04 mph (+0.04%) |

**The fix is a third calibration mark.** Three known collinear points determine the
1-D projective map `t = (a·x + b)/(c·x + 1)` that a pinhole camera actually applies,
which recovers true inches anywhere on the line. Tap 0 in, 36 in, then the halfway
mark. Against the pinhole simulator this is exact — better than 1e-5 % at every yaw
angle from 0 to 40 degrees and every offset tested.

The same third mark doubles as a squareness meter: if the camera is square, the
middle mark projects to the midpoint of the two ends. The app reports the deviation
as a skew percentage and says plainly whether the correction is doing any work.
Skipping the third mark falls back to the old two-point scale, labelled as such.

**Out of plane is still the one thing to get right.** A tape 8 inches nearer the
lens than the clubhead reads 13.3% slow, and no calibration can detect it from one
view. The tape goes on the floor directly under the bottom of the swing.

### The rig

Step 1 of the speed test is a five-card photo walkthrough — one photo, one instruction,
Next. Swipe or tap the dots to move between them. The final card is the record button.

1. Tape measure on the floor along the target line, running under the bottom of your swing. Extend to 36 in and lock it.
2. Phone on the floor 5–6 ft back, facing you, roughly square to the tape. Main 1x lens.
3. Frame so the whole tape is visible — it is the ruler, and a cut-off end means no calibration.
4. Slow motion at 240 fps. 120 works. 60 does not; the clubhead crosses the frame between exposures.
5. Record 5–10 full-effort dry swings in one clip.

The photos live in `img/` as WebP sources and are also embedded in `index.html` as data
URIs in the `SETUP_IMG` object, so the app remains a single file and the walkthrough works
offline and on first load. To swap a photo: replace the WebP in `img/`, re-encode it to
base64, and update the matching key in `SETUP_IMG`.

### Why two frames apart

At 240 fps a 100 mph clubhead moves 7.3 in per frame, and marking error is about ±2%.
Spanning two frames halves it.

**The frame gap is counted by the app, not typed by the user.** It used to be a number
in a text field, and typing 2 after stepping 3 reports a speed 50% high — the largest
error the app could produce, from a single slip. Each mark now records the frame it was
placed on and the gap is derived. Manual override is still there behind a toggle.

**Arc versus chord is corrected.** Two marks measure the straight chord; the clubhead
travels an arc, so the chord is always short — 0.21% over 2 frames on a 65 in radius,
0.85% over 4. The app converts chord back to arc with `2R·asin(chord/2R)`.

### Guards built in

- Ruler shorter than ~400 px triggers a warning: below that, tap error starts to dominate.
- Detected frame rates snap to rates a camera would actually shoot at, because container timestamps quantise and a 240 fps file otherwise measures as 250 and silently costs 4%. A rate that snaps to nothing is reported as unreadable rather than trusted.
- Frame-interval estimation uses the low quartile, not the median. A dropped frame yields a delta that is a *multiple* of the true interval, so with 60% of frames dropped the median reads 120 on a 240 fps file — halving every speed silently. The quartile still reads 240.
- File frame rate (used to step frames) and capture rate (used for the maths) are kept as two separate visible numbers. A Photos-app slo-mo export can be a 30 fps file with the time stretched 8x; stepping that as 30 fps would read eight times too low.
- Results outside 30–160 mph are flagged rather than saved quietly.
- A span wider than 4 frames is flagged: the clubhead decelerates after the low point, so a long window reads below peak.
- Dry swings store **no ball speed**. There is no ball, so a "ball speed" would be clubhead speed times an assumed smash factor, and the displayed smash factor would be exactly that assumption. The app stores what it measured and nothing else.
- Spread across the swing set is reported as a setup-quality verdict. Under 3% CV is tight; over 6% means the tape moved or you are not clicking the same part of the blur each time.

## The six steps

The home screen is a numbered path, not a dashboard, until the block begins:

1. **Build or get the equipment** — full screen, three colour-coded sticks, DIY instructions, one tap to confirm
2. **Set up the measuring camera** — the five-card photo walkthrough; marked done when a calibration succeeds
3. **Get a baseline** — the speed test, 5–10 swings, averaged
4. **Start the training** — begins the 6-week block; the daily view takes over from here
5. **Remeasure** — weeks 2, 4 and 6
6. **Optimise** — reads the change and prescribes what to adjust

Every row is tappable, so anyone who already owns sticks or knows their number can jump
ahead. Once the block starts, the steps collapse to a one-line strip on Today.

Step 6 branches on the measured result rather than offering generic advice: a flat retest
sends the user to rule out the tape position, then effort, then adherence, and only then
change the training — because the most likely explanation for "no gain" is a measurement
problem, not a training problem.

## Which stick to grab

Each implement has a colour and a banner: light is mint, mid amber, heavy orange, driver
white. The banner sits at the *top* of every group in the protocol list and at the top of
the session screen, above the drill name — the equipment decision comes before the
movement, so it reads first. Protocol sets are grouped by implement and the banner states
how many sets that stick covers.

## Drill attribution

Every drill and exercise supports an optional credit:

```js
{ ..., src:{ by:'Coach name', url:'https://...' } }
```

When present, the session player, the program list and the gym library render
"Drill after <coach>" with a link. Drills are written in our own words from the
mechanics; the credit points at the original. Training methods are not copyrightable,
but a coach's phrasing and a branded program's structure are — so the library
describes what to do and sends people to the source.

## Carry estimates

Carry was `club × 1.48 smash × 1.75 yards-per-mph-of-ball`. Both figures describe a tour
player in their optimal launch window, and the pair overstated carry by about 12% for the
golfers this app is for — a 94 mph swing was told 243 yards when the real number is ~215.

It is now a least-squares fit through published driver benchmarks spanning 85–120 mph club
speed (PGA Tour, LPGA, scratch, 5/10/15 handicap, senior):

```
carry_yards = 2.896 × clubspeed_mph − 55.4      R² = 0.9895
```

Mean absolute error 1.2%, worst case 2.6%, against 12.4% mean for the old model. It is
deliberately linear with a negative intercept because carry is not proportional to speed —
faster players also launch more efficiently — and it is clamped below 55 mph where the fit
runs out. The slope doubles as the "yards per 1 mph" figure quoted on the progress screen,
so the two can never drift apart.

## The 6-week course

Day 1 is gated: the Today screen shows nothing but the speed test until a baseline exists,
because an six-week block with no starting number cannot be evaluated. After that the app
runs day by day — today's sessions, tick them off, retest at the end of weeks 2, 4 and 6.

**Reminders** are exported as an `.ics` file covering all 42 days with an alarm an hour
before each session. Calendar reminders work whether or not the app is open and need no
server, no push infrastructure and no account.

**Journal** — a free-text note per day, stored alongside that day's completion record.

**Checklist and the adherence model.** Each session carries a mph value, and missed
sessions are totalled into a visible cost. The numbers come from this model:

```
projected block gain = baseline x 4.5%        (range shown as 2.5-6%)
weighted:  speed work 60%  |  gym 25%  |  tempo 15%
per session = baseline x 0.045 x weight / count of that session type
```

At a 100 mph baseline that is 4.5 mph for the block, 0.15 mph per speed session, 0.05 per
gym session. Six weeks is a shorter block than eight, so the budget was cut accordingly
rather than left flattering.

The block length is derived from the `WEEKS` array (`BLOCK_W()` / `BLOCK_D()`), so changing
the number of weeks does not leave stale copy or a wrong denominator behind.

**This is a planning projection, not a measurement, and the app says so on every screen it
appears on.** It exists to give a skipped session a visible size. Real gains in an six-week
block land somewhere in 3–7% depending on training age, sleep and how hard you actually
swing, and the user's own retests replace the estimate with a fact. Do not tune these
weights upward to make the app more motivating — an inflated number is discovered the first
time someone retests, and it takes the credibility of everything else with it.

The missed-session card is deliberately non-punitive: it reports the gap, says nothing is
permanently lost, and tells the user to reschedule while keeping 48 hours between speed
sessions.

## File tree

```
mach/
├── index.html      the whole app — UI, data, logic, styles, setup photos
├── img/            setup walkthrough photos (also embedded in index.html)
├── manifest.json   PWA metadata (installs to the home screen)
├── sw.js           service worker, offline cache
├── icon.svg        source icon
├── icon-192.png    PWA icon
├── icon-512.png    PWA icon
├── README.md
└── MARKETING.md    positioning, store copy, launch plan
```

## Run it

Open `index.html` in any browser. That is the whole install.

For the service worker and home-screen install to work you need to serve it over http:

```bash
cd mach
python3 -m http.server 8080
# then open http://localhost:8080
```

## Deploy

**Netlify** — drag the `mach` folder onto app.netlify.com/drop. Live in about 20 seconds.

**Vercel** — `npx vercel --prod` from inside the folder.

**GitHub Pages** — push the folder to a repo, then Settings → Pages → deploy from
`main` / root. Note that the path will be `/repo-name/`, so nothing needs changing —
all asset paths are relative.

**Cloudflare Pages** — connect the repo, leave the build command empty, set the output
directory to `/`.

On iOS: open the site in Safari → Share → Add to Home Screen. It launches full-screen
with no browser chrome. On Android, Chrome offers the install prompt automatically.

## Data

Stored on the device. The app checks for a host storage API first, then falls back to
`localStorage`, then to memory. Export writes a JSON file from Settings. No network
calls are made except loading the two Google fonts — delete that `<link>` in `index.html`
if you want a fully offline-first load with system fonts.

Keys: `mach:profile`, `mach:log`, `mach:done`, `mach:tempo`.

## Testing

`index.html` is driven entirely by click events, so the regression suite clicks rather than
setting state — an earlier version of this suite drove `state` directly and hid a broken
event handler behind passing tests. 24 checks cover the day-1 gate, the photo walkthrough, the four-step wizard
and its guards, frame-rate detection, multi-swing averaging, both session players,
checklist, journal, metronome, calendar export and persistence across reload.

Measurement accuracy is verified against synthetic geometry with an exact known answer,
including the invariance table above.

## Build roadmap

**Phase 1 — shipped (this build).** Program engine, 4 speed protocols, 27-exercise gym
library, 5 gym day templates, tempo metronome, speed log with chart, guided session
player, DIY equipment guide, PWA + offline.

**Phase 2 — the obvious next two weeks.**
- Rep counter driven by the device microphone (a swing through air has a clear whoosh peak) so a set counts itself
- Push notifications for session days via the Notification API
- A second 6-week block (Block 2: heavier contrast work, higher jump volume) so the app has a path after week 6
- Charting ball speed and smash factor as separate series

**Phase 3 — differentiation.**
- Automatic ball detection in the video screen — the ball is the brightest round blob moving 10x faster than anything else in the frame, so a simple frame-difference and circularity test should remove the tapping entirely
- Video tempo capture: reuse the same frame stepper — tap takeaway, top and impact, get your real ratio back and feed it to the metronome
- Accelerometer speed estimate: strap the phone to the shaft, integrate peak angular velocity, calibrate against one known number
- CSV import from Rapsodo, Garmin R10 and Trackman exports

**Phase 4 — if you want revenue.** See MARKETING.md. The honest model here is a one-time
unlock, not a subscription, because "everything else is expensive" is the entire pitch.

## Safety note that should stay in the product

Overspeed training is high-intent and one-sided. The reverse-direction reps in every
protocol are not filler — they are what keeps the load balanced. The app says this in
the equipment sheet; don't cut it.
