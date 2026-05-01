/**
 * 硬件部件 — 平台支持的硬件目录（CPU / GPU / 网卡 / SSD），bs_catalog 持久化。
 */
import { useMemo, useState } from "react";
import {
  useCatalogItems, useDeleteCatalogItem, useUpsertCatalogItem,
  type CatalogItem, type CatalogKind,
} from "../api/catalogItems";

type Kind = "cpu" | "gpu" | "nic" | "ssd";

const KIND_LABEL: Record<Kind, string> = {
  gpu: "GPU", cpu: "CPU", nic: "网卡", ssd: "SSD",
};

type Field = {
  key: string;
  label: string;
  type: "text" | "number";
  step?: string;
  unit?: string;
  width?: number;
};

const FIELDS: Record<Kind, Field[]> = {
  gpu: [
    { key: "model",      label: "型号",       type: "text",   width: 110 },
    { key: "vendor",     label: "厂商",       type: "text",   width: 90 },
    { key: "fp8_tflops", label: "FP8",        type: "number", unit: " TFLOPS" },
    { key: "bf16_tflops",label: "BF16",       type: "number", unit: " TFLOPS" },
    { key: "hbm_gb",     label: "HBM",        type: "number", unit: " GB" },
    { key: "mem_bw_tbs", label: "Mem BW",     type: "number", step: "0.1", unit: " TB/s" },
    { key: "tdp_w",      label: "TDP",        type: "number", unit: " W" },
    { key: "year",       label: "发布",       type: "number", width: 70 },
  ],
  cpu: [
    { key: "model",     label: "型号",       type: "text",   width: 220 },
    { key: "vendor",    label: "厂商",       type: "text",   width: 90 },
    { key: "cores",     label: "核心",       type: "number", unit: " 核" },
    { key: "base_ghz",  label: "基频",       type: "number", step: "0.1", unit: " GHz" },
    { key: "boost_ghz", label: "加速频率",   type: "number", step: "0.1", unit: " GHz" },
    { key: "tdp_w",     label: "TDP",        type: "number", unit: " W" },
    { key: "mem_channels", label: "内存通道", type: "number" },
  ],
  nic: [
    { key: "model",     label: "型号",        type: "text",   width: 160 },
    { key: "vendor",    label: "厂商",        type: "text",   width: 90 },
    { key: "bw_gbps",   label: "单口带宽",    type: "number", unit: " Gbps" },
    { key: "ports",     label: "端口数",      type: "number" },
    { key: "protocol",  label: "协议",        type: "text",   width: 130 },
    { key: "tdp_w",     label: "TDP",         type: "number", unit: " W" },
  ],
  ssd: [
    { key: "model",        label: "型号",       type: "text",   width: 200 },
    { key: "vendor",       label: "厂商",       type: "text",   width: 90 },
    { key: "capacity_tb",  label: "容量",       type: "number", step: "0.01", unit: " TB" },
    { key: "interface",    label: "接口",       type: "text",   width: 110 },
    { key: "read_gbs",     label: "顺序读",     type: "number", step: "0.1", unit: " GB/s" },
    { key: "write_gbs",    label: "顺序写",     type: "number", step: "0.1", unit: " GB/s" },
  ],
};

type Row = { id: string } & Record<string, string | number>;

function asRow(it: CatalogItem<unknown>): Row {
  return { id: it.id, ...(it.body as Record<string, string | number>) };
}

export function Catalog() {
  const [kind, setKind] = useState<Kind>("cpu");
  const [editing, setEditing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);

  // Counts: query each kind in parallel for the top chips.
  const cpu = useCatalogItems("cpu");
  const gpu = useCatalogItems("gpu");
  const nic = useCatalogItems("nic");
  const ssd = useCatalogItems("ssd");
  const all: Record<Kind, ReturnType<typeof useCatalogItems>> = { cpu, gpu, nic, ssd };

  const upsert = useUpsertCatalogItem(kind);
  const del = useDeleteCatalogItem(kind);

  const fields = FIELDS[kind];
  const rows: Row[] = useMemo(
    () => (all[kind].data ?? []).map(asRow),
    [all, kind],
  );

  const upsertRow = async (row: Row) => {
    const { id, ...rest } = row;
    const name = String(rest.model ?? id);
    await upsert.mutateAsync({ id, name, body: rest });
  };

  const deleteRow = async (id: string) => {
    if (!window.confirm("确认删除该部件？")) return;
    await del.mutateAsync(id);
  };

  return (
    <>
      <div className="page-hd">
        <h1 className="page-ttl">硬件部件</h1>
      </div>

      {/* Stat chips — display-only, not clickable. */}
      <div className="stat-chips">
        {(["cpu", "gpu", "nic", "ssd"] as Kind[]).map((k) => (
          <div key={k} className="stat-chip">
            <div className="num">{all[k].data?.length ?? "—"}</div>
            <div className="lab">{KIND_LABEL[k]}</div>
          </div>
        ))}
      </div>

      {/* Kind tabbar + actions */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {(["cpu", "gpu", "nic", "ssd"] as Kind[]).map((k) => (
              <button
                key={k}
                className={`btn ${k === kind ? "btn-primary" : "btn-ghost"}`}
                style={{ fontSize: 12, padding: "5px 12px" }}
                onClick={() => { setKind(k); setEditing(null); setAdding(false); }}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: "auto" }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12, padding: "6px 12px" }}
              onClick={() => { setEditing(null); setAdding(true); }}
            >
              + 新增 {KIND_LABEL[kind]}
            </button>
          </div>
        </div>
      </div>

      {(adding || editing) && (
        <PartForm
          kind={kind}
          fields={fields}
          initial={editing ?? blankRow(kind)}
          isNew={adding}
          onCancel={() => { setEditing(null); setAdding(false); }}
          onSave={(row) => upsertRow(row).then(() => { setEditing(null); setAdding(false); })}
        />
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {all[kind].isLoading ? (
          <div style={{ padding: 16, color: "var(--t3)", fontSize: 12 }}>加载中…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--t3)", fontSize: 12 }}>
            尚无 {KIND_LABEL[kind]} 部件 — 点右上「+ 新增」录入
          </div>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.key} style={{ width: f.width, textAlign: f.type === "number" ? "right" : "left" }}>
                    {f.label}
                  </th>
                ))}
                <th style={{ width: 110, textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="report-row">
                  {fields.map((f) => (
                    <td key={f.key} style={{
                      fontFamily: f.type === "number" ? "var(--mono)" : undefined,
                      textAlign: f.type === "number" ? "right" : "left",
                    }}>
                      {fmtCell(r[f.key], f)}
                    </td>
                  ))}
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: "3px 8px", marginRight: 4 }}
                      onClick={() => { setAdding(false); setEditing(r); }}
                    >编辑</button>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 11, padding: "3px 8px", color: "var(--red)" }}
                      onClick={() => deleteRow(r.id)}
                    >删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function PartForm({
  kind, fields, initial, isNew, onCancel, onSave,
}: {
  kind: Kind;
  fields: Field[];
  initial: Row;
  isNew: boolean;
  onCancel: () => void;
  onSave: (r: Row) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Row>(initial);
  const onSubmit = () => {
    const id = draft.id || `${kind}-${slug(String(draft.model ?? ""))}`;
    void onSave({ ...draft, id });
  };
  return (
    <div className="card" style={{ marginBottom: 14, borderLeft: "3px solid var(--blue)" }}>
      <div className="card-head" style={{ marginBottom: 10 }}>
        <div className="card-t">{isNew ? "新增" : "编辑"} {KIND_LABEL[kind]}</div>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--t3)" }}>
          {draft.id || "(自动生成)"}
        </span>
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 10,
      }}>
        {fields.map((f) => {
          // htmlFor + id link the label to the input — needed for both
          // screen readers and Playwright's getByLabel().
          const inputId = `catalog-field-${kind}-${f.key}`;
          return (
            <div key={f.key}>
              <label htmlFor={inputId}
                style={{ fontSize: 10.5, color: "var(--t3)", display: "block", marginBottom: 3 }}>
                {f.label}{f.unit && <span style={{ marginLeft: 4 }}>({f.unit.trim()})</span>}
              </label>
              <input
                id={inputId}
                type={f.type}
                step={f.step}
                value={String(draft[f.key] ?? "")}
                onChange={(e) => {
                  const v = f.type === "number" ? Number(e.target.value) : e.target.value;
                  setDraft({ ...draft, [f.key]: v });
                }}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  background: "var(--bg-3)", border: "1px solid var(--hairline)",
                  borderRadius: "var(--r-sm)", color: "var(--t1)", fontSize: 12,
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: "6px 12px" }}
                onClick={onCancel}>取消</button>
        <button className="btn btn-primary" style={{ fontSize: 12, padding: "6px 14px" }}
                onClick={onSubmit}>保存</button>
      </div>
    </div>
  );
}

function fmtCell(v: unknown, f: Field): string {
  if (v == null || v === "") return "—";
  if (f.type === "number" && typeof v === "number") return `${v}${f.unit ?? ""}`;
  return String(v);
}

function blankRow(kind: Kind): Row {
  const r: Row = { id: "" };
  for (const f of FIELDS[kind]) r[f.key] = f.type === "number" ? 0 : "";
  return r;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    || String(Date.now()).slice(-6);
}
// suppress unused-import lint (CatalogKind is generic param)
void (null as unknown as CatalogKind);
