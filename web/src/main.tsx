import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/global.css";
import { getToken, setSession } from "./api/client";

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

// Auth bootstrap — the platform no longer surfaces a login screen, but the
// BFF still requires an Authorization header. Fetch a token transparently on
// first load (default user) and stash it; subsequent reloads reuse it.
async function bootstrapAuth(): Promise<void> {
  if (getToken()) return;
  try {
    const r = await fetch("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "songwenjun", password: "" }),
    });
    if (!r.ok) return;
    const j = await r.json();
    if (j?.token && Array.isArray(j?.projects) && j.projects.length > 0) {
      setSession(j.token, j.projects[0]);
    }
  } catch { /* offline / BFF down — let queries error normally */ }
}

// Default-spec bootstrap — runs after auth so that pages relying on
// hwspec_topo_b1 / model_moe256e never see 404. asset-svc's Snapshot()
// self-creates the bs_spec row when missing (003e0... migration), so we
// just need to POST a minimal body once. Idempotent: a successful GET
// returns early without re-seeding.
type EnsureSpec = { kind: string; id: string; body: unknown };
const DEFAULT_SPECS: EnsureSpec[] = [
  {
    kind: "hwspec", id: "hwspec_topo_b1",
    body: {
      datacenter: { id: "dc-default", name: "默认数据中心", clusters: [], scale_out_fabrics: [] },
      server_templates: [],
    },
  },
  {
    kind: "model", id: "model_moe256e",
    body: {
      model_name: "Default-Model", family: "Dense Transformer",
      params: "8B (placeholder)", layers: 32, hidden: 4096,
      activated_params_b: 8, total_params_b: 8,
      seq_len: 8192, quant: "FP8",
    },
  },
];

async function bootstrapDefaultSpecs(): Promise<void> {
  const token = getToken();
  if (!token) return;
  const auth = { Authorization: `Bearer ${token}`, "X-Project-ID": "p_default" };
  for (const spec of DEFAULT_SPECS) {
    try {
      const r = await fetch(`/v1/specs/${spec.kind}/${spec.id}`, { headers: auth });
      if (r.ok) continue;  // already exists, leave alone
      if (r.status !== 404 && r.status !== 502) continue;  // not a missing-row signal
      await fetch(`/v1/specs/${spec.kind}/${spec.id}/snapshot`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ body: spec.body }),
      }).catch(() => { /* swallow — let queries error if it really matters */ });
    } catch { /* offline */ }
  }
}

bootstrapAuth().then(bootstrapDefaultSpecs).finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
});
