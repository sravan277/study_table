"use client";

import { useMemo } from "react";
import { AWAKEN_MIN, DAY_START_MIN, KIND_COLOR } from "@/lib/schedule";
import { formatDuration, formatHm, formatHmOfDay, formatSpan } from "@/lib/time";
import type { BlockId, BlockMetrics, DayStats } from "@/lib/types";

/**
 * The linear rail beneath the dial.
 *
 * The dial answers "what does the shape of my day look like". The rail answers the
 * question a circle cannot: how long each block is, side by side, in order. Both are
 * the same data at two different angles of attack, and together they make a schedule
 * readable at a glance and auditable line by line.
 *
 * Segment width is proportional to real duration, so a 3-hour study block is three
 * times the width of the 40-minute exercise block and you can see a schedule gap
 * without reading a single number.
 */
export function Rail({
  metrics,
  selectedId,
  onSelect,
}: {
  metrics: BlockMetrics[];
  selectedId: string | null;
  onSelect: (id: BlockId) => void;
}) {
  // Same rule as the dial: the rail covers the waking day from 08:30, so sleep is not
  // in it and the axis runs 08:30 → 24:00 rather than midnight → midnight.
  const segments = useMemo(
    () =>
      metrics
        .filter((m) => m.block.id !== "sleep")
        .sort((a, b) => (a.block.startMin ?? 0) - (b.block.startMin ?? 0)),
    [metrics],
  );
  const totalMs = segments.reduce((sum, m) => sum + m.plannedMs, 0);

  return (
    <section className="rail" aria-label="Schedule, in order">
      <div className="rail__head">
        <span className="rail__title">The day, in order</span>
        <span className="rail__scale" />
        <span className="rail__title mono">
          {segments.filter((m) => m.status === "done").length} of{" "}
          {metrics.filter((m) => m.block.timed).length} timed blocks done
        </span>
      </div>

      <div className="rail__track">
        {segments.map((m) => (
          <button
            key={m.block.id}
            type="button"
            className={[
              "rail__seg",
              m.status === "missed" ? "rail__seg--missed" : "",
              m.status === "done" ? "rail__seg--done" : "",
              m.status === "active" || m.status === "due" ? "rail__seg--active" : "",
              selectedId === m.block.id ? "rail__seg--selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ flex: `${m.plannedMs} 1 0`, ["--seg-color" as string]: KIND_COLOR[m.block.kind] }}
            onClick={() => onSelect(m.block.id)}
            aria-label={`${m.block.title}, ${formatHm(m.startMs)} to ${formatHm(m.endMs)}, ${formatSpan(m.plannedMs)}. ${statusText(m)}`}
            title={`${m.block.title} · ${formatHm(m.startMs)}–${formatHm(m.endMs)} · ${formatSpan(m.plannedMs)}`}
          >
            {/* Mirror of the dial: the whole window at low opacity, focus at full. */}
            <span className="rail__seg-lit" style={{ opacity: m.progress > 0 ? 0.9 : 0 }} />
            <span className="rail__seg-fill" style={{ height: `${Math.min(100, m.progress * 100)}%` }} />
          </button>
        ))}
      </div>

      <div className="rail__axis mono" aria-hidden>
        {AXIS.map((hour) => {
          const label = hour === 24 ? "24:00" : formatHmOfDay(hour * 60);
          // Positioned as a fraction of the awake day, matching where the dial puts it.
          const at = ((hour * 60 - DAY_START_MIN) / AWAKEN_MIN) * 100;
          if (at < 0 || at > 100) return null;
          return (
            <span key={hour} style={{ left: `${at}%` }}>
              {label}
            </span>
          );
        })}
      </div>
      <span className="visually-hidden">The day runs {formatSpan(totalMs)} from 08:30 to midnight.</span>
    </section>
  );
}

/**
 * Hour marks across the waking day, starting at 08:30 rather than 08:00. 8.5 is a
 * deliberate half — the day's edge is the only label that matters, and it is not on an
 * hour.
 */
const AXIS = [8.5, 10, 12, 14, 16, 18, 20, 22, 24];

function statusText(m: BlockMetrics): string {
  switch (m.status) {
    case "done":
      return "completed";
    case "missed":
      return `missed, ${Math.round(m.progress * 100)} percent focused`;
    case "active":
      return m.isRunning ? "running" : "in progress, timer stopped";
    case "due":
      return "starts shortly";
    case "future":
      return "not yet due";
    case "passthrough":
      return "no timer";
  }
}

/**
 * The day in numbers.
 *
 * Efficiency is focused over planned across timed blocks only — counting meals and
 * sleep would flatter the number, which would defeat the purpose.
 */
export function Stats({ stats }: { stats: DayStats }) {
  return (
    <section className="stats" aria-label="Day totals">
      <Stat label="Focused" value={formatDuration(stats.focusedMs)} sub={`of ${formatSpan(stats.plannedMs)} planned`} tone="lit" />
      <Stat
        label="Wasted"
        value={formatDuration(stats.wastedMs)}
        sub={stats.wastedMs > 0 ? "never pressed start, or paused" : "clean so far"}
        tone={stats.wastedMs > 0 ? "alarm" : undefined}
      />
      <Stat
        label="Blocks"
        value={`${stats.doneBlocks}/${stats.timedBlocks}`}
        sub={stats.missedBlocks > 0 ? `${stats.missedBlocks} missed` : "all on track"}
        tone={stats.missedBlocks > 0 ? "alarm" : undefined}
      />
      <Stat label="Efficiency" value={`${stats.efficiency}%`} sub="focused over planned" />
      <Stat
        label="Water"
        value={`${stats.waterDone}/${stats.waterTotal}`}
        sub={stats.waterDone >= stats.waterTotal && stats.waterTotal > 0 ? "target met" : "glasses today"}
      />
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "lit" | "alarm" }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value mono${tone ? ` stat__value--${tone}` : ""}`}>{value}</div>
      <div className="stat__sub">{sub}</div>
    </div>
  );
}

/** What each colour means. Appears once, under everything else. */
export function Legend() {
  const items: [string, string][] = [
    [KIND_COLOR.study, "Study"],
    [KIND_COLOR.exercise, "Exercise"],
    [KIND_COLOR.hobby, "Hobby"],
    [KIND_COLOR.life, "No timer"],
    ["var(--alarm)", "Missed"],
  ];
  return (
    <div className="legend">
      {items.map(([color, label]) => (
        <span className="legend__item" key={label}>
          <span className="dock__swatch" style={{ background: color }} aria-hidden />
          {label}
        </span>
      ))}
      <span className="legend__item">
        <span
          className="dock__swatch"
          style={{ background: "color-mix(in srgb, var(--study) 42%, transparent)" }}
          aria-hidden
        />
        Dim remainder = wasted
      </span>
    </div>
  );
}