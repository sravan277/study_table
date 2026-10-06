// Mobile static-export config.
//
// Used ONLY for the Android/Capacitor build. scripts/export-static.mjs swaps it
// into place as `next.config.mjs`, then restores the checked-in
// `next.config.ts` afterwards (including on failure).
//
// Why a separate file: `next build` has no `--config` flag, it always loads
// `next.config.*` from the project root. So the only way to keep the server
// config intact is to rename it aside for the duration of the build.
//
// Why `headers()` is dropped: it is unsupported under `output: "export"` and
// meaningless for a static bundle. Next.js ignores it and logs a warning. The
// `/sw.js` Service-Worker-Allowed header it sets matters only for the hosted
// web build, not for the APK, where the WebView loads from
// https://localhost via Capacitor's local server.

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",

  // NOTE: in Next.js 16, `distDir` does double duty — when `output: "export"`
  // is set, `distDir` renames the *static output* directory (`out` -> distDir)
  // and the internal build cache is forced back to `.next`
  // (see hasCustomExportOutput() in node_modules/next/dist/build/index.js).
  // It does NOT give the mobile build an isolated build cache, so it is left
  // unset here to keep the conventional `out/` output directory.

  // There is no image optimiser in a static export, so any next/image render
  // would fail at build time. (This app does not currently use next/image,
  // but leaving this on means adding one later cannot silently break the APK.)
  images: { unoptimized: true },
};

export default nextConfig;
