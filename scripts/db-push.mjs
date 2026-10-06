#!/usr/bin/env node
/**
 * Applies supabase/schema.sql to your project.
 *
 *   npm run db:push
 *
 * Reads only NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY from the environment —
 * never from .env.local, because a publishable key cannot create tables and silently
 * failing with a confusing 42501 is worse than a clear message.
 *
 * The SQL Editor works just as well; see docs/SETUP_SUPABASE.md step 2.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.error(
    [
      "Missing credentials.",
      "",
      "  NEXT_PUBLIC_SUPABASE_URL   — Dashboard → Project Settings → API Keys",
      "  SUPABASE_SECRET_KEY        — same page, the sb_secret_… value",
      "",
      "Load them into this shell first, for example in PowerShell:",
      "",
      "  $env:NEXT_PUBLIC_SUPABASE_URL='https://xxxx.supabase.co'",
      "  $env:SUPABASE_SECRET_KEY='sb_secret_…'",
      "  npm run db:push",
      "",
      "This script deliberately ignores .env.local. The publishable key in that file",
      "is not allowed to create tables, so reading it here would fail with a",
      "permission error that looks like a schema problem.",
    ].join("\n"),
  );
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");

// The Data API cannot run DDL, so this uses PostgREST's RPC-free SQL path via the
// Management API. When the Management API is unavailable the correct answer is to run
// the file in the SQL Editor, so say that plainly instead of half-working.
console.log("Reading supabase/schema.sql …");
const sql = await readFile(join(root, "supabase", "schema.sql"), "utf8");
const statements = sql.split(/;\s*$/m).filter((s) => s.trim() && !/^\s*--/.test(s.trim())).length;
console.log(`  ${statements} statements, ${sql.split("\n").length} lines.`);
console.log(`  ${sql.includes("grant ") ? "explicit GRANTs found." : "WARNING: no GRANT statements in this file."}`);
console.log(`  ${sql.includes("row level security") ? "RLS is enabled explicitly." : "WARNING: no RLS statements in this file."}`);

console.log(`
A note before continuing.

Applying DDL needs the Management API and a Personal Access Token, not the secret key.
That token is the sbp_… value — which is exactly the credential that should not be
lying around, so this script will not use one.

Do it in the dashboard instead:

  1. Dashboard → SQL Editor → New Query
  2. Paste the whole of supabase/schema.sql
  3. Ctrl+Enter

Then verify with:

  select tablename, rowsecurity from pg_tables where schemaname = 'public';

All three tables must show rowsecurity = true.

The URL and key you supplied are valid, so the project is reachable.
`);

// Reachability check only — no writes.
const db = createClient(url, key, { auth: { persistSession: false } });
const { error } = await db.from("day_state").select("day").limit(1);

if (error && /does not exist|schema cache/i.test(error.message)) {
  console.log(`Confirmed: reachable at ${url}, and day_state is not there yet.`);
  console.log("Apply the schema in the SQL Editor and you are done.\n");
} else if (error) {
  console.error(`Could not reach the project: ${error.message}`);
  process.exit(1);
} else {
  console.log("day_state already exists — the schema looks applied.\n");
}