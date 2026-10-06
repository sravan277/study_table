"use client";

import { useEffect, useState } from "react";
import { isNative, onNativePermissionChange, sendNativeTestNotification } from "@/lib/native";
import {
  currentPermission,
  disablePush,
  enablePush,
  registerWorker,
  requestPermission,
  type PermissionState,
} from "@/lib/notifications";
import { backendLabel } from "@/lib/supabase";
import type { WaterSlot } from "@/lib/types";
import { formatHm } from "@/lib/time";

/**
 * The water meter.
 *
 * Fourteen hourly slots from 08:30 to 22:00. The glass fills as slots are
 * acknowledged, and the next reminder is stated in words rather than left for you to
 * work out from a timestamp.
 */
export function WaterMeter({
  slots,
  now,
  onAcknowledge,
}: {
  slots: WaterSlot[];
  now: number;
  onAcknowledge: (atMin: number) => void;
}) {
  const done = slots.filter((s) => s.acknowledgedAt !== null).length;
  const next = slots.find((s) => s.atMs > now) ?? null;
  const due = slots.find((s) => s.atMs <= now && s.acknowledgedAt === null) ?? null;
  const fill = slots.length > 0 ? (done / slots.length) * 100 : 0;

  return (
    <div className="water">
      <div className="water__glass" aria-hidden="true">
        <div className="water__fill" style={{ height: `${fill}%` }} />
      </div>
      <div>
        <div className="water__count mono">
          {done}/{slots.length}
        </div>
        <div className="water__next">
          {due
            ? `due now · ${formatHm(due.atMs)}`
            : next
              ? `next ${formatHm(next.atMs)}`
              : "done for today"}
        </div>
      </div>
      {due ? (
        <button
          type="button"
          className="btn btn--ghost"
          style={{ color: "var(--water)", borderColor: "color-mix(in srgb, var(--water) 45%, transparent)" }}
          onClick={() => onAcknowledge(due.atMin)}
        >
          Drank it
        </button>
      ) : null}
    </div>
  );
}

/**
 * Notification permissions.
 *
 * The button exists because `requestPermission()` needs a user gesture in some
 * browsers, so permission cannot be requested on page load. The label always states
 * what is currently true and what pressing it will do.
 */
export function NotifyLamp() {
  const [permission, setPermission] = useState<PermissionState>("default");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      await registerWorker();
      const p = await currentPermission();
      if (live) setPermission(p);
    })();
    return () => {
      live = false;
    };
  }, []);

  // The app asks for notification permission at launch, which can happen after this lamp
  // has rendered. Without subscribing to the answer it would sit on "Turn on
  // notifications" for the whole session while the OS delivered them.
  useEffect(() => onNativePermissionChange(setPermission), []);

  const onPress = async () => {
    setBusy(true);
    setDetail("");
    try {
      // Android has no API for an app to revoke its own notification permission — the
      // grant is deliberately one-way, and only system settings can take it back. So on
      // native this button cannot be an on/off switch, and pretending otherwise by
      // calling `disablePush` (a Web Push unsubscribe) would report a successful revoke
      // that never happened. It reports the truth instead: it is on, and here is where
      // to change it.
      if (isNative()) {
        const p = await requestPermission();
        setPermission(p);
        if (p === "denied") {
          setDetail("Blocked by Android. Settings › Apps › Day Dial › Notifications. In-page reminders still work.");
          return;
        }
        if (p !== "granted") {
          setDetail("Not granted. In-page reminders still work.");
          return;
        }
        // Already granted, so pressing the lamp is the one moment the user is actually
        // asking "is this working?". Fire a real notification and report what happened.
        // Android discards a notification aimed at a bad channel without any error
        // reaching the app, which is precisely why this check had to become explicit
        // rather than something to infer from the lamp's colour.
        setDetail(await sendNativeTestNotification());
        return;
      }

      if (permission === "granted") {
        await disablePush();
        setPermission((await currentPermission()) as PermissionState);
        setDetail("Push off. In-page reminders still work.");
        return;
      }
      const p = await requestPermission();
      setPermission(p);
      if (p !== "granted") {
        setDetail(p === "denied" ? "Blocked. Re-enable it in your browser's site settings." : "Permission not granted.");
        return;
      }
      const result = await enablePush();
      setDetail(
        result.ok
          ? "Push on. Reminders arrive even with this tab closed."
          : `In-page only. ${result.error ?? ""}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const on = permission === "granted";
  const blocked = permission === "denied";
  const label = busy ? "…" : on ? "Notifications on" : blocked ? "Notifications blocked" : "Turn on notifications";
  const title =
    permission === "unsupported"
      ? "This build cannot show notifications."
      : detail || (isNative() && !on ? "Android notifications." : undefined);

  return (
    <button
      type="button"
      className="lamp lamp--action"
      onClick={() => void onPress()}
      disabled={busy || permission === "unsupported"}
      title={title || undefined}
    >
      <span className={`lamp__dot ${on ? "lamp__dot--on" : blocked ? "lamp__dot--warn" : "lamp__dot--off"}`} />
      {label}
    </button>
  );
}

/** Where the day's numbers are being kept. */
export function BackendLamp({ status }: { status: string }) {
  const map: Record<string, string> = {
    off: "This device",
    pending: "Syncing…",
    syncing: "Syncing…",
    synced: "Supabase",
    error: "Sync failed",
  };
  return (
    <span className="lamp" title={status === "error" ? "Local storage is still working; the remote copy failed." : undefined}>
      <span className={`lamp__dot ${status === "error" ? "lamp__dot--warn" : status === "off" ? "lamp__dot--off" : "lamp__dot--on"}`} />
      {map[status] ?? backendLabel()}
    </span>
  );
}