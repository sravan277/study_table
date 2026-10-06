import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase access, optional by design.
 *
 * The app is fully functional with no backend at all. When keys are absent,
 * `supabase()` returns null and everything falls back to localStorage plus in-page
 * notifications. Nothing in the UI changes shape.
 *
 * Only the PUBLISHABLE key ever reaches this file. The secret key is read exclusively
 * in the route handlers under src/app/api — never here.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

export const isConfigured = Boolean(url && key);

/**
 * One shared client for the browser. A second client on a hot reload duplicates every
 * request, so the instance is cached on globalThis — the pattern supabase-js itself
 * documents for the browser.
 */
export function supabase(): SupabaseClient | null {
  if (!isConfigured) return null;

  const store = globalThis as typeof globalThis & { __dayDialSupabase?: SupabaseClient };
  store.__dayDialSupabase ??= createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return store.__dayDialSupabase;
}

/** Human-readable backend state for the header badge. */
export function backendLabel(): string {
  return isConfigured ? "Supabase" : "This device";
}

export const TABLES = {
  day: "day_state",
  push: "push_subscriptions",
  dispatch: "dispatch_log",
} as const;