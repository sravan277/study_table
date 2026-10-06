"use client";

import Link from "next/link";
import { memo, useCallback, useMemo, useState } from "react";
import { ClientOnly } from "@/lib/client-only";
import { MAX_RECORDS, clearHistory, groupByMonth, summarise, type DayRecord, type MonthGroup } from "@/lib/history";
import { KIND_COLOR } from "@/lib/schedule";
import { StoreProvider, useStore } from "@/lib/store";
import { formatDuration, formatHm, formatSpan, pad } from "@/lib/time";
import type { BlockKind, BlockMetrics, BlockStatus } from "@/lib/types";

/**
 * `logs.css` is imported by the segment layout, not here.
 *
 * Imported by the page instead, Next preloads the stylesheet for the route and then does
 * not apply it before load, which Chrome reports as "preloaded but not used" — a warning
 * on every visit to this page. A layout's stylesheet is part of the route's own render
 * and is applied with it.

/**
 * The archive.
 *
 * Everything below reads from localStorage, so there is nothing to fetch and nothing
 * to be stale: the dial's own snapshot is thrown away at midnight, the archive is the
 * copy that survives, and the only question this page answers is what it says.
 *
 * Structure, top to bottom: the archive's own summary, then today's live card —
 * today is not in here yet, it is written at rollover — then the archived days by
 * month, then the two destructive things you can do to a log.
 */

/* ------------------------------------------------------------------ page --- */

export default function Page() {
  // Bumped by "Clear all history" to remount the provider. `clearHistory` removes the
  // key and tells nobody; without a re-read the context would keep serving the array it
  // loaded on mount and the page would carry on showing the days that were just deleted.
  // One deliberate remount is cheaper and more honest than a refresh hook that exists
  // only to serve this button.
  const [epoch, setEpoch] = useState(0);

  return (
    <StoreProvider key={epoch}>
      <ClientOnly fallback={<Shell />}>
        <Logs onCleared={() => setEpoch((n) => n + 1)} />
      </ClientOnly>
    </StoreProvider>
  );
}

/**
 * What the server sends. The record count comes from localStorage and the focus total
 * from the archive, so there is no honest number to print here — a shaped quiet shell
 * beats six zeros that are wrong for a frame.
 */
function Shell() {
  return (
    <main className="shell logs" aria-busy="true">
      <header className="logs__head">
        <Link href="/" className="logs__back">
          Dial
        </Link>
        <h1 className="logs__title">Logs</h1>
      </header>
      <p className="hint">Reading the archive.</p>
    </main>
  );
}

/* ------------------------------------------------------------------ main --- */

function Logs({ onCleared }: { onCleared: () => void }) {
  const { history, today, stats, metrics } = useStore();

  const archive = useSettledHistory(history);
  const summary = useMemo(() => summarise(archive), [archive]);
  const months = useMemo(() => groupByMonth(archive), [archive]);
  const liveBlocks = useMemo(() => metrics.map(viewOf), [metrics]);

  // From the store rather than from `new Date()`: the archive is filed in IST, so the
  // year a row belongs to has to be judged in IST too or 31 December drops its year.
  const currentYear = Number(today.slice(0, 4));

  return (
    <main className="shell logs">
      <header className="logs__head">
        <Link href="/" className="logs__back">
          Dial
        </Link>
        <h1 className="logs__title">Logs</h1>
        <span className="logs__rule" />
        <span className="logs__count mono">
          {archive.length} {archive.length === 1 ? "day" : "days"} archived
        </span>
      </header>

      <section className="logs__live" aria-label="Today, still in progress">
        {/* Same component as an archived row, so the two never drift apart visually.
            `perfect` is hard false: a day with blocks still to run has not earned one,
            and awarding it would be the archive's one unforgivable lie. */}
        <DayCard
          date={today}
          currentYear={currentYear}
          totals={{ ...stats, perfect: false }}
          blocks={liveBlocks}
          live
        />
      </section>

      {archive.length === 0 ? (
        <EmptyArchive />
      ) : (
        <>
          <section aria-label="Archive summary">
            <div className="stats">
              <Tile
                label="Days tracked"
                value={String(summary.days)}
                sub={`since ${months[months.length - 1].label}`}
              />
              <Tile
                label="Total focused"
                value={hoursMinutes(summary.totalFocusedMs)}
                sub={`${hoursMinutes(summary.totalWastedMs)} wasted`}
                tone="lit"
              />
              <Tile label="Streak" value={String(summary.currentStreak)} sub={`best ${summary.bestStreak}`} />
              <Tile label="Avg efficiency" value={`${summary.avgEfficiency}%`} sub="focused over planned" />
              <Tile
                label="Perfect days"
                value={String(summary.perfectDays)}
                sub="every timed block met"
              />
            </div>
          </section>

          <Archive months={months} currentYear={currentYear} />
        </>
      )}

      <ArchiveActions archive={archive} today={today} onCleared={onCleared} />
    </main>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "lit" | "alarm";
}) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value mono${tone ? ` stat__value--${tone}` : ""}`}>{value}</div>
      <div className="stat__sub">{sub}</div>
    </div>
  );
}

/**
 * Nothing archived yet.
 *
 * The tempting thing to add here is a chart of zero, or a sample week. Both would be
 * fiction. The one fact a new user actually needs is when this page starts being
 * wrong: a day is filed at midnight, once the dial can no longer change it.
 */
function EmptyArchive() {
  return (
    <div className="hint">
      <strong className="logs__empty-head">No days archived yet.</strong>{" "}
      A day is written here at midnight, once the dial has stopped being able to change it — so the entry for
      today appears tomorrow morning. Today&rsquo;s running numbers are above; they join the archive overnight, not
      before. The log keeps {MAX_RECORDS} days and then drops the oldest.
    </div>
  );
}

/* --------------------------------------------------------------- archive --- */

/**
 * Every archived day.
 *
 * Memoised, and that is load-bearing rather than incidental. The store ticks four
 * times a second and today's live card has to follow it; without a boundary, one tick
 * would re-render up to `MAX_RECORDS` rows whose numbers have not changed by a
 * millisecond. The months array only changes when the archive does, so `memo` plus a
 * stable `history` identity is all the isolation a WebView needs.
 */
const Archive = memo(function Archive({
  months,
  currentYear,
}: {
  months: MonthGroup[];
  currentYear: number;
}) {
  // One open row at a time. Several would stack six block ledgers per row and the page
  // stops being scannable, which is the only job it has.
  const [openDate, setOpenDate] = useState<string | null>(null);
  const toggle = useCallback((date: string) => {
    setOpenDate((prev) => (prev === date ? null : date));
  }, []);

  return (
    <section className="logs__section" aria-label="Archived days">
      <div className="logs__section-head">
        <h2 className="logs__section-title">Archive</h2>
        <span className="logs__rule" />
        <span className="logs__section-note mono">newest first</span>
      </div>

      {months.map((group) => (
        <Month key={group.key} group={group} currentYear={currentYear} openDate={openDate} onToggle={toggle} />
      ))}
    </section>
  );
});

function Month({
  group,
  currentYear,
  openDate,
  onToggle,
}: {
  group: MonthGroup;
  currentYear: number;
  openDate: string | null;
  onToggle: (date: string) => void;
}) {
  // The heading's own tally, so a month can be judged without opening any of it.
  const focused = group.records.reduce((sum, r) => sum + r.focusedMs, 0);
  const perfect = group.records.filter((r) => r.perfect).length;

  return (
    <section className="logs__month" aria-label={group.label}>
      <h3 className="logs__month-label">{group.label}</h3>
      <p className="logs__month-tally mono">
        {group.records.length} {group.records.length === 1 ? "day" : "days"} · {hoursMinutes(focused)} focused
        {perfect > 0 ? ` · ${perfect} perfect` : ""}
      </p>

      <ul className="logs__days">
        {group.records.map((record) => (
          <li key={record.date}>
            <DayCard
              date={record.date}
              currentYear={currentYear}
              totals={record}
              blocks={record.blocks}
              onToggle={onToggle}
              open={openDate === record.date}
              controlled
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------- day card --- */

/** The numbers a day has to show, whichever kind of day it is. `DayRecord` satisfies it. */
interface DayTotals {
  plannedMs: number;
  focusedMs: number;
  wastedMs: number;
  timedBlocks: number;
  doneBlocks: number;
  missedBlocks: number;
  waterTotal: number;
  waterDone: number;
  efficiency: number;
  perfect: boolean;
}

/**
 * One day: a summary row that expands into a per-block ledger.
 *
 * Rendered for today's live entry and for every archived day from the same code, so
 * "in progress" and "finished" cannot end up looking like two different features.
 * `open`/`onToggle` are supplied by the archive; the live card keeps its own state.
 */
function DayCard({
  date,
  currentYear,
  totals,
  blocks,
  live = false,
  open,
  onToggle,
  controlled = false,
}: {
  date: string;
  currentYear: number;
  totals: DayTotals;
  blocks: BlockView[];
  live?: boolean;
  open?: boolean;
  onToggle?: (date: string) => void;
  controlled?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = controlled ? Boolean(open) : ownOpen;
  const setOpen = controlled ? undefined : setOwnOpen;

  const anchor = dayAnchor(date);
  const weekday = anchor ? weekdayFormat.format(anchor) : "";
  const dayNumber = anchor ? pad(anchor.getUTCDate()) : date;
  const monthName = anchor ? monthFormat.format(anchor) : "";
  const year = anchor ? anchor.getUTCFullYear() : 0;
  // The year is only load-bearing when it is not the year you are reading this in.
  const showYear = anchor !== null && year !== currentYear;

  const buttonId = `logs-row-${date}`;
  const panelId = `logs-panel-${date}`;

  // Timed blocks only. The archive keeps sleep, lunch, break and dinner as well, and
  // each of those carries a wastedMs equal to however much of its window went by —
  // 8 h 30 for sleep alone. Listed unfiltered, the page would tell you that you wasted
  // fourteen hours, which is exactly the claim this app's accounting exists to refuse:
  // a block with no timer has nothing to complete and therefore nothing to waste.
  const timed = blocks.filter((b) => b.timed);

  // Hours and minutes for a day that is over, h:mm:ss for one that is still running.
  // A finished day has no moving part left, so the seconds would only add width that
  // never has to hold still; today's figure is a timer and should read like one.
  const focusedText = live ? formatDuration(totals.focusedMs) : hoursMinutes(totals.focusedMs);

  const focusPct = totals.efficiency;
  const wastePct = totals.plannedMs > 0 ? Math.max(0, Math.min(100, (totals.wastedMs / totals.plannedMs) * 100)) : 0;

  return (
    <>
      <button
        id={buttonId}
        type="button"
        className="logs__row"
        // The row's ISO date as a stable selector hook. The visible date is rendered
        // for people ("Wed 30", year hidden unless it differs) and is useless to a test
        // that has to tell one day from another: a bare `hasText: "30"` also matches
        // today's live card whenever its day number and its running timer happen to
        // share a digit, which is how "30" came to match "Sat 03" + "00:00:00". That
        // made a passing test silently start asserting against the wrong row. The ISO
        // string is unambiguous and does not move when the design does.
        data-date={date}
        aria-expanded={isOpen}
        aria-controls={panelId}
        // The row's visible text is the visual truth; this is the same information as
        // one sentence, so a screen reader is not made to assemble it from seven spans.
        // The bar below is hidden as a result and carries nothing the label lacks.
        aria-label={daySentence({
          date: anchor ? `${weekday} ${Number(dayNumber)} ${monthName}` : date,
          totals,
          live,
        })}
        onClick={() => (setOpen ? setOpen(!isOpen) : onToggle?.(date))}
      >
        <span className="logs__date">
          <span className="logs__date-weekday">{weekday || "—"}</span>
          <span className="logs__date-day mono">{dayNumber}</span>
          {showYear ? <span className="logs__date-year mono">{year}</span> : null}
        </span>

        <span className="logs__main">
          <span className="logs__main-line">
            <span className="logs__focused mono">{focusedText}</span>
            <span className="logs__eff mono">focused</span>
            <span className="logs__eff mono">{totals.efficiency}%</span>
          </span>
          <span className="logs__bar" aria-hidden>
            <span className="logs__bar-focus" style={{ width: `${focusPct}%` }} />
            <span
              className="logs__bar-waste"
              style={{ left: `${focusPct}%`, width: `${Math.max(0, Math.min(100 - focusPct, wastePct))}%` }}
            />
          </span>
        </span>

        <span className="logs__facts">
          <span className="logs__fact mono">
            {totals.doneBlocks}/{totals.timedBlocks} blocks
          </span>
          <span className={`logs__fact mono${totals.missedBlocks > 0 ? " logs__fact--missed" : ""}`}>
            {totals.missedBlocks} missed
          </span>
          <span className="logs__fact mono">
            {totals.waterDone}/{totals.waterTotal} water
          </span>
        </span>

        <span className="logs__marks">
          {live ? <span className="logs__chip logs__chip--live">Today · live</span> : null}
          {totals.perfect && !live ? <span className="logs__chip logs__chip--perfect">Perfect</span> : null}
          {totals.missedBlocks > 0 ? (
            <span className="logs__chip logs__chip--missed">{totals.missedBlocks} missed</span>
          ) : null}
          <span className="logs__chevron" aria-hidden />
        </span>
      </button>

      {isOpen ? (
        <div className="logs__panel" id={panelId} role="region" aria-labelledby={buttonId}>
          <p className="logs__panel-note">
            {timed.length} timed {timed.length === 1 ? "block" : "blocks"}. Meals, breaks and sleep carry no timer,
            so they are not listed: there is nothing they could have completed, and nothing they could have wasted.
          </p>
          {timed.map((block) => (
            <BlockLedger key={block.id} block={block} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function BlockLedger({ block }: { block: BlockView }) {
  const missed = block.status === "missed";

  return (
    <div className="logs__block">
      <div className="logs__block-head">
        <span className="logs__swatch" style={{ background: KIND_COLOR[block.kind] }} aria-hidden />
        <span className="logs__block-title">{block.title}</span>
        <span className={`logs__block-status${missed ? " logs__block-status--missed" : ""}`}>
          {statusWord(block.status)}
        </span>
      </div>

      {/* The dock's ledger, verbatim in shape. Waste is split into its two causes because
          they are two different problems: never pressing start is a habit, pausing is
          an interruption, and a single "wasted" number cannot tell them apart. */}
      <div className="ledger">
        <LedgerRow k="Focused" v={formatDuration(block.focusedMs)} />
        <LedgerRow k="Planned" v={formatSpan(block.plannedMs)} />
        <LedgerRow k="Wasted" v={formatDuration(block.wastedMs)} alarm={block.wastedMs > 0} />
        <LedgerRow k="· before you started" v={formatDuration(block.unstartedMs)} alarm={block.unstartedMs > 0} />
        <LedgerRow k="· while paused" v={formatDuration(block.pausedMs)} alarm={block.pausedMs > 0} />
      </div>
    </div>
  );
}

function LedgerRow({ k, v, alarm }: { k: string; v: string; alarm?: boolean }) {
  return (
    <div className="ledger__row">
      <span className="ledger__key">{k}</span>
      <span className={`ledger__val mono${alarm ? " ledger__val--waste" : ""}`}>{v}</span>
    </div>
  );
}

/* --------------------------------------------------------------- actions --- */

/**
 * Export and delete.
 *
 * Both children are keyed, and that is not decoration. The confirm step adds and
 * removes siblings around the destructive button; without stable keys React matches
 * children by index, the button's type changes from one element to another, and the
 * element holding keyboard focus is destroyed — so arming the confirm would throw a
 * keyboard user back to the top of the document at the exact moment the page is asking
 * them to be careful.
 */
function ArchiveActions({
  archive,
  today,
  onCleared,
}: {
  archive: DayRecord[];
  today: string;
  onCleared: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const empty = archive.length === 0;

  const onExport = () => {
    downloadArchive(archive, exportFilename(today));
    setNote(`Exported ${archive.length} ${archive.length === 1 ? "day" : "days"} as JSON.`);
  };

  const onClear = () => {
    // Archive only. Today's snapshot lives under a different key and is not touched,
    // so this cannot cost anyone the day they are in the middle of.
    clearHistory();
    setConfirming(false);
    onCleared();
    setNote("Archive cleared. Today is untouched and will be filed at midnight.");
  };

  return (
    <div className="logs__actions">
      {confirming ? (
        <p className="logs__warn" key="warn">
          <strong>
            Delete {archive.length} archived {archive.length === 1 ? "day" : "days"}?
          </strong>{" "}
          This cannot be undone. Export first if there is any doubt. Today&rsquo;s running day is not part of it.
        </p>
      ) : null}

      <button key="export" type="button" className="btn" onClick={onExport} disabled={empty}>
        Export JSON
      </button>

      <button
        key="danger"
        type="button"
        className={`btn${confirming ? " btn--primary" : " btn--danger"}`}
        style={{ ["--accent" as string]: confirming ? "var(--alarm)" : undefined }}
        onClick={() => (confirming ? onClear() : setConfirming(true))}
        disabled={empty}
      >
        {confirming ? "Yes, clear the archive" : "Clear all history"}
      </button>

      {confirming ? (
        <button key="cancel" type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      ) : null}

      <p className="logs__note" key="note" role="status">
        {note || "Exports the archived days as JSON. Today is not in it until midnight."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ data --- */

/**
 * The slice of a block this page needs.
 *
 * Narrower than `DayRecordBlock` deliberately: it drops the start and completion
 * stamps, which nothing here renders, so today's card can build one of these straight
 * from `BlockMetrics` instead of inventing epoch values the live metrics never carried.
 */
interface BlockView {
  id: string;
  title: string;
  kind: BlockKind;
  timed: boolean;
  plannedMs: number;
  focusedMs: number;
  wastedMs: number;
  unstartedMs: number;
  pausedMs: number;
  status: BlockStatus;
}

function viewOf(m: BlockMetrics): BlockView {
  return {
    id: m.block.id,
    title: m.block.title,
    kind: m.block.kind,
    timed: m.block.timed,
    plannedMs: m.plannedMs,
    focusedMs: m.focusedMs,
    wastedMs: m.wastedMs,
    unstartedMs: m.unstartedMs,
    pausedMs: m.pausedMs,
    status: m.status,
  };
}

/**
 * The previous array, unless this one genuinely differs.
 *
 * `memo` around <Archive> is only worth anything if `history` holds its identity
 * between archive writes, and that is the store's business rather than this page's. A
 * store that re-read localStorage on the 250ms tick would hand over a fresh array four
 * times a second and drag every archived row along with it; comparing by content costs
 * a linear scan of at most `MAX_RECORDS` entries and makes the memo correct either way.
 *
 * Adjusted during render rather than in an effect, for the reason the store's own
 * midnight rollover gives: React documents this pattern for state derived from a changed
 * input, and an effect would spend a frame re-rendering up to 400 rows on an archive
 * that is already the right one.
 */
function useSettledHistory(history: DayRecord[]): DayRecord[] {
  const [settled, setSettled] = useState(history);
  if (!sameArchive(settled, history)) setSettled(history);
  return settled;
}

function sameArchive(a: DayRecord[], b: DayRecord[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((record, i) => record.date === b[i].date && record.archivedAt === b[i].archivedAt);
}

/* ------------------------------------------------------------------ util --- */

const weekdayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });
const monthFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long" });

/**
 * A display `Date` for an ISO day.
 *
 * Anchored at UTC noon for the reason `monthLabel` in history.ts is: "2026-10-01"
 * parses as UTC midnight, which is 05:30 in IST, and formatting that instant in a
 * local zone is how a row under an "October 2026" heading ends up reading the 30th.
 *
 * Null rather than an Invalid Date, because formatting one throws RangeError out of a
 * render, and one row that will not format must not cost the other 399.
 */
function dayAnchor(date: string): Date | null {
  const parts = date.split("-");
  if (parts.length !== 3) return null;
  const [year, month, day] = parts.map(Number);
  const at = new Date(Date.UTC(year, month - 1, day, 12));
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * "41h 12m" for archive-scale totals.
 *
 * `formatDuration` is deliberately the wrong tool here: it reports seconds and pads the
 * hour, so a month of focus reads "41:12:00" — a resolution nobody wants from a figure
 * that reaches four digits, and one whose zeros say nothing. `formatSpan` is closer but
 * puts spaces where this app's compact figures do not. Whole minutes cost less than a
 * minute a day across the whole archive.
 */
function hoursMinutes(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  return hrs > 0 ? `${hrs}h ${rest}m` : `${rest}m`;
}

/**
 * `day-dial-logs-2026-10-02-1425.json`.
 *
 * The date comes from the store rather than from `new Date()` so the filename matches
 * the dates inside the file even if the device is set to another zone. The minutes are
 * in it because a date alone collides: a morning export and an evening one on the same
 * day are the same filename, and the second silently overwrites the first.
 */
function exportFilename(today: string): string {
  return `day-dial-logs-${today}-${formatHm(Date.now()).replace(":", "")}.json`;
}

function downloadArchive(archive: DayRecord[], filename: string): void {
  const payload = {
    app: "day-dial",
    exportedAt: new Date().toISOString(),
    records: archive,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Not in the same tick. `click()` only queues the download — the blob is read
  // asynchronously — and a URL revoked before the browser gets to it is a download that
  // silently never arrives. One macrotask is enough for the hand-off, and the blob is
  // still released immediately afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * One sentence per day.
 *
 * Spelled out rather than assembled from the row's own text so the numbers arrive in a
 * form that can be read aloud: "3 of 6 timed blocks done" instead of "3 6 0 8 14".
 */
function daySentence({
  date,
  totals,
  live,
}: {
  date: string;
  totals: DayTotals;
  live: boolean;
}): string {
  return [
    date,
    live ? "still in progress" : "archived",
    `${hoursMinutes(totals.focusedMs)} focused`,
    `${totals.efficiency} percent efficiency`,
    `${totals.doneBlocks} of ${totals.timedBlocks} timed blocks done`,
    totals.missedBlocks > 0 ? `${totals.missedBlocks} missed` : "none missed",
    totals.perfect && !live ? "perfect day" : null,
    `${totals.waterDone} of ${totals.waterTotal} glasses of water`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

/**
 * One word per block state.
 *
 * Not imported from `statusText` in Readout.tsx: that one takes a `BlockMetrics` and
 * talks about a running timer, which is exactly the distinction this panel must not
 * draw. An archived block does not run.
 */
function statusWord(status: BlockStatus): string {
  switch (status) {
    case "done":
      return "done";
    case "missed":
      return "missed";
    case "active":
      return "in progress";
    case "due":
      return "due shortly";
    case "future":
      return "not yet";
    case "passthrough":
      return "no timer";
  }
}