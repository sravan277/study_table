/**
 * The durable archive.
 *
 * The day snapshot under `day-dial:v1` is thrown away at midnight — that is what makes it
 * trustworthy, because nothing stale can carry into today. The price is that yesterday's
 * numbers are gone, which is the one thing a planner should never lose. So the archive is
 * a separate key holding one immutable-ish record per day, written at rollover.
 *
 * Two rules shape everything here:
 *
 *  1. Archived numbers are produced by `computeBlockMetrics`, never recomputed. A history
 *     that disagreed with the dial would be worse than no history, so there is exactly
 *     one implementation of "how much of this block was wasted".
 *  2. Reading the archive can never throw. It is untrusted JSON from an older build, a
 *     hand edit, or a truncated write, and a corrupt archive must not stop today's timer
 *     from drawing. Every read falls back to an empty archive instead.
 */

import { BLOCK_BY_ID, EMPTY_STATE, buildWaterSlots, computeMetrics, computeStats } from "./metrics";
import { clamp } from "./time";
import type { BlockId, BlockKind, BlockStatus, DaySnapshot } from "./types";

/**
 * A rolling year of history.
 *
 * localStorage shares one origin-wide quota of roughly 5MB, and on a phone the browser
 * starts refusing writes — or evicting the origin — long before that. The archive has to
 * live inside that quota alongside the day snapshot, because a write failure there takes
 * the live timer down too. One record is a few KB at worst, 400 of them is a rounding
 * error, and 400 days is more history than anyone scrolls back through.
 */
export const MAX_RECORDS = 400;

const KEY = "day-dial:history:v1";

const BLOCK_KINDS = ["study", "exercise", "hobby", "life"] satisfies readonly BlockKind[];
const BLOCK_STATUSES = [
  "future",
  "due",
  "active",
  "done",
  "missed",
  "passthrough",
] satisfies readonly BlockStatus[];

/** One block as it stood when the day was archived. Labels are copied, not looked up. */
export interface DayRecordBlock {
  id: BlockId;
  label: string;
  title: string;
  kind: BlockKind;
  timed: boolean;
  plannedMs: number;
  focusedMs: number;
  wastedMs: number;
  unstartedMs: number;
  pausedMs: number;
  status: BlockStatus;
  startedAt: number | null;
  completedAt: number | null;
}

export interface DayRecord {
  /** ISO date in IST, e.g. "2026-10-01" */
  date: string;
  /** epoch ms when this day was written to the archive */
  archivedAt: number;
  blocks: DayRecordBlock[];
  plannedMs: number;
  focusedMs: number;
  wastedMs: number;
  timedBlocks: number;
  doneBlocks: number;
  missedBlocks: number;
  waterTotal: number;
  waterDone: number;
  /** 0-100, focused/planned across timed blocks */
  efficiency: number;
  /** every timed block hit its target */
  perfect: boolean;
}

export interface HistorySummary {
  days: number;
  perfectDays: number;
  totalPlannedMs: number;
  totalFocusedMs: number;
  totalWastedMs: number;
  /** mean efficiency across days that had any focus at all */
  avgEfficiency: number;
  currentStreak: number;
  bestStreak: number;
}

export interface MonthGroup {
  /** "2026-10" */
  key: string;
  label: string;
  records: DayRecord[];
}

/* ------------------------------------------------------------------ *
 * Date helpers
 *
 * Every date in the archive is an IST calendar day rendered as a bare
 * "YYYY-MM-DD". Comparing two of those as strings is correct and cheap;
 * the only thing that needs real arithmetic is "are these two days
 * adjacent", which needs a day number with no timezone attached.
 * ------------------------------------------------------------------ */

/**
 * A `Date` anchored to a fixed UTC instant on the given ISO day, or null if the string
 * does not name a day that exists.
 *
 * Anchoring at UTC *noon* rather than midnight is deliberate. `new Date("2026-10-01")`
 * parses as UTC midnight, which is 05:30 on the first in IST and the previous evening in
 * any zone behind UTC — so formatting that instant in the device's zone is exactly how a
 * month header ends up reading "September 2026". Noon leaves no edge to fall off.
 *
 * The round-trip check is not paranoia: `Date.UTC` silently rolls 2026-02-31 over into
 * March 3, so a string can have the right shape and still name a day that never happened.
 */
function utcAnchor(date: string, hour: number): Date | null {
  const parts = date.split("-");
  if (parts.length !== 3) return null;
  const [year, month, day] = parts.map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day, hour));
  if (Number.isNaN(anchor.getTime())) return null;
  if (
    anchor.getUTCFullYear() !== year ||
    anchor.getUTCMonth() !== month - 1 ||
    anchor.getUTCDate() !== day
  ) {
    return null;
  }
  return anchor;
}

/** Shape *and* calendar check. A hand-typed date that is not real is not a date. */
function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && utcAnchor(value, 0) !== null;
}

/**
 * Whole days since the epoch, for adjacency tests. UTC arithmetic only, so no DST
 * boundary can shift a day by a fraction and break an otherwise real run.
 *
 * An unparseable date yields NaN, which fails every adjacency comparison and so breaks a
 * streak rather than silently welding two unrelated days together.
 */
function dayOrdinal(date: string): number {
  const anchor = utcAnchor(date, 0);
  return anchor === null ? Number.NaN : Math.round(anchor.getTime() / 86_400_000);
}

/* ------------------------------------------------------------------ *
 * Defensive parsing
 *
 * Validation is per record, never per file. One bad day must not cost the
 * other 399, and the shape of the damage from a corrupt archive is always
 * "some records are wrong", never "all of them are".
 * ------------------------------------------------------------------ */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A duration. Never negative — metrics.ts clamps, so a negative means a bad payload. */
function isDuration(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/** An epoch ms that may legitimately be absent. */
function isNullableStamp(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isBlockStatus(value: unknown): value is BlockStatus {
  return typeof value === "string" && (BLOCK_STATUSES as readonly string[]).includes(value);
}

function parseBlock(raw: unknown): DayRecordBlock | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;

  // The id has to exist in today's schedule, otherwise the block is from a version of the
  // day this build has never heard of and nothing about it can be trusted.
  if (typeof v.id !== "string" || !BLOCK_BY_ID.has(v.id as BlockId)) return null;
  if (typeof v.label !== "string" || typeof v.title !== "string") return null;
  if (typeof v.kind !== "string" || !(BLOCK_KINDS as readonly string[]).includes(v.kind)) return null;
  if (typeof v.timed !== "boolean") return null;
  if (
    !isDuration(v.plannedMs) ||
    !isDuration(v.focusedMs) ||
    !isDuration(v.wastedMs) ||
    !isDuration(v.unstartedMs) ||
    !isDuration(v.pausedMs)
  ) {
    return null;
  }
  if (!isBlockStatus(v.status)) return null;
  if (!isNullableStamp(v.startedAt) || !isNullableStamp(v.completedAt)) return null;

  return {
    id: v.id as BlockId,
    label: v.label,
    title: v.title,
    kind: v.kind as BlockKind,
    timed: v.timed,
    plannedMs: v.plannedMs,
    focusedMs: v.focusedMs,
    wastedMs: v.wastedMs,
    unstartedMs: v.unstartedMs,
    pausedMs: v.pausedMs,
    status: v.status,
    startedAt: v.startedAt,
    completedAt: v.completedAt,
  };
}

function parseRecord(raw: unknown): DayRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;

  // The date is the archive's primary key. A record without a trustworthy one cannot be
  // placed, cannot be found by recordForDate, and cannot join a streak.
  if (!isIsoDate(v.date)) return null;
  if (!isFiniteNumber(v.archivedAt)) return null;
  if (!Array.isArray(v.blocks)) return null;

  const blocks: DayRecordBlock[] = [];
  for (const entry of v.blocks) {
    const block = parseBlock(entry);
    // One unparseable block invalidates the record rather than being dropped on its own:
    // a day whose block list no longer matches the schedule would show a total that does
    // not add up to the rows above it.
    if (block === null) return null;
    blocks.push(block);
  }

  if (!isDuration(v.plannedMs) || !isDuration(v.focusedMs) || !isDuration(v.wastedMs)) return null;
  if (!isCount(v.timedBlocks) || !isCount(v.doneBlocks) || !isCount(v.missedBlocks)) return null;
  if (!isCount(v.waterTotal) || !isCount(v.waterDone)) return null;
  if (!isFiniteNumber(v.efficiency)) return null;
  if (typeof v.perfect !== "boolean") return null;

  return {
    date: v.date,
    archivedAt: v.archivedAt,
    blocks,
    plannedMs: v.plannedMs,
    focusedMs: v.focusedMs,
    wastedMs: v.wastedMs,
    timedBlocks: v.timedBlocks,
    doneBlocks: v.doneBlocks,
    missedBlocks: v.missedBlocks,
    waterTotal: v.waterTotal,
    waterDone: v.waterDone,
    // Clamped rather than rejected. Out of range is repairable — it can only come from a
    // divide-by-something bug in an older build — and discarding a whole day of real
    // history over one bad percentage is a far worse failure than rounding it back into
    // 0-100.
    efficiency: Math.round(clamp(v.efficiency, 0, 100)),
    perfect: v.perfect,
  };
}

/**
 * The archive's one canonical form: valid records only, one per date, newest date first,
 * capped.
 *
 * Applied on write as well as on read, so the file in localStorage is always in this shape.
 * Order that depends on which code path last touched the archive means a reader assuming
 * "newest first" renders a month upside down on the day it matters.
 */
function canonical(raw: unknown): DayRecord[] {
  if (!Array.isArray(raw)) return [];

  const latestByDate = new Map<string, DayRecord>();
  for (const entry of raw) {
    const record = parseRecord(entry);
    if (record === null) continue;
    // upsert already guarantees uniqueness, so this only ever fires on a hand-edited file.
    // Keep the most recently written copy, which is the one reflecting the final state of
    // that day.
    const held = latestByDate.get(record.date);
    if (held === undefined || record.archivedAt >= held.archivedAt) {
      latestByDate.set(record.date, record);
    }
  }

  return [...latestByDate.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    // Capped after sorting so the survivors are the newest days, not whichever days
    // happened to be written first.
    .slice(0, MAX_RECORDS);
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Some private-browsing modes throw merely on *touching* window.localStorage, not
    // just on writing to it, so even reading the handle can fail.
    return null;
  }
}

/**
 * Read the archive, newest first. Returns `[]` for anything unusable — missing key,
 * unparseable JSON, wrong top-level shape — because every caller can already cope with
 * having no history, and none of them can cope with throwing mid-render.
 */
export function loadHistory(): DayRecord[] {
  const store = storage();
  if (!store) return [];
  let raw: unknown;
  try {
    const text = store.getItem(KEY);
    if (!text) return [];
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  return canonical(raw);
}

function writeHistory(records: DayRecord[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(records));
  } catch {
    // Quota or private-browsing failure. Nothing in the app reads this key except the
    // history views, so the worst case is an archive that quietly stops growing while
    // today's timer carries on unaffected.
  }
}

/**
 * Replace the archive wholesale.
 *
 * Synchronous on purpose, unlike the day snapshot: this runs once per day, not four times
 * a second, so there is no debounce to hide behind — and the moment it matters most is
 * page unload, where a pending 400ms timer may never fire.
 */
export function saveHistory(records: DayRecord[]): void {
  writeHistory(canonical(records));
}

/**
 * Insert or replace one day and return the new archive, newest first.
 *
 * Replacement, not append, is the whole point: a day gets archived at rollover and again
 * whenever it is archived deliberately, and two records for the same date would double
 * every count in the history view.
 */
export function upsertHistory(record: DayRecord): DayRecord[] {
  const without = loadHistory().filter((r) => r.date !== record.date);
  const next = canonical([record, ...without]);
  writeHistory(next);
  return next;
}

export function clearHistory(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Same reasoning as the write failure: nothing here is load-bearing for the timer.
  }
}

/* ------------------------------------------------------------------ *
 * Archiving a day
 * ------------------------------------------------------------------ */

/**
 * Freeze a live snapshot into a record.
 *
 * Every number below comes out of `computeBlockMetrics` — `computeMetrics` is exactly
 * `BLOCKS.map((b) => computeBlockMetrics(...))` — so the archive cannot drift from the
 * dial it was drawn from. The waste split, the clamping, the unstarted/paused derivation:
 * all of it is decided once, in metrics.ts.
 *
 * Pass the snapshot *before* the store's rollover clears it. The record is filed under
 * `snapshot.date`, not `isoDate(now)`, because the caller's snapshot is the thing that
 * knows which day these counters belong to, and at the moment of rollover the two differ.
 *
 * Pass the archived day's own window too, not the current clock:
 *
 *     const midnight = dayStartMs(now);
 *     archiveSnapshot(prev, midnight - 86_400_000, midnight + 1);
 *
 * At rollover `dayStartMs(now)` is already today's midnight, so handing that in alongside
 * `now` is not a smaller error, it is an inverted one. Focus and planned survive, since
 * every window is the same length every day, but elapsed collapses to zero — waste,
 * unstarted and paused all archive as 0, blocks that met their target resolve to "done"
 * and the rest read "future". The day then reads as flawless, which is the one report a
 * history must never get wrong.
 *
 * The trailing millisecond is what closes the 22:00 → 24:00 window, which otherwise ends
 * exactly on the boundary and resolves to "active" — neither done nor missed, forever.
 * Elapsed and focused are both clamped to the window, so a millisecond past midnight
 * inflates nothing.
 */
export function archiveSnapshot(snapshot: DaySnapshot, dayStart: number, now: number): DayRecord {
  // BLOCKS order, not alphabetical: the schedule runs 08:30 → midnight and sleep last,
  // which is the order the dial rotates in. Sorting by id would put "break" at the top and
  // "sleep" in the middle of the day.
  const metrics = computeMetrics(dayStart, now, snapshot.blocks);

  const blocks = metrics.map((m): DayRecordBlock => {
    const state = snapshot.blocks[m.block.id] ?? EMPTY_STATE;
    return {
      id: m.block.id,
      label: m.block.label,
      title: m.block.title,
      kind: m.block.kind,
      timed: m.block.timed,
      // Non-timed blocks are archived exactly as the dial reported them, which means a
      // passthrough row carries plannedMs equal to its window length and wastedMs equal to
      // however much of that window elapsed. That reads alarming in a raw dump, but it is
      // not a claim about the user: computeStats ignores passthrough blocks, so the day's
      // totals and efficiency only ever cover timed work. Special-casing them here would
      // mean the archive and the dial disagreed about the same block.
      plannedMs: m.plannedMs,
      focusedMs: m.focusedMs,
      wastedMs: m.wastedMs,
      unstartedMs: m.unstartedMs,
      pausedMs: m.pausedMs,
      status: m.status,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    };
  });

  // Re-derive the slot set so the archived count is the fourteen the schedule defines
  // rather than whatever survived in a hand-edited store. Acknowledgements carry across by
  // minute, so nothing that was actually ticked off is lost.
  const water = buildWaterSlots(
    dayStart,
    snapshot.water.filter((w) => typeof w?.atMin === "number"),
  );

  // The same totals the header shows, from the same function. No second arithmetic path.
  const stats = computeStats(metrics, water);

  return {
    date: snapshot.date,
    archivedAt: now,
    blocks,
    plannedMs: stats.plannedMs,
    focusedMs: stats.focusedMs,
    wastedMs: stats.wastedMs,
    timedBlocks: stats.timedBlocks,
    doneBlocks: stats.doneBlocks,
    missedBlocks: stats.missedBlocks,
    waterTotal: stats.waterTotal,
    waterDone: stats.waterDone,
    efficiency: stats.efficiency,
    // A timed block counts as done when it met its target or was explicitly completed, so
    // this means "every timed block hit its target", not "every timed block was closed
    // normally". The zero guard matters: a record with no timed blocks at all has not
    // earned a perfect day, and without the guard `0 === 0` would award one.
    perfect: stats.timedBlocks > 0 && stats.doneBlocks === stats.timedBlocks,
  };
}

/* ------------------------------------------------------------------ *
 * Reading the archive
 * ------------------------------------------------------------------ */

/**
 * Roll up an archive.
 *
 * Streaks are counted over recorded days only, and that has a consequence worth stating
 * plainly: a day with no record — the app was never opened, or the browser cache was
 * cleared — leaves a hole in the calendar and the streak restarts, even though nothing was
 * failed that day. Inventing empty days to bridge the gap would be a nicer number and a
 * bigger lie, so the gap stays a gap.
 */
export function summarise(records: DayRecord[]): HistorySummary {
  const ascending = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let totalPlannedMs = 0;
  let totalFocusedMs = 0;
  let totalWastedMs = 0;
  let perfectDays = 0;

  // Only days with real focus are averaged. A record with zero focusedMs is a day the app
  // was never opened, and counting it as 0% would punish the mean for a day that contains
  // no evidence of anything — the opposite of what an efficiency average is for.
  let focusDays = 0;
  let efficiencyTotal = 0;

  for (const record of ascending) {
    totalPlannedMs += record.plannedMs;
    totalFocusedMs += record.focusedMs;
    totalWastedMs += record.wastedMs;
    if (record.perfect) perfectDays += 1;
    if (record.focusedMs > 0) {
      focusDays += 1;
      efficiencyTotal += record.efficiency;
    }
  }

  // One ascending pass answers "longest run anywhere". `previousOrdinal` is what makes a
  // run consecutive rather than merely perfect days scattered across the archive.
  let bestStreak = 0;
  let run = 0;
  let previousOrdinal: number | null = null;
  for (const record of ascending) {
    const ordinal = dayOrdinal(record.date);
    if (record.perfect && previousOrdinal !== null && ordinal === previousOrdinal + 1) {
      run += 1;
    } else {
      run = record.perfect ? 1 : 0;
    }
    previousOrdinal = ordinal;
    if (run > bestStreak) bestStreak = run;
  }

  // currentStreak: the same run, anchored at the newest recorded day. A non-perfect day
  // ends it, and so does a calendar gap (the ordinal jumps by more than one).
  let currentStreak = 0;
  let newerOrdinal: number | null = null;
  for (let i = ascending.length - 1; i >= 0; i -= 1) {
    const record = ascending[i];
    if (!record.perfect) break;
    const ordinal = dayOrdinal(record.date);
    // The newest recorded day is the anchor, so the first iteration has nothing to be
    // adjacent to and `newerOrdinal` is null.
    if (newerOrdinal !== null && ordinal !== newerOrdinal - 1) break;
    currentStreak += 1;
    newerOrdinal = ordinal;
  }

  return {
    days: records.length,
    perfectDays,
    totalPlannedMs,
    totalFocusedMs,
    totalWastedMs,
    avgEfficiency: focusDays > 0 ? Math.round(efficiencyTotal / focusDays) : 0,
    currentStreak,
    bestStreak,
  };
}

const monthFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

/** "October 2026" from "2026-10-01". See `utcAnchor` for why the anchor is UTC noon. */
function monthLabel(date: string): string {
  const anchor = utcAnchor(date, 12);
  // A date that will not parse has no month to name. Echoing it keeps the group usable
  // instead of throwing RangeError out of a rendering path.
  return anchor === null ? date : monthFormat.format(anchor);
}

/** Months newest-first, records newest-first within each. Zero-padded keys sort as text. */
export function groupByMonth(records: DayRecord[]): MonthGroup[] {
  const buckets = new Map<string, DayRecord[]>();
  for (const record of records) {
    const key = record.date.slice(0, 7);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, bucket]) => {
      const newestFirst = [...bucket].sort((a, b) =>
        a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
      );
      return { key, label: monthLabel(newestFirst[0].date), records: newestFirst };
    });
}

/**
 * Linear, deliberately. The archive is capped at 400 records and every caller already has
 * the array in hand from `loadHistory`, so building a Map would cost more than the one
 * comparison it saves on the single lookup this exists for.
 */
export function recordForDate(records: DayRecord[], date: string): DayRecord | undefined {
  return records.find((record) => record.date === date);
}
