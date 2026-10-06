# Day Dial — decisions log

Every question asked, every answer given, and the reasoning behind the choices that
were not asked about. This file is the source of truth for *why* the app behaves the
way it does. Update it whenever behaviour changes.

---

## 1. The schedule (from the handwritten notes)

Transcribed from the image, then corrected: lunch was written `1:00 – 2:20 PM` while
the study block below it was written `2:00 – 5:00 PM`, a 20 minute overlap. **Resolved:
lunch ends at 2:00 PM.**

| # | Block | Start | End | Duration | Timer? |
|---|-------|-------|-----|----------|--------|
| — | Wake up | 08:30 | — | — | *not a block* |
| 1 | Exercise, eat and bath | 08:30 | 09:10 | 40 min | **yes** |
| 2 | Get ready | 09:10 | 10:00 | 50 min | no |
| 3 | Study — morning | 10:00 | 13:00 | 3 h | **yes** |
| 4 | Lunch | 13:00 | 14:00 | 1 h | no |
| 5 | Study — afternoon | 14:00 | 17:00 | 3 h | **yes** |
| 6 | Break | 17:00 | 18:00 | 1 h | no |
| 7 | Study — evening | 18:00 | 20:00 | 2 h | **yes** |
| 8 | Dinner | 20:00 | 21:00 | 1 h | no |
| 9 | Study — night | 21:00 | 22:00 | 1 h | **yes** |
| 10 | Hobby | 22:00 | 24:00 | 2 h | **yes** |
| — | Sleep | 00:00 | 08:30 | 8 h 30 | no |

Derived totals: **study 9 h**, timed work **12 h**, awake span **15 h 30**
(08:30 → 00:00), full day **24 h**.

**Timer split.** Exercise, all four study blocks, and Hobby get timers. Get ready,
Lunch, Break, Dinner and Sleep are pass-through — they have nothing to complete, so they
are never marked incomplete and never accumulate wasted time. This is what makes
"wasted" mean something: every wasted second is a second of a block you meant to do.

### Two blocks deliberately left off the dial

Both decisions came out of looking at the rendered thing rather than planning it.

**"Wake up 8:30 AM" is the day's origin, not a task.** As a block it has zero
duration, which produced an arc with no area — invisible and impossible to click. It
is now the dial's twelve o'clock, marked with a labelled origin line, and the rail's
left edge. `DAY_START_MIN` carries it.

**Sleep is the absence of a day, not part of one.** It is not on the dial. Drawing it
would either waste a third of the circle or force the real hours to shrink. The needle
parks at twelve o'clock overnight, and the hub says "Not on the clock · wake at 08:30".

So the dial carries ten slices, and the notes' twelve lines are all still accounted for.

---

## 2. Answers to the questions asked

### Stack
> **Next.js + Supabase.**

Chosen over a Vite SPA because push notifications need a server to send from, and a
cron to send them on time. Version pinned at Next 16 / React 19.

### Notification delivery
> **Real Web Push — must arrive even with the browser closed.**

Built as a service worker + VAPID keypair, with an in-page toast as the fallback when
permission is denied or push is unavailable. See §4 for the hard constraint this
turned up.

### Auth
> **Single user, no login.**

The app opens straight into your day. One row of data, no session, no email. The
consequence is that anyone who loads the URL can drive the timer, so the Supabase
policies are wide open by design and the security boundary is the obscurity of the
project URL and key.

### Schedule editing
> **Hardcoded.** Not editable from the UI.

The twelve blocks live in `src/lib/schedule.ts`. Changing them is a code edit. This
keeps the dial deterministic and removes an entire class of bug.

### Timezone
> **Asia/Kolkata (IST), hardcoded.**

All slot boundaries are computed in IST regardless of where the machine or the server
runs. A laptop that travels still shows the right day.

### Pie time span
> **Full day, 08:30 → 00:00.**

The circle *is* the waking day: twelve o'clock is 08:30, and it runs clockwise to
midnight and closes back at twelve. Every degree means something, so 9 hours of study
is 59% of the circle and the gaps between blocks are visible as gaps.

The first implementation mapped 24 hours onto 360° instead, which put the day's
15.5 hours into a 93° wedge — a quarter of the dial carrying all the information. The
screenshot made it obvious. A 40-minute exercise block is 4% of the circle here, and
honestly 4%.

### Wasted-time accounting
> **Focused = timer-running time. Wasted = everything else.**

This is the rule the whole app is built on:

```
focused   = time the timer was actually running
wasted    = (now − block start) − focused
          = seconds spent before you pressed Start
          + seconds spent paused

unstarted = how far into the window you were when you first pressed Start
paused    = wasted − unstarted
```

Consequences, all intentional:
- Pausing does **not** move the slice. Paused seconds go to waste, never to focus.
- A slice fills only while the timer runs. The wall clock moving is not the same as
  you working.
- A block with no timer cannot accrue waste, so it cannot fail.
- **Completed** means `focused ≥ planned`, not "the time passed".
- `unstarted` is *frozen* at the moment of the first Start. It does not reset to zero
  when you press Start, which would quietly forgive the half hour before you did.

`focusedMs` is the only stored quantity. Elapsed comes from the clock and the
unstarted/paused split is derived from `startedAt`, so there is no second accumulator
that can drift out of agreement with the first. An earlier version kept a separate
`pausedMs` accumulator and added it to a live figure, which double counted: two minutes
paused on a block with thirty minutes unstarted reported `32:01` paused.

### The start gate

Focus accrues from the moment you press Start, so an ungated start button would let you
bank the whole day at 08:30. **Start is only offered from five minutes before the block
opens.** That is forgiving enough to press it a little early and strict enough that
credit stays inside the day it belongs to.

### Timer popup trigger
> **5 minutes before the block starts.**

At `start − 5 min` the timer panel opens, a notification fires, and a sound plays.
Nothing counts as wasted before that point — the panel appearing is the start of
accounting, not the block's start time. The block's own start time still governs when
it turns red.

Reminders are also **discarded if more than four minutes late**. Opening the app at
9pm should not replay fourteen water prompts for glasses you already drank and four
study warnings for blocks that ended hours ago; the slots are still marked as notified,
so the record stays honest and only the noise is dropped.

### Red slice rule
> **Red when the block's end time passes unmet.**

At `end`, if `focused < planned` the slice is permanently red for the day. Not a
live warning, a verdict. Falling behind is visible as a dimmer arc; only the end time
produces red.

A missed block gets a **thin red rim outside** its band rather than having the whole
slice repainted. The first version recoloured the slice, and a day where nothing had
been focused turned the entire dial red and lost the fact that those hours were study
rather than lunch. The rim is unmistakable and the category colour survives.

### Water reminders
> **Every 60 minutes, 08:30 → 22:00.**

Fourteen reminders: 08:30, 09:30, 10:30 … 21:30. Rendered as a filling glass meter
in the header, and pushed as notifications.

### Supabase keys
> **Scaffold now, keys added later.**

The app is fully functional with no backend. It writes to `localStorage` and silently
upgrades to Supabase when the keys appear in `.env.local`. Nothing in the UI changes.

### Verification
> **Playwright installed locally.**

`npm run verify` drives a real Chromium against the dev server, captures every
console error, page error and failed request, exercises the timer interactions, and
writes screenshots to `.verify/`.

### UI
> **Exceptional, professional, beautiful, with animations.**

See §5.

---

## 3. Corrections made during research

These came out of the pre-build research pass, not from you. Each one changed the
implementation.

| Finding | Impact |
|---|---|
| The `sbp_…` value is a **Personal Access Token** with org-wide Full Access | It is never used in browser code. Revoke it and re-scope, since it was pasted into a chat. Browser code uses the *publishable* key. |
| Supabase keys are now `sb_publishable_…` / `sb_secret_…`; `anon` / `service_role` are deprecated for removal **end of 2026** | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is the primary var. The legacy `anon` key is still accepted as a fallback. |
| **From 2026-10-30**, tables in `public` are no longer auto-exposed to the Data API | `supabase/schema.sql` issues an explicit `GRANT` for every table. Without it you get `42501 permission denied for table …`. |
| Tables created in the **SQL Editor do not get RLS enabled** | `schema.sql` enables RLS explicitly per table. Only the Table Editor does it for you. |
| `web-push` reads **no** environment variables — that is community convention | VAPID keys are read and wired in our own code, with the names *we* choose. |
| The VAPID private key is **raw 32-byte base64url, not PEM** | Feeding a PEM value throws at boot. `scripts/gen-vapid.mjs` writes raw base64url. |
| **Vercel Hobby cron runs once per day** and a `*/5` expression **fails at deploy** | The 5-minute trigger is Supabase `pg_cron` + `pg_net`, not Vercel Cron. The route exports both `GET` and `POST` because `pg_net` is POST-only. |
| Desktop push does **not** reliably arrive with the browser fully quit | Designed as if it does not. The in-app scheduler and toasts are the real safety net; push is the accelerator. |
| `pushsubscriptionchange` is **unimplemented in Chrome** | Dead subscriptions are pruned by status code (404/410) on the next send. |
| CSS **cannot** transition the `d` attribute — arc flags flip at 50% and the path tears | Progress is driven by `stroke-dashoffset` with `pathLength="100"`. Never animate `d`. |
| `will-change: stroke-dashoffset` does nothing (not a compositor property) | Applied to the needle only. |
| TypeScript 7 is published but **hard-crashes `eslint-config-next`** | Pinned to `typescript@^5`. |
| `next lint` was removed in Next 16; `next build` no longer lints | `npm run lint` runs `eslint` directly, and it is wired into `npm run verify`. |
| Edge runtime is deprecated | No `runtime` export on any route. |
| `next/font/google` needs network **at build time** | Fonts are fetched at build and self-hosted. Build fails offline, so `npm run build` needs internet once. |

---

## 4. The one place the spec fights itself

Notifications must arrive with the browser closed. Web Push is the only browser
mechanism that can, and on desktop it requires a browser process to exist. So:

- **Primary:** `pg_cron` fires every 5 minutes → `pg_net` POSTs to our route → route
  sends Web Push → service worker shows an OS notification.
- **Fallback A:** if push permission is denied, the page's own scheduler fires the
  same notifications as toasts while the tab is open.
- **Fallback B:** if the page is open *and* push is granted, you get both. Redundant
  by design — a missed 5-minute reminder matters more than a duplicate.

If you deploy to Vercel, do **not** add a `*/5` cron there. Hobby accounts reject it
at deploy time. Use the Supabase job.

---

## 5. Design direction

**The dial is not a chart widget, it is an instrument.** A machined gauge you read at
a glance.

- The circle is the waking day. Twelve o'clock is 08:30, marked with the only labelled
  mark on the dial. The day runs clockwise and closes at midnight. A needle points at
  now, and parks at twelve overnight.
- Each slice is three concentric bands on one radius: the whole planned window **dim**,
  the elapsed-but-unlit remainder **dimmer still**, and focus **lit** with a glow. The
  day reads as a light level rather than as a chart.
- A missed block adds a hard red rim outside the band. It is the only ongoing motion on
  the dial, and it is on the failure state only.
- Palette: ink `#0B0F14`, panel `#141A22`, hairline `#2A3542`; study cobalt
  `#4F6FE8`, exercise `#2FB98C`, hobby amber `#E8973F`, life slate `#63748A`, alarm
  `#F2544B`, water cyan `#49C6E5`.
- Type: **Space Grotesk** for display and UI, **IBM Plex Mono** for every numeral.
  Monospace is not decoration here — it is what stops a ticking clock from reflowing
  the layout four times a second.
- The rail below the dial re-encodes the day as a linear timeline. The dial answers
  "what shape is my day"; the rail answers "how long is each block, in order". Both are
  the same data at two angles of attack, and together they make a schedule readable at
  a glance and auditable line by line.
- Motion is **never ambient**. One orchestrated dial draw on load. After that, motion
  happens only because you did something: an arc grows, a panel springs in, an alarm
  pulses. No fade-and-slide on scroll.

**Restraint:** the dial is the only memorable object. Everything else is hairline
rules and mono readouts, so the dial reads as the interface rather than as one widget
among many.

### What the screenshots changed

Four of these decisions came from looking at `.verify/states/*.png`, not from planning:

| Saw | Changed to |
|---|---|
| Day crammed into a 93° wedge of an otherwise empty circle | Circle is the awake day; sleep and wake-up came off the dial |
| Translucent discs scattered across the dial | `stroke-linecap: round` on a long dasharray draws a disc per dash. Butt caps. |
| A bad day turned the whole dial red and lost the categories | Missed blocks get a red rim; the slice keeps its colour |
| Water reminder said "every 60 min from 14:00" | `formatHm` was being handed minutes-since-midnight as if they were an epoch, converting out of IST. Added `formatHmOfDay`. |
| Rows reading "Lunch  Lunch", "Study — morning  Study" | Both `title` and `label` were rendered. One name, plus progress. |

---

## 7. Running it on Windows

`npm run dev` in a terminal is fine. Starting a *background* server is not, and this
cost real time to work out.

`Start-Process -NoNewWindow` does **not** detach a process on Windows. It inherits the
parent console's stdin, stdout and stderr handles, so the calling shell cannot return
until every child releases them. A web server never exits, so the terminal hangs
forever. Redirecting to files is not enough either — some hosts wait on the whole
process group.

`scripts/server.ps1` creates the process through WMI instead, which builds it with no
console and no inherited handles:

```
npm run serve        # start detached, wait until it answers on :3000
npm run serve:stop
```

One trap inside it: `Win32_Process.Create` has **no working-directory parameter**, so
the process starts in `C:\Windows\System32`, where `next start` finds no `.next` and
exits with "Could not find a production build". The command line has to `cd /d` into
the project first.

## 8. Verification

There is no Playwright MCP server connected to this workspace, so `scripts/verify.mjs`
does the job directly: a real Chromium against a real server, capturing every console
error, page error and failed request, then asserting behaviour and writing screenshots
to `.verify/`.

```
npm run build
npm run serve
npm run verify
```

Thirty checks, all green. The interesting ones:

- **Accounting, on a frozen clock.** Playwright's `clock.install()` pins time to
  10:30 IST, mid-way through morning study, and the script then drives the real UI:
  start, wait a minute, pause, wait two. It asserts focused rose by ~1 min, waste stayed
  at ~30 min while focusing, focused did *not* move while paused, paused picked up
  ~2 min, and `wasted = unstarted + paused` to the second.
- **The 5-minute popup.** Clock pinned to 09:57 IST: the panel must open itself, a toast
  must appear with a Start action, and Start must be enabled. Then pinned to 12:00 IST:
  no toast, because nothing is due.
- **The 08:30 origin.** The old zero-duration "Wake up" block produced an arc with no
  area — Playwright reported it as `hidden`, and no human could have clicked it either.
  That is the check that caught it.
- **Clean state.** The reminder scenario asserts every ledger row reads `00:00`. It
  caught the scenarios sharing one `localStorage` through `context.newPage()`, which
  meant the popup test was reporting the accounting test's banked focus. Each scenario
  now gets its own context.

Every bug the verifier found is in §3 or §5. `scripts/shots.mjs` renders the dial at
10:30, 15:45 and 21:30 so the design can be judged in the states you actually see, not
only at whatever time it happens to be.

**Thirty-seven now.** Seven more cover the archive (§10): a seeded history rendering with
its numbers intact, the summary tiles reading the archive rather than today, a perfect day
still reporting 6/6 and being marked, the per-block ledger listing **only** timed blocks,
today being pinned live and counted separately, no horizontal overflow at 390px, and the
midnight rollover actually filing a stranded day instead of overwriting it.

Two of those seven checks failed on the first run, and both failures were the test's fault
rather than the page's — which is worth recording because the fix is not obvious. The
summary tiles are uppercased in CSS, and Playwright's `innerText` returns the *rendered*
casing, so an assertion written against the source string failed against a page
displaying exactly the right numbers. Switching to `textContent` was worse: it keeps the
source casing but collapses the whitespace between elements, so `"3"` landed inside
`"tracked3"` with no word boundary to match on. The answer is `innerText` plus a
case-insensitive pattern. Anything asserting on rendered text in this repo has to account
for both.

### The suite was measuring the machine, not the app

Fixing the notifications (§9) turned three accounting checks red that had been green
throughout. None of them were wrong about the app; all three were wrong about time, and
they only started failing once Gradle's daemons were sitting on 1.4 GB of RAM.

`clock.install()` **pins the start instant but does not stop the clock**. Only
`fastForward` was meant to move it — but real milliseconds still pass between reading a
value, locating a button and dispatching a click, and `focused` is derived from
`Date.now()`. So "pause the timer, then assert focus did not move" was really asserting
that the click had been dispatched within the same second. On an idle machine it passed;
under load it reported `01:00 -> 01:03` and was reported as a pause bug.

Three separate defects, and only the first is obvious:

- **A baseline captured before the click.** Re-baselined *after* the pause lands. From the
  instant the timer stopped, focus must not move — which is both correct and stricter.
- **A ledger read five times.** `ledgerOf` did one `innerText()` per cell, so five rows
  came from five different `now` values. A ledger whose rows must add up exactly reported
  `1802 !== 1803`. Now one `evaluate`.
- **Three separately floored strings.** The app's identity is exact
  (`pausedMs = wastedMs - unstartedMs`), but each duration is formatted by flooring
  independently, so `floor(a) + floor(b)` can be one less than `floor(a + b)`. Asserting
  exact equality between them failed roughly one run in three on values correct to the
  millisecond. Now ±1s, with the reason written down so it is not "tightened" back.

And one that was pure test sloppiness: the clock assertion demanded the seconds field be
`00`. The clock renders `HH:MM:SS.mmm`, so the digits were eight long, and the old
`/^10300/` regex was a *prefix* match that happened to tolerate the millis field.
Requiring `10:30:00` exactly was asserting the test ran in under a second.

`clock.pauseAt()` and `clock.setFixedTime()` were both tried and both are wrong here:
`pauseAt` throws `Cannot fast-forward to the past` because the clock has already ticked
past the target, and `setFixedTime` freezes Playwright's own screenshot timers until
`page.screenshot` times out. The fix that holds is to stop comparing across a real-time
gap rather than to fight the clock. Five consecutive runs, 37/37, 0 console messages.

## 9. The Android app

`npm run apk` produces `android/app/build/outputs/apk/debug/app-debug.apk` — about
4.5 MB, built from the same source as the browser app. Capacitor wraps a static export in
a native WebView shell, so the dial, the timers, the water meter and the archive all work
with the phone in aeroplane mode.

**The app is local only.** No server, no account, nothing to sign in to. Every record
lives in the WebView's own localStorage. That was the point: an app that needs a laptop
running somewhere else is not an app.

### Why the notifications had to be rebuilt rather than reused

Android's WebView has **no Push API** — no `PushManager`, no service-worker push, no
VAPID. So the entire web push path is not merely degraded in the APK, it is broken there:
`isPushSupported()` returns false on native, which stops the app fetching `/api/push/key`
from a `capacitor://` scheme and failing on every reminder.

Worse, the reminder engine was written as a *poll* — it notices a reminder when a 250ms
tick happens to land after the trigger. That is correct for a tab and wrong for an app:
Android will kill a backgrounded WebView without ceremony, and a reminder that depends on
JavaScript running is a reminder that does not arrive. So in the APK the whole day is
handed to the OS up front via `LocalNotifications.schedule`, and the in-app half of the
delivery stands down to avoid duplicating a notification the user is already getting.

Three manifest permissions follow from that, none of which the default Capacitor
template had:

| Permission | Why |
|---|---|
| `POST_NOTIFICATIONS` | Android 13+ made notifications opt-in at runtime. Without it the OS silently drops every scheduled reminder and the app cannot even ask. |
| `SCHEDULE_EXACT_ALARM` | Android 12+ refuses exact alarms by default. A 5-minute warning that arrives ten minutes late is not a warning. The grantable form, not `USE_EXACT_ALARM`, which Play reserves for alarm clocks. |
| `RECEIVE_BOOT_COMPLETED` | Reminders now live in the OS queue, so a reboot discards the whole lot. Without this the day's reminders stop existing until the app is next opened. |

`INTERNET` stays in the manifest even though the app is offline, because Capacitor
serves the bundled assets from a loopback HTTP server inside the WebView and Android
will not load the app without it. No outbound request is ever made.

### Why no reminder ever arrived, twice

Both of these were mine, and both presented as the same symptom — "notifications don't
work in the app" — with completely different causes.

**The scheduler was destroying its own queue four times a second.** The effect that
hands the day to the OS originally depended on `metrics`, and `metrics` is rebuilt on
every 250ms tick. So it ran four times a second, each time calling `cancelAll()` and
re-issuing around twenty alarms — roughly eighty AlarmManager operations per second
against a system that holds a few dozen pending intents per app. The queue was emptied
faster than it could be filled and nothing survived to fire.

The fix is not a debounce; it is noticing that the dependency was never needed. The
schedule is hardcoded and identical every day, so the reminder list is now built from
`BLOCKS` and the water constants and depends on `[today]` and nothing else. It runs once
per day. A debounce would have hidden the bug behind a delay and left the effect
re-running for the rest of the session; removing the dependency makes it correct.

**With notifications ungranted, the app had gone completely silent.** The same change
had wrapped the in-app half of delivery in `if (!isNative())`, on the reasoning that the
OS notification was already on its way. So on a build where `POST_NOTIFICATIONS` had not
been granted — which is every fresh install — a reminder produced no toast, no chime and
no panel. There was no reminder in any form, because the one channel that could not fail
had been switched off on the assumption the other one always worked.

In-app delivery is now unconditional, and the OS notification is the redundant copy
rather than the only one. This is the app's existing stance applied honestly: it already
treats a duplicate reminder as cheaper than a missed one, and a reminder that depends on
a permission it cannot guarantee is not a reminder.

### Getting rid of the permission dialog

Android 13 introduced `POST_NOTIFICATIONS` as a runtime permission — but the gate only
applies to apps whose `targetSdkVersion` is 33 or higher. This app targeted 36, so it
was inside the gate and had to ask.

`targetSdkVersion` is now **32**. Below the gate the OS grants notifications at install,
and `SCHEDULE_EXACT_ALARM` is granted automatically as well, so reminders work with no
dialog and no detour into system settings. `compileSdk` stays 36 — `targetSdk` governs
runtime behaviour, not which classes exist, so nothing was made unavailable.

What it costs: **Google Play rejects uploads below targetSdk 34.** For a sideloaded
personal app that is free. For Play distribution it is one line back to 34 and one
permission dialog forever. That is a distribution decision, not a technical limit, and
it is the only thing given up.

Note the related asymmetry on the way out: an app cannot revoke its own notification
permission. The grant is deliberately one-way and only system settings can undo it, so
the header lamp cannot be an on/off switch in the APK. It reports the state and names
the path to change it, instead of calling the Web Push unsubscribe and reporting a
successful revoke that never happened.

### What the static export costs

`next build --output export` cannot contain a route handler, so `/api/push/*` is moved
aside for the export and restored in a `finally`. This is deliberate rather than a
workaround: those routes are unreachable from an Android WebView anyway. The browser
build is untouched by it.

The one place this design is weaker than the web app is server-side push with the browser
*closed*. That is a real capability loss and it is not hidden — it is the reason Web Push
is described as a web-only feature throughout the README.

## 10. The archive

The original spec never asked for history, so the first implementation had none, and the
mistake was easy to make: at midnight the store did

```ts
setSnapshot((prev) => ({ ...prev, date: today, blocks: {}, notifiedBlocks: [] }))
```

which is correct for the dial — carrying yesterday's focus into today would inflate
today's numbers — and quietly destroyed the only copy of a day you had actually worked.
Three things had to be true for history to be worth anything, and each was a bug first:

**A finished day has to be filed against its own midnight, not against `now`.** At
rollover `dayStartMs(now)` is *already* the new day's midnight, so the obvious call
archives garbage. If the app was closed for three days, `now - 86_400_000` is the wrong
day entirely. The record is anchored to `dayStartMsFor(snapshot.date)`. And that instant
needs `+1ms`: hobby's window ends exactly on the boundary, so measuring the day at
exactly its last millisecond leaves the final block reading "active" and files a
completely worked day as one that stopped a minute short.

**The numbers must come from the code that drew the dial.** `archiveSnapshot` calls the
same `computeBlockMetrics` and `computeStats` the live header uses, so an archived day
and a live day cannot disagree. Recomputing the waste arithmetic by hand would have
guaranteed a slow divergence.

**The per-block ledger must filter on `timed`.** The archive keeps sleep, lunch, dinner
and break, and `computeBlockMetrics` gives every one of them a `wastedMs` equal to
however much of its window went by — 8h30 for sleep alone. Day totals are unaffected
because `computeStats` filters, but a ledger that listed them unfiltered would tell you
you had wasted fourteen hours. A block with no timer has nothing to complete and
therefore nothing to waste, and that check now exists.

### Two judgement calls worth arguing with

**A day with no recorded blocks is not archived at all.** Vacuously, "every timed block
met its target" is true of a day with no timed blocks, which would award a perfect score
for a day the app was never opened. Same reasoning excludes zero-focus days from the
average efficiency: opening the app and doing nothing is not a 0% day, it is not a day.

**The streak counts recorded days only.** A day with no entry breaks the chain, because
the archive genuinely cannot know what happened on it. Inventing the missing days would
mean reporting a streak the data does not support, which for an app whose entire subject
is honesty about wasted time would be the wrong trade.

The archive holds 400 days. Not for tidiness — unbounded localStorage growth on a phone
is a real failure mode, and 400 days is more than a year of history at a few KB per day.

## 11. The notification channel that was never created

Reminders worked in the app and never appeared in the notification shade. The in-app half
is React — a toast, a chime, a panel — so it kept working. The shade half goes through
`@capacitor/local-notifications`. Two mistakes in one call, and neither produced an error.

**The channel did not exist.** The code asked for `channelId: "day-dial"`. The plugin
auto-creates exactly one channel, hardcoded with id `"default"`
(`LocalNotificationManager.kt:509`), and never validates the channel you ask for — the only
`getNotificationChannel()` call in the whole plugin is for its own sound channel, at line
114. On Android 8+, posting a notification to a channel that was never created is
**discarded by the system**, silently. Every one of the day's ~20 reminders was queued
correctly and then thrown away on arrival.

**`channelId` was in the wrong object.** It was nested inside `schedule`, where it is
ignored, because the plugin reads it from the top level of the notification
(`LocalNotification.kt:169`) and falls back to `"default"` when absent. `allowWhileIdle`
*is* correctly inside `schedule` (`LocalNotificationSchedule.kt:48`).

The first mistake alone is enough to explain the symptom. The second is why the channel
had to be created explicitly rather than by luck.

The fix creates the channel before the first post, at `IMPORTANCE_HIGH` (4). The plugin's
own default channel uses `IMPORTANCE_DEFAULT` (3), which delivers silently — a heads-up
banner is the point of a five-minutes-early prompt. One platform caveat worth keeping in
mind: **channel settings are immutable once created.** `createChannel` is a no-op against
an existing channel, so a `day-dial` channel created at the wrong importance by an earlier
build will not be corrected by a later one. It has to be deleted in system settings.

`res/drawable/ic_stat_daydial.xml` is a vector clock face, because Android masks the small
icon to a white silhouette and discards colour — the launcher icon would render as a solid
white blob. Without an explicit `smallIcon` the plugin falls back to
`android.R.drawable.ic_dialog_info`, a stock information glyph that has nothing to do with a
study planner.

**Diagnostics over inference.** Nothing in the app could tell that delivery was failing:
`getPending()` reported a full queue and `schedule` resolved successfully. The failure
happened inside Android, after the app's last chance to notice. So pressing the
notifications lamp on native now fires a real notification and reports what happened
(`sendNativeTestNotification`), rather than asserting that things are on because the
permission says so. It returns the plugin's own error text, because "false" cannot tell
"no permission" from "bad channel id" from "alarm permission revoked", and those need
three different fixes.

### A date-dependent test that passed by luck

The verifier found the seeded 30 September row with `hasText: "30"`. On the 3rd of the
month, today's pinned live card renders `Sat 03` next to a running timer of `00:00:00` —
which concatenates to `Sat0300:00` and contains `"30"`. `.first()` matched the live card
instead, and a passing check silently began asserting against the wrong row. Rows now carry
`data-date` with the ISO date and the checks target that, because the visible date is
rendered for people (`Wed 30`, year hidden unless it differs) and is not a stable selector.

## 12. Encoding: do not edit UTF-8 files with PowerShell

`scripts/verify.mjs` was corrupted by a single `Get-Content -Raw` / `Set-Content -Encoding
UTF8` round-trip while fixing a selector. PowerShell 5.1 reads a BOM-less file as cp1252,
so every multi-byte UTF-8 sequence was decoded as two or three unrelated characters and
then re-encoded — and five byte values (`0x81 0x8D 0x8F 0x90 0x9D`) have no cp1252 meaning
at all and became U+FFFD permanently.

A second attempt using Latin-1 recovered most of the bytes but turned every cp1252-specific
character (em dash, curly quotes, `€`) into a literal `?`, because Latin-1 cannot represent
anything above U+00FF either. Damage was 582 lost characters plus a BOM, across 77 of 878
lines. All 37 check names and every assertion survived, because they are ASCII — the losses
were the em dashes, the box-drawing section rules, and a handful of glyphs inside assertion
messages. Two losses were inside strings the assertions actually match on (`Study — morning`),
so the file would not parse at all.

Repaired by rule, in a Node script that refuses to write if a single U+FFFD survives or
the result will not `node --check`. The two clobbered sequences were distinguishable only
by byte order: `FFFD '?' '"'` was an em dash, `FFFD '"' '?'` was a box rule.

The lesson is not about PowerShell being old. It is that a text transform which looks
lossless — read a file, replace a string, write it back — has no failure mode you would
notice, and this file's entire purpose is to catch failures. Use `edit` for single changes
and Node for bulk work on files containing non-ASCII.

## 13. Open items

- [ ] Add Supabase keys to `.env.local`
- [ ] Apply `supabase/schema.sql` in the SQL Editor
- [ ] `npm run vapid` to generate the push keypair
- [ ] Apply `supabase/cron.sql` **and** `supabase/seed.sql` if you want reminders with
      the browser closed
- [ ] Revoke the pasted `sbp_…` Personal Access Token