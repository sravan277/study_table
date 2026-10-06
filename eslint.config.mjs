import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  /**
 * `mobile/**` and `android/**` are build output, not source.
 *
 * `mobile/www` is the static export that gets bundled into the APK — thousands of
 * minified files that ESLint was reporting on, none of them ours to fix. `android/` is
 * the generated Capacitor project, and the only file in it anyone edits is
 * `AndroidManifest.xml`, which is XML.
 */
globalIgnores([
  ".next/**",
  "out/**",
  "build/**",
  "mobile/**",
  "android/**",
  "next-env.d.ts",
  ".verify/**",
]),
]);

export default eslintConfig;