/**
 * Experiment JSON — serialize / parse / download / read.
 *
 * Cross-environment portability for Sim form state. The architect saves
 * a hand-tuned configuration as JSON, sends it to a teammate or carries
 * it to another deployment, and re-imports there to start from the
 * exact same form state.
 *
 * Shape is deliberately conservative — just the minimum needed to
 * reconstruct the form. We don't include lineage hashes (those vary by
 * environment) or KPI snapshots (those are run-time, not config).
 *
 * Schema versioning: `version: 1`. Future incompatible changes bump
 * the version; parseExperiment surfaces the version mismatch as a
 * structured error rather than silently returning bad data.
 */

const SCHEMA_VERSION = 1;

export type Experiment = {
  $schema: "bytesim.experiment.v1";
  version: number;
  kind: "infer" | "train";
  title: string;
  exportedAt: string;
  form: Record<string, unknown>;
};

export type ParseResult =
  | { ok: true; experiment: Experiment }
  | { ok: false; error: string };

export function serializeExperiment(
  kind: "infer" | "train",
  title: string,
  form: Record<string, unknown>,
): string {
  const exp: Experiment = {
    $schema: "bytesim.experiment.v1",
    version: SCHEMA_VERSION,
    kind, title, exportedAt: new Date().toISOString(),
    form,
  };
  return JSON.stringify(exp, null, 2);
}

export function parseExperiment(text: string): ParseResult {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "JSON 不是对象" };
    }
    if (parsed.$schema !== "bytesim.experiment.v1") {
      return { ok: false, error: `非 ByteSim experiment schema (got ${parsed.$schema ?? "无 $schema"})` };
    }
    if (typeof parsed.version !== "number" || parsed.version > SCHEMA_VERSION) {
      return { ok: false, error: `不支持的 schema 版本 ${parsed.version}` };
    }
    if (parsed.kind !== "infer" && parsed.kind !== "train") {
      return { ok: false, error: `kind 必须是 infer 或 train (got ${parsed.kind})` };
    }
    if (!parsed.form || typeof parsed.form !== "object") {
      return { ok: false, error: "缺少 form 对象" };
    }
    return { ok: true, experiment: parsed as Experiment };
  } catch (e) {
    return { ok: false, error: `JSON 解析失败: ${String(e)}` };
  }
}

/**
 * Trigger a browser download of the JSON. No external library — uses a
 * synthetic anchor + revocable Blob URL. Filename includes timestamp
 * to avoid clobbering on multiple exports of the same name.
 */
export function downloadExperiment(
  kind: "infer" | "train",
  title: string,
  form: Record<string, unknown>,
): void {
  const json = serializeExperiment(kind, title, form);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = (title || kind).replace(/[^\w一-龥]+/g, "_").slice(0, 40);
  a.href = url;
  a.download = `bytesim-${kind}-${safeName}-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a File (from <input type=file>) into text. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
