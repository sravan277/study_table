#!/usr/bin/env node
// End-to-end Android APK build. Safe to re-run; incremental after the first run.
//
//   node scripts/build-apk.mjs             # assembleDebug
//   node scripts/build-apk.mjs --release   # assembleRelease (unsigned — no signingConfig)
//
// Stages:
//   1. Resolve a JDK 21 (AGP rejects the Java 25 that is otherwise the only JDK here)
//   2. Resolve the Android SDK, verify platforms/android-<compileSdk>, write local.properties
//   3. Static export of the Next.js app -> mobile/www   (scripts/export-static.mjs)
//   4. capacitor sync android                          (copies mobile/www into the APK)
//   5. gradlew assembleDebug | assembleRelease
//   6. Verify the APK exists, print its path and size
//
// Nothing here touches global state: no setx, no PATH edits. JAVA_HOME and
// ANDROID_HOME are set on the child process env only, so a plain `npm run build`
// or `npm run dev` on this machine is unaffected.

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  createWriteStream,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID_DIR = path.join(ROOT, "android");
const LOG_DIR = path.join(ANDROID_DIR, "build-logs");

const isWin = process.platform === "win32";
const RELEASE = process.argv.includes("--release");
const GRADLE_TASK = RELEASE ? "assembleRelease" : "assembleDebug";
const VARIANT = RELEASE ? "release" : "debug";

const log = (m) => console.log(`[apk] ${m}`);
const fail = (m) => {
  console.error(`[apk] ERROR: ${m}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ *
 * 1. JDK 21
 * ------------------------------------------------------------------ */

// Most specific first. CAP_JDK_HOME wins if set, so this survives the Adoptium
// build getting a version bump (21.0.12 -> 21.0.13), which would otherwise
// silently invalidate a hard-coded path.
function jdkCandidates() {
  const list = [];
  if (process.env.CAP_JDK_HOME) list.push(process.env.CAP_JDK_HOME);
  const adoptium = "C:\\Program Files\\Eclipse Adoptium";
  if (isWin && existsSync(adoptium)) {
    for (const d of readdirSync(adoptium)) {
      if (/^jdk-21/i.test(d)) list.push(path.join(adoptium, d));
    }
  }
  list.push("C:/Tools/jdk21", "C:/Program Files/Java/jdk-21");
  return list;
}

/** Java version string for a JDK home, or null if that home is unusable. */
function probeJdk(home) {
  const exe = path.join(home, "bin", isWin ? "java.exe" : "java");
  if (!existsSync(exe)) return null;
  const r = spawnSync(exe, ["-version"], { encoding: "utf8" });
  if (r.error) return null;
  const m = `${r.stdout || ""}${r.stderr || ""}`.match(/version "([^"]+)"/);
  return m ? m[1] : null;
}

function resolveJdk() {
  for (const home of jdkCandidates()) {
    const v = probeJdk(home);
    if (!v) continue;
    if (!v.startsWith("21.")) {
      log(`skipping ${home} (Java ${v}, need 21)`);
      continue;
    }
    return { home, version: v };
  }
  fail(
    "no JDK 21 found. Install one with:\n" +
      "  winget install --id EclipseAdoptium.Temurin.21.JDK -e --accept-source-agreements --accept-package-agreements\n" +
      "or point CAP_JDK_HOME at an existing JDK 21."
  );
}

/* ------------------------------------------------------------------ *
 * 2. Android SDK
 * ------------------------------------------------------------------ */

function resolveSdk() {
  const candidates = [
    process.env.CAP_ANDROID_SDK,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    isWin && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
      : null,
    isWin && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local", "Android", "Sdk")
      : null,
    "/usr/lib/android-sdk",
  ].filter(Boolean);

  for (const sdk of candidates) {
    if (existsSync(path.join(sdk, "platforms")) && existsSync(path.join(sdk, "build-tools"))) {
      return sdk;
    }
  }
  fail(
    "no Android SDK found. Looked in:\n" +
      candidates.map((c) => `  - ${c}`).join("\n") +
      "\nSet ANDROID_HOME or CAP_ANDROID_SDK."
  );
}

/** The compileSdk the Capacitor template actually asks for. */
function requiredCompileSdk() {
  const varsFile = path.join(ANDROID_DIR, "variables.gradle");
  if (!existsSync(varsFile)) {
    fail("android/variables.gradle is missing — run `npx cap add android` first");
  }
  const m = readFileSync(varsFile, "utf8").match(/compileSdkVersion\s*=\s*(\d+)/);
  if (!m) fail("could not parse compileSdkVersion out of android/variables.gradle");
  return Number(m[1]);
}

/* ------------------------------------------------------------------ *
 * process helper: live output + on-disk log + non-zero exit propagation
 * ------------------------------------------------------------------ */

let logStream = null;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const label = `${path.basename(cmd)} ${args.join(" ")}`;
    log(`$ ${label}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      env: opts.env || process.env,
      shell: false,
    });

    // Keep a small in-memory tail so a failure can show us the real error
    // without depending on the log file having been flushed.
    const tail = [];
    const TAIL_LINES = 40;
    const capture = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line === "") continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
      if (logStream) logStream.write(buf);
    };

    child.stdout.on("data", (d) => {
      capture(d);
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      capture(d);
      process.stderr.write(d);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(0);
      console.error(`\n[apk] ${label} exited with code ${code}`);
      console.error(`[apk] --- last ${tail.length} lines ---`);
      console.error(tail.join("\n"));
      console.error(`[apk] --- end ---\n`);
      reject(new Error(`${label} failed with code ${code}`));
    });
  });
}

/* ------------------------------------------------------------------ *
 * Gradle
 * ------------------------------------------------------------------ */

// `gradlew.bat` is a batch file, and Node >= 18.20 / 20.12 / 22 refuse to spawn
// `.cmd`/`.bat` without `shell: true` (CVE-2024-27980 hardening); `shell: true`
// then reopens the DEP0190 quoting hole, which is painful because
// `-Dorg.gradle.java.home=C:\Program Files\...` contains spaces and backslashes.
//
// So run the wrapper's main class the same way gradlew.bat does internally:
//     "<JAVA_EXE>" -Dorg.gradle.appname=gradlew -jar gradle-wrapper.jar <args>
// No shell, no quoting ambiguity, and the JDK is pinned twice over — once by
// which java binary we exec, and once via -Dorg.gradle.java.home so every forked
// compile/AGP process agrees.
function runGradle(task, jdk, env) {
  const wrapperJar = path.join(ANDROID_DIR, "gradle", "wrapper", "gradle-wrapper.jar");
  if (!existsSync(wrapperJar)) {
    fail(`gradle-wrapper.jar is missing at ${wrapperJar} — the android/ project looks incomplete`);
  }
  const javaExe = path.join(jdk.home, "bin", isWin ? "java.exe" : "java");
  const args = [
    "-Dorg.gradle.appname=gradlew",
    `-Dorg.gradle.java.home=${jdk.home}`,
    "-jar",
    wrapperJar,
    task,
  ];
  return run(javaExe, args, { cwd: ANDROID_DIR, env });
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  if (!existsSync(ANDROID_DIR)) {
    fail("android/ is missing — run `npx cap add android` first");
  }

  const jdk = resolveJdk();
  log(`JDK 21 : ${jdk.home}  (java ${jdk.version})`);

  const sdk = resolveSdk();
  log(`SDK    : ${sdk}`);

  const compileSdk = requiredCompileSdk();
  const platformDir = path.join(sdk, "platforms", `android-${compileSdk}`);
  if (!existsSync(platformDir)) {
    const sdkmanager = path.join(sdk, "cmdline-tools", "latest", "bin", isWin ? "sdkmanager.bat" : "sdkmanager");
    fail(
      `platforms;android-${compileSdk} is not installed, but android/variables.gradle sets compileSdk ${compileSdk}.\n` +
        `Install it with:\n  "${sdkmanager}" "platforms;android-${compileSdk}"`
    );
  }
  log(`compileSdk ${compileSdk} satisfied`);

  // android/local.properties is machine-specific; regenerate it every run so a
  // moved SDK directory cannot strand a stale absolute path.
  writeFileSync(
    path.join(ANDROID_DIR, "local.properties"),
    [
      "## Generated by scripts/build-apk.mjs — do not edit, do not commit.",
      "## Forward slashes on purpose: avoids escaping backslashes and colons on Windows.",
      `sdk.dir=${sdk.replace(/\\/g, "/")}`,
      "",
    ].join("\n")
  );
  log("wrote android/local.properties");

  // Child process env only — the ambient machine environment is untouched.
  const env = {
    ...process.env,
    JAVA_HOME: jdk.home,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    PATH: `${path.join(jdk.home, "bin")}${isWin ? ";" : ":"}${process.env.PATH || ""}`,
  };

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${GRADLE_TASK}.log`);
  logStream = createWriteStream(logPath, { flags: "w" });
  log(`log    : ${logPath}`);

  log("stage 1/4  static export (next build -> mobile/www)");
  await run(process.execPath, [path.join(ROOT, "scripts", "export-static.mjs")], { env });

  // Spawn the Capacitor CLI's JS entrypoint via node rather than `npx`/`cap`.
  // Node >= 18.20 refuses to spawn a `.cmd` shim without `shell: true` (the
  // CVE-2024-27980 hardening), and `shell: true` brings back the DEP0190
  // argument-quoting hazard. Same approach as scripts/export-static.mjs.
  const capBin = path.join(ROOT, "node_modules", "@capacitor", "cli", "bin", "capacitor");
  if (!existsSync(capBin)) {
    fail(`Capacitor CLI not found at ${capBin} — run \`npm install\` first`);
  }

  log("stage 2/4  capacitor sync");
  await run(process.execPath, [capBin, "sync", "android"], { env });

  log(`stage 3/4  gradlew ${GRADLE_TASK}  (a cold first run downloads AGP + deps, ~5 min)`);
  await runGradle(GRADLE_TASK, jdk, env);

  const apk = path.join(ANDROID_DIR, "app", "build", "outputs", "apk", VARIANT, `app-${VARIANT}.apk`);
  if (!existsSync(apk)) {
    fail(`gradle reported success but no APK at ${apk}`);
  }
  const size = statSync(apk).size;

  logStream.end();
  log("stage 4/4  done");
  console.log("");
  console.log(`  APK   ${apk}`);
  console.log(`  size  ${size.toLocaleString("en-US")} bytes (${(size / 1048576).toFixed(2)} MB)`);
  if (RELEASE) {
    console.log("  note  release is UNSIGNED — add a signingConfig before shipping it");
  }
  console.log("");
}

main().catch((e) => {
  if (logStream) logStream.end();
  console.error(`[apk] build failed: ${e.message}`);
  process.exit(1);
});
