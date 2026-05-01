// Drag from palette → drop on a rack. We use the HTML5 DnD API; the palette
// item ships a JSON descriptor and the RackCanvas resolves it on drop.

import type { ServerKind, ServerTemplate } from "../../api/specs";
import type { Selection } from "./Inspector";

export type PaletteItem = {
  kind: "server-template";
  template: ServerTemplate;
  label: string;
};

type Props = {
  templates: ServerTemplate[];
  selection: Selection;
  onSelect: (templateId: string) => void;
  onAdd: () => void;
  onRemove: (templateId: string) => void;
};

const KIND_ICON: Record<ServerKind, string> = { cpu: "C", gpu: "G", memory: "M", storage: "S" };
// All kinds use the same green (matches the rack tile's "ok" icon).
const KIND_ICON_BG = "rgba(72, 200, 116, 0.20)";
const KIND_ICON_FG = "#48c874";

const trashStyle: React.CSSProperties = {
  fontSize: 11, padding: "2px 6px", marginLeft: "auto",
  color: "var(--red)", border: "none", background: "transparent", cursor: "pointer",
};

function templateLabel(t: ServerTemplate): string {
  return t.name?.trim() || "未命名";
}

export function Palette({ templates, selection, onSelect, onAdd, onRemove }: Props) {
  return (
    <div className="palette">
      <div className="pal-sec">
        <div className="pal-t">服务器（拖到机柜 / 点击查看详情）</div>
        {templates.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--t3)", padding: "6px 4px" }}>
            暂无服务器，点击下方「+ 新建」开始。
          </div>
        )}
        {templates.map((t) => {
          const sel = selection?.kind === "template" && selection.templateId === t.id;
          const item: PaletteItem = { kind: "server-template", template: t, label: templateLabel(t) };
          const k = t.kind ?? "gpu";
          return (
            <div
              key={t.id}
              className={`pal-item ${sel ? "sel" : ""}`}
              draggable
              onClick={(e) => { e.stopPropagation(); onSelect(t.id); }}
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-bytesim-palette", JSON.stringify(item));
                e.dataTransfer.effectAllowed = "copy";
              }}
              style={{ cursor: "pointer" }}
              data-testid={`palette-template-${t.id}`}
            >
              <span
                className="pal-ico"
                style={{
                  background: KIND_ICON_BG,
                  color: KIND_ICON_FG,
                  fontWeight: 700,
                }}
              >
                {KIND_ICON[k]}
              </span>
              <span style={{ flex: 1 }}>{templateLabel(t)}</span>
              <button
                style={trashStyle}
                onClick={(e) => { e.stopPropagation(); onRemove(t.id); }}
                title="删除该服务器"
                data-testid={`palette-remove-${t.id}`}
              >
                🗑
              </button>
            </div>
          );
        })}
        <button
          className="btn btn-ghost"
          style={{ marginTop: 8, fontSize: 11, padding: "4px 10px", width: "100%" }}
          onClick={onAdd}
          data-testid="palette-add-template"
        >
          + 新建服务器
        </button>
      </div>
    </div>
  );
}
