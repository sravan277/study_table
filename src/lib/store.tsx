"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BLOCK_BY_ID,
  EMPTY_STATE,
  computeBlockMetrics,
  computeMetrics,
  computeStats,
  currentBlock,
  nextBlock,
} from "./metrics";
import { flushSnapshot, loadSnapshot, saveSnapshot } from "./persist";
import { archiveSnapshot, loadHistory, upsertHistory, type DayRecord } from "./history";
import { LEAD_MS } from "./schedule";
import { TABLES, isConfigured, supabase } from "./supabase";
import { dayStartMs, dayStartMsFor, isoDate, wallClock } from "./time";
import type { BlockId, BlockMetrics, BlockState, DaySnapshot, DayStats, Toast, WaterSlot } from "./types";

/**
 * The clock.
 *
 * React ticks 4x a second; CSS transitions interpolate `stroke-dashoffset` between
 * those ticks. So the arcs move at 60fps while React re-renders 4 times a second, which
 * is both goals met without either one being brute forced.
 */
const TICK_MS = 250;

const REMOTE_DEBOUNCE_MS = 2500;

interface StoreValue {
  now: number;
  /** Minutes since IST midnight, derived here so no component re-implements the zone. */
  minutesOfDay: number;
  today: string;
  metrics: BlockMetrics[];
  /** Archived days, newest first. Today is not in here — it is filed at midnight. */
  history: DayRecord[];
  /** The block whose timer panel is open, if any. */
  selected: BlockMetrics | null;
  stats: DayStats;
  water: WaterSlot[];
  current: BlockMetrics | null;
  upcoming: BlockMetrics | null;
  toasts: Toast[];
  selectedId: BlockId | null;
  select: (id: BlockId | null) => void;
  start: (id: BlockId) => void;
  pause: (id: BlockId) => void;
  resume: (id: BlockId) => void;
  complete: (id: BlockId) => void;
  reset: (id: BlockId) => void;
  acknowledgeWater: (atMin: number) => void;
  pushToast: (toast: Omit<Toast, "id" | "createdAt">) => void;
  dismissToast: (id: string) => void;
  remoteStatus: "off" | "pending" | "syncing" | "synced" | "error";
}

const StoreContext = createContext<StoreValue | null>(null);

function stateFor(snapshot: DaySnapshot, id: BlockId): BlockState {
  return snapshot.blocks[id] ?? EMPTY_STATE;
}

function freshSnapshot(at: number): DaySnapshot {
  return { date: isoDate(at), blocks: {}, water: [], notifiedBlocks: [] };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  // localStorage is readable here because the page is gated behind <ClientOnly>, so
  // there is no server render for this to disagree with.
  const [snapshot, setSnapshot] = useState<DaySnapshot>(() =>
    typeof window === "undefined" ? freshSnapshot(Date.now()) : loadSnapshot(Date.now(), dayStartMs(Date.now())),
  );
  const [history, setHistory] = useState<DayRecord[]>(() =>
    typeof window === "undefined" ? [] : loadHistory(),
  );
  const [now, setNow] = useState(() => Date.now());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedId, setSelectedId] = useState<BlockId | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<StoreValue["remoteStatus"]>("off");

  const dayStart = useMemo(() => dayStartMs(now), [now]);
  const today = useMemo(() => isoDate(now), [now]);
  const minutesOfDay = useMemo(() => wallClock(now).minutesOfDay, [now]);

  /* -- the archive.
   *
   * Read once, lazily, for the same reason the snapshot above is: the page is gated
   * behind <ClientOnly>, so there is no server render for this to disagree with, and an
   * effect that set it on mount would cost a second render pass on every load. */
  /* -- midnight rollover.
   *
   * Adjusted during render rather than in an effect. React documents this exact
   * pattern for state derived from a changed input, and an effect would spend a whole
   * frame rendering yesterday's numbers before correcting them.
   *
   * The outgoing day is *archived* before its counters are dropped. It used to be
   * simply overwritten, which is why the logs page had nothing to show: the only copy
   * of a finished day was the one being thrown away.
   *
   * Archiving writes to localStorage, which is a side effect and so does not belong in a
   * render — except that the alternative is strictly worse here. Holding the record in
   * state and flushing it from an effect means an extra render pass on the one tick
   * where the day rolls over, and leaves a window in which a refresh loses the day
   * entirely. `upsertHistory` replaces by date rather than appending, so a render React
   * decides to throw away and run again writes the identical record twice and the second
   * write is a no-op. The archive is append-only by date; this cannot corrupt it. */
  const [seenDate, setSeenDate] = useState(today);
  if (seenDate !== today) {
    setSeenDate(today);
    if (snapshot.date !== today) {
      // Anchored to the day being archived rather than to `now`. If the app was closed
      // for three days, `now - 86400000` is the wrong day entirely and the finished
      // day's blocks would be measured against a window that is not theirs.
      const filed = dayStartMsFor(snapshot.date);
      if (filed !== null && typeof window !== "undefined") {
        // +1ms: the hobby block's window ends exactly on midnight, and at exactly
        // midnight it still reads "active", so a day that was fully worked would be
        // filed as one that stopped a minute short of the end.
        setHistory(upsertHistory(archiveSnapshot(snapshot, filed, filed + 86_400_001)));
      }
      setSnapshot({ ...snapshot, date: today, blocks: {}, notifiedBlocks: [] });
    }
    setSelectedId(null);
  }

  /* -- tick */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  /* -- pull the remote day, once.
   *
   * Local wins on conflict: it is the fresher of the two in the normal case, and the
   * remote row exists for when the browser cache is cleared. */
  useEffect(() => {
    if (!isConfigured) return;
    let cancelled = false;
    const client = supabase();
    if (!client) return;

    void client
      .from(TABLES.day)
      .select("payload")
      .eq("day", today)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setRemoteStatus("error");
          return;
        }
        setRemoteStatus("synced");
        const remote = data?.payload as Partial<DaySnapshot> | undefined;
        if (!remote) return;
        setSnapshot((prev) =>
          prev.date === today
            ? {
                ...prev,
                blocks: { ...(remote.blocks ?? {}), ...prev.blocks },
                notifiedBlocks: remote.notifiedBlocks ?? prev.notifiedBlocks,
              }
            : prev,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [today]);

  /* -- persist locally */
  useEffect(() => {
    saveSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    const onHide = () => flushSnapshot();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  /* -- persist remotely, debounced so a ticking timer is not a write per second */
  const remoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isConfigured) return;
    if (remoteTimer.current) clearTimeout(remoteTimer.current);

    remoteTimer.current = setTimeout(() => {
      const client = supabase();
      if (!client) return;
      setRemoteStatus("syncing");
      void client
        .from(TABLES.day)
        .upsert({ day: snapshot.date, payload: snapshot }, { onConflict: "day" })
        .then(({ error }) => setRemoteStatus(error ? "error" : "synced"));
    }, REMOTE_DEBOUNCE_MS);

    return () => {
      if (remoteTimer.current) clearTimeout(remoteTimer.current);
    };
  }, [snapshot]);

  /* -- derived */
  const metrics = useMemo(() => computeMetrics(dayStart, now, snapshot.blocks), [dayStart, now, snapshot.blocks]);
  const stats = useMemo(() => computeStats(metrics, snapshot.water), [metrics, snapshot.water]);
  const current = useMemo(() => currentBlock(metrics), [metrics]);
  const upcoming = useMemo(() => nextBlock(metrics), [metrics]);
  const selected = useMemo(
    () => (selectedId ? (metrics.find((m) => m.block.id === selectedId) ?? null) : null),
    [metrics, selectedId],
  );

  /* -- toasts */
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<Toast, "id" | "createdAt">) => {
    const id = `${toast.kind}-${toast.blockId ?? "app"}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { ...toast, id, createdAt: Date.now() }]);
  }, []);

  useEffect(() => {
    const timers = toasts
      .filter((t) => t.ttl > 0)
      .map((t) => setTimeout(() => dismissToast(t.id), t.ttl));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  /* -- timer actions */
  const mutate = useCallback((id: BlockId, fn: (s: BlockState) => BlockState) => {
    setSnapshot((prev) => ({
      ...prev,
      blocks: { ...prev.blocks, [id]: fn(prev.blocks[id] ?? EMPTY_STATE) },
    }));
  }, []);

  const start = useCallback(
    (id: BlockId) => {
      const at = Date.now();
      const target = BLOCK_BY_ID.get(id);
      if (!target?.timed) return;
      const m = computeBlockMetrics(target, dayStartMs(at), at, stateFor(snapshot, id));
      if (m.startsInMs > LEAD_MS || m.status === "done" || m.status === "missed") return;

      mutate(id, (s) => ({
        ...s,
        running: true,
        // The first Start fixes the origin, and resumes never move it. That keeps
        // "wasted before you started" one honest number instead of resetting it on
        // every pause.
        startedAt: s.startedAt ?? at,
        resumedAt: at,
      }));
    },
    [mutate, snapshot],
  );

  const pause = useCallback(
    (id: BlockId) => {
      const at = Date.now();
      mutate(id, (s) => {
        if (!s.running || !s.resumedAt) return s;
        // Focus banks the leg it just ran. Everything after this point is waste.
        return { ...s, focusedMs: s.focusedMs + Math.max(0, at - s.resumedAt), running: false, resumedAt: null };
      });
    },
    [mutate],
  );

  const resume = useCallback(
    (id: BlockId) => {
      const at = Date.now();
      mutate(id, (s) =>
        s.running || s.completedAt !== null
          ? s
          : { ...s, running: true, resumedAt: at, startedAt: s.startedAt ?? at },
      );
    },
    [mutate],
  );

  const complete = useCallback(
    (id: BlockId) => {
      const at = Date.now();
      mutate(id, (s) => {
        const liveLeg = s.running && s.resumedAt ? Math.max(0, at - s.resumedAt) : 0;
        return {
          ...s,
          focusedMs: s.focusedMs + liveLeg,
          running: false,
          resumedAt: null,
          completedAt: at,
        };
      });
    },
    [mutate],
  );

  const reset = useCallback((id: BlockId) => {
    setSnapshot((prev) => {
      const blocks = { ...prev.blocks };
      delete blocks[id];
      return { ...prev, blocks };
    });
  }, []);

  const acknowledgeWater = useCallback((atMin: number) => {
    setSnapshot((prev) => ({
      ...prev,
      water: prev.water.map((w) => (w.atMin === atMin ? { ...w, acknowledgedAt: Date.now() } : w)),
    }));
  }, []);

  const select = useCallback((id: BlockId | null) => setSelectedId(id), []);

  const value = useMemo<StoreValue>(
    () => ({
      now,
      minutesOfDay,
      today,
      metrics,
      history,
      selected,
      stats,
      water: snapshot.water,
      current,
      upcoming,
      toasts,
      selectedId,
      select,
      start,
      pause,
      resume,
      complete,
      reset,
      acknowledgeWater,
      pushToast,
      dismissToast,
      remoteStatus: isConfigured ? remoteStatus : "off",
    }),
    [
      now,
      minutesOfDay,
      today,
      metrics,
      history,
      selected,
      stats,
      snapshot.water,
      current,
      upcoming,
      toasts,
      selectedId,
      select,
      start,
      pause,
      resume,
      complete,
      reset,
      acknowledgeWater,
      pushToast,
      dismissToast,
      remoteStatus,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}

export { EMPTY_STATE, LEAD_MS };