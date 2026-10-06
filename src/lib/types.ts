/**
 * Domain types.
 *
 * The whole app is built around one distinction: focused time (timer running) versus
 * wasted time (everything else). See NOTES.md §2 for why.
 */

export type BlockKind = "study" | "exercise" | "hobby" | "life";

export type BlockId =
  | "exercise"
  | "ready"
  | "study-morning"
  | "lunch"
  | "study-afternoon"
  | "break"
  | "study-evening"
  | "dinner"
  | "study-night"
  | "hobby"
  | "sleep";

export interface Block {
  id: BlockId;
  /** Short name for the dial label and the rail. */
  label: string;
  /** Human phrasing used in notifications: "Study — afternoon". */
  title: string;
  kind: BlockKind;
  /**
   * Minutes from local midnight IST. `end` may exceed 1440 for blocks that run past
   * midnight. `start == null` means the block has no fixed start (Wake up).
   */
  startMin: number | null;
  endMin: number;
  /** Timed blocks get a timer, accrue wasted time, and can turn red. */
  timed: boolean;
}

/**
 * Mutable per-block tracking state. Persisted to localStorage and mirrored to
 * Supabase. Durations are milliseconds.
 *
 * `focusedMs` is the only accumulated quantity. Elapsed time comes from the clock,
 * waste is `elapsed - focused`, and the unstarted/paused split is derived from
 * `startedAt`. Deriving is deliberate: there is nothing stored that can drift out of
 * agreement with the clock, so closing the tab, refreshing, or coming back tomorrow
 * cannot make the numbers disagree with each other.
 */
export interface BlockState {
  /** Milliseconds the timer was actually running. The number that fills the slice. */
  focusedMs: number;
  /** First Start press, epoch ms. null until the timer is started for the first time. */
  startedAt: number | null;
  /** Last resume, epoch ms. Only meaningful while `running` is true. */
  resumedAt: number | null;
  running: boolean;
  /** Epoch ms the user explicitly marked the block finished. */
  completedAt: number | null;
}

/** Where a block sits relative to right now. Drives colour and copy. */
export type BlockStatus =
  | "future" // more than the lead time away
  | "due" // within the 5-minute lead window
  | "active" // inside the window
  | "done" // window closed, target met
  | "missed" // window closed, target not met
  | "passthrough"; // no timer, so it can never be done or missed

/** Derived, recomputed on every tick. Never persisted. */
export interface BlockMetrics {
  block: Block;
  startMs: number;
  endMs: number;
  plannedMs: number;
  /** Seconds of the window that have elapsed, clamped to the window. */
  elapsedMs: number;
  /** focusedMs plus the currently-running leg. */
  focusedMs: number;
  /** elapsed − focused. Never negative. */
  wastedMs: number;
  /** Waste accrued before the first Start press — how far into the window it happened. */
  unstartedMs: number;
  /** Waste accrued after starting but with the timer not running. wasted − unstarted. */
  pausedMs: number;
  /** focused / planned, clamped to 1. Drives arc length. */
  progress: number;
  /** elapsed / planned, clamped to 1. Drives the dim track sweep. */
  timeProgress: number;
  status: BlockStatus;
  /** ms until the block starts. Negative once it has. */
  startsInMs: number;
  /** ms until the block ends. Negative once it has. */
  endsInMs: number;
  /** True when this block has a running timer right now. */
  isRunning: boolean;
  /** True once Start has been pressed at least once. */
  hasStarted: boolean;
}

export interface WaterSlot {
  /** Minutes from midnight IST. */
  atMin: number;
  /** Epoch ms for this slot today. */
  atMs: number;
  /** Epoch ms of the last notification for this slot, so it fires exactly once. */
  notifiedAt: number | null;
  acknowledgedAt: number | null;
}

export interface DaySnapshot {
  /** ISO date in IST, e.g. "2026-10-01". Resets all counters when it changes. */
  date: string;
  blocks: Partial<Record<BlockId, BlockState>>;
  water: WaterSlot[];
  /** Block ids whose 5-minute notification has already fired today. */
  notifiedBlocks: BlockId[];
}

export interface Toast {
  id: string;
  kind: "task" | "water" | "missed" | "done" | "info" | "error";
  title: string;
  body?: string;
  blockId?: BlockId;
  /** ms; toasts auto-dismiss after this. 0 means sticky. */
  ttl: number;
  /** Set when the toast offers an action, e.g. "Start". */
  action?: { label: string; blockId: BlockId };
  createdAt: number;
}

/**
 * Notification permission, as reported by the browser or by the Android runtime prompt.
 *
 * Lives here rather than in notifications.ts because native.ts needs it too, and two
 * modules importing each other's types is a cycle that TypeScript erases but linters
 * rightly complain about.
 */
export type PermissionState = "unsupported" | "default" | "granted" | "denied" | "error";

export interface DayStats {
  plannedMs: number;
  focusedMs: number;
  wastedMs: number;
  timedBlocks: number;
  doneBlocks: number;
  missedBlocks: number;
  waterTotal: number;
  waterDone: number;
  /** 0–100, focused over planned across timed blocks. */
  efficiency: number;
}