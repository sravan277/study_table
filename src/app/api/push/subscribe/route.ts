import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Stores and removes push subscriptions.
 *
 * Write path uses the publishable key, so RLS applies. That is fine: there is one user,
 * so the policies are `using (true)` by design and the boundary is the obscurity of the
 * project URL and key.
 */
export const dynamic = "force-dynamic";

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

interface IncomingSubscription {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

export async function POST(request: Request) {
  const db = client();
  if (!db) {
    return NextResponse.json({ ok: true, note: "No Supabase configured; subscription not stored." });
  }

  let sub: IncomingSubscription;
  try {
    sub = (await request.json()) as IncomingSubscription;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const endpoint = sub.endpoint;
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ ok: false, error: "endpoint, keys.p256dh and keys.auth are all required" }, { status: 400 });
  }

  const { error } = await db.from("push_subscriptions").upsert(
    {
      endpoint,
      p256dh,
      auth,
      user_agent: request.headers.get("user-agent"),
      last_used_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const db = client();
  if (!db) return NextResponse.json({ ok: true });

  let endpoint: string | undefined;
  try {
    endpoint = ((await request.json()) as { endpoint?: string }).endpoint;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!endpoint) {
    return NextResponse.json({ ok: false, error: "endpoint is required" }, { status: 400 });
  }

  const { error } = await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
  return NextResponse.json({ ok: true });
}