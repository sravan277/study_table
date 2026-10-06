"use client";

import { useEffect, useState } from "react";
import type { Toast } from "@/lib/types";

/**
 * Toasts.
 *
 * The always-available notification channel. If push permission is denied, or the
 * browser cannot register a worker, this is what still tells you a block is coming —
 * so it carries the same information the push payload does, including the Start
 * action.
 */
export function Toaster({
  toasts,
  onDismiss,
  onAction,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  onAction: (blockId: string) => void;
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} onAction={onAction} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
  onAction,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
  onAction: (blockId: string) => void;
}) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (toast.ttl > 0) return;
    return;
  }, [toast.ttl]);

  const close = () => {
    setLeaving(true);
    setTimeout(() => onDismiss(toast.id), 200);
  };

  return (
    <div
      className={`toast${leaving ? " toast--out" : ""}`}
      style={{ ["--toast-accent" as string]: ACCENT[toast.kind], position: "relative" }}
    >
      <button type="button" className="toast__close" onClick={close} aria-label="Dismiss">
        ×
      </button>
      <div className="toast__title">{toast.title}</div>
      {toast.body ? <div className="toast__body">{toast.body}</div> : null}
      {toast.action ? (
        <button type="button" className="toast__action" onClick={() => onAction(toast.action!.blockId)}>
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );
}

const ACCENT: Record<Toast["kind"], string> = {
  task: "var(--study)",
  water: "var(--water)",
  missed: "var(--alarm)",
  done: "var(--exercise)",
  info: "var(--life)",
  error: "var(--alarm)",
};