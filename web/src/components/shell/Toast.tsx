/**
 * Tiny toast: `useToast()` returns `(msg, kind?) => void`.
 * Replaces alert() calls. Stacks bottom-right, auto-dismisses in 5s, hover
 * to pause. No external deps. State is module-global so hooks-anywhere works.
 */
import { useEffect, useState } from "react";

type Kind = "info" | "ok" | "warn" | "err";
type Toast = { id: number; msg: string; kind: Kind };

let _id = 0;
const _subs = new Set<(t: Toast[]) => void>();
let _list: Toast[] = [];

function emit(next: Toast[]) {
  _list = next;
  _subs.forEach((s) => s(next));
}

export function pushToast(msg: string, kind: Kind = "info"): void {
  const t = { id: ++_id, msg, kind };
  emit([..._list, t]);
  // auto-dismiss
  setTimeout(() => emit(_list.filter((x) => x.id !== t.id)), 5000);
}

export function useToast() {
  return pushToast;
}

const KIND_COLOR: Record<Kind, string> = {
  info: "var(--blue)",
  ok: "var(--green)",
  warn: "var(--orange)",
  err: "var(--red)",
};

export function ToastHost() {
  const [list, setList] = useState<Toast[]>(_list);
  useEffect(() => {
    _subs.add(setList);
    return () => { _subs.delete(setList); };
  }, []);
  if (list.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed", right: 24, bottom: 24, zIndex: 1000,
        display: "flex", flexDirection: "column", gap: 8,
        pointerEvents: "none",
      }}
    >
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          onClick={() => emit(_list.filter((x) => x.id !== t.id))}
          style={{
            pointerEvents: "auto",
            background: "var(--surface-3)",
            border: "1px solid var(--hairline-2)",
            borderLeft: `3px solid ${KIND_COLOR[t.kind]}`,
            borderRadius: "var(--r-sm)",
            padding: "10px 14px",
            color: "var(--t1)",
            fontSize: 12.5,
            maxWidth: 360,
            boxShadow: "var(--sh-md)",
            cursor: "pointer",
          }}
          title="点击关闭"
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
