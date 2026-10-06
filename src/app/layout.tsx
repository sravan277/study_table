import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
/**
 * The logs stylesheet is imported here rather than by the logs segment.
 *
 * A route-level stylesheet becomes its own chunk, and the header's `<Link href="/logs">`
 * prefetches that route — so the browser preloads a stylesheet that a visitor who never
 * opens Logs never applies, and Chrome reports it twice on every load:
 * "preloaded using link preload but not used". Importing it from the root layout folds
 * it into the one global chunk, which is applied on the first paint and so has nothing
 * left over to complain about. 6 KB, and the archive was being downloaded anyway.
 */
import "./logs/logs.css";

/**
 * Two families, chosen for the subject.
 *
 * Space Grotesk carries the display and UI: it has the slightly technical,
 * instrument-panel character that a gauge wants, and it is not the default
 * choice a template reaches for.
 *
 * IBM Plex Mono carries every numeral on the page. That is functional, not
 * stylistic — a running clock set in a proportional face reflows its own layout
 * four times a second.
 *
 * Both are fetched at build time and self-hosted, so the browser never talks to
 * Google. Note this means `next build` needs network access once.
 */
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Day Dial",
  description: "A day-planning instrument: one 24-hour dial, a timer per block, and reminders before each one.",
  applicationName: "Day Dial",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Day Dial" },
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}