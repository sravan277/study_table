import { BLOCKS, LEAD_MS, WATER_END_MIN, WATER_INTERVAL_MIN, WATER_START_MIN } from "./schedule";
import { clamp } from "./time";
import type { Block, BlockId, BlockMetrics, BlockState, BlockStatus, DayStats, WaterSlot } from "./types";

/** A block with no recorded state behaves as untouched. */
export const EMPTY_STATE: BlockState = {
  focusedMs: 0,
  startedAt: null,
  resumedAt: null,
  running: false,
  completedAt: null,
};

/**
 * Derive everything about a block from its window and its recorded state.
 *
 * The important decision here is that `focusedMs` is the *only* accumulated quantity.
 * Elapsed time comes from the clock, waste is `elapsed − focused`, and nothing else is
 * stored. That means closing the tab, refreshing, or coming back tomorrow cannot make
 * the numbers drift — there is nothing to drift.
 */
export function computeBlockMetrics(
  block: Block,
  dayStart: number,
  now: number,
  state: BlockState | undefined,
): BlockMetrics {
  const s = state ?? EMPTY_STATE;

  const startMs = dayStart + (block.startMin ?? 0) * 60_000;
  const endMs = dayStart + block.endMin * 60_000;
  const plannedMs = Math.max(0, endMs - startMs);

  // Only time inside the window can be wasted.
  const elapsedMs = clamp(now - startMs, 0, plannedMs);

  // Focus accrues while running, from whenever Start was pressed. It is clamped to the
  // planned duration so a timer left running overnight cannot inflate the number.
  const liveLeg = s.running && s.resumedAt ? Math.max(0, now - s.resumedAt) : 0;
  const focusedMs = block.timed ? Math.min(plannedMs, s.focusedMs + liveLeg) : 0;

  const wastedMs = Math.max(0, elapsedMs - focusedMs);

  /*
   * The waste split, derived rather than accumulated.
   *
   * `unstarted` is how far into the window you were when you first pressed Start. If
   * you have never pressed it, that is the whole elapsed stretch. `paused` is then
   * simply whatever waste is left over, which is exact by construction.
   *
   * The earlier version kept a separate `pausedMs` accumulator in BlockState and added
   * it to a live figure, which double counted: pausing for two minutes on a block with
   * thirty minutes of unstarted time reported 32:01 paused instead of 2:00. Storing an
   * accumulator for a quantity that is fully determined by two others is how drift gets
   * in, so BlockState no longer has one.
   */
  const firstStart = s.startedAt ?? (s.running && s.resumedAt ? s.resumedAt : null);
  const countingBeganAt = firstStart ?? now;
  const unstartedMs = clamp(countingBeganAt - startMs, 0, elapsedMs);
  const pausedMs = Math.max(0, wastedMs - unstartedMs);

  const startsInMs = startMs - now;
  const endsInMs = endMs - now;

  let status: BlockStatus;
  if (!block.timed) {
    status = "passthrough";
  } else if (s.completedAt !== null || focusedMs >= plannedMs) {
    status = "done";
  } else if (now > endMs) {
    status = "missed";
  } else if (now >= startMs) {
    status = "active";
  } else if (now >= startMs - LEAD_MS) {
    status = "due";
  } else {
    status = "future";
  }

  return {
    block,
    startMs,
    endMs,
    plannedMs,
    elapsedMs,
    focusedMs,
    wastedMs,
    unstartedMs,
    pausedMs,
    progress: plannedMs > 0 ? clamp(focusedMs / plannedMs, 0, 1) : 0,
    timeProgress: plannedMs > 0 ? clamp(elapsedMs / plannedMs, 0, 1) : 0,
    status,
    startsInMs,
    endsInMs,
    isRunning: s.running,
    hasStarted: firstStart !== null,
  };
}

export function computeMetrics(
  dayStart: number,
  now: number,
  states: Partial<Record<BlockId, BlockState>>,
): BlockMetrics[] {
  return BLOCKS.map((block) => computeBlockMetrics(block, dayStart, now, states[block.id]));
}

/** The block whose window contains `now`, if any. Drives the header readout. */
export function currentBlock(metrics: BlockMetrics[]): BlockMetrics | null {
  return (
    metrics.find((m) => m.status === "active" || m.status === "due") ??
    metrics.find((m) => m.block.timed && m.status === "future" && m.startsInMs <= LEAD_MS) ??
    null
  );
}

/** The next timed block that has not started. Used by the idle prompt. */
export function nextBlock(metrics: BlockMetrics[]): BlockMetrics | null {
  return metrics.find((m) => m.block.timed && (m.status === "due" || m.status === "future")) ?? null;
}

export function computeStats(metrics: BlockMetrics[], water: WaterSlot[]): DayStats {
  const timed = metrics.filter((m) => m.block.timed);
  const plannedMs = timed.reduce((sum, m) => sum + m.plannedMs, 0);
  const focusedMs = timed.reduce((sum, m) => sum + m.focusedMs, 0);
  const wastedMs = timed.reduce((sum, m) => sum + m.wastedMs, 0);

  return {
    plannedMs,
    focusedMs,
    wastedMs,
    timedBlocks: timed.length,
    doneBlocks: timed.filter((m) => m.status === "done").length,
    missedBlocks: timed.filter((m) => m.status === "missed").length,
    waterTotal: water.length,
    waterDone: water.filter((w) => w.acknowledgedAt !== null).length,
    efficiency: plannedMs > 0 ? Math.round((focusedMs / plannedMs) * 100) : 0,
  };
}

/** Hourly water slots from 08:30 to 22:00 — fourteen of them. */
export function buildWaterSlots(dayStart: number, previous: WaterSlot[] = []): WaterSlot[] {
  const byMinute = new Map(previous.map((slot) => [slot.atMin, slot]));
  const slots: WaterSlot[] = [];

  for (let min = WATER_START_MIN; min <= WATER_END_MIN; min += WATER_INTERVAL_MIN) {
    const existing = byMinute.get(min);
    slots.push({
      atMin: min,
      atMs: dayStart + min * 60_000,
      notifiedAt: existing?.notifiedAt ?? null,
      acknowledgedAt: existing?.acknowledgedAt ?? null,
    });
  }
  return slots;
}

/**
 * Blocker for starting a timer early.
 *
 * Focus accrues from the Start press, so allowing a start 6 hours early would let the
 * whole day be banked in one sitting. Gating on the 5-minute lead window keeps credit
 * inside the day it belongs to while still forgiving a few early minutes.
 */
export function startBlocker(m: BlockMetrics): string | null {
  if (!m.block.timed) return "This block does not use a timer.";
  if (m.status === "done") return "Already completed.";
  if (m.startsInMs > LEAD_MS) {
    const mins = Math.ceil(m.startsInMs / 60_000);
    return `Opens ${mins} min before the block starts.`;
  }
  if (m.status === "missed") return "This block has already ended.";
  return null;
}

export const BLOCK_BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));