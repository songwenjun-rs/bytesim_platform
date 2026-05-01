/**
 * S5.1/S5.5 — Sim page preset dropdown.
 *
 * Renders a `<select>` of named presets above the form. On change, calls
 * `onApply(form)` with the preset's full form payload — the page spreads
 * it into local state. The component is generic so the same UI shell
 * serves both InferenceSim and TrainingSim with their distinct form
 * shapes; only the `presets` prop differs.
 *
 * S5.5 — when `kind` and `currentForm` are supplied, the user can save
 * the current form state as a custom preset. Custom presets live in
 * localStorage and appear below the hardcoded ones in the dropdown.
 * Each custom preset has a delete affordance next to the dropdown when
 * it's the current selection.
 *
 * `hideActions=true` suppresses the in-card 💾/📤/📂 buttons; pages can
 * then render <PresetActionsRow> separately (e.g. in a sticky topbar)
 * and pass `presetsVersion` back so the dropdown picks up new entries.
 */
import { useRef, useState } from "react";
import type { Preset } from "./presets";
import {
  type CustomPreset, type Kind,
  loadCustomPresets, saveCustomPreset, deleteCustomPreset,
} from "./customPresets";
import {
  downloadExperiment, parseExperiment, readFileAsText,
} from "./experimentJson";
import { pushToast } from "../shell/Toast";

type Props<F> = {
  presets: Preset<F>[];
  /** Apply the selected preset's form payload + display metadata. The page
   *  can use `meta.name` to override the run title with the preset's
   *  human-friendly name (instead of the preset.form.title field). */
  onApply: (form: F, meta?: { name: string }) => void;
  /** S5.5 — kind partition for custom preset storage. Required for save/delete. */
  kind?: Kind;
  /** S5.5 — current form state, used as the save payload. Required for save. */
  currentForm?: F;
  /** Hide the in-card 💾/📤/📂 action buttons. Render <PresetActionsRow> elsewhere. */
  hideActions?: boolean;
  /** External counter — bump after a save/import elsewhere triggers a re-read of localStorage. */
  presetsVersion?: number;
};

export function PresetSelector<F>({
  presets, onApply, kind, currentForm,
  hideActions = false, presetsVersion = 0,
}: Props<F>) {
  const [selectedId, setSelectedId] = useState<string>("");
  // We re-read on each save/delete via this counter — simpler than a
  // useEffect+state mirror because writes are user-initiated and few.
  const [version, setVersion] = useState(0);
  void version;  // referenced to drive re-render after mutation
  void presetsVersion;  // external bump — included in render so the list re-reads
  const customPresets: CustomPreset[] = kind ? loadCustomPresets(kind) : [];

  // Hidden file input ref for the import flow. Click is triggered from
  // the visible "📂 导入 JSON" button.
  const importInputRef = useRef<HTMLInputElement>(null);

  const allPresets: { id: string; name: string; desc: string; form: F; isCustom: boolean }[] = [
    ...presets.map((p) => ({ ...p, isCustom: false })),
    ...customPresets.map((p) => ({
      id: p.id, name: p.name, desc: p.desc,
      form: p.form as unknown as F,
      isCustom: true,
    })),
  ];
  const selected = allPresets.find((p) => p.id === selectedId) ?? null;

  const handleChange = (id: string) => {
    setSelectedId(id);
    if (!id) return;
    const p = allPresets.find((q) => q.id === id);
    if (p) onApply(p.form, { name: p.name });
  };

  const handleSave = () => {
    if (!kind || !currentForm) return;
    const name = window.prompt("模板名称：");
    if (!name) return;
    const p = saveCustomPreset(kind, name, currentForm as unknown as Record<string, unknown>);
    if (!p) return;
    setVersion((v) => v + 1);
    setSelectedId(p.id);  // select the just-saved preset
  };

  const handleDelete = () => {
    if (!kind || !selectedId || !selected?.isCustom) return;
    if (!window.confirm(`删除模板「${selected.name}」？`)) return;
    deleteCustomPreset(kind, selectedId);
    setSelectedId("");
    setVersion((v) => v + 1);
  };

  const handleExport = () => {
    if (!kind || !currentForm) return;
    const title = (currentForm as { title?: string })?.title ?? `${kind} experiment`;
    downloadExperiment(
      kind, title,
      currentForm as unknown as Record<string, unknown>,
    );
    pushToast("已导出 JSON", "ok");
  };

  const handleImportClick = () => importInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";  // reset so re-importing the same file fires
    if (!file || !kind) return;
    try {
      const text = await readFileAsText(file);
      const r = parseExperiment(text);
      if (!r.ok) {
        pushToast("导入失败：" + r.error, "err");
        return;
      }
      if (r.experiment.kind !== kind) {
        pushToast(
          `JSON kind=${r.experiment.kind}，与当前页面 ${kind} 不匹配`,
          "err",
        );
        return;
      }
      onApply(r.experiment.form as unknown as F, { name: r.experiment.title });
      pushToast(`已导入 ${r.experiment.title}`, "ok");
    } catch (err) {
      pushToast("读取文件失败：" + String(err), "err");
    }
  };

  const canSave = kind != null && currentForm != null;
  const showActions = !hideActions;

  // Same sizing as the 启动训练仿真 button on the topbar above so the
  // preset card's action row visually anchors to the topbar.
  const headBtnStyle: React.CSSProperties = { fontSize: 13, padding: "7px 18px" };

  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="preset-selector">
      <div
        className="card-head"
        style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
      >
        <div className="card-t">场景模板</div>
        <div className="card-x">选一个最接近的场景，然后微调</div>
        {showActions && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canSave && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleSave}
                data-testid="preset-save"
                style={headBtnStyle}
              >
                💾 另存为
              </button>
            )}
            {canSave && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleExport}
                data-testid="preset-export-json"
                style={headBtnStyle}
                title="导出当前 form 为 JSON 文件"
              >
                📤 导出 JSON
              </button>
            )}
            {kind && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={handleImportClick}
                  data-testid="preset-import-json"
                  style={headBtnStyle}
                  title="从 JSON 文件加载 form"
                >
                  📂 导入 JSON
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleImportFile}
                  data-testid="preset-import-input"
                  style={{ display: "none" }}
                />
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={selectedId}
          onChange={(e) => handleChange(e.target.value)}
          data-testid="preset-select"
          style={{
            padding: "6px 10px",
            background: "var(--surface-2)",
            border: "1px solid var(--hairline)",
            borderRadius: "var(--r-sm)",
            color: "var(--t1)",
            fontSize: 12,
            width: 320,
            maxWidth: "100%",
          }}
        >
          <option value="">— 不使用模板 —</option>
          {presets.length > 0 && (
            <optgroup label="预置场景">
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          )}
          {customPresets.length > 0 && (
            <optgroup label="自定义模板">
              {customPresets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          )}
        </select>

        {selected?.isCustom && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleDelete}
            data-testid="preset-delete"
            style={{ fontSize: 11, padding: "4px 10px", color: "var(--red)" }}
          >
            🗑 删除
          </button>
        )}
      </div>

      {selected && <PresetInfoGrid form={selected.form as unknown as Record<string, unknown>} />}
    </div>
  );
}

/** Standalone 💾/📤/📂 button row — render in a sticky topbar when
 *  `hideActions=true` is passed to PresetSelector. After a save/import,
 *  call `onChange()` so the parent can bump `presetsVersion` and the
 *  dropdown re-reads the localStorage list. */
export function PresetActionsRow<F>({
  kind, currentForm, onApply, onChange, btnStyle,
}: {
  kind: Kind;
  currentForm: F;
  onApply: (form: F, meta?: { name: string }) => void;
  onChange?: () => void;
  btnStyle?: React.CSSProperties;
}) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const style: React.CSSProperties = btnStyle ?? { fontSize: 13, padding: "7px 18px" };

  const handleSave = () => {
    const name = window.prompt("模板名称：");
    if (!name) return;
    const p = saveCustomPreset(kind, name, currentForm as unknown as Record<string, unknown>);
    if (!p) return;
    pushToast(`已保存模板「${p.name}」`, "ok");
    onChange?.();
  };

  const handleExport = () => {
    const title = (currentForm as { title?: string })?.title ?? `${kind} experiment`;
    downloadExperiment(kind, title, currentForm as unknown as Record<string, unknown>);
    pushToast("已导出 JSON", "ok");
  };

  const handleImportClick = () => importInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const r = parseExperiment(text);
      if (!r.ok) { pushToast("导入失败：" + r.error, "err"); return; }
      if (r.experiment.kind !== kind) {
        pushToast(`JSON kind=${r.experiment.kind}，与当前页面 ${kind} 不匹配`, "err");
        return;
      }
      onApply(r.experiment.form as unknown as F, { name: r.experiment.title });
      pushToast(`已导入 ${r.experiment.title}`, "ok");
      onChange?.();
    } catch (err) {
      pushToast("读取文件失败：" + String(err), "err");
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleSave}
        data-testid="preset-save"
        style={style}
      >
        💾 另存为
      </button>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleExport}
        data-testid="preset-export-json"
        style={style}
        title="导出当前 form 为 JSON 文件"
      >
        📤 导出 JSON
      </button>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleImportClick}
        data-testid="preset-import-json"
        style={style}
        title="从 JSON 文件加载 form"
      >
        📂 导入 JSON
      </button>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportFile}
        data-testid="preset-import-input"
        style={{ display: "none" }}
      />
    </>
  );
}

/** Render the selected preset's key fields as a compact key-value grid.
 *  Only known fields are surfaced — unknown keys are silently skipped so
 *  the same component works for both Inference and Training presets. */
function PresetInfoGrid({ form }: { form: Record<string, unknown> }) {
  const f = form;
  const num = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : undefined);
  const str = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);

  const items: { label: string; value: string }[] = [];
  const gpuModel = str("gpu_model");
  const gpuCount = num("gpu_count");
  if (gpuModel && gpuCount) items.push({ label: "集群", value: `${gpuCount}× ${gpuModel}` });

  const tp = num("TP"), pp = num("PP"), ep = num("EP"), cp = num("CP");
  if (tp && pp) {
    let parallel = `TP${tp} PP${pp}`;
    if (ep && ep > 1) parallel += ` EP${ep}`;
    if (cp && cp > 1) parallel += ` CP${cp}`;
    items.push({ label: "并行", value: parallel });
  }

  const quant = str("quant");
  if (quant) items.push({ label: "量化", value: quant });

  const recompute = str("recompute");
  if (recompute) items.push({ label: "重算", value: recompute });

  const overlap = str("overlap");
  if (overlap) items.push({ label: "Overlap", value: overlap });

  const act = num("activated_params_b"), total = num("total_params_b");
  if (act && total) {
    items.push({
      label: "参数 激活/总",
      value: act === total ? `${act}B (dense)` : `${act}B / ${total}B`,
    });
  }

  const seq = num("seq_len");
  if (seq) items.push({ label: "序列", value: String(seq) });

  const gb = num("global_batch");
  if (gb) items.push({ label: "Global Batch", value: String(gb) });

  const avgSeqs = num("avg_active_seqs");
  if (avgSeqs) items.push({ label: "并发序列", value: String(avgSeqs) });

  const ttft = num("slo_ttft_p99_ms");
  if (ttft) items.push({ label: "SLO TTFT p99", value: `${ttft} ms` });

  const tpot = num("slo_tpot_ms");
  if (tpot) items.push({ label: "SLO TPOT", value: `${tpot} ms` });

  const kv = num("kv_size_gb_per_seq");
  if (kv) items.push({ label: "KV/seq", value: `${kv} GB` });

  const prefix = num("prefix_share_ratio");
  if (prefix != null) items.push({ label: "Prefix 共享", value: `${(prefix * 100).toFixed(0)}%` });

  if (items.length === 0) return null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "6px 16px",
        marginTop: 10,
        padding: "10px 12px",
        borderRadius: "var(--r-sm)",
        background: "var(--surface-2)",
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
      data-testid="preset-info-grid"
    >
      {items.map((i) => (
        <div key={i.label} style={{ display: "flex", gap: 8, minWidth: 0 }}>
          <span style={{ color: "var(--t3)", minWidth: 70, flexShrink: 0 }}>{i.label}</span>
          <span style={{ color: "var(--t1)", fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {i.value}
          </span>
        </div>
      ))}
    </div>
  );
}
