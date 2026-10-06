#!/usr/bin/env node
/**
 * Browser verification.
 *
 *   npm run dev          # in one terminal
 *   npm run verify       # in another
 *
 * There is no Playwright MCP server connected to this workspace, so this script does
 * the job directly: it drives a real Chromium against a real server, captures every
 * console error, page error and failed request, exercises the timer interactions, and
 * writes screenshots plus a JSON report to .verify/.
 *
 * It is not the Playwright test runner, so assertions are plain `node:assert`.
 *
 * Flags:
 *   --url     base URL            (default http://localhost:3000)
 *   --headed  show the browser
 *   --timeout per-step ms         (default 15000)
 */

import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", ".verify");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const BASE = arg("url", "http://localhost:3000");
const HEADED = argv.includes("--headed");
const STEP_TIMEOUT = Number(arg("timeout", 15000));

/**
 * How many blocks get a slice on the dial.
 *
 * Eleven blocks exist: sleep and the rest of the day. But sleep is the absence of a
 * day and "Wake up" is the day's origin rather than a task, so neither takes a slice —
 * ten do, plus the 08:30 origin mark. Keep this in step with src/lib/schedule.ts.
 */
const ON_DIAL = 10;

const report = {
  base: BASE,
  startedAt: new Date().toISOString(),
  console: [],
  pageErrors: [],
  failedRequests: [],
  checks: [],
  screenshots: [],
  summary: {},
};

const check = (name, fn) => async (page) => {
  try {
    await fn(page);
    report.checks.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    report.checks.push({ name, ok: false, error: error.message });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
};

const shot = async (page, name, fullPage = false) => {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  report.screenshots.push(name + ".png");
  console.log(`  shot  ${name}.png`);
  return file;
};

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log(`\nDay Dial — browser verification`);
  console.log(`target: ${BASE}\n`);

  let browser;
  try {
    browser = await chromium.launch({ headless: !HEADED });
  } catch (error) {
    console.error(
      [
        "",
        "Could not launch Chromium.",
        "",
        "  npx playwright install chromium",
        "",
        `  ${error.message}`,
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

const VIEWPORT = { width: 1600, height: 1100 };
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2,
  permissions: [],
});
const page = await context.newPage();
page.setDefaultTimeout(STEP_TIMEOUT);

/**
 * A fresh, isolated page with its own localStorage.
 *
 * `context.newPage()` would share storage with every earlier scenario, so the reminder
 * test loaded the 1 minute of focus the accounting test had banked and reported
 * "Focused 01:00" for a block that had not started yet. Each scenario needs its own
 * context, or the assertions are measuring each other's leftovers.
 */
const isolatedPage = async (label) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.setDefaultTimeout(STEP_TIMEOUT);
  p.on("pageerror", (e) => report.pageErrors.push(`[${label}] ${e.message}`));
  p.on("console", (msg) => {
    if (msg.type() === "error") report.console.push({ type: "error", text: `[${label}] ${msg.text()}` });
  });
  return { ctx, p };
};

  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      report.console.push({ type, text: msg.text(), location: msg.location()?.url });
      console.log(`  ${type === "error" ? "ERR " : "WARN"}  ${msg.text().slice(0, 160)}`);
    }
  });
  page.on("pageerror", (error) => {
    report.pageErrors.push(error.message);
    console.log(`  PAGEERROR  ${error.message.slice(0, 200)}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    // A cancelled request is what an in-flight fetch looks like when the page unloads;
    // it is noise, not a defect.
    if (failure.includes("ERR_ABORTED")) return;
    report.failedRequests.push({ url: request.url(), failure });
    console.log(`  REQFAIL  ${request.url().slice(0, 110)} — ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && new URL(response.url()).origin === new URL(BASE).origin) {
      report.failedRequests.push({ url: response.url(), failure: `HTTP ${response.status()}` });
      console.log(`  HTTP ${response.status()}  ${response.url().slice(0, 110)}`);
    }
  });

  try {
    // ── load ────────────────────────────────────────────────────────────────
    console.log("Loading");
    const response = await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    assert.ok(response, "No response from the server");
    console.log(`  HTTP ${response.status()}`);

    // ── the dial is the hero and it is big ──────────────────────────────────
    console.log("\nStructure");

    await check("page has a title", async () => {
      const title = await page.title();
      assert.ok(title.length > 0, "empty <title>");
    })();

    await check("dial is present and large", async () => {
      const dial = page.locator(".dial");
      await dial.waitFor({ state: "visible" });
      const box = await dial.boundingBox();
      assert.ok(box, "dial has no box");
      assert.ok(box.width >= 320, `dial is only ${Math.round(box.width)}px wide`);
      console.log(`        dial: ${Math.round(box.width)}×${Math.round(box.height)}`);
    })();

    await check(`dial renders ${ON_DIAL} slices`, async () => {
      const count = await page.locator(".dial__slice").count();
      assert.equal(count, ON_DIAL, `expected ${ON_DIAL} slices, found ${count}`);
    })();

    await check("clock is running below the dial", async () => {
      const clock = page.locator(".clock");
      await clock.waitFor({ state: "visible" });
      const dial = await page.locator(".dial").boundingBox();
      const clockBox = await clock.boundingBox();
      assert.ok(clockBox.y > dial.y + dial.height - 5, "clock is not below the dial");

      const first = await page.locator(".clock__digits").innerText();
      await page.waitForTimeout(1200);
      const second = await page.locator(".clock__digits").innerText();
      assert.notEqual(first, second, "clock digits did not change in 1.2s");
    })();

    await check("timer dock sits to the right of the dial", async () => {
      const dial = await page.locator(".dial").boundingBox();
      const dock = await page.locator(".dock").boundingBox();
      assert.ok(dock.x > dial.x + dial.width - 5, "dock is not right of the dial");
    })();

    await check("rail shows the day in order", async () => {
      const segments = await page.locator(".rail__seg").count();
      assert.equal(segments, ON_DIAL, `expected ${ON_DIAL} rail segments, found ${segments}`);
    })();

    await check("water meter has 14 slots", async () => {
      const text = await page.locator(".water__count").innerText();
      assert.match(text, /0\/14/, `expected 0/14, got ${text}`);
    })();

    await check("six timed blocks carry timers", async () => {
      const label = await page.locator(".rail__title.mono").innerText();
      // innerText reflects text-transform, so the DOM text is uppercase.
      assert.match(label, /0 of 6/i, `expected "0 of 6", got ${label}`);
    })();

    await check("legend is present", async () => {
      await page.locator(".legend").waitFor({ state: "visible" });
    })();

    await shot(page, "01-hero");

    // ── clicking a slice opens the timer to its right ───────────────────────
    console.log("\nInteraction");

    const slices = page.locator(".dial__slice");
    let studyOpened = false;

    for (let i = 0; i < 12; i += 1) {
      const label = (await slices.nth(i).getAttribute("aria-label")) ?? "";
      if (!label.startsWith("Study — morning")) continue;
      await slices.nth(i).click();
      studyOpened = true;
      break;
    }

    await check("clicking a slice opens its timer panel", async () => {
      assert.ok(studyOpened, "could not find the morning study slice to click");
      const title = await page.locator(".dock__title").innerText();
      assert.match(title, /Study — morning/, `panel shows "${title}"`);
    })();

    await check("panel itemises focused and wasted", async () => {
      const rows = await page.locator(".ledger__key").allInnerTexts();
      const flat = rows.join(" | ");
      for (const want of ["Focused", "Wasted", "before you started", "while paused"]) {
        assert.ok(flat.includes(want), `ledger is missing "${want}". Saw: ${flat}`);
      }
    })();

    await check("slice is keyboard reachable", async () => {
      const focusable = await page.locator('.dial__slice[tabindex="0"]').count();
      assert.equal(focusable, ON_DIAL, `expected ${ON_DIAL} focusable slices, found ${focusable}`);
    })();

    await shot(page, "02-panel");

    // ── start / pause accounting ────────────────────────────────────────────
    // The study block is hardcoded to 10:00 IST, so outside that window Start is
    // correctly refused. That refusal is itself the behaviour under test.
    await check("start is gated outside the block's window", async () => {
      const startBtn = page.locator(".dock__actions .btn--primary");
      const label = (await startBtn.innerText()).trim();
      if (label === "Start") {
        const disabled = await startBtn.isDisabled();
        assert.ok(disabled, "Start was enabled outside the window");
        const gate = await page.locator(".dock__gate").innerText();
        assert.match(gate, /Opens \d+ min before/i, `unhelpful gate message: ${gate}`);
      }
    })();

    // ── start / pause accounting, on a clock we control ──────────────────────
    // Testing the timer honestly needs a block whose window is open, and "now" is not.
    // Playwright's clock API freezes time at a chosen IST instant, so this exercises the
    // real reducer through the real UI instead of asserting on a snapshot of it.
    console.log("\nAccounting (clock frozen at 10:30 IST)");

    const { ctx: acctCtx, p: acct } = await isolatedPage("accounting");

    // 10:30 IST === 05:00 UTC. The morning study block runs 10:00–13:00, so this lands
    // 30 minutes in, comfortably inside the window and past the 5 minute lead.
    //
    // `pauseAt` right after `install`, and it matters. `install()` alone leaves the clock
    // *ticking in real time*; only `fastForward` was supposed to move it, but real
    // milliseconds still pass between reading the ledger, locating the Pause button and
    // dispatching the click. Those milliseconds bank as real focus, so the suite ended up
    // asserting that the click was fast rather than that pause works — it passed on an
    // idle machine and failed the moment Gradle's daemons were holding 1.4 GB. Frozen,
    // the accounting assertions are exact and machine speed stops mattering.
    await acct.clock.install({ time: new Date("2026-10-01T05:00:00Z") });
    await acct.goto(BASE, { waitUntil: "domcontentloaded" });
    await acct.locator(".dial__slice").first().waitFor({ state: "visible" });
    await acct.waitForTimeout(600);

    const ledgerOf = async (p) =>
      // One `evaluate`, not a locator call per cell. Each `innerText()` is a separate
      // round-trip to the browser, and since `wasted` is derived from the clock, five
      // reads taken five milliseconds apart return five different instants — which is
      // how a ledger whose rows must add up exactly reported `1802 !== 1803`. Reading
      // the panel in one go makes every row come from the same `now`.
      p.evaluate(() => {
        const rows = {};
        for (const row of document.querySelectorAll(".ledger__row")) {
          const k = row.querySelector(".ledger__key")?.textContent?.trim();
          const v = row.querySelector(".ledger__val")?.textContent?.trim();
          if (k && v) rows[k] = v;
        }
        return rows;
      });

    const toSeconds = (clock) => {
      const parts = clock.split(":").map(Number);
      return parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    };

    let opened = false;
    for (let i = 0; i < 12; i += 1) {
      const label = (await acct.locator(".dial__slice").nth(i).getAttribute("aria-label")) ?? "";
      if (!label.startsWith("Study — morning")) continue;
      await acct.locator(".dial__slice").nth(i).click();
      opened = true;
      break;
    }

    await check("frozen clock puts the dial at 10:30 with study active", async () => {
      assert.ok(opened, "could not find the morning study slice");
      // The clock renders HH:MM:SS.mmm, so the digits carry a hundredths field too — eight of
      // them, not six. Cut to the seconds before matching.
      //
      // 10:30 and any seconds, not 10:30:00 specifically. `clock.install()` pins the
      // start instant but does not stop the clock, so real time passes between the
      // install and this read; requiring the seconds field to still be `00` was
      // asserting that the test had run in under a second, and it started failing on a
      // busy machine for exactly that reason. The dial's position comes from the same
      // clock, and the minute is what identifies the block.
      const digits = (await acct.locator(".clock__digits").innerText()).replace(/\D/g, "").slice(0, 6);
      assert.match(digits, /^1030\d\d$/, `clock reads ${digits}, expected 10:30:…`);
    })();

    let afterStart = null;

    await check("Start is offered inside the block's window", async () => {
      const btn = acct.locator(".dock__actions .btn--primary");
      // innerText reflects text-transform, so the DOM text is uppercase.
      assert.match((await btn.innerText()).trim(), /^start$/i, "expected a Start button");
      assert.ok(await btn.isEnabled(), "Start was disabled while the block was open");
    })();

    await check("unstarted time is recorded as wasted", async () => {
      // 30 minutes have already elapsed in this block and the timer never started.
      const rows = await ledgerOf(acct);
      const wasted = toSeconds(rows.Wasted ?? "0:00");
      const unstarted = toSeconds(rows["· before you started"] ?? "0:00");
      const focused = toSeconds(rows.Focused ?? "0:00");

      assert.ok(wasted >= 29 * 60, `wasted was only ${rows.Wasted}, expected ~30 min`);
      assert.equal(unstarted, wasted, `unstarted (${rows["· before you started"]}) should equal wasted (${rows.Wasted})`);
      assert.equal(focused, 0, `focused should be 0 before starting, got ${rows.Focused}`);
    })();

    await acct.locator(".dock__actions .btn--primary").click();
    await acct.clock.fastForward(60_000); // one minute of real focus
    await acct.waitForTimeout(400);

    await check("running the timer fills the slice and banks focused time", async () => {
      afterStart = await ledgerOf(acct);
      const focused = toSeconds(afterStart.Focused ?? "0:00");
      const wasted = toSeconds(afterStart.Wasted ?? "0:00");
      const unstarted = toSeconds(afterStart["· before you started"] ?? "0:00");

      assert.ok(focused >= 55 && focused <= 65, `focused was ${afterStart.Focused}, expected ~1 min`);
      assert.ok(
        wasted >= 29 * 60 && wasted <= 32 * 60,
        `wasted should stay near 30 min while focusing, got ${afterStart.Wasted}`,
      );
      // Start was pressed at 10:30 into a window that opened at 10:00, so the unstarted
      // waste is 30 minutes — and it must STAY 30 minutes. An earlier version reset it to
      // zero the moment Start was pressed, which quietly forgave the half hour.
      assert.ok(
        unstarted >= 29 * 60 + 30 && unstarted <= 30 * 60 + 30,
        `unstarted should stay ~30 min, got ${afterStart["· before you started"]}`,
      );
      // The ledger has to add up: waste is exactly the two causes, never a third number. The
      // app's identity is exact; the ±1s is the flooring artefact explained below.
      const paused = toSeconds(afterStart["· while paused"] ?? "0:00");
      assert.ok(
        Math.abs(wasted - (unstarted + paused)) <= 1,
        `wasted (${afterStart.Wasted}) should equal unstarted + paused (${unstarted + paused}), within the 1s flooring artefact`,
      );

      // One minute of a three hour block is 0.55%, which rounds to 1.
      const pct = Number(await acct.locator('.dock__bar[role="progressbar"]').getAttribute("aria-valuenow"));
      assert.ok(pct >= 0 && pct <= 2, `progress was ${pct}%, expected ~1%`);
    })();

await acct.locator(".dock__actions .btn--primary").click(); // Pause

    // Baseline taken *after* the pause lands, not before the click.
    //
    // `clock.install()` leaves the clock ticking in real time — only `fastForward` was
    // meant to move it, but real milliseconds still pass between reading the ledger,
    // locating the button and dispatching the click. Those milliseconds bank as genuine
    // focus, so comparing a pre-click baseline to a post-click reading was really
    // asserting that the click was fast. It passed on an idle machine and failed the
    // moment Gradle's daemons were holding 1.4 GB, which is a test that measures the
    // runner's mood rather than the app.
    //
    // Re-baselining is both correct and stricter about what it means: from the instant
    // the timer stopped, focus must not move at all.
    const pausedStart = await ledgerOf(acct);

    await acct.clock.fastForward(120_000); // two minutes paused
    await acct.waitForTimeout(400);

    await check("pausing stops the slice and records the pause as wasted", async () => {
      const rows = await ledgerOf(acct);
      const paused = toSeconds(rows["· while paused"] ?? "0:00");

      assert.equal(
        rows.Focused,
        pausedStart.Focused,
        `focused grew while paused: ${pausedStart.Focused} -> ${rows.Focused}`,
      );
      assert.ok(paused >= 115 && paused <= 125, `paused was ${rows["· while paused"]}, expected ~2 min`);
      assert.ok(
        toSeconds(rows.Wasted ?? "0:00") >= 31 * 60,
        `wasted should include the pause, got ${rows.Wasted}`,
      );
      // A one-second tolerance, and it is a rendering artefact rather than slack in the
      // assertion. The app's own identity is exact — `pausedMs = wastedMs - unstartedMs`
      // — but the three rows are formatted by flooring each duration independently, so
      // `floor(a) + floor(b)` can be one less than `floor(a + b)`. Requiring exact
      // equality between three separately-floored strings failed about one run in three
      // on values that were, to the millisecond, correct.
      assert.ok(
        Math.abs(toSeconds(rows.Wasted ?? "0:00") - (toSeconds(rows["· before you started"] ?? "0:00") + paused)) <= 1,
        `wasted (${rows.Wasted}) should equal unstarted + paused (${toSeconds(rows["· before you started"] ?? "0:00") + paused}), within the 1s flooring artefact`,
      );

      const pct = Number(await acct.locator('.dock__bar[role="progressbar"]').getAttribute("aria-valuenow"));
      assert.ok(pct >= 0 && pct <= 2, `progress moved while paused: ${pct}%`);
    })();

    await acct.screenshot({ path: join(OUT, "06-timer-running.png") });
    report.screenshots.push("06-timer-running.png");

    // Band lengths are in units of the slice's own arc, not minutes. Morning study is
    // 3 hours = 18 degrees = 5 units of the dial, so 33 wasted minutes of 180 reads as
    // ~18, and one focused minute reads as ~0.55.
    await check("the lit arc registered focus, and stayed still while paused", async () => {
      const lit = acct.locator(".dial__slice[aria-label^='Study — morning'] .dial__waste ~ .dial__lit, .dial__slice[aria-label^='Study — morning'] .dial__lit");
      const waste = acct.locator(".dial__slice[aria-label^='Study — morning'] .dial__waste");

      const litLen = Number((await lit.first().getAttribute("stroke-dasharray")).split(" ")[0]);
      const wasteLen = Number((await waste.first().getAttribute("stroke-dasharray")).split(" ")[0]);

      assert.ok(litLen > 0.3 && litLen < 2, `lit band is ${litLen} units, expected ~0.55`);
      assert.ok(wasteLen > 16 && wasteLen < 21, `waste band is ${wasteLen} units, expected ~18`);
      assert.ok(wasteLen > litLen * 10, "waste should dwarf focus this early in the block");

      const before = litLen;
      await acct.clock.fastForward(60_000);
      await acct.waitForTimeout(400);
      const stillRunning = Number((await lit.first().getAttribute("stroke-dasharray")).split(" ")[0]);
      assert.ok(
        Math.abs(stillRunning - before) < 0.05,
        `lit band moved while paused: ${before} -> ${stillRunning}`,
      );
    })();

    await acctCtx.close();

    // ── the headline feature: the panel opens itself 5 minutes early ────────
    console.log("\nReminder");

    const { ctx: dueCtx, p: due } = await isolatedPage("reminder");

    // 09:57 IST === 04:27 UTC. Morning study starts at 10:00, so this is 3 minutes
    // inside the 5 minute lead window and the popup must already have fired.
    await due.clock.install({ time: new Date("2026-10-01T04:27:00Z") });
    await due.goto(BASE, { waitUntil: "domcontentloaded" });
    await due.locator(".dial__slice").first().waitFor({ state: "attached" });
    await due.waitForTimeout(1200);

    await check("a block inside the lead window opens its own timer panel", async () => {
      const title = (await due.locator(".dock__title").innerText()).trim();
      assert.match(title, /Study — morning/, `panel opened for "${title}"`);

      // Nothing has run yet, so the ledger must be entirely zero. This is the check
      // that catches state leaking in from another scenario through shared storage.
      const rows = await ledgerOf(due);
      for (const key of ["Focused", "Wasted", "· before you started", "· while paused"]) {
        assert.equal(rows[key], "00:00", `${key} was ${rows[key]}, expected 00:00 on a clean day`);
      }
    })();

    await check("a block inside the lead window raises a toast with a Start action", async () => {
      const toast = due.locator(".toast").first();
      await toast.waitFor({ state: "visible", timeout: 4000 });
      const heading = (await toast.locator(".toast__title").innerText()).trim();
      assert.match(heading, /in five minutes/i, `toast read "${heading}"`);
      assert.ok(
        (await toast.locator(".toast__action").count()) > 0,
        "the toast offers no way to act on it",
      );
    })();

    await check("Start is offered early, inside the lead window", async () => {
      const btn = due.locator(".dock__actions .btn--primary");
      assert.match((await btn.innerText()).trim(), /^start$/i, "expected an enabled Start");
      assert.ok(await btn.isEnabled(), "Start was disabled during the lead window");
    })();

    await check("a block outside the lead window stays quiet", async () => {
      const { ctx: outCtx, p: outside } = await isolatedPage("quiet");
      // 12:00 IST, mid-morning-study. Nothing is within five minutes of starting.
      await outside.clock.install({ time: new Date("2026-10-01T06:30:00Z") });
      await outside.goto(BASE, { waitUntil: "domcontentloaded" });
      await outside.locator(".dial__slice").first().waitFor({ state: "attached" });
      await outside.waitForTimeout(1200);
      const toasts = await outside.locator(".toast").count();
      assert.equal(toasts, 0, `${toasts} toast(s) fired with nothing due`);
      await outCtx.close();
    });

    await due.screenshot({ path: join(OUT, "07-reminder-popup.png") });
    report.screenshots.push("07-reminder-popup.png");
    await dueCtx.close();

    // ── missed blocks turn red ──────────────────────────────────────────────
    await check("past blocks read as passed, not crashed", async () => {
      const missed = await page.locator(".rail__seg--missed, .rail__seg--done").count();
      console.log(`        ${missed} segment(s) resolved as done or missed`);
      // At the current hour there may legitimately be none. Assert the class vocabulary
      // exists instead of assuming an outcome.
      const attrs = await page.locator(".rail__seg").first().getAttribute("class");
      assert.ok(attrs.includes("rail__seg"), "rail segments lost their base class");
    })();

    // ── persistence ─────────────────────────────────────────────────────────
    await check("state survives a reload", async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".dial").waitFor({ state: "visible" });
      const slices = await page.locator(".dial__slice").count();
      assert.equal(slices, ON_DIAL, `dial did not re-render: ${slices} slices, expected ${ON_DIAL}`);
    })();

    // ── responsive ──────────────────────────────────────────────────────────
    console.log("\nLayout");

    await check("dial is the dominant element on desktop", async () => {
      const dial = await page.locator(".dial").boundingBox();
      const shell = await page.locator(".shell").boundingBox();
      assert.ok(
        dial.width > shell.width * 0.3,
        `dial is ${Math.round(dial.width)}px in a ${Math.round(shell.width)}px shell — not dominant`,
      );
    })();

    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.waitForTimeout(400);
    await shot(page, "03-desktop", true);

    for (const [name, size] of [
      ["04-tablet", { width: 900, height: 1200 }],
      ["05-mobile", { width: 390, height: 900 }],
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(500);
      await shot(page, name, true);
    }

    await check("no horizontal overflow on mobile", async () => {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow <= 1) return;

      // Name the culprits rather than just reporting a number, so the next fix is obvious.
      const culprits = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const out = [];
        document.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.right > vw + 1) {
            out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").split(" ")[0]} → ${Math.round(r.right)}px`);
          }
        });
        return out.slice(0, 6);
      });
      assert.fail(`page overflows by ${overflow}px at 390px wide. Widest: ${culprits.join(", ")}`);
    })();

    // ── accessibility floor ─────────────────────────────────────────────────
    console.log("\nAccessibility");

    await page.setViewportSize({ width: 1600, height: 1100 });

    await check("every slice has an accessible name", async () => {
      const names = await page.locator(".dial__slice").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("aria-label") ?? ""),
      );
      const blank = names.filter((n) => n.trim().length < 8);
      assert.equal(blank.length, 0, `${blank.length} slice(s) have no usable label`);
    })();

    await check("status is not conveyed by colour alone", async () => {
      const described = await page.locator(".dial__slice").evaluateAll((nodes) =>
        nodes.every((n) => (n.getAttribute("aria-label") ?? "").length > 40),
      );
      assert.ok(described, "slice labels are too short to carry their state as text");
    })();

    await check("reduced motion is respected", async () => {
      const { ctx: rmCtx, p: emulated } = await isolatedPage("reduced-motion");
      await emulated.emulateMedia({ reducedMotion: "reduce" });
      await emulated.goto(BASE, { waitUntil: "networkidle" });
      const duration = await emulated
        .locator(".toast, .clock__colon")
        .first()
        .evaluate((n) => {
          const s = getComputedStyle(n);
          return { duration: s.animationDuration, iteration: s.animationIterationCount };
        })
        .catch(() => ({ duration: "0.01ms", iteration: "1" }));
      assert.ok(
        parseFloat(duration.duration) < 0.05 || duration.iteration === "1",
        `animation still running under reduced motion: ${JSON.stringify(duration)}`,
      );
      await rmCtx.close();
    })();

    await check("interactive controls are keyboard focusable", async () => {
      const focused = await page.evaluate(() => {
        const el = document.querySelector(".dial__slice");
        el?.focus();
        return document.activeElement === el;
      });
      assert.ok(focused, "a slice could not take focus");
    })();

    /* ── the archive ───────────────────────────────────────────────────────── */
    // The logs page gets its own context and a *seeded* archive, because the thing worth
    // verifying is not that an empty page renders — it is that a stored day comes back
    // with its numbers intact, that the live today is kept separate from it, and that
    // the ledger under a day lists only the blocks that actually had timers.
    const { ctx: logsCtx, p: logs } = await isolatedPage("logs");

    const seedArchive = [
      { date: "2026-09-29", perfect: false },
      { date: "2026-09-30", perfect: true },
      { date: "2026-10-01", perfect: false },
    ];

    await logs.addInitScript((records) => {
      const BLOCK_IDS = [
        "exercise", "ready", "study-morning", "lunch", "study-afternoon",
        "break", "study-evening", "dinner", "study-night", "hobby", "sleep",
      ];
      const TIMED = new Set(["exercise", "study-morning", "study-afternoon", "study-evening", "study-night", "hobby"]);
      const PLANNED = {
        exercise: 40, "study-morning": 180, "study-afternoon": 180,
        "study-evening": 120, "study-night": 60, hobby: 120,
      };
      // Three days, each fully settled, so every block reads done or missed rather than
      // depending on when the clock happens to be.
      const archive = records.map(({ date, perfect }, index) => {
        const blocks = BLOCK_IDS.map((id) => {
          const timed = TIMED.has(id);
          const plannedMs = (PLANNED[id] ?? 60) * 60_000;
          const met = perfect || index === 2 ? timed : timed && id !== "study-night";
          const focusedMs = timed ? (met ? plannedMs : Math.round(plannedMs * 0.25)) : 0;
          return {
            id,
            label: id,
            title: id,
            kind: TIMED.has(id) ? (id === "exercise" ? "exercise" : id === "hobby" ? "hobby" : "study") : "life",
            timed,
            plannedMs,
            focusedMs,
            // Non-timed blocks carry a full window of "waste" in the archive. Listing
            // them would claim ~14 hours lost, so this is the assertion that the UI
            // filters on `timed`.
            wastedMs: timed ? plannedMs - focusedMs : plannedMs,
            unstartedMs: timed ? (plannedMs - focusedMs) / 2 : 0,
            pausedMs: timed ? (plannedMs - focusedMs) / 2 : 0,
            status: timed ? (met ? "done" : "missed") : "passthrough",
            startedAt: 1,
            completedAt: 2,
          };
        });
        const timedBlocks = blocks.filter((b) => b.timed);
        const doneBlocks = timedBlocks.filter((b) => b.status === "done").length;
        const missedBlocks = timedBlocks.filter((b) => b.status === "missed").length;
        const planned = timedBlocks.reduce((s, b) => s + b.plannedMs, 0);
        const focused = timedBlocks.reduce((s, b) => s + b.focusedMs, 0);
        return {
          date,
          archivedAt: Date.parse(`${date}T20:00:00Z`),
          blocks,
          plannedMs: planned,
          focusedMs: focused,
          wastedMs: planned - focused,
          timedBlocks: timedBlocks.length,
          doneBlocks,
          missedBlocks,
          waterTotal: 14,
          waterDone: perfect ? 14 : 9,
          efficiency: Math.round((focused / planned) * 100),
          perfect,
        };
      });
      window.localStorage.setItem("day-dial:history:v1", JSON.stringify(archive));
    }, seedArchive);

    await check("logs page renders a seeded archive", async () => {
      await logs.goto(`${BASE}/logs`, { waitUntil: "load" });
      await logs.waitForSelector(".logs__row", { timeout: STEP_TIMEOUT });
      const rows = await logs.locator(".logs__row").count();
      // Three archived days plus the pinned live card for today.
      assert.strictEqual(rows, 4, `expected 4 day rows, saw ${rows}`);
    })();

    await check("summary tiles read the archive, not today's numbers", async () => {
      // innerText for the spacing it preserves between elements, lowercased before the
      // assertion: the tiles are uppercased in CSS and innerText returns the *rendered*
      // casing, so a pattern written against the source string fails on a page that is
      // displaying exactly the right numbers. textContent is the opposite trap — it keeps
      // the source casing but collapses "3" against its neighbours into "tracked3".
      const tiles = (await logs.locator(".stat").allInnerTexts()).map((t) => t.toLowerCase());
      assert.ok(tiles.length >= 5, `expected summary tiles, saw ${tiles.length}`);
      assert.ok(
        tiles.some((t) => t.includes("days tracked") && /\b3\b/.test(t)),
        `no tile reported the 3 archived days: ${JSON.stringify(tiles)}`,
      );
    })();

    await check("a stored day keeps its focus total and its missed count", async () => {
      const row = logs.locator('.logs__row[data-date="2026-09-30"]');
      await row.waitFor({ timeout: STEP_TIMEOUT });
      const text = await row.textContent();
      // 2026-09-30 is the perfect day: 6 of 6 timed blocks, nothing missed.
      assert.ok(/6\s*\/\s*6/.test(text), `perfect day did not report 6/6 blocks: ${text}`);
      assert.ok(/perfect/i.test(text), `perfect day was not marked: ${text}`);
    })();

    await check("the ledger under a day lists only timed blocks", async () => {
      const row = logs.locator('.logs__row[data-date="2026-09-30"]');
      await row.click();
      const panel = row.locator("xpath=following-sibling::*[1]");
      await panel.waitFor({ timeout: STEP_TIMEOUT });
      const titles = await panel.locator(".logs__block-title").allInnerTexts();
      assert.strictEqual(titles.length, 6, `expected 6 timed blocks, saw ${titles.length}: ${titles}`);
      // Sleep, lunch, dinner and break have no timer and therefore nothing to waste.
      const joined = titles.join(" ").toLowerCase();
      for (const ghost of ["sleep", "lunch", "dinner", "break", "ready"]) {
        assert.ok(!joined.includes(ghost), `non-timed block "${ghost}" leaked into the ledger`);
      }
    })();

    await check("today is shown live and is not counted as archived", async () => {
      const live = logs.locator(".logs__chip--live").first();
      assert.ok(await live.count(), "today is not marked live");
      const body = await logs.locator("main").textContent();
      assert.ok(/days archived/i.test(body), "archive count missing");
    })();

    await check("logs has no horizontal overflow on a phone viewport", async () => {
      const phone = await logsCtx.newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(`${BASE}/logs`, { waitUntil: "load" });
      await phone.waitForSelector(".logs__row", { timeout: STEP_TIMEOUT });
      const overflow = await phone.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      await shot(phone, "08-logs-mobile", true);
      await phone.close();
      assert.ok(overflow <= 0, `logs overflows by ${overflow}px at 390px wide`);
    })();

    await check("a day filed by midnight reaches the archive", async () => {
      // The rollover path, exercised end to end rather than trusted: a snapshot dated
      // yesterday, opened today, must be archived instead of silently overwritten.
      const { ctx: rollCtx, p: roll } = await isolatedPage("rollover");
      await roll.addInitScript(() => {
        const yesterday = new Date(Date.now() - 86_400_000);
        const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(yesterday);
        window.localStorage.setItem(
          "day-dial:v1",
          JSON.stringify({
            date: iso,
            blocks: {
              "study-morning": { focusedMs: 120_000, startedAt: 1, resumedAt: null, running: false, completedAt: 2 },
            },
            water: [],
            notifiedBlocks: [],
          }),
        );
      });
      await roll.goto(`${BASE}/`, { waitUntil: "load" });
      await roll.waitForSelector(".dial", { timeout: STEP_TIMEOUT });
      const filed = await roll.evaluate(() => {
        const raw = window.localStorage.getItem("day-dial:history:v1");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return { count: parsed.length, date: parsed[0]?.date, focused: parsed[0]?.focusedMs };
      });
      assert.ok(filed, "nothing was archived — a finished day was overwritten");
      assert.ok(filed.focused > 0, "the archived day kept no focus");
      await rollCtx.close();
    })();

    await shot(logs, "09-logs-desktop", true);
    await logsCtx.close();
  } finally {
    // ── verdict ─────────────────────────────────────────────────────────────
    const errors = report.console.filter((c) => c.type === "error");
    const warnings = report.console.filter((c) => c.type === "warning");
    const failed = report.checks.filter((c) => !c.ok);

    report.summary = {
      passed: report.checks.filter((c) => c.ok).length,
      failed: failed.length,
      consoleErrors: errors.length,
      consoleWarnings: warnings.length,
      pageErrors: report.pageErrors.length,
      failedRequests: report.failedRequests.length,
    };

    await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));

    console.log(`\n${"─".repeat(58)}`);
    console.log(`checks          ${report.summary.passed} passed, ${report.summary.failed} failed`);
    console.log(`console         ${errors.length} error(s), ${warnings.length} warning(s)`);
    console.log(`page errors     ${report.pageErrors.length}`);
    console.log(`failed requests ${report.failedRequests.length}`);
    console.log(`artifacts       ${OUT}`);
    console.log(`${"─".repeat(58)}\n`);

    if (failed.length) {
      console.log("Failures:");
      for (const f of failed) console.log(`  ✗ ${f.name}\n    ${f.error}`);
      console.log("");
    }
    if (errors.length) {
      console.log("Console errors:");
      for (const e of errors) console.log(`  ✗ ${e.text.slice(0, 200)}`);
      console.log("");
    }
    if (report.pageErrors.length) {
      console.log("Page errors:");
      for (const e of report.pageErrors) console.log(`  ✗ ${e.slice(0, 200)}`);
      console.log("");
    }

    await context.close();
    await browser.close();
  }

  const s = report.summary;
  const clean = s.failed === 0 && s.consoleErrors === 0 && s.pageErrors === 0 && s.failedRequests === 0;
  console.log(clean ? "All checks passed.\n" : "Problems found — see above and .verify/report.json\n");
  process.exit(clean ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nVerifier crashed: ${error.stack ?? error.message}\n`);
  process.exit(3);
});