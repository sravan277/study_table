/**
 * Notifications.
 *
 * Three layers, deliberately redundant. A missed 5-minute reminder costs more than a
 * duplicate one, so each reminder is offered through every channel that happens to be
 * available:
 *
 *   1. Web Push      — arrives with the tab closed, subject to the browser having a
 *                      running process (see NOTES.md §4)
 *   2. OS Notification — via the service worker, same delivery, user-visible form
 *   3. In-page toast  — always available, always works, only needs an open tab
 *
 * The VAPID public key is fetched from our own route rather than inlined, because it
 * lives in a server-side env var and must not be baked into the client bundle.
 */

import { isNative, nativePermission, requestNativePermission } from "./native";
import type { PermissionState } from "./types";

export type { PermissionState };

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  blockId?: string;
  url?: string;
}

/**
 * VAPID public key to Uint8Array, per the Push API spec.
 *
 * The explicit `Uint8Array<ArrayBuffer>` annotation is load-bearing. TypeScript 5.7
 * made TypedArrays generic over their backing buffer, and `PushManager.subscribe`
 * wants a `BufferSource`, which excludes `SharedArrayBuffer`. An unannotated
 * `Uint8Array` is `Uint8Array<ArrayBufferLike>` and is therefore not assignable, so
 * the type has to say which buffer it is backed by.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export function isPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  // Not a preference — a hard requirement. Android's WebView has no PushManager, and a
  // static export ships no /api/push/* for the fetch below to reach. The APK is local
  // only, so the OS scheduler in native.ts is the whole notification story there and this
  // path must go quiet rather than fail loudly on every reminder.
  if (isNative()) return false;
  return "serviceWorker" in navigator && "PushManager" in window;
}

let cachedKey: string | null = null;

export async function vapidPublicKey(): Promise<string | null> {
  if (cachedKey) return cachedKey;
  try {
    const res = await fetch("/api/push/key", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { publicKey?: string | null };
    cachedKey = body.publicKey ?? null;
    return cachedKey;
  } catch {
    return null;
  }
}

let registration: ServiceWorkerRegistration | null = null;

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  // Not registered in the APK. The assets are served from the `capacitor://` scheme,
  // where a service worker cannot be installed and `/sw.js` does not exist, so the call
  // rejects and leaves a console error behind on every launch.
  if (isNative()) return null;
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  if (registration) return registration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return registration;
  } catch {
    return null;
  }
}

export async function currentPermission(): Promise<PermissionState> {
  // Delegated rather than branched at each call site, so "what is the notification
  // permission" has exactly one answer. On Android the browser API does not exist at all,
  // and `Notification.permission` in a WebView either throws or reports a browser-level
  // state that has nothing to do with the OS one.
  if (isNative()) return nativePermission();
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as PermissionState;
}

/**
 * Ask for permission. Must be called from a user gesture in some browsers, which is
 * why the header button exists rather than this running on load.
 */
export async function requestPermission(): Promise<PermissionState> {
  if (isNative()) return requestNativePermission();
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    return (await Notification.requestPermission()) as PermissionState;
  } catch {
    return "error";
  }
}

/**
 * Register this browser for push and hand the subscription to the server.
 *
 * Chrome does not implement `pushsubscriptionchange`, so an expired subscription cannot
 * be renewed from the page. Dead ones are pruned server-side on the next send by
 * status code; that is the real safety net, not this function.
 */
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!isPushSupported()) return { ok: false, error: "This browser cannot receive push." };

  const reg = await registerWorker();
  if (!reg) return { ok: false, error: "The service worker did not register." };

  const key = await vapidPublicKey();
  if (!key) return { ok: false, error: "No VAPID key on the server. Run: npm run vapid" };

  try {
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
    if (!res.ok) return { ok: false, error: `Server rejected the subscription (${res.status}).` };
    pushActive = true;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not subscribe to push." };
  }
}

export async function disablePush(): Promise<void> {
  const reg = await registerWorker();
  const sub = await reg?.pushManager.getSubscription();
  pushActive = false;
  if (!sub) return;
  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
}

/**
 * Whether this browser is actually registered for push.
 *
 * The reminder engine consults this before every dispatch. Without the gate the app
 * called `/api/push/send` on every reminder whether or not anyone could receive it,
 * and the server's "you have no VAPID keys" response filled the console with errors
 * that looked like app faults and were not.
 */
let pushActive = false;

export function isPushActive(): boolean {
  return pushActive;
}

/**
 * Ask the server to send a push now, for the reminder that is due.
 *
 * Best-effort by construction. A failure never surfaces as an error toast, because the
 * in-page toast for the same reminder has already fired and complaining twice is noise.
 */
export async function requestDispatch(payload: PushPayload): Promise<boolean> {
  if (!pushActive) return false;
  try {
    const res = await fetch("/api/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether the user has interacted with the page yet.
 *
 * An AudioContext created before the first gesture starts suspended, and the browser
 * logs a warning when you try to schedule sound on it. Reminders can legitimately fire
 * before any interaction — opening the tab during a study block does exactly that — so
 * rather than creating a context that cannot make noise, this waits for a gesture.
 */
let hasInteracted = false;

if (typeof window !== "undefined") {
  const mark = () => {
    hasInteracted = true;
  };
  // capture + once, so this costs nothing after the first interaction.
  window.addEventListener("pointerdown", mark, { capture: true, once: true });
  window.addEventListener("keydown", mark, { capture: true, once: true });
}

/** Short audible cue. Uses WebAudio so there is no asset to ship. */
export function chime(kind: "due" | "water" = "due"): void {
  if (typeof window === "undefined" || !hasInteracted) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    // A context left suspended by the autoplay policy is silent, so resume it and stop
    // if the browser refuses rather than scheduling notes nobody will hear.
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);

    const notes = kind === "due" ? [660, 880] : [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const startAt = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.18);
    });
    setTimeout(() => void ctx.close(), 900);
  } catch {
    // Autoplay policy or no audio device. Silent is the correct failure here.
  }
}