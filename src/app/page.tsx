"use client";

import Link from "next/link";
import { DayDial } from "@/components/DayDial";
import { Clock } from "@/components/Clock";
import { Dock } from "@/components/Dock";
import { Legend, Rail, Stats } from "@/components/Readout";
import { Toaster } from "@/components/Toaster";
import { ReminderEngine } from "@/components/ReminderEngine";
import { BackendLamp, NotifyLamp, WaterMeter } from "@/components/Controls";
import { AWAKEN_MIN, DAY_START_MIN } from "@/lib/schedule";
import { isConfigured } from "@/lib/supabase";
import { StoreProvider, useStore } from "@/lib/store";
import { ClientOnly } from "@/lib/client-only";
import { formatDateLong, formatDuration } from "@/lib/time";

export default function Page() {
  return (
    <StoreProvider>
      <ClientOnly fallback={<Shell />}>
        <DayDialPage />
      </ClientOnly>
    </StoreProvider>
  );
}

/**
 * What the server sends. Every real value on this page comes from the IST clock or
 * from localStorage, neither of which exists during SSR — so sending a shaped skeleton
 * is more honest than sending numbers that would immediately be wrong.
 */
function Shell() {
  return (
    <main className="shell" aria-busy="true">
      <header className="plate">
        <h1 className="plate__mark">Day Dial</h1>
        <span className="plate__rule" />
        <span className="plate__zone mono">Asia/Kolkata</span>
      </header>
      <div className="hero">
        <div className="hero__stage">
          <div className="dial" style={{ opacity: 0.25 }} aria-hidden />
          <div className="clock">
            <div className="clock__digits mono">--:--:--</div>
          </div>
        </div>
        <aside className="dock">
          <div className="dock__empty">
            <div className="dock__empty-head">Loading</div>
            <div className="dock__next">Reading today&rsquo;s dial</div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function DayDialPage() {
  const {
    now,
    minutesOfDay,
    metrics,
    stats,
    water,
    selected,
    current,
    upcoming,
    toasts,
    selectedId,
    select,
    start,
    pause,
    complete,
    reset,
    acknowledgeWater,
    dismissToast,
    remoteStatus,
  } = useStore();

  // Minutes from the dial's own origin (08:30) to now, and what is left of the day.
  const minutesSinceWake = minutesOfDay >= DAY_START_MIN ? minutesOfDay - DAY_START_MIN : minutesOfDay + 24 * 60 - DAY_START_MIN;
  const awakeProgress = Math.min(1, Math.max(0, minutesSinceWake / AWAKEN_MIN));
  const remainingMs = Math.max(0, (AWAKEN_MIN - minutesSinceWake) * 60_000);

  return (
    <main className="shell">
      <ReminderEngine />

      <header className="plate">
        <h1 className="plate__mark">Day Dial</h1>
        <span className="plate__date">{formatDateLong(now)}</span>
        <span className="plate__rule" />
        <span className="plate__zone mono">Asia/Kolkata</span>
        {/* The archive is a second screen rather than a fourth lamp: it is looked at
            occasionally and deliberately, not glanced at, and a lamp invites a glance. */}
        <Link className="plate__link" href="/logs">
          Logs
        </Link>
        <div className="lamps">
          <WaterMeter slots={water} now={now} onAcknowledge={acknowledgeWater} />
          <NotifyLamp />
          <BackendLamp status={remoteStatus} />
        </div>
      </header>

      <div className="hero">
        <div className="hero__stage">
          <DayDial
            metrics={metrics}
            now={now}
            minutesOfDay={minutesOfDay}
            selectedId={selectedId}
            onSelect={(id) => select(selectedId === id ? null : id)}
          />
          <Clock now={now} awakeProgress={awakeProgress} remaining={remainingMs} />
        </div>

        <Dock
          selected={selected}
          upcoming={upcoming}
          metrics={metrics}
          onSelect={(id) => select(id)}
          onStart={start}
          onPause={pause}
          onComplete={complete}
          onReset={reset}
          onClose={() => select(null)}
        />
      </div>

      <Rail metrics={metrics} selectedId={selectedId} onSelect={(id) => select(id)} />
      <Stats stats={stats} />
      <Legend />

      <CurrentLine current={current} stats={stats} />

      {!isConfigured ? (
        <p className="hint">
          Running on local storage, which is enough for the timer and the reminders while this tab is open. To sync the
          day across devices and get push notifications with the browser closed, add your Supabase keys to{" "}
          <code>.env.local</code> — see <code>docs/SETUP_SUPABASE.md</code> for the exact dashboard steps.
        </p>
      ) : null}

      <Toaster
        toasts={toasts}
        onDismiss={dismissToast}
        onAction={(blockId) => {
          select(blockId as never);
          start(blockId as never);
        }}
      />
    </main>
  );
}

/** One line of plain English about where the day actually is. */
function CurrentLine({ current, stats }: { current: ReturnType<typeof useStore>["current"]; stats: ReturnType<typeof useStore>["stats"] }) {
  if (!current) {
    return (
      <p className="hint">
        Nothing is running. {stats.missedBlocks > 0 ? `${stats.missedBlocks} block(s) ended short today.` : "The dial is clear."}{" "}
        {formatDuration(stats.focusedMs)} focused so far.
      </p>
    );
  }

  return (
    <p className="hint">
      <strong>{current.block.title}</strong> runs {formatDuration(current.plannedMs)}, and{" "}
      {formatDuration(current.focusedMs)} of that is counted as focused. Anything the timer is not running for counts as
      wasted, so the slice only fills while you are actually on it.
    </p>
  );
}