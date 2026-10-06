"use client";

import { useEffect, useRef } from "react";
import { chime, requestDispatch } from "@/lib/notifications";
import { isNative, nativePermission, requestNativePermission, syncNativeReminders } from "@/lib/native";
import {
  BLOCKS,
  LEAD_MS,
  WATER_END_MIN,
  WATER_INTERVAL_MIN,
  WATER_START_MIN,
} from "@/lib/schedule";
import {
  dayStartMs,
  formatDuration,
  formatHm,
  formatHmOfDay,
  formatRelative,
  formatSpan,
} from "@/lib/time";
import { useStore } from "@/lib/store";
import type { BlockId } from "@/lib/types";

/**
 * The reminder engine.
 *
 * Fires once per block per day, five minutes before the block starts, and once per water
 * slot when it comes due. Everything is keyed off a fired-set that rehydrates from
 * persisted state, so a reminder cannot double-fire from a re-render and cannot fire
 * again after a refresh either.
 *
 * Two guards matter more than they look:
 *
 *   `STALE_MS`  A reminder is only useful while it can still be acted on. Opening the
 *               app at 9pm should not replay fourteen water prompts for glasses you
 *               already drank and four study warnings for blocks that ended hours ago.
 *               Anything past the staleness window is marked as fired silently, so the
 *               record stays honest and the toast does not.
 *
 *   `pushActive` Requests to the server are only made when this browser is genuinely
 *               registered for push. Otherwise every reminder produced a failed request
 *               that filled the console with errors nobody could act on.
 *
 * Each reminder goes out on every channel available:
 *
 *   1. the panel opens — that is the "the time has come" moment
 *   2. an in-page toast, always
 *   3. Web Push via the server, so it lands with the tab closed
 *   4. a short chime
 *
 * Duplicates are deliberate. A missed reminder costs more than a redundant one.
 */
export function ReminderEngine() {
  const { metrics, water, select, pushToast, today } = useStore();
  const firedBlocks = useRef<Set<BlockId>>(new Set());
  const firedWater = useRef<Set<number>>(new Set());
  const completedSeen = useRef<Set<BlockId>>(new Set());
  const missedSeen = useRef<Set<BlockId>>(new Set());

  // A new calendar day resets every "already fired" guard. Without this, tomorrow
  // would be silent because today's set is still in memory.
  useEffect(() => {
    firedBlocks.current = new Set();
    firedWater.current = new Set();
    completedSeen.current = new Set();
    missedSeen.current = new Set();
  }, [today]);

  /* -- native: hand the whole day to the OS, once per day.
   *
   * Every effect above is a *poll* — it notices a reminder the moment a tick happens to
   * land after the trigger. That is the right shape for a tab that is open and wrong for
   * an APK: Android will happily kill the WebView while the app is backgrounded, and a
   * reminder that depends on JavaScript running is a reminder that does not arrive.
   *
   * So in the APK the reminders are scheduled ahead of time with the OS instead, and
   * these effects simply stop when there is no app running to notice.
   *
   * The dependency list is `[today]` and nothing else, which is the whole trick. An
   * earlier version of this effect depended on `metrics` — and `metrics` is rebuilt on
   * every 250ms tick, so it re-ran four times a second, each time calling `cancelAll()`
   * and re-issuing twenty alarms. That is eighty AlarmManager operations per second
   * against a system that holds a few dozen pending intents per app: the queue was
   * destroyed faster than it could be filled, and no reminder ever arrived. This is
   * also why the list below is built from `BLOCKS` rather than from `metrics` — the
   * day's schedule is fixed, so the only thing that can change it is the date.
   */
  useEffect(() => {
    if (!isNative()) return;

    const midnight = dayStartMs();

    const blockReminders = BLOCKS.filter((b) => b.timed && b.startMin !== null).map((b, i) => ({
      // Ids are ours because Capacitor keys the queue on them. 1..n for blocks keeps
      // them clear of the water range below, which starts at 1000.
      id: i + 1,
      title: `${b.title} in 5 minutes`,
      body: `${formatSpan((b.endMin - (b.startMin ?? 0)) * 60_000)} - starts at ${formatHmOfDay(b.startMin ?? 0)}`,
      at: midnight + ((b.startMin ?? 0) - LEAD_MIN) * 60_000,
    }));

    const waterReminders: typeof blockReminders = [];
    for (let minute = WATER_START_MIN; minute <= WATER_END_MIN; minute += WATER_INTERVAL_MIN) {
      waterReminders.push({
        id: 1000 + minute,
        title: "Drink water",
        body: `Every ${WATER_INTERVAL_MIN} min from ${formatHmOfDay(WATER_START_MIN)}`,
        at: midnight + minute * 60_000,
      });
    }

    void syncNativeReminders([...blockReminders, ...waterReminders]);
  }, [today]);

  /* -- native: ask once, immediately.
   *
   * Android 13+ makes notifications a runtime permission, so there is no manifest-only
   * route to a working reminder — the app has to ask, and the system dialog has to be
   * answered. Asking at launch rather than from the header lamp turns "notifications do
   * nothing and the button is easy to miss" into one dialog the first time the app opens.
   * It is only requested when the state is still `default`, so it never nags after a
   * decision has been made either way. */
  useEffect(() => {
    if (!isNative()) return;
    let live = true;
    void (async () => {
      const before = await nativePermission();
      if (!live || before !== "default") return;
      // Nothing needs re-syncing afterwards: the scheduling effect above already queued
      // today's reminders, and Android holds them whether or not they may be displayed.
      // Granting permission reveals them, it does not create them. The header lamp hears
      // about the answer from native.ts's own listener, because a notification permission
      // is not day state and has no business in the day's snapshot.
      await requestNativePermission();
    })();
    return () => {
      live = false;
    };
  }, []);

  /* -- blocks: five minutes before the start -- */
  useEffect(() => {
    for (const m of metrics) {
      if (!m.block.timed) continue;
      if (firedBlocks.current.has(m.block.id)) continue;
      if (m.status !== "due") continue;

      firedBlocks.current.add(m.block.id);

      if (-m.startsInMs > STALE_MS) continue; // long past; the record still counts

      const body = `${formatSpan(m.plannedMs)} - starts at ${formatHm(m.startMs)} - ${formatRelative(m.startsInMs)}`;
      pushToast({
        kind: "task",
        title: `${m.block.title} in five minutes`,
        body,
        blockId: m.block.id,
        ttl: 30_000,
        action: { label: "Start early", blockId: m.block.id },
      });
      // Always deliver in the page as well as to the OS. An earlier version skipped the
      // in-app half on native, reasoning that the OS notification was already on its way
      // — which left the app completely silent whenever POST_NOTIFICATIONS had not been
      // granted, with no toast, no chime and no panel. A reminder must not depend on a
      // permission it cannot guarantee; it fires here first and the notification is the
      // redundant copy, not the only copy.
      select(m.block.id);
      chime("due");
      void requestDispatch({
        title: `${m.block.title} in 5 minutes`,
        body,
        tag: `block-${m.block.id}`,
        blockId: m.block.id,
      });
    }
  }, [metrics, pushToast, select]);

  /* -- water: on the slot, no lead -- */
  useEffect(() => {
    for (const slot of water) {
      if (firedWater.current.has(slot.atMin)) continue;
      if (slot.atMs > Date.now()) continue;

      firedWater.current.add(slot.atMin);
      if (Date.now() - slot.atMs > STALE_MS) continue;

      const n = water.filter((w) => w.acknowledgedAt !== null).length + 1;
      const body = `Glass ${n} of ${water.length} - every ${WATER_INTERVAL_MIN} min from ${formatHmOfDay(WATER_START_MIN)}`;

      pushToast({ kind: "water", title: "Drink water", body, ttl: 20_000 });
      chime("water");
      void requestDispatch({ title: "Drink water", body, tag: `water-${slot.atMin}` });
    }
  }, [water, pushToast]);

/* -- completion: confirm the good news once -- */
  useEffect(() => {
    for (const m of metrics) {
      if (m.status !== "done" || completedSeen.current.has(m.block.id)) continue;
      completedSeen.current.add(m.block.id);
      pushToast({
        kind: "done",
        title: `${m.block.title} complete`,
        body: `${formatDuration(m.focusedMs)} of ${formatSpan(m.plannedMs)} focused.`,
        blockId: m.block.id,
        ttl: 12_000,
      });
    }
  }, [metrics, pushToast]);

  /* -- the other verdict: it ended short -- */
  useEffect(() => {
    for (const m of metrics) {
      if (m.status !== "missed" || missedSeen.current.has(m.block.id)) continue;
      missedSeen.current.add(m.block.id);
      // A block that ended hours ago is not news. Its slice is already red; that is the
      // verdict, and it does not need a notification to repeat itself.
      if (-m.endsInMs > STALE_MS) continue;
      const short = Math.max(0, m.plannedMs - m.focusedMs);
      pushToast({
        kind: "missed",
        title: `${m.block.title} ended short`,
        body: `${formatDuration(short)} of ${formatSpan(m.plannedMs)} unfocused. It stays red for today.`,
        blockId: m.block.id,
        ttl: 20_000,
        action: { label: "Open", blockId: m.block.id },
      });
    }
  }, [metrics, pushToast]);

  return null;
}

const LEAD_MIN = LEAD_MS / 60_000;

/**
 * How late a reminder may be and still be worth showing. Four minutes is just over one
 * tick interval, so a reminder always appears the moment its window opens and stops
 * appearing shortly after it would have been useless.
 */
const STALE_MS = 4 * 60_000;

export { LEAD_MS };