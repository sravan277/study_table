"use client";

import { useMemo } from "react";
import { KIND_COLOR, LEAD_MS } from "@/lib/schedule";
import { startBlocker } from "@/lib/metrics";
import { formatDuration, formatHm, formatRelative, formatSpan } from "@/lib/time";
import type { BlockId, BlockMetrics } from "@/lib/types";

/**
 * The timer dock.
 *
 * Lives to the right of the dial, which is where the slice it belongs to points. The
 * pointer rule on its left edge is aligned to that slice's vertical centre, so the
 * connection between "I clicked that arc" and "this panel opened" is spatial rather
 * than something you have to read.
 *
 * The panel's real job is the ledger. Focused time fills the slice; everything else is
 * waste, and waste is split into the two causes so you can see which one you are
 * actually doing — never having pressed start, or having paused.
 */
export function Dock({
  selected,
  upcoming,
  metrics,
  onSelect,
  onStart,
  onPause,
  onComplete,
  onReset,
  onClose,
}: {
  selected: BlockMetrics | null;
  upcoming: BlockMetrics | null;
  metrics: BlockMetrics[];
  onSelect: (id: BlockId) => void;
  onStart: (id: BlockId) => void;
  onPause: (id: BlockId) => void;
  onComplete: (id: BlockId) => void;
  onReset: (id: BlockId) => void;
  onClose: () => void;
}) {
  return (
    <aside className="dock" style={{ ["--accent" as string]: selected ? KIND_COLOR[selected.block.kind] : undefined }}>
      {selected?.block.timed ? (
        <TimedPanel
          m={selected}
          onStart={onStart}
          onPause={onPause}
          onComplete={onComplete}
          onReset={onReset}
          onClose={onClose}
        />
      ) : selected ? (
        <PassThroughPanel m={selected} metrics={metrics} onSelect={onSelect} onClose={onClose} />
      ) : (
        <IdlePanel upcoming={upcoming} metrics={metrics} onSelect={onSelect} />
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ idle --- */

function IdlePanel({
  upcoming,
  metrics,
  onSelect,
}: {
  upcoming: BlockMetrics | null;
  metrics: BlockMetrics[];
  onSelect: (id: BlockId) => void;
}) {
  return (
    <div className="dock__empty">
      <div className="dock__empty-head">Next up</div>
      {upcoming ? (
        <>
          <div className="dock__next">{upcoming.block.title}</div>
          <div className="dock__next-when">
            {formatHm(upcoming.startMs)} · {formatSpan(upcoming.plannedMs)} · {formatRelative(upcoming.startsInMs)}
          </div>
        </>
      ) : (
        <>
          <div className="dock__next">Day complete</div>
          <div className="dock__next-when">Nothing left on the dial.</div>
        </>
      )}

      <ul className="dock__list">
        {metrics
          .filter((m) => m.block.id !== "sleep")
          .map((m) => (
            <li key={m.block.id}>
              <span className="dock__swatch" style={{ background: KIND_COLOR[m.block.kind] }} />
              {/* One name, not two. Rendering both `title` and `label` produced rows
                  like "Lunch  Lunch" and "Study — morning  Study", which read as a
                  rendering bug even though both strings were correct. */}
              <button type="button" className="dock__pick" onClick={() => onSelect(m.block.id)}>
                {m.block.title}
              </button>
              {m.block.timed ? (
                <span className="dock__pct mono">{Math.round(m.progress * 100)}%</span>
              ) : (
                <span className="dock__pct dock__pct--none">no timer</span>
              )}
              <span className="dock__time mono">{formatHm(m.startMs)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------- pass-through --- */

function PassThroughPanel({
  m,
  metrics,
  onSelect,
  onClose,
}: {
  m: BlockMetrics;
  metrics: BlockMetrics[];
  onSelect: (id: BlockId) => void;
  onClose: () => void;
}) {
  const next = metrics.find((x) => x.block.timed && (x.status === "future" || x.status === "due"));

  return (
    <div className="dock__panel">
      <div className="dock__head">
        <span className="dock__swatch dock__swatch--lg" style={{ background: KIND_COLOR[m.block.kind] }} />
        <div>
          <div className="dock__title">{m.block.title}</div>
          <div className="dock__window mono">
            {formatHm(m.startMs)} – {formatHm(m.endMs)}
          </div>
        </div>
      </div>

      <div className="dock__readout">
        <span className="dock__big mono" style={{ color: "var(--life)" }}>
          {m.status === "active" || m.status === "due" ? "In progress" : m.status === "future" ? formatRelative(m.startsInMs) : "Passed"}
        </span>
        <span className="dock__big-label">No timer</span>
      </div>

      <p className="ledger__note">
        Meals, breaks and sleep carry no timer. There is nothing to complete and nothing can be wasted here — every
        wasted second on this dial belongs to a block you meant to work on.
      </p>

      <div className="dock__actions">
        {next ? (
          <button type="button" className="btn btn--primary" onClick={() => onSelect(next.block.id)}>
            {next.block.label} timer
          </button>
        ) : null}
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ timed --- */

function TimedPanel({
  m,
  onStart,
  onPause,
  onComplete,
  onReset,
  onClose,
}: {
  m: BlockMetrics;
  onStart: (id: BlockId) => void;
  onPause: (id: BlockId) => void;
  onComplete: (id: BlockId) => void;
  onReset: (id: BlockId) => void;
  onClose: () => void;
}) {
  const blocker = useMemo(() => startBlocker(m), [m]);
  const missed = m.status === "missed";
  const done = m.status === "done";
  const remainingMs = Math.max(0, m.plannedMs - m.focusedMs);
  const lateMs = missed ? -m.endsInMs : 0;

  // The pointer rule: align the dock's left edge to the slice it belongs to.
  const pointerTop = pointerPercent(m);

  const bigValue = done
    ? formatDuration(m.focusedMs)
    : missed
      ? `${Math.round(m.progress * 100)}%`
      : m.isRunning
        ? formatDuration(remainingMs)
        : formatDuration(m.plannedMs);

  const bigLabel = done ? "focused, complete" : missed ? "of the block focused" : m.isRunning ? "remaining" : "planned";

  return (
    <div
      className={`dock__panel${missed ? " dock__panel--missed" : ""}`}
      style={{ ["--accent" as string]: KIND_COLOR[m.block.kind] }}
    >
      {/* Spatial link back to the slice. Hidden when the column has stacked. */}
      <span className="dock__pointer" style={{ top: `${pointerTop}%`, height: 0 }} aria-hidden />

      <div className="dock__head">
        <span className="dock__swatch dock__swatch--lg" style={{ background: KIND_COLOR[m.block.kind] }} />
        <div>
          <div className="dock__title">{m.block.title}</div>
          <div className="dock__window mono">
            {formatHm(m.startMs)} – {formatHm(m.endMs)} · {formatSpan(m.plannedMs)}
          </div>
        </div>
      </div>

      <div className="dock__readout">
        <span className={`dock__big mono ${done ? "dock__big--lit" : missed ? "dock__big--alarm" : ""}`}>{bigValue}</span>
        <span className="dock__big-label">
          {bigLabel}
          {missed && lateMs > 0 ? (
            <>
              <br />
              ended {formatSpan(lateMs)} ago
            </>
          ) : null}
        </span>
      </div>

      {/* Same visual language as the dial: dim is planned, lit is focus. */}
      <div
        className="dock__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(m.progress * 100)}
        aria-label={`${m.block.title} progress`}
      >
        <div
          className="dock__bar-fill"
          style={{
            width: `${Math.min(100, m.progress * 100)}%`,
            background: missed ? "var(--alarm)" : KIND_COLOR[m.block.kind],
          }}
        />
      </div>

      {/* The ledger. This is the whole point of the app. */}
      <div className="ledger">
        <Row k="Focused" v={formatDuration(m.focusedMs)} />
        <Row k="Wasted" v={formatDuration(m.wastedMs)} alarm={m.wastedMs > 0} />
        <Row k="· before you started" v={formatDuration(m.unstartedMs)} alarm={m.unstartedMs > 0} />
        <Row k="· while paused" v={formatDuration(m.pausedMs)} alarm={m.pausedMs > 0} />
        <Row k="Remaining" v={formatDuration(remainingMs)} />
        <div className="ledger__row ledger__row--total">
          <span className="ledger__key">{missed ? "Missed" : done ? "Completed" : "Still to go"}</span>
          <span className={`ledger__val ${missed ? "ledger__val--waste" : ""}`}>
            {missed ? formatDuration(m.plannedMs - m.focusedMs) : done ? "on time" : formatRelative(m.endsInMs)}
          </span>
        </div>
      </div>

      <div className="dock__actions">
        {done || missed ? (
          <button type="button" className="btn btn--primary" onClick={() => onComplete(m.block.id)}>
            Mark complete
          </button>
        ) : m.isRunning ? (
          <button type="button" className="btn btn--primary" onClick={() => onPause(m.block.id)}>
            Pause
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onStart(m.block.id)}
            disabled={Boolean(blocker)}
          >
            Start
          </button>
        )}
        <button type="button" className="btn btn--danger" onClick={() => onReset(m.block.id)}>
          Reset
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {blocker && !done && !missed ? <p className="dock__gate">{blocker}</p> : null}

      {missed ? (
        <p className="dock__gate">
          This block ended at {formatHm(m.endMs)} with {formatDuration(m.focusedMs)} of {formatSpan(m.plannedMs)} focused.
          Every second after it ends counts as wasted, so pausing no longer protects anything.
        </p>
      ) : null}

      {m.isRunning && !done ? (
        <p className="dock__gate">
          Focus is only being counted while this runs. Pause and the slice stops filling — those seconds go to wasted
          instead.
        </p>
      ) : null}

      {!m.isRunning && !done && !missed && !m.hasStarted && m.status === "active" ? (
        <p className="dock__gate">
          {formatDuration(m.wastedMs)} of this block has already gone by without the timer running.
        </p>
      ) : null}
    </div>
  );
}

function Row({ k, v, alarm }: { k: string; v: string; alarm?: boolean }) {
  return (
    <div className="ledger__row">
      <span className="ledger__key">{k}</span>
      <span className={`ledger__val mono ${alarm ? "ledger__val--waste" : ""}`}>{v}</span>
    </div>
  );
}

/**
 * Vertical centre of a slice as a percentage of the dock's height.
 *
 * The dial's angle is measured clockwise from twelve o'clock, so the y offset is
 * `cos(angle)` — positive below the centre line, which is why the cosine is negated.
 */
function pointerPercent(m: BlockMetrics): number {
  const startDeg = ((m.block.startMin ?? 0) / 60) * 6;
  const endDeg = (m.block.endMin / 60) * 6;
  const mid = ((startDeg + endDeg) / 2) * (Math.PI / 180);
  const y = -Math.cos(mid);
  return Math.max(4, Math.min(96, ((y + 1) / 2) * 100));
}

export { LEAD_MS };