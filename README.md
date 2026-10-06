# Day Dial

A day-planning instrument. One large dial holds your whole day; each block on it has a
timer; time you spend with the timer stopped is recorded as wasted; and a reminder
arrives five minutes before every block.

Built from a handwritten plan, transcribed in [`NOTES.md`](./NOTES.md) alongside every
decision and every correction made along the way.

```
npm install
npm run dev
```

That is the whole setup. It runs with no backend, no account and no configuration —
state lives in `localStorage` and reminders work while the tab is open. Adding Supabase
upgrades it to sync across devices and to notify you with the browser closed;
[`docs/SETUP_SUPABASE.md`](./docs/SETUP_SUPABASE.md) is the click-by-click walkthrough.

---

## What it does

**The dial.** The circle is your waking day. Twelve o'clock is 08:30, the day runs
clockwise to midnight, and a needle points at now. Every degree means something: nine
hours of study is 59% of the circle, and the gaps between blocks are visible as gaps.

Each slice is three bands on one radius:

| Band | Meaning |
|---|---|
| dim | the whole planned window |
| dimmer | the part of that window that has gone by unlit — **wasted** |
| **lit, with a glow** | focus. The only thing on the dial with a glow. |

A block that ends with its target unmet keeps its colour and gains a **hard red rim**.
The rim is the only ongoing motion on the dial, and it is on the failure state only.

**The clock** runs beneath the dial, in monospace with tabular figures so a ticking
second cannot reflow the layout. Below it, a rule shows how much of the waking day is
gone.

**The dock** sits to the right of the dial, with a hairline aligned to the slice it
belongs to. Its real job is the ledger:

```
Focused               52:00
Wasted                30:00
  · before you started 30:00
  · while paused      00:00
Remaining            2:07:59
```

**Click any slice** to open its timer. **Five minutes before any block starts** the
panel opens itself, a notification fires and the dial chimes.

**The rail** under everything re-encodes the day as a linear timeline. The dial answers
"what shape is my day"; the rail answers "how long is each block, in order".

**The logs** at `/logs` keep every finished day. At midnight the day's counters are
archived — not thrown away — so you get a month-by-month history: total focus, streaks,
efficiency, blocks met and missed, water, and a per-block ledger you can open on any
day. Today sits at the top of that page as a live card and joins the archive overnight.
It is all local: 400 days, stored on the device, exportable as JSON.

---

## The one rule everything follows

> **Focused is the time the timer is running. Everything else is wasted.**

```
focused   = time the timer was actually running
wasted    = (now − block start) − focused
unstarted = how far into the window you were at your first Start
paused    = wasted − unstarted
```

So pausing does not move the slice — those seconds go to waste. A block you never
pressed Start for is wasted from the moment its window opened. A block with no timer at
all (lunch, break, sleep) can accrue no waste and therefore can never fail.

`focusedMs` is the only stored number. Everything else is derived from the clock, so
nothing can drift out of agreement with anything else.

---

## The day

| Block | Time | Timer |
|---|---|---|
| Wake up | 08:30 | *the dial's origin* |
| Exercise, eat and bath | 08:30 – 09:10 | yes |
| Get ready | 09:10 – 10:00 | no |
| Study — morning | 10:00 – 13:00 | yes |
| Lunch | 13:00 – 14:00 | no |
| Study — afternoon | 14:00 – 17:00 | yes |
| Break | 17:00 – 18:00 | no |
| Study — evening | 18:00 – 20:00 | yes |
| Dinner | 20:00 – 21:00 | no |
| Study — night | 21:00 – 22:00 | yes |
| Hobby | 22:00 – 24:00 | yes |
| Sleep | 00:00 – 08:30 | no |

Twelve hours of timed work, nine of it study. Water reminders hourly, 08:30 to 22:00.
All times Asia/Kolkata, computed from that zone rather than from your device.

To change the schedule, edit [`src/lib/schedule.ts`](./src/lib/schedule.ts). It is the
single source of truth; `supabase/seed.sql` mirrors it for the scheduled-job path.

---

## Commands

| | |
|---|---|
| `npm run dev` | development server |
| `npm run build` | production build |
| `npm run serve` | start the production server **detached** (see below) |
| `npm run serve:stop` | stop it |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | lint + typecheck |
| `npm run verify` | drive a real browser, assert behaviour, screenshot |
| `npm run vapid` | generate a Web Push keypair |
| `npm run db:push` | check your Supabase project and tell you what to run |
| `npm run apk` | build the Android APK (see below) |
| `npm run apk:release` | the same, signed with a release keystore |

### The Android app

```bash
npm run apk
```

Four stages, all automatic: static export → `capacitor sync` → Gradle → report the APK
path. Output lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Install it with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, or
copy the file to the phone and open it (allow "install from unknown sources").

The app is **local only**. There is no server, no account, and nothing to sign in to —
the schedule is hardcoded in the app and every record is written to the device's own
storage. Two consequences are worth knowing before you wonder why they differ from the
browser:

| | Browser / PWA | Android APK |
|---|---|---|
| Data | localStorage, optionally synced to Supabase | localStorage only. Never leaves the phone. |
| Reminders | Web Push, so they arrive with the tab closed | Android's own notification scheduler |
| Server routes | `/api/push/*` available | **not bundled at all** |

That last row is not an omission. Android's WebView has no Push API, so `/api/push/*`
would be dead weight inside the APK; a static export cannot contain a route handler at
all. The build moves `src/app/api` aside for the export and restores it afterwards, so
the browser version keeps working. Web Push remains a web-only feature — see
[NOTES.md](./NOTES.md) §9.

Reminders in the APK are handed to the OS in advance rather than fired by JavaScript,
because Android kills a backgrounded WebView. That is why the manifest asks for
`POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM` and `RECEIVE_BOOT_COMPLETED`.

**No permission dialog appears.** `targetSdkVersion` is deliberately **32**, and that is
the whole mechanism: Android 13 introduced `POST_NOTIFICATIONS` as a runtime permission,
but the gate only applies to apps targeting API 33 or higher. Below that the OS grants
notifications at install, and `SCHEDULE_EXACT_ALARM` is granted automatically too.
`compileSdk` stays 36, so every modern API is still available — `targetSdk` governs
runtime behaviour, not which classes exist. The price is that **Google Play will not
accept an upload below targetSdk 34**; for a sideloaded app that costs nothing, and
putting it back to 34 is the only change needed if you ever want Play distribution.

Requires JDK 21 and the Android SDK. `npm run apk` finds both itself; the first Gradle
run downloads the Android Gradle Plugin and takes several minutes, and later ones take
under a minute.

Install with `adb install -r`, or copy the file across and open it. `versionCode` is 2 —
uninstalling first is the reliable way to be sure nothing from the old build lingers,
in particular a notification permission that was already declined.

### `npm run serve` rather than `next start` in the background

`Start-Process -NoNewWindow` does not detach a process on Windows — it inherits the
parent console's handles, so the shell waits for the server, which never exits, and the
terminal hangs. `scripts/server.ps1` goes through WMI instead, which creates a process
with no console and no inherited handles. It also `cd`s into the project, because
`Win32_Process.Create` has no working-directory parameter and would otherwise start in
`System32` and fail to find `.next`.

---

## Verification

No Playwright MCP server is connected to this workspace, so `npm run verify` drives a
real Chromium directly. It captures every console error, page error and failed
request, then asserts thirty behaviours and writes screenshots to `.verify/`.

```bash
npm run build
npm run serve
npm run verify
```

The part worth knowing about: Playwright's `clock.install()` pins the page to a chosen
IST instant, so the accounting is tested honestly rather than by inspecting a snapshot.
At 10:30 IST, mid-way through morning study, it drives the real UI — start, wait a
minute, pause, wait two — and asserts that focused rose by about a minute, that waste
held steady while focusing, that focused did **not** move while paused, and that
`wasted = unstarted + paused` to the second. It then pins the clock to 09:57 to prove
the five-minute popup fires on its own, and to 12:00 to prove it stays quiet when
nothing is due.

`node scripts/shots.mjs` renders the dial at 10:30, 15:45 and 21:30, so the design can
be judged in the states you will actually see.

---

## Layout

```
src/lib/
  schedule.ts     the day, hardcoded, with its colours
  types.ts        domain types
  time.ts         IST maths, derived from Intl rather than assumed
  metrics.ts      the accounting: focused, wasted, unstarted, paused
  geometry.ts     arc maths and the dash patterns
  store.tsx       state, timer actions, persistence
  notifications.ts  push, permission, chime
  persist.ts      localStorage, defensive on read
  history.ts      the archive: finished days, streaks, month grouping
  native.ts       the Capacitor bridge — OS notifications, no network
  supabase.ts     optional backend, silent when absent
  client-only.tsx the hydration gate
src/components/   DayDial, Clock, Dock, Readout (rail/stats/legend), Toaster,
                  Controls, ReminderEngine
src/app/api/      /push/key, /push/send, /push/subscribe  (web only — see below)
src/app/logs/     the archive: /logs
public/sw.js      service worker
supabase/         schema.sql, cron.sql, seed.sql
docs/             SETUP_SUPABASE.md + research/
scripts/          verify.mjs, shots.mjs, server.ps1, gen-vapid.mjs, db-push.mjs,
                  build-apk.mjs, export-static.mjs
android/          generated by Capacitor — do not hand-edit except the manifest
mobile/www/       the static export bundled into the APK, generated
```

---

## Documentation

- [`NOTES.md`](./NOTES.md) — every decision, every correction, and what each one cost
- [`docs/SETUP_SUPABASE.md`](./docs/SETUP_SUPABASE.md) — dashboard walkthrough
- [`docs/research/`](./docs/research) — the pre-build research the implementation rests on:
  Supabase's 2026 key and grant changes, Web Push, and the SVG arc maths

### One security note

The `sbp_…` token supplied at the start of this project is a **Personal Access Token**
with org-wide Full Access. It was pasted into a chat, so treat it as compromised and
revoke it in **Account Preferences → Access Tokens**. The app never needs it — browser
code uses the publishable key only.
