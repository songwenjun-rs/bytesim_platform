import { useEffect, useRef, useState } from "react";
import { wsURL } from "../../api/client";

type LogEvent = {
  type: "log" | "eof";
  ts?: string;
  source?: string;
  level?: "info" | "warn" | "err";
  msg?: string;
};

export function EngineLog({ runId }: { runId: string }) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setEvents([]);
    setStatus("connecting");
    const ws = new WebSocket(wsURL(`/v1/streams/run/${runId}/log`));
    ws.onopen = () => setStatus("open");
    ws.onerror = () => setStatus("error");
    ws.onclose = () => setStatus((s) => (s === "error" ? "error" : "closed"));
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as LogEvent;
        setEvents((prev) => [...prev, ev]);
      } catch { /* ignore parse errors */ }
    };
    return () => ws.close();
  }, [runId]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events]);

  const statusTag =
    status === "open"   ? <span className="tag tag-teal">▶ 流式</span> :
    status === "closed" ? <span className="tag tag-green">完成</span> :
    status === "error"  ? <span className="tag tag-red">连接失败</span> :
                          <span className="tag tag-white">连接中…</span>;

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-t">引擎日志 · WebSocket 流</div>
        {statusTag}
      </div>
      <pre className="run-log" ref={ref}>
        {events.length === 0 && status !== "error" && (
          <span style={{ color: "var(--t3)" }}>等待日志…</span>
        )}
        {events.map((ev, i) => {
          if (ev.type === "eof") {
            return <div key={i} style={{ color: "var(--t3)" }}>— 流结束 —</div>;
          }
          return (
            <div key={i} className={`lvl-${ev.level ?? "info"}`}>
              {ev.ts && <span className="ts">[{ev.ts}]</span>}
              {ev.source && <span className="src">{ev.source}</span>}
              {ev.msg}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
