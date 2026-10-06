/**
 * IST time math.
 *
 * Every slot boundary in this app is Asia/Kolkata, regardless of where the browser
 * or the server runs. Two things fall out of that:
 *
 *  1. `Date` alone is never enough — the device timezone must not leak in.
 *  2. The timezone offset is derived from `Intl` rather than hardcoded to +05:30, so
 *     changing TIME_ZONE in one place stays correct even for a zone with DST.
 */

export const TIME_ZONE = "Asia/Kolkata";

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  /** Minutes elapsed since IST midnight, 0-1439. */
  minutesOfDay: number;
}

/** The device-local wall clock as observed in the app's timezone. */
export function wallClock(at: number | Date = Date.now()): WallClock {
  const date = at instanceof Date ? at : new Date(at);
  const parts: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(date)) parts[part.type] = part.value;

  // `hour` comes back as "24" for midnight under hour12:false in some ICU versions.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute,
    second,
    minutesOfDay: hour * 60 + minute,
  };
}

/**
 * Milliseconds to add to a timezone's wall-clock reading to get the UTC instant.
 * IST is a fixed +05:30, but this is derived so a DST zone still works.
 */
function zoneOffsetMs(at: number): number {
  const w = wallClock(at);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - at;
}

/** Epoch ms of 00:00 in the app's timezone, for the day containing `at`. */
export function dayStartMs(at: number = Date.now()): number {
  const w = wallClock(at);
  const midnightAsUtc = Date.UTC(w.year, w.month - 1, w.day, 0, 0, 0, 0);
  return midnightAsUtc - zoneOffsetMs(at);
}

/** Epoch ms for `minutes` after 00:00 IST on the day containing `at`. */
export function atMinutes(minutes: number, at: number = Date.now()): number {
  return dayStartMs(at) + minutes * 60_000;
}

/**
 * Epoch ms of 00:00 IST on the calendar day an ISO string names, or null.
 *
 * Needed to archive a day *after* the fact. Every other helper here takes an instant
 * and answers "which day is this in", but the archive is written at midnight about a
 * day that has already finished, so the only handle left on it is its date string.
 *
 * The anchor is 06:00 UTC rather than midnight because `Date.UTC(y, m, d)` is UTC
 * midnight, which in IST is 05:30 the *previous* day — asking for the day-start of
 * that instant returns yesterday's midnight and silently files the day under the wrong
 * date. Six hours in is far enough past IST midnight to be unambiguous in either
 * direction for any real offset.
 */
export function dayStartMsFor(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const anchor = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 6, 0, 0);
  if (Number.isNaN(anchor)) return null;
  const start = dayStartMs(anchor);
  return isoDate(start) === iso ? start : null;
}

/** "2026-10-01" — the key that resets every counter at midnight. */
export function isoDate(at: number = Date.now()): string {
  const w = wallClock(at);
  const mm = String(w.month).padStart(2, "0");
  const dd = String(w.day).padStart(2, "0");
  return `${w.year}-${mm}-${dd}`;
}

/** "10:22:07" — the running clock. Always 24-hour, always zero-padded. */
export function formatClock(at: number): string {
  const w = wallClock(at);
  return `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** "10:22" for schedule labels. */
export function formatHm(at: number): string {
  const w = wallClock(at);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * "08:30" for a time-of-day, from minutes since IST midnight.
 *
 * Not the same as passing an epoch to formatHm. Doing that treats the number as a
 * timestamp and converts it out of IST, which is how the water reminder ended up
 * reading "every 60 min from 14:00" when the schedule says 08:30.
 */
export function formatHmOfDay(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "Thursday 1 October" — the date plate in the header. */
export function formatDateLong(at: number): string {
  const w = wallClock(at);
  const date = new Date(Date.UTC(w.year, w.month - 1, w.day));
  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
  }).format(date);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long" }).format(date);
  return `${weekday} ${w.day} ${month}`;
}

/**
 * "2:14:07" — durations under an hour get a leading zero hour, above 90 minutes drop
 * the hour entirely. Keeps the timer dock from reflowing as it crosses an hour.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

/** "3 h", "40 min", "1 h 20" — planned lengths in the rail and legend. */
export function formatSpan(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hrs === 0) return `${rest} min`;
  if (rest === 0) return `${hrs} h`;
  return `${hrs} h ${rest} min`;
}

/** "in 4 min", "in 2 h 10 min", "9 min late", "now". Used on the panel and toasts. */
export function formatRelative(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 45_000) return "now";
  const mins = Math.round(abs / 60_000);
  const text = mins < 60 ? `${mins} min` : formatSpan(mins * 60_000);
  return ms > 0 ? `in ${text}` : `${text} ago`;
}

/** Countdown label for the water meter: "3 of 14". */
export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Clamp helper used throughout the metrics maths. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}