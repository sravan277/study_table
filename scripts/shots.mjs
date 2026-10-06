/**
 * Screenshot the dial at a chosen IST time, with the clock frozen there.
 *
 * The hero looks very different at 09:00 (nothing has happened yet) than at 21:30
 * (most of the day is spent, one block missed, a timer mid-run), and a design can only
 * be judged on the state people will actually see. This is how those states get looked
 * at without waiting until evening.
 *
 *   node scripts/shots.mjs
 *   node scripts/shots.mjs --url http://localhost:3000
 */

import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", ".verify", "states");

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const BASE = arg("url", "http://localhost:3000");

/** 10:30 IST === 05:00 UTC. IST is a fixed +05:30 with no DST. */
const SCENARIOS = [
  { name: "a-morning-1030", ist: "2026-10-01T05:00:00Z", focus: "study-morning" },
  { name: "b-afternoon-1545", ist: "2026-10-01T10:15:00Z", focus: "study-afternoon" },
  { name: "c-evening-2130", ist: "2026-10-01T16:00:00Z", focus: "study-night" },
];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

for (const s of SCENARIOS) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1150 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(s.ist) });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator(".dial__slice").first().waitFor({ state: "attached" });
  await page.waitForTimeout(500);

  // Open the scenario's block, and run its timer for a while so the lit band, the
  // waste band and the ledger all have something real to show.
  for (let i = 0; i < 12; i += 1) {
    const label = (await page.locator(".dial__slice").nth(i).getAttribute("aria-label")) ?? "";
    if (label.startsWith("Study —")) {
      await page.locator(".dial__slice").nth(i).click();
      break;
    }
  }
  await page.waitForTimeout(300);

  const start = page.locator(".dock__actions .btn--primary");
  if ((await start.count()) && (await start.innerText()).trim().toLowerCase() === "start") {
    await start.click();
    await page.clock.fastForward(52 * 60_000);
    await page.waitForTimeout(400);
  }

  await page.screenshot({ path: join(OUT, `${s.name}.png`) });
  await page.screenshot({ path: join(OUT, `${s.name}-full.png`), fullPage: true });
  console.log(`shot ${s.name}`);

  await context.close();
}

await browser.close();
console.log(`\nwritten to ${OUT}\n`);
