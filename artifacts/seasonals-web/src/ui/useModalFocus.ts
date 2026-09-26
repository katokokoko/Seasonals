/**
 * モーダルの focus 管理 (EventDetailCard と同じ方式を hook にしたもの)。
 * - 開いた時に [data-autofocus] (無ければ容器) へ focus
 * - 閉じた時に開く前の要素 (trigger) へ戻す
 * - Esc で onClose、Tab / Shift+Tab は容器内で循環
 */
import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, trigger?: HTMLElement | null) {
  useEffect(() => {
    if (!open) return;
    const prev = trigger ?? (document.activeElement as HTMLElement | null);
    const t = window.setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current;
      first?.focus({ preventScroll: true });
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    };
  }, [open, ref, trigger]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, ref, onClose]);
}
