"use client";

import { formatClock, formatDateLong, formatDuration } from "@/lib/time";

/**
 * The running clock, directly beneath the dial.
 *
 * Drawn in monospace with tabular figures so the digits never reflow — a proportional
 * face here would shuffle the layout four times a second. The hundredths are the part
 * that actually moves, which makes the timer's rate honest at a glance.
 */
export function Clock({
  now,
  awakeProgress,
  remaining,
}: {
  now: number;
  /** 0–1 through the awake span, 08:30 → 24:00. */
  awakeProgress: number;
  remaining: number;
}) {
  const text = formatClock(now);
  const [hh, mm, ss] = text.split(":");
  const ms = String(Math.floor((now % 1000) / 10)).padStart(2, "0");

  return (
    <div className="clock">
      <div className="clock__digits mono" role="timer" aria-label={`Time is ${text}`}>
        <span>{hh}</span>
        <span className="clock__colon">:</span>
        <span>{mm}</span>
        <span className="clock__colon">:</span>
        <span>{ss}</span>
        <span className="clock__ms">.{ms}</span>
      </div>

      <div className="clock__caption">IST · 24-hour · {formatDateLong(now)}</div>

      <div className="daybar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(awakeProgress * 100)} aria-label="Progress through the waking day">
        <div className="daybar__fill" style={{ width: `${Math.min(100, awakeProgress * 100)}%` }} />
      </div>

      <div className="daybar__marks mono">
        <span>08:30 awake</span>
        <span>{remaining > 0 ? `${formatDuration(remaining)} of the day left` : "day is done"}</span>
        <span>24:00 sleep</span>
      </div>
    </div>
  );
}