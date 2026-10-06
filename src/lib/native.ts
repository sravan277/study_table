/**
 * Native bridge.
 *
 * The app is one codebase that ships three ways: the browser at localhost:3000, an
 * installable PWA, and an Android APK built by `npm run apk`. The APK is the reason this
 * file exists.
 *
 * Android's WebView has no Push API at all — no `PushManager`, no service-worker push,
 * and `/api/push/*` is not even bundled, because a static export cannot contain a route
 * handler. So the web push path is not merely useless in the APK, it is broken there:
 * left unguarded, every reminder would fire a `fetch("/api/push/key")` that resolves
 * against the `capacitor://` scheme, fail, and land in the console as a fault that is not
 * the user's. `isPushSupported()` below returns false on native for that reason, and
 * reminders are scheduled through the OS instead.
 *
 * Two constraints shape every call here:
 *
 *   1. Nothing may reach the network. This app is local-only, so `isNative` gates the
 *      web push path rather than merely preferring it.
 *   2. The plugin is imported dynamically. `@capacitor/local-notifications` has no
 *      meaning in a browser bundle, and a static import would put native bridge calls
 *      into the web build where they can only fail.
 */

import { Capacitor } from "@capacitor/core";
import type { PermissionState } from "./types";

/** True inside the APK. False in every browser, including a PWA. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

interface LocalNotificationSchema {
  id: number;
  title: string;
  body: string;
  channelId?: string;
  /**
   * Bare resource base name, NOT a file path and not a drawable reference. The plugin
   * resolves it with `getResourceID(context, name, "drawable")`, so this is
   * "ic_stat_daydial" for res/drawable/ic_stat_daydial.xml. Anything else resolves to
   * zero and the plugin quietly substitutes Android's generic info glyph.
   */
  smallIcon?: string;
  schedule: { at: Date; channelId?: string; allowWhileIdle: boolean };
  extra?: Record<string, unknown>;
}

interface LocalNotificationsPlugin {
  checkPermissions(): Promise<{ display: PermissionState }>;
  requestPermissions(): Promise<{ display: PermissionState }>;
  schedule(options: LocalNotificationSchema): Promise<void>;
  cancelAll(): Promise<void>;
  getPending(): Promise<{ notifications: { id: number }[] }>;
  createChannel(channel: { id: string; name: string; importance: number }): Promise<void>;
}

/** Our notification channel. Must be created before anything posts to it. */
const CHANNEL_ID = "day-dial";

/**
 * Status-bar icon, as the bare base name of a res/drawable resource.
 *
 * Notification icons are masked to a white silhouette, so this is a vector clock rather
 * than the launcher icon — see res/drawable/ic_stat_daydial.xml.
 */
const SMALL_ICON = "ic_stat_daydial";

/**
 * Android importance levels, from `NotificationManager`.
 *
 * `IMPORTANCE_HIGH` (4) is the "heads-up" level: the one that actually appears as a
 * banner and is worth interrupting someone for. The plugin's own default channel uses
 * `IMPORTANCE_DEFAULT` (3), which delivers silently — which would have looked like a
 * second bug on top of the real one. A five-minutes-early study prompt does not
 * warrant waking the phone up across the room, but it does warrant being visible.
 */
const IMPORTANCE_HIGH = 4;

let plugin: LocalNotificationsPlugin | null | undefined;

/**
 * The plugin, or null if it is unavailable.
 *
 * Cached including the null, because this is consulted on every reminder tick and
 * re-importing a missing module four times a second would be a small but permanent tax
 * on a WebView that is already the slowest thing on the device.
 */
async function localNotifications(): Promise<LocalNotificationsPlugin | null> {
  if (plugin !== undefined) return plugin;
  try {
    const mod = await import("@capacitor/local-notifications");
    plugin = mod.LocalNotifications as unknown as LocalNotificationsPlugin;
  } catch {
    plugin = null;
  }
  return plugin;
}

/** Current OS permission. Mirrors the web `Notification.permission` tri-state. */
export async function nativePermission(): Promise<PermissionState> {
  const api = await localNotifications();
  if (!api) return "unsupported";
  try {
    return (await api.checkPermissions()).display;
  } catch {
    return "error";
  }
}

/**
 * Ask for notification permission.
 *
 * On Android 13+ this is the runtime `POST_NOTIFICATIONS` prompt, which cannot be
 * pre-granted by the manifest, so there is no way to deliver a reminder without asking.
 * Must be called from a user gesture, which is why the header button exists rather than
 * this running on app start.
 */
export async function requestNativePermission(): Promise<PermissionState> {
  const api = await localNotifications();
  if (!api) return "unsupported";
  try {
    const result = (await api.requestPermissions()).display;
    notifyPermissionListeners(result);
    return result;
  } catch {
    return "error";
  }
}

/**
 * Permission observers.
 *
 * The header lamp reads permission once on mount, but the prompt this file raises is
 * answered at launch — *after* the lamp has already rendered. Without a way to announce
 * the answer, the lamp sat there claiming notifications were off for the whole session
 * while the OS was quietly delivering them, which is worse than showing nothing at all:
 * it teaches you to distrust the indicator.
 */
const permissionListeners = new Set<(state: PermissionState) => void>();

export function onNativePermissionChange(listener: (state: PermissionState) => void): () => void {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

function notifyPermissionListeners(state: PermissionState): void {
  for (const listener of permissionListeners) listener(state);
}

/**
 * Rebuild the day's reminders in the OS notification queue.
 *
 * Called on launch and again at rollover. The web app schedules a reminder by noticing
 * that its time has arrived while a tab happens to be open; inside an APK there may be no
 * tab, no `setInterval`, and no JS running at all, so the only way a reminder can arrive
 * is if the OS was told about it in advance. That is what `at` does — it hands the
 * trigger to AlarmManager rather than waiting for it.
 *
 * Everything is cancelled first. Capacitor's `schedule` is additive and ids are assigned
 * by the caller, so re-scheduling on every launch without a clear would stack duplicates
 * of the same reminder and the queue would grow by a day's worth on every app open.
 */
export async function syncNativeReminders(
  reminders: readonly { id: number; title: string; body: string; at: number }[],
): Promise<boolean> {
  const api = await localNotifications();
  if (!api) return false;
  try {
    // The channel has to exist BEFORE the first post, not after. This was the bug that
    // made every reminder invisible: the app asked for channel "day-dial", which nothing
    // ever created, and Android 8+ drops a notification aimed at an unknown channel
    // without raising an error or logging a fault the app can see. The reminder was
    // queued correctly and then discarded on arrival, which is why the in-app half kept
    // working and the notification half never did.
    //
    // Idempotent, so it is safe on every launch. Channel settings are immutable once
    // created — if "day-dial" already exists at the wrong importance, re-creating it is a
    // no-op rather than an update, which is a platform rule and is noted in NOTES.md.
    await api.createChannel({
      id: CHANNEL_ID,
      name: "Study reminders",
      importance: IMPORTANCE_HIGH,
    });

    await api.cancelAll();
    // Anything already due has fired or been handled in-app; scheduling it in the past
    // would make Android deliver the whole backlog the instant the app opens.
    const upcoming = reminders.filter((r) => r.at > Date.now());
    for (const reminder of upcoming) {
      await api.schedule({
        id: reminder.id,
        title: reminder.title,
        body: reminder.body,
        // Top-level, NOT inside `schedule`. The plugin reads the channel from the
        // notification body (`LocalNotification.channelId`) and falls back to its own
        // "default" channel when it is absent; nesting it under `schedule` is silently
        // ignored, so the reminder posted to a channel nobody had configured.
        channelId: CHANNEL_ID,
        smallIcon: SMALL_ICON,
        schedule: { at: new Date(reminder.at), allowWhileIdle: true },
        extra: { blockId: reminder.id },
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** True once the OS queue holds today's reminders. Drives the header lamp. */
export async function hasPendingNativeReminders(): Promise<boolean> {
  const api = await localNotifications();
  if (!api) return false;
  try {
    return (await api.getPending()).notifications.length > 0;
  } catch {
    return false;
  }
}

/**
 * Fire a single notification a few seconds from now, for verifying delivery by hand.
 *
 * This exists because the bug that made every reminder invisible was invisible from the
 * app's own point of view. The queue looked full, `getPending()` reported success, and
 * Android discarded each notification on arrival without telling anyone — so the only
 * honest way to confirm the shade works is to put a notification in it and look.
 *
 * Returns a line of plain text describing what happened. It deliberately surfaces the
 * plugin's own error message instead of returning a boolean, because "false" cannot
 * distinguish "no permission" from "bad channel id" from "alarm permission revoked", and
 * those three need three different fixes.
 */
export async function sendNativeTestNotification(): Promise<string> {
  const api = await localNotifications();
  if (!api) return "Plugin unavailable — the native module did not load.";

  const permission = await nativePermission();
  if (permission === "denied") {
    return "Permission denied. Android will not show anything; grant it in Settings → Apps → Day Dial → Notifications.";
  }

  try {
    await api.createChannel({ id: CHANNEL_ID, name: "Study reminders", importance: IMPORTANCE_HIGH });
    await api.schedule({
      id: 99_000,
      title: "Day Dial",
      body: "Notifications are working.",
      channelId: CHANNEL_ID,
      smallIcon: SMALL_ICON,
      // In the past by design: the plugin posts a past-dated notification immediately
      // rather than arming an alarm, which is the fastest way to see the shade light up.
      schedule: { at: new Date(Date.now() - 1000), allowWhileIdle: true },
    });
    return `Sent. Check the shade in a moment. Queued reminders: ${(await api.getPending()).notifications.length}.`;
  } catch (error) {
    return `Failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}