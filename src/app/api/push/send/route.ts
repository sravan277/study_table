import webpush from "web-push";
import { NextResponse } from "next/server";

/**
 * Sends a Web Push to every registered subscription.
 *
 * The secret key is read here and nowhere else. `web-push` does not read environment
 * variables itself — that is community convention — so the wiring is ours to do, and
 * this file is the only place it happens.
 *
 * The private key must be RAW BASE64URL, not PEM. `web-push` validates it against
 * /^[A-Za-z0-9\-_]+$/ and decodes it as base64url, so a PEM block throws here rather
 * than silently sending nothing.
 */
export const dynamic = "force-dynamic";

export const runtime = "nodejs";

/** Short — this is called by a cron, not by a human waiting. */
export const maxDuration = 25;

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

let configured = false;

function wire() {
  if (configured) return webpush;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:day-dial@example.com";
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  if (publicKey && privateKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = true;
  }
  return webpush;
}

export async function POST(request: Request) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  // Not configured is a state, not a failure. Returning 503 here made every reminder
  // write an error into the browser console even though the app was behaving correctly
  // — the in-page toast is the working channel until `npm run vapid` has been run.
  if (!publicKey || !privateKey) {
    return NextResponse.json(
      { ok: true, skipped: true, delivered: 0, note: "No VAPID keys configured; run npm run vapid." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  let payload: { title?: string; body?: string; tag?: string; blockId?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const message = JSON.stringify({
    title: payload.title ?? "Day Dial",
    body: payload.body ?? "",
    tag: payload.tag,
    blockId: payload.blockId,
    url: "/",
  });

  // No backend configured: the service worker cannot be reached, but the in-page toast
  // has already fired, so this is a soft no-op rather than an error worth showing.
  if (!url || !serviceKey) {
    return NextResponse.json({ ok: true, delivered: 0, note: "No Supabase secret configured; nothing sent." });
  }

  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .limit(100);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
  }

  const subscriptions = (data ?? []) as PushSubscriptionRow[];
  const dead: string[] = [];
  let delivered = 0;

  for (const sub of subscriptions) {
    try {
      await wire().sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        message,
      );
      delivered += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      // 404 and 410 are the push service telling us this subscription is gone for good.
      // Chrome does not implement pushsubscriptionchange, so pruning here is the only
      // way dead subscriptions ever leave the table.
      if (statusCode === 404 || statusCode === 410) dead.push(sub.endpoint);
    }
  }

  if (dead.length > 0) {
    await admin.from("push_subscriptions").delete().in("endpoint", dead);
  }

  return NextResponse.json({ ok: true, delivered, pruned: dead.length });
}

/** Lets the cron in supabase/cron.sql hit the same logic without duplicating it. */
export async function GET(request: Request) {
  const secret = process.env.PUSH_DISPATCH_SECRET;
  const provided = request.headers.get("x-dispatch-secret") ?? new URL(request.url).searchParams.get("secret");
  if (secret && provided !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(request);
}