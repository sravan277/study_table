import type { Block } from "./types";

const h = (hour: number, minute = 0) => hour * 60 + minute;

/**
 * The day, transcribed from the handwritten notes.
 *
 * Lunch was written `1:00 – 2:20 PM` while the study block under it was written
 * `2:00 – 5:00 PM`, a 20-minute overlap. Lunch ends at 2:00.
 *
 * "Wake up 8:30 AM" is deliberately NOT a block. It is the day's origin, not a task:
 * as a zero-length block it produced an arc with no area, which is invisible and
 * impossible to click. Instead it is the dial's twelve o'clock and the rail's left
 * edge — see DAY_START_MIN.
 *
 * `endMin` is allowed to exceed 1440 so Hobby can run 22:00 → 24:00 without wrapping.
 */
export const BLOCKS: Block[] = [
  {
    id: "exercise",
    label: "Exercise",
    title: "Exercise, eat and bath",
    kind: "exercise",
    startMin: h(8, 30),
    endMin: h(9, 10),
    timed: true,
  },
  {
    id: "ready",
    label: "Get ready",
    title: "Get ready",
    kind: "life",
    startMin: h(9, 10),
    endMin: h(10),
    timed: false,
  },
  {
    id: "study-morning",
    label: "Study",
    title: "Study — morning",
    kind: "study",
    startMin: h(10),
    endMin: h(13),
    timed: true,
  },
  {
    id: "lunch",
    label: "Lunch",
    title: "Lunch",
    kind: "life",
    startMin: h(13),
    endMin: h(14),
    timed: false,
  },
  {
    id: "study-afternoon",
    label: "Study",
    title: "Study — afternoon",
    kind: "study",
    startMin: h(14),
    endMin: h(17),
    timed: true,
  },
  {
    id: "break",
    label: "Break",
    title: "Break",
    kind: "life",
    startMin: h(17),
    endMin: h(18),
    timed: false,
  },
  {
    id: "study-evening",
    label: "Study",
    title: "Study — evening",
    kind: "study",
    startMin: h(18),
    endMin: h(20),
    timed: true,
  },
  {
    id: "dinner",
    label: "Dinner",
    title: "Dinner",
    kind: "life",
    startMin: h(20),
    endMin: h(21),
    timed: false,
  },
  {
    id: "study-night",
    label: "Study",
    title: "Study — night",
    kind: "study",
    startMin: h(21),
    endMin: h(22),
    timed: true,
  },
  {
    id: "hobby",
    label: "Hobby",
    title: "Hobby",
    kind: "hobby",
    startMin: h(22),
    endMin: h(24),
    timed: true,
  },
  {
    id: "sleep",
    label: "Sleep",
    title: "Sleep",
    kind: "life",
    startMin: h(0),
    endMin: h(8, 30),
    timed: false,
  },
];

/** The dial spans the full 24 hours, beginning at 08:30 IST. */
export const DAY_START_MIN = h(8, 30);
export const DAY_LENGTH_MIN = 24 * 60;
export const AWAKEN_MIN = h(15, 30); // 08:30 → 24:00

/** Notification lead time before a block starts. */
export const LEAD_MS = 5 * 60 * 1000;

/** Water reminders: hourly, 08:30 through 22:00. */
export const WATER_START_MIN = h(8, 30);
export const WATER_END_MIN = h(22);
export const WATER_INTERVAL_MIN = 60;

/** Category colours. One palette, defined once, used by dial, rail and legend. */
export const KIND_COLOR: Record<Block["kind"], string> = {
  study: "#4F6FE8",
  exercise: "#2FB98C",
  hobby: "#E8973F",
  life: "#63748A",
};

export const ALARM_COLOR = "#F2544B";
export const WATER_COLOR = "#49C6E5";

/** Blocks whose full window has passed, in chronological order. Used for the rail. */
export const TIMED_BLOCKS = BLOCKS.filter((b) => b.timed);

export const DAY_TOTAL_MS = AWAKEN_MIN * 60 * 1000;