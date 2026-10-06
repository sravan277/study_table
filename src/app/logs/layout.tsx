import type { Metadata } from "next";

/**
 * The logs segment.
 *
 * A layout rather than inline in the page, for one reason: `page.tsx` is a client
 * component — every number on it comes from localStorage and the IST clock, neither
 * of which exists during SSR — and a `"use client"` module cannot export `metadata`.
 * The title has to live in a server component somewhere below the root layout, and
 * this is the only place there is.
 *
 * `logs.css` is *not* imported here. It is imported by the root layout, so that it
 * lands in the single global stylesheet instead of becoming a second chunk the header's
 * prefetch downloads and never uses. See the note in `src/app/layout.tsx`.
 */
export const metadata: Metadata = {
  title: "Logs · Day Dial",
  description: "Every archived day: focused time, waste, blocks met and blocks missed.",
};

export default function LogsLayout({ children }: { children: React.ReactNode }) {
  return children;
}