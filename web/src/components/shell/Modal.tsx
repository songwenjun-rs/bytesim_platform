/**
 * Tiny modal — no portals, no deps. Use cases: text-input prompt with
 * validation/cancel, confirm dialog, anything where alert()/prompt() falls short.
 *
 *   const [open, setOpen] = useState(false);
 *   <Modal open={open} title="…" onClose={() => setOpen(false)} onSubmit={…}>
 *     <input … />
 *   </Modal>
 *
 * Renders a backdrop + centered card; Esc / backdrop click closes when
 * onClose is provided. Submit button gets the user's keyboard focus.
 */
import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit?: () => void;     // omit for read-only / info modals
  submitLabel?: string;
  submitDisabled?: boolean;
  destructive?: boolean;     // red submit (delete/reject)
};

export function Modal({
  open, title, children,
  onClose, onSubmit, submitLabel = "确定",
  submitDisabled, destructive,
}: Props) {
  const submitRef = useRef<HTMLButtonElement | null>(null);

  // Esc closes; focus submit on open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && onSubmit && !submitDisabled) {
        // Don't fire while typing in a textarea (multi-line)
        const target = e.target as HTMLElement | null;
        if (target && target.tagName === "TEXTAREA") return;
        onSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    submitRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onSubmit, submitDisabled]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 900,
        background: "rgba(0,0,0,0.5)",
        display: "grid", placeItems: "center",
        backdropFilter: "saturate(160%) blur(2px)",
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 380, maxWidth: 540,
          boxShadow: "var(--sh-lg)",
        }}
      >
        <div className="card-head">
          <div className="card-t">{title}</div>
          <button
            className="btn btn-plain"
            onClick={onClose}
            aria-label="关闭"
            style={{ padding: "2px 8px" }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: "8px 0" }}>{children}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          {onSubmit && (
            <button
              ref={submitRef}
              className={destructive ? "btn btn-ghost" : "btn btn-primary"}
              onClick={onSubmit}
              disabled={submitDisabled}
              style={destructive ? { color: "var(--red)", borderColor: "var(--red)" } : undefined}
            >
              {submitLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
