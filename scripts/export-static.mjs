#!/usr/bin/env node
// Produces the static site that Capacitor ships inside the APK.
//
// Pipeline: temporarily hide the server-only /api/push routes -> swap in
// next.config.mobile.mjs -> `next build` (output: export) -> copy ./out into
// ./mobile/www -> restore everything.
//
// Everything it moves is restored in a `finally` block AND re-verified
// afterwards, so a build failure can never leave the working tree mutilated.
// It also self-heals: if a previous run was killed hard (power loss, kill -9)
// and left the stash behind, the next run puts it back before doing anything.

import { existsSync, renameSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Source tree pieces that must be hidden for the duration of the export.
const API_DIR = path.join(ROOT, "src", "app", "api");
// Stash lives OUTSIDE src/ so the Next.js file crawler cannot see it.
const STASH_DIR = path.join(ROOT, ".mobile-stash", "src-app-api");

// Config swap. The checked-in next.config.ts is never edited, only renamed.
const MAIN_CONFIG = path.join(ROOT, "next.config.ts");
const MOBILE_CONFIG = path.join(ROOT, "next.config.mobile.mjs");
const ACTIVE_MOBILE_CONFIG = path.join(ROOT, "next.config.mjs");
const MOBILE_CONFIG_STASH = path.join(ROOT, ".mobile-stash", "next.config.ts");

// Build dirs.
// OUT_DIR is Next.js's default static-export directory. It stays `out` because
// leaving `distDir` unset is deliberate — see next.config.mobile.mjs.
// The internal build cache always lands in `.next` regardless (Next 16 forces
// it), so a mobile build does invalidate the dev/server cache. That is fine,
// it is a regenerable cache, just don't be surprised by it.
const OUT_DIR = path.join(ROOT, "out");
const WEB_DIR = path.join(ROOT, "mobile", "www");

const log = (m) => console.log(`[export-static] ${m}`);

/** Restore a file/dir that we moved, and prove it landed. */
function restore(from, to, label) {
  if (!existsSync(from)) {
    if (existsSync(to)) {
      log(`restore ok (nothing to move): ${label}`);
      return;
    }
    throw new Error(`Cannot restore ${label}: neither ${from} nor ${to} exists`);
  }
  if (existsSync(to)) {
    // Destination unexpectedly present — the safer of two evils is to fail
    // loudly rather than silently overwrite real source.
    throw new Error(`Cannot restore ${label}: ${to} already exists, refusing to overwrite`);
  }
  renameSync(from, to);
  if (!existsSync(to)) {
    throw new Error(`FAILED to restore ${label}: ${to} missing after rename`);
  }
  log(`restored ${label}`);
}

/** Hard self-heal for an interrupted previous run, before we touch anything. */
function recoverStaleStash() {
  if (existsSync(STASH_DIR) && !existsSync(API_DIR)) {
    log("found a stale stash from an interrupted run — recovering src/app/api");
    renameSync(STASH_DIR, API_DIR);
  }
  if (existsSync(MOBILE_CONFIG_STASH) && !existsSync(MAIN_CONFIG)) {
    log("found a stale config stash — recovering next.config.ts");
    renameSync(MOBILE_CONFIG_STASH, MAIN_CONFIG);
  }
  // A leftover next.config.mjs would shadow next.config.ts on every later
  // build, so drop it if we are not the ones running right now.
  if (existsSync(ACTIVE_MOBILE_CONFIG)) {
    log("removing stale next.config.mjs left by an interrupted run");
    rmSync(ACTIVE_MOBILE_CONFIG, { force: true });
  }
}

// Node >= 18.20 / 20.12 / 22 refuse to spawn a `.cmd`/`.bat` shim without
// `shell: true` (the CVE-2024-27980 hardening), and `shell: true` reintroduces
// argument-quoting hazards (DEP0190). So invoke the Next CLI's JS entrypoint
// directly through the current node binary — no shim, no shell, no quoting.
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

function runBuild() {
  if (!existsSync(NEXT_BIN)) {
    throw new Error(`next CLI not found at ${NEXT_BIN} — run \`npm install\` first`);
  }
  const res = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`next build exited with code ${res.status}`);
  }
}

function main() {
  recoverStaleStash();

  if (!existsSync(MOBILE_CONFIG)) {
    throw new Error(`missing ${path.relative(ROOT, MOBILE_CONFIG)}`);
  }
  const apiPresent = existsSync(API_DIR);

  let buildCode = 0;
  try {
    // Clean output dir so a stale route cache cannot resurrect removed routes
    // and so repeat runs are deterministic.
    rmSync(OUT_DIR, { recursive: true, force: true });

    if (apiPresent) {
      mkdirSync(path.dirname(STASH_DIR), { recursive: true });
      if (existsSync(STASH_DIR)) rmSync(STASH_DIR, { recursive: true, force: true });
      renameSync(API_DIR, STASH_DIR);
      log("moved src/app/api aside (server-only Web Push routes; useless in a WebView)");
    }

    renameSync(MAIN_CONFIG, MOBILE_CONFIG_STASH);
    cpSync(MOBILE_CONFIG, ACTIVE_MOBILE_CONFIG);
    log("swapped in next.config.mobile.mjs as next.config.mjs");

    runBuild();

    const indexHtml = path.join(OUT_DIR, "index.html");
    if (!existsSync(indexHtml)) {
      throw new Error(`build reported success but ${path.relative(ROOT, indexHtml)} was not produced`);
    }

    // Publish to Capacitor's webDir.
    mkdirSync(WEB_DIR, { recursive: true });
    rmSync(WEB_DIR, { recursive: true, force: true });
    cpSync(OUT_DIR, WEB_DIR, { recursive: true });
    log(`copied out/ -> ${path.relative(ROOT, WEB_DIR)}`);
  } catch (err) {
    buildCode = 1;
    console.error(`[export-static] FAILED: ${err.message}`);
  } finally {
    // Order matters: config first so the tree is never left in a state where a
    // stray next.config.mjs shadows the real one, then the routes.
    try {
      if (existsSync(ACTIVE_MOBILE_CONFIG)) rmSync(ACTIVE_MOBILE_CONFIG, { force: true });
      restore(MOBILE_CONFIG_STASH, MAIN_CONFIG, "next.config.ts");
    } catch (e) {
      console.error(`[export-static] RESTORE ERROR (config): ${e.message}`);
      buildCode = 1;
    }
    try {
      if (apiPresent) restore(STASH_DIR, API_DIR, "src/app/api");
    } catch (e) {
      console.error(`[export-static] RESTORE ERROR (api): ${e.message}`);
      buildCode = 1;
    }
    if (existsSync(path.join(ROOT, ".mobile-stash"))) {
      rmSync(path.join(ROOT, ".mobile-stash"), { recursive: true, force: true });
    }
  }

  // Post-restore verification: the working tree must be back to normal.
  const problems = [];
  if (!existsSync(MAIN_CONFIG)) problems.push("next.config.ts is missing");
  if (apiPresent && !existsSync(API_DIR)) problems.push("src/app/api is missing");
  if (existsSync(ACTIVE_MOBILE_CONFIG)) problems.push("next.config.mjs was left behind");
  if (existsSync(STASH_DIR)) problems.push(".mobile-stash/src-app-api was left behind");
  if (problems.length) {
    console.error(`[export-static] POST-RESTORE VERIFICATION FAILED:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  log("post-restore verification passed (working tree intact)");

  if (buildCode !== 0) process.exit(buildCode);
  log("static export complete");
}

main();
