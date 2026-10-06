import { NextResponse } from "next/server";

/**
 * The VAPID public key, for the browser.
 *
 * Served from a route rather than inlined so the key stays a server-side env var and
 * never enters the client bundle. It is public by definition — the browser has to
 * receive it — but keeping it in one place means rotating the pair is a single change.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.VAPID_PUBLIC_KEY ?? null;
  return NextResponse.json(
    { publicKey: key },
    { headers: { "Cache-Control": "no-store" } },
  );
}