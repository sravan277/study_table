"use client";

import { useMemo } from "react";
import { arcPath, dashFor, fullDash, minutesToAngle, polarToCartesian, withGaps } from "@/lib/geometry";
import { ALARM_COLOR, AWAKEN_MIN, DAY_START_MIN, KIND_COLOR } from "@/lib/schedule";
import { formatHm, formatSpan } from "@/lib/time";
import type { BlockId, BlockKind, BlockMetrics, BlockStatus } from "@/lib/types";

/**
 * The day dial.
 *
 * The full circle is the waking day: 08:30 at twelve o'clock, running clockwise to
 * midnight, and back to twelve. Every degree means something, so the four study blocks
 * take 59% of the circle, the gaps between them are visible as gaps, and a 40 minute
 * exercise block is honestly 4% rather than a decorative tick.
 *
 * Sleep is not on the dial. It is the absence of a day, not part of one, and drawing it
 * would either waste a third of the circle or distort everything else. The needle
 * parks at twelve o'clock overnight to say so.
 *
 * Each slice carries three concentric bands on one radius, so they read as one object:
 *
 *   track   the whole planned span, dim
 *   waste   dimmer still, over the part of the window that has passed unlit
 *   lit     focus — the only band on the dial with a glow
 *
 * Progress is `stroke-dashoffset` on paths whose `d` never changes. Animating `d` makes
 * the large-arc flag flip at the halfway point and the arc tears; see
 * src/lib/geometry.ts.
 */

const SIZE = 640;
const CENTRE = SIZE / 2;
const R_LIT = 258;
const BAND = 46;
const GAUGE_R = R_LIT - BAND / 2 - 15;

/** Sleep sits outside the awake day, so it never gets a slice. */
const ON_DIAL = (m: BlockMetrics) => m.block.id !== "sleep";

interface SliceGeometry {
  metrics: BlockMetrics;
  gStart: number;
  gEnd: number;
}

export function DayDial({
  metrics,
  now,
  minutesOfDay,
  selectedId,
  onSelect,
}: {
  metrics: BlockMetrics[];
  now: number;
  /** Minutes since IST midnight, supplied by the store so the dial never re-derives it. */
  minutesOfDay: number;
  selectedId: string | null;
  onSelect: (id: BlockId) => void;
}) {
  const slices = useMemo<SliceGeometry[]>(
    () =>
      metrics
        .filter((m) => m.block.startMin !== null && ON_DIAL(m))
        .map((m) => {
          const startDeg = minutesToAngle(m.block.startMin ?? 0, DAY_START_MIN, AWAKEN_MIN);
          const endDeg = minutesToAngle(m.block.endMin, DAY_START_MIN, AWAKEN_MIN);
          const [gStart, gEnd] = withGaps(startDeg, endDeg);
          return { metrics: m, gStart, gEnd };
        })
        .sort((a, b) => a.gStart - b.gStart),
    [metrics],
  );

  const gaugeMarks = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => {
        const angle = i * 7.5;
        const major = i % 4 === 0;
        const from = polarToCartesian(CENTRE, CENTRE, GAUGE_R, angle);
        const to = polarToCartesian(CENTRE, CENTRE, GAUGE_R + (major ? 8 : 4), angle);
        return { key: i, major, x1: from.x, y1: from.y, x2: to.x, y2: to.y };
      }),
    [],
  );

  // The needle shares the dial's origin, so it is placed at the rotated position rather
  // than the wall-clock angle. Between midnight and 08:30 there is no day to point into,
  // so it parks at twelve rather than sweeping the wrong way.
  const awake = minutesOfDay >= DAY_START_MIN;
  const needleAngle = awake ? minutesToAngle(minutesOfDay, DAY_START_MIN, AWAKEN_MIN) : 0;
  const active = metrics.find((m) => m.status === "active" || m.status === "due") ?? null;

  return (
    <div className="dial">
      <svg
        className="dial__svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ "--band": `${BAND}px` } as React.CSSProperties}
        role="img"
        aria-label={`Day dial, 24 hours from 08:30. ${active ? `Now in ${active.block.title}.` : "Nothing running."}`}
      >
        {/* The 30-minute grille. This is the dial's scale, so it is structure rather
            than decoration — 48 ticks, every fourth one taller. */}
        <g aria-hidden="true">
          {gaugeMarks.map((m) => (
            <line
              key={m.key}
              className={m.major ? "dial__gauge dial__gauge--major" : "dial__gauge"}
              x1={m.x1}
              y1={m.y1}
              x2={m.x2}
              y2={m.y2}
            />
          ))}
        </g>

        {/* 08:30, the origin of the whole dial. Wake up is a moment, not a task, so it
            has no slice of its own — it is the line the day starts on. */}
        <g className="dial__origin" aria-hidden>
          <line
            x1={polarToCartesian(CENTRE, CENTRE, GAUGE_R - 12, 0).x}
            y1={polarToCartesian(CENTRE, CENTRE, GAUGE_R - 12, 0).y}
            x2={polarToCartesian(CENTRE, CENTRE, GAUGE_R + 16, 0).x}
            y2={polarToCartesian(CENTRE, CENTRE, GAUGE_R + 16, 0).y}
          />
          <text
            x={CENTRE}
            y={CENTRE - R_LIT - BAND / 2 - 20}
            textAnchor="middle"
            className="dial__origin-label"
          >
            08:30 awake
          </text>
        </g>

        {slices.map((slice) => (
          <Slice
            key={slice.metrics.block.id}
            slice={slice}
            selected={selectedId === slice.metrics.block.id}
            onSelect={onSelect}
          />
        ))}

        {/* The needle. `will-change: transform` lives on this element alone, because
            transform is the one property the compositor can genuinely accelerate. */}
        <g
          className={awake ? "dial__needle" : "dial__needle dial__needle--parked"}
          style={{ transform: `rotate(${needleAngle}deg)`, transformOrigin: `${CENTRE}px ${CENTRE}px` }}
        >
          <line x1={CENTRE} y1={CENTRE - R_LIT + BAND / 2 + 5} x2={CENTRE} y2={CENTRE - R_LIT - BAND / 2 - 12} />
        </g>
        <circle className="dial__needle-cap" cx={CENTRE} cy={CENTRE} r={3} />

        <circle cx={CENTRE} cy={CENTRE} r={R_LIT - BAND / 2} fill="none" stroke="var(--hairline-soft)" strokeWidth={1} />
      </svg>

      <Hub active={active} now={now} awake={awake} />
    </div>
  );
}

function Slice({
  slice,
  selected,
  onSelect,
}: {
  slice: SliceGeometry;
  selected: boolean;
  onSelect: (id: BlockId) => void;
}) {
  const { metrics: m, gStart, gEnd } = slice;
  const color = KIND_COLOR[m.block.kind as BlockKind];
  const alarmed = m.status === "missed";

  // Every band shares one geometry; only the dash pattern differs.
  const d = arcPath(CENTRE, CENTRE, R_LIT, gStart, gEnd);
  const dRim = arcPath(CENTRE, CENTRE, R_LIT + BAND / 2 + 4, gStart, gEnd);

  // Lit = focus, measured from the start of the slice.
  const lit = dashFor(0, m.progress * 100);
  // Wasted = the stretch of elapsed window that focus did not cover, so it begins where
  // the lit band stops. Units are percent of this slice's own arc: 3 hours of study is
  // 5 units of the dial, so 33 wasted minutes reads as ~18.
  const wasteLen = Math.max(0, Math.min(m.timeProgress, 1 - m.progress) * 100);
  const waste = dashFor(m.progress * 100, wasteLen);
  const track = fullDash();

  const label = [
    m.block.title,
    `${formatHm(m.startMs)} to ${formatHm(m.endMs)}`,
    describe(m),
  ].join(". ");

  return (
    <g
      className={`dial__slice${selected ? " dial__slice--selected" : ""}`}
      tabIndex={0}
      role="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={() => onSelect(m.block.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(m.block.id);
        }
      }}
    >
      <path className="dial__hover" d={d} />

      {/* The whole planned window, in the block's own colour but very dim. Keeping the
          category colour here is what stops a bad day from turning the whole dial red
          and losing the fact that those hours were study, not lunch. */}
      <path
        className="dial__track"
        d={d}
        stroke={color}
        pathLength={100}
        strokeDasharray={track.dasharray}
        strokeDashoffset={track.dashoffset}
      />

      {/* Elapsed-but-unlit. Butt caps, deliberately: round caps turn every dash of a
          long dasharray into a visible disc, which scattered translucent circles across
          the dial. */}
      {wasteLen > 0.01 ? (
        <path
          className="dial__waste"
          d={d}
          stroke={color}
          pathLength={100}
          strokeDasharray={waste.dasharray}
          strokeDashoffset={waste.dashoffset}
        />
      ) : null}

      <path
        className="dial__lit"
        d={d}
        stroke={color}
        pathLength={100}
        strokeDasharray={lit.dasharray}
        strokeDashoffset={lit.dashoffset}
        opacity={m.progress > 0.001 ? 1 : 0}
      />

      {/* A missed block gets a hard red rim outside the band rather than having its
          whole slice repainted. The failure is then unmistakable at a glance, and the
          dial still tells you which kind of block you lost. */}
      {alarmed ? <path className="dial__rim" d={dRim} stroke={ALARM_COLOR} /> : null}

      {/* The hit area sits on the band radius with `pointer-events: all`, so the whole
          slice responds — including the gaps and the edges, which a filled wedge alone
          would leave dead. */}
      <path className="dial__hit" d={d} />
      <title>{label}</title>
    </g>
  );
}

function Hub({ active, now, awake }: { active: BlockMetrics | null; now: number; awake: boolean }) {
  // Overnight the dial has nothing to say about focus, so it says the only true thing
  // available: the day is not running yet. "Off the clock" with a bare dash underneath
  // was technically accurate and completely useless.
  if (!awake) {
    return (
      <div className="dial__hub">
        <span className="dial__now-label">Night</span>
        <span className="dial__now-block">Not on the clock</span>
        <span className="dial__now-detail mono">{formatHm(now)}</span>
        <span className="dial__now-detail mono">wake at 08:30</span>
      </div>
    );
  }

  return (
    <div className="dial__hub">
      <span className="dial__now-label">{active ? (active.status === "missed" ? "Ended" : "Now") : "Now"}</span>
      <span className="dial__now-block">{active ? active.block.title : "Between blocks"}</span>
      <span className="dial__now-detail mono">{active ? `${formatHm(active.startMs)}–${formatHm(active.endMs)}` : formatHm(now)}</span>
{active ? (
          <span className="dial__now-detail mono">
            {/* Both in "3 h" form. formatDuration here would read "52:00 of 3 h", which
                is two different notations in one line. */}
            {active.block.timed ? `${formatSpan(active.focusedMs)} of ${formatSpan(active.plannedMs)}` : "no timer"}
          </span>
        ) : null}
    </div>
  );
}

/**
 * Colour alone never carries meaning here. Every coloured band is paired with text in
 * the slice's accessible name, the rail label, and the panel.
 */
function describe(m: BlockMetrics): string {
  switch (m.status) {
    case "future":
      return `Starts at ${formatHm(m.startMs)}, not yet due`;
    case "due":
      return "Starts in under five minutes";
    case "active":
      return m.isRunning
        ? `Timer running, ${Math.round(m.progress * 100)} percent focused`
        : `In progress but the timer is not running, ${Math.round(m.progress * 100)} percent focused`;
    case "done":
      return `Completed, ${formatSpan(m.focusedMs)} focused`;
    case "missed":
      return `Missed, ended at ${formatHm(m.endMs)} with ${Math.round(m.progress * 100)} percent focused`;
    case "passthrough":
      return "No timer on this block";
  }
}

export type { BlockStatus };