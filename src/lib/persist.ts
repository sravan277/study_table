import { EMPTY_STATE, buildWaterSlots } from "./metrics";
import { archiveSnapshot, upsertHistory } from "./history";
import { dayStartMsFor, isoDate } from "./time";
import type { BlockId, BlockState, DaySnapshot } from "./types";

/**
 * localStorage persistence.
 *
 * Writes are debounced and every read is defensive: the payload is untrusted input
 * that may have been written by an older build, hand-edited, or truncated by a crash.
 * Anything that fails validation falls back to a fresh day rather than throwing,
 * because losing a day of focus totals is annoying but a blank page is useless.
 */

const KEY = "day-dial:v1";
const WRITE_DEBOUNCE_MS = 400;

export function freshSnapshot(now: number, dayStart: number): DaySnapshot {
  return {
    date: isoDate(now),
    blocks: {},
    water: buildWaterSlots(dayStart),
    notifiedBlocks: [],
  };
}

function isBlockState(value: unknown): value is BlockState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const num = (k: string) => typeof v[k] === "number" && Number.isFinite(v[k] as number);
  const nullableNum = (k: string) => v[k] === null || num(k);
  return (
    num("focusedMs") &&
    nullableNum("startedAt") &&
    nullableNum("resumedAt") &&
    nullableNum("completedAt") &&
    typeof v.running === "boolean"
  );
}

/** Repair whatever we are given into a shape the app can trust. */
export function sanitise(input: unknown, now: number, dayStart: number): DaySnapshot {
  const fresh = freshSnapshot(now, dayStart);
  if (typeof input !== "object" || input === null) return fresh;

  const raw = input as Partial<DaySnapshot>;

  // A snapshot from another day is discarded outright. Carrying yesterday's focus into
  // today would silently inflate today's numbers.
  if (raw.date !== fresh.date) return fresh;

  const blocks: Partial<Record<BlockId, BlockState>> = {};
  if (typeof raw.blocks === "object" && raw.blocks !== null) {
    for (const [id, value] of Object.entries(raw.blocks)) {
      if (isBlockState(value)) blocks[id as BlockId] = value;
    }
  }

  const previousWater = Array.isArray(raw.water) ? raw.water : [];
  const water = buildWaterSlots(
    dayStart,
    previousWater.filter((w) => typeof w?.atMin === "number"),
  );

  const notifiedBlocks = Array.isArray(raw.notifiedBlocks)
    ? (raw.notifiedBlocks.filter((id) => typeof id === "string") as BlockId[])
    : [];

  return { date: fresh.date, blocks, water, notifiedBlocks };
}

/**
 * File a snapshot that belongs to a day which has already ended.
 *
 * `sanitise` discards a snapshot whose date is not today, and that is right for the dial
 * — carrying yesterday's focus into today would inflate today's numbers. It used to mean
 * the day was simply gone, which matters in exactly one case: you open the app after
 * midnight, or after installing the build that introduced the archive, and the day you
 * actually worked is the one sitting in this key waiting to be overwritten.
 *
 * So the discard happens on the way in only. `sanitise` is called with noon of the
 * stranded day as "now", which makes that day the current day and the existing
 * validation applies unchanged — no second parser to keep in step with the first.
 */
function fileStrandedDay(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const date = (raw as { date?: unknown }).date;
  if (typeof date !== "string") return;

  const filed = dayStartMsFor(date);
  if (filed === null) return;

  const stranded = sanitise(raw, filed + 12 * 3_600_000, filed);
  // Nothing recorded means nothing worth keeping. A day the app was merely open on
  // would otherwise fill the archive with empty rows that all read 0% efficiency.
  if (Object.keys(stranded.blocks).length === 0) return;

  // +1ms for the same reason the midnight rollover uses one: hobby's window ends on the
  // boundary, so measuring the day at exactly its last millisecond leaves the final
  // block still "active".
  upsertHistory(archiveSnapshot(stranded, filed, filed + 86_400_001));
}

export function loadSnapshot(now: number, dayStart: number): DaySnapshot {
  if (typeof window === "undefined") return freshSnapshot(now, dayStart);
  try {
    const stored = window.localStorage.getItem(KEY);
    if (!stored) return freshSnapshot(now, dayStart);
    const parsed: unknown = JSON.parse(stored);
    fileStrandedDay(parsed);
    return sanitise(parsed, now, dayStart);
  } catch {
    return freshSnapshot(now, dayStart);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: DaySnapshot | null = null;

export function saveSnapshot(snapshot: DaySnapshot): void {
  pending = snapshot;
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushSnapshot, WRITE_DEBOUNCE_MS);
}

/** Force an immediate write. Called on pagehide so a closing tab does not lose 400ms. */
export function flushSnapshot(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Quota or private-browsing failure. The app keeps running from memory.
  }
  pending = null;
}

/**
 * Fold the running leg into the stored counters so a reload does not lose the time
 * between the last render and the page close.
 */
export function settleRunningStates(snapshot: DaySnapshot, now: number): DaySnapshot {
  let changed = false;
  const blocks = { ...snapshot.blocks };

  for (const [id, state] of Object.entries(blocks) as [BlockId, BlockState | undefined][]) {
    if (state?.running && state.resumedAt) {
      const delta = Math.max(0, now - state.resumedAt);
      blocks[id] = {
        ...state,
        focusedMs: state.focusedMs + delta,
        running: false,
        resumedAt: null,
      };
      changed = true;
    }
  }
  return changed ? { ...snapshot, blocks } : snapshot;
}

export { EMPTY_STATE };