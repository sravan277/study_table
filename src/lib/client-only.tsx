"use client";

import { useSyncExternalStore } from "react";

/**
 * Renders only after hydration.
 *
 * Every number on this page comes from the IST clock and from localStorage, neither of
 * which the server can see. Rendering them during SSR would guarantee a hydration
 * mismatch and a visible jump from server time to client time on every load — so the
 * dynamic subtree waits for the client, and the server sends a static shell instead.
 *
 * `useSyncExternalStore` with a server snapshot of `false` is the sanctioned way to
 * express "this differs between server and client". It is also, unlike a
 * `useEffect` + `setState` mount flag, free of the cascading-render problem.
 */
const noopSubscribe = () => () => {};

export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function ClientOnly({ children, fallback = null }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  return useIsClient() ? <>{children}</> : <>{fallback}</>;
}