/**
 * S5.5 — User-saved Sim presets.
 *
 * Architects often arrive at a useful baseline through several rounds
 * of tweaking; without persistence they re-key the same numbers next
 * session. The 5+5 hardcoded presets cover canonical scenarios but not
 * the architect's specific in-flight design ("our DC's H200 cluster
 * with prefix=0.7 + active=320 — bookmark this").
 *
 * Storage: localStorage, partitioned by kind (infer | train) so the two
 * distinct form shapes don't bleed into each other. No cross-device
 * sync — when an org needs that, the project-level preset registry is
 * a separate problem (likely a BFF endpoint, out of scope here).
 *
 * Form shape stays untyped at this layer — saveCustomPreset takes the
 * page's typed form, callers cast on read. This keeps the storage util
 * generic without making `Preset<F>` import a type cycle.
 */

const STORAGE_KEY_PREFIX = "bytesim:customPresets:";

export type CustomPreset = {
  id: string;
  name: string;
  desc: string;
  /** Form payload — page-shape; callers cast to InferencePresetForm or TrainingPresetForm. */
  form: Record<string, unknown>;
  savedAt: string;
};

export type Kind = "infer" | "train";

function storageKey(kind: Kind): string {
  return STORAGE_KEY_PREFIX + kind;
}

export function loadCustomPresets(kind: Kind): CustomPreset[] {
  try {
    const raw = localStorage.getItem(storageKey(kind));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is CustomPreset =>
        p && typeof p.id === "string" && typeof p.name === "string"
        && p.form && typeof p.form === "object",
    );
  } catch {
    return [];
  }
}

export function saveCustomPreset(
  kind: Kind, name: string, form: Record<string, unknown>,
): CustomPreset | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Date.now alone collides under fast back-to-back saves (test harness,
  // user double-click). Append a short random suffix to guarantee uniqueness.
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const preset: CustomPreset = {
    id, name: trimmed,
    desc: `自定义 · 保存于 ${new Date().toLocaleDateString()}`,
    form,
    savedAt: new Date().toISOString(),
  };
  try {
    const current = loadCustomPresets(kind);
    const next = [preset, ...current].slice(0, 20);  // cap at 20 per kind
    localStorage.setItem(storageKey(kind), JSON.stringify(next));
    return preset;
  } catch { return null; }
}

export function deleteCustomPreset(kind: Kind, id: string): void {
  try {
    const current = loadCustomPresets(kind);
    const next = current.filter((p) => p.id !== id);
    localStorage.setItem(storageKey(kind), JSON.stringify(next));
  } catch { /* */ }
}
