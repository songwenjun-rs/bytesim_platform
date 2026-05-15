# Simulation Report Data Path · Redesign

**Status**: Design proposal. No code change yet.
**Owner**: Reporting / Engine platform.
**Companion**: `docs/run_detail_prototype.html` (the v4 UI this design must serve).

---

## 1. Why redesign

The current data path was grown incrementally and now exhibits six structural
issues that make every new report field expensive to ship and easy to silently
drop.

### 1.1 Current issues

| # | Issue | Where |
|---|-------|-------|
| 1 | **Hardcoded allowlist filters engine response** | `services/engine_svc/app/pipeline.py:288` (`for fwd in ("bottleneck", "phase_breakdown", ...)`)— any new field surrogate emits is silently dropped unless this list is manually extended. |
| 2 | **`run.kpis` schema lies** | Declared `Record<string, number>` in TS; actually carries nested objects (`bottleneck`, `phase_breakdown`). UI uses `as any` to read them. |
| 3 | **`boundaries` field collision** | surrogate emits structured boundaries; engine_svc constructs placeholder `{level, text}` boundaries that *overwrite* surrogate's data. |
| 4 | **TCO is a parallel side channel** | Lives in its own table + API, queried separately. Logically it's "an engine's prediction" but treated specially. |
| 5 | **engine_svc mixes orchestration with presentation synthesis** | It both calls engines/picks best AND fabricates display-layer data (`boundaries` placeholder, kpi merging). Two responsibilities should be split. |
| 6 | **`bs_run` row is both state and KPI store** | `status`, `progress_pct`, `kpis`, `artifacts`, `boundaries`, `confidence` all live on one row → write amplification, frequent updates, conflated read patterns. |

### 1.2 What the new prototype needs

`docs/run_detail_prototype.html` (report v4) asks for 9 sections worth of data,
including new fields surrogate already emits but the pipeline drops:
`boundaries` (structured), `confidence_sub`, `recommendations`, `calibration`,
`engine_info`, `collective_times`, `hbm_breakdown`. The current path can't
deliver them without breaking the allowlist abstraction; this document
specifies what to do instead.

---

## 2. Design principles

| # | Principle | Rationale |
|---|-----------|-----------|
| A | **Engine response is persisted verbatim** | Whatever surrogate emits is what the DB stores and what the UI reads. No intermediate filtering, merging, or placeholder injection. |
| B | **JSONB columns for engine output** | Contract extensions become "add field on surrogate side" only — write path requires no change. UI reads with field-presence guards. |
| C | **TCO is treated as another engine** | tco_engine_svc adopts `EnginePredictRequest/Response` contract. Stored, queried, versioned identically to surrogate output. |
| D | **Append-only event log replaces PATCH-driven updates** | `bs_run_event` captures stage transitions, log lines, status changes. UI subscribes; `bs_run` row only updates on lifecycle change. |
| E | **Operational state vs engine output separated by table** | `bs_run` holds lifecycle (status/progress/timestamps); engine output lives in `bs_run_engine_call` keyed by `(run_id, engine, candidate_id)`. |
| F | **Reports are derived from JOIN, not stored as entity** | `/v1/runs/{id}/report` is a query result. No "report" row to keep in sync. |
| G | **All candidate predictions retained** | The 24 candidates from the scan stage stay in DB; only one is flagged `is_best=true`. Audit trail and "what-if" UI become free. |
| H | **Contract version travels with each response** | `bs_run_engine_call.contract_version` lets old runs render with old field shapes when the contract evolves. |
| I | **Artifacts are content-addressed** | Stored by sha256, with m:n linking. Deduplication and GC become tractable. |

---

## 3. Data model

### 3.1 Tables

```sql
-- Operational lifecycle only. Row is small, written rarely.
CREATE TABLE bs_run (
    id              text PRIMARY KEY,
    project_id      text NOT NULL,
    kind            text NOT NULL,              -- train | infer | batch | agent | tco | calibration
    title           text NOT NULL,
    status          text NOT NULL,              -- queued | running | done | failed | cancelled
    progress_pct    real,
    started_at      timestamptz,
    finished_at     timestamptz,
    parent_run_id   text REFERENCES bs_run(id),
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT NOW()
);

-- 4 input specs locked to the run at creation. Immutable.
CREATE TABLE bs_run_spec (
    run_id          text PRIMARY KEY REFERENCES bs_run(id),
    hwspec_hash     char(40) NOT NULL,
    model_hash      char(40) NOT NULL,
    strategy_hash   char(40),
    workload_hash   char(40)
);

-- Every predict call made during the pipeline. Append-only.
CREATE TABLE bs_run_engine_call (
    id                  bigserial PRIMARY KEY,
    run_id              text NOT NULL REFERENCES bs_run(id),
    engine_name         text NOT NULL,           -- surrogate-analytical | tco-analytical | chakra-trace | ...
    engine_version      text NOT NULL,
    contract_version    text NOT NULL,           -- v4 | v5 | ...
    stage               text NOT NULL,           -- baseline | scan | top_k | attribution | tco
    candidate_id        text,                    -- nullable; populated for scan candidates
    is_best             boolean NOT NULL DEFAULT false,
    request_jsonb       jsonb NOT NULL,          -- EnginePredictRequest
    response_jsonb      jsonb NOT NULL,          -- EnginePredictResponse (verbatim)
    latency_ms          real NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX bs_run_engine_call_run_best ON bs_run_engine_call (run_id) WHERE is_best;
CREATE INDEX bs_run_engine_call_run_stage ON bs_run_engine_call (run_id, stage);

-- Append-only event log: replaces PATCH-driven row updates on bs_run.
CREATE TABLE bs_run_event (
    id              bigserial PRIMARY KEY,
    run_id          text NOT NULL REFERENCES bs_run(id),
    ts              timestamptz NOT NULL DEFAULT NOW(),
    kind            text NOT NULL,               -- status_change | stage_start | stage_end | log | warn
    payload_jsonb   jsonb NOT NULL
);
CREATE INDEX bs_run_event_run_ts ON bs_run_event (run_id, ts);

-- Content-addressed artifact store. Multi-run dedup + GC ready.
CREATE TABLE bs_artifact (
    sha256          char(64) PRIMARY KEY,
    bytes           bigint NOT NULL,
    mime            text NOT NULL,
    label           text,
    icon            text
);

CREATE TABLE bs_run_artifact (
    run_id          text NOT NULL REFERENCES bs_run(id),
    artifact_sha    char(64) NOT NULL REFERENCES bs_artifact(sha256),
    name            text NOT NULL,
    ordering        int NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, artifact_sha, name)
);

-- Engine-level calibration provenance. Run references a snapshot id.
CREATE TABLE bs_calibration_snapshot (
    id              text PRIMARY KEY,
    engine_name     text NOT NULL,
    version         text NOT NULL,
    loaded_at       timestamptz NOT NULL,
    cells_jsonb     jsonb NOT NULL
);
```

### 3.2 What goes away

- `bs_run.kpis` JSONB column → replaced by `bs_run_engine_call.response_jsonb` (richer, structured, versioned).
- `bs_run.boundaries` JSONB column → boundaries now live inside `response_jsonb.boundaries` (structured, no field-name collision).
- `bs_run.artifacts` JSONB column → normalized into `bs_artifact` + `bs_run_artifact`.
- `bs_run.confidence` numeric column → `response_jsonb.confidence` + `confidence_sub`.
- `bs_run.surrogate_ver` text column → `bs_run_engine_call.engine_version`.

`bs_run` shrinks to ~10 columns of pure lifecycle state.

---

## 4. Service boundaries

```
┌─────────────────┐
│      web        │
│                 │ GET /v1/runs/{id}/report   → full payload in one call
│                 │ WS  /v1/runs/{id}/stream   → live events during running
└────────┬────────┘
         │
┌────────▼────────┐
│      bff        │ Auth + rate-limit + caching only.
│                 │ No business aggregation logic.
└────────┬────────┘
         │
┌────────▼────────────────────────────────────────────────┐
│   report-svc   (read-only side)                          │
│                                                          │
│   GET /report                                            │
│     SQL JOIN over (bs_run, bs_run_spec,                  │
│       bs_run_engine_call WHERE is_best,                  │
│       bs_run_artifact, bs_artifact,                      │
│       bs_calibration_snapshot)                           │
│                                                          │
│   WS /stream                                             │
│     Subscribe to bs_run_event inserts (LISTEN/NOTIFY     │
│     or polling); push to client.                         │
└─────┬──────────────────────────────────┬─────────────────┘
      │                                  │
┌─────▼─────────┐                ┌───────▼──────────────┐
│   run_svc     │                │     engine_svc        │
│ (write side)  │                │     (orchestrator)    │
│                │                │                       │
│ Writes:        │                │ POST /runs/{id}/start │
│ • bs_run       │                │  1. Loop stages       │
│ • bs_run_spec  │   APIs ────────┤  2. POST /v1/predict  │
│ • bs_run_event │                │     to engine-registry│
│ • bs_artifact  │                │  3. INSERT one row    │
│ • bs_run_artif │                │     per call into     │
│                │                │     bs_run_engine_call│
│ Reads:         │                │  4. Pick best;        │
│ Listing /      │                │     UPDATE is_best    │
│ filtering APIs │                │  5. Call tco-engine,  │
│                │                │     same path         │
└────────────────┘                │  6. Each transition → │
                                  │     bs_run_event row  │
                                  │  7. status updates →  │
                                  │     PATCH bs_run      │
                                  └─────────────┬─────────┘
                                                │
                                  ┌─────────────▼──────────────┐
                                  │    engine_registry_svc      │
                                  │  • Coverage routing         │
                                  │  • Pydantic contract check  │
                                  │  • Stamp _provenance        │
                                  └────┬──────────────┬─────────┘
                                       │              │
                              ┌────────▼──┐   ┌───────▼──────────┐
                              │ surrogate │   │  tco-engine      │
                              │   -svc    │   │  -svc (as engine)│
                              └───────────┘   └──────────────────┘
```

### 4.1 New service: `report-svc`

Read-side service responsible for assembling the `RunReport` payload from the
normalized tables. May live in `bff` as a module if the deployment topology
prefers fewer processes — the boundary is logical.

Responsibilities:
- One read endpoint: `GET /v1/runs/{id}/report` (JOIN + return).
- One stream endpoint: `WS /v1/runs/{id}/stream` (subscribe to events).
- No writes.
- Caching is its concern (e.g. memoize `is_best` query per run-id).

### 4.2 What each existing service stops doing

| Service | No longer does |
|---------|----------------|
| `engine_svc` | Allowlist filtering. Boundary placeholder synthesis. Writes to `run.kpis`. Writes to `run.boundaries`. |
| `bff` | Aggregating 3 run_svc calls into one response. Business logic. |
| `run_svc` | Storing KPIs / engine output / boundaries. (Becomes pure operational-state CRUD + event log.) |
| `tco_engine_svc` | Owning a separate API surface. Adopts `EnginePredictRequest/Response`. |

---

## 5. End-to-end flow

### 5.1 Submit and execute a run

```
1. User POST /v1/runs
   bff → run_svc:
     INSERT bs_run (status=queued)
     INSERT bs_run_spec (4 spec hashes)
     INSERT bs_run_event (kind=status_change, payload={from: null, to: queued})
   run_svc returns {id}; bff kicks engine_svc.

2. engine_svc orchestrates the pipeline:

   INSERT bs_run_event (kind=status_change, queued → running)
   UPDATE bs_run SET status=running, started_at=NOW()

   FOR stage IN [baseline, scan, top_k, attribution]:
     INSERT bs_run_event (kind=stage_start, payload={stage})

     FOR candidate IN stage:
       req  = build EnginePredictRequest
       resp = POST /v1/predict (engine-registry)
       INSERT bs_run_engine_call (
         run_id, engine_name="surrogate-analytical",
         engine_version=resp._provenance.version,
         contract_version="v4",
         stage, candidate_id,
         request_jsonb=req, response_jsonb=resp,
         is_best=false, latency_ms
       )

     INSERT bs_run_event (kind=stage_end, payload={stage, candidates_n, duration_ms})

   # Choose best by mfu_pct (or whatever the policy is)
   UPDATE bs_run_engine_call SET is_best=true WHERE id=<chosen>

   # TCO is just another engine call against the chosen candidate's inputs
   tco_resp = POST /v1/predict (engine-registry, engine="tco-analytical")
   INSERT bs_run_engine_call (engine_name="tco-analytical",
     stage="tco", is_best=true, response_jsonb=tco_resp)

   # Artifacts: engine_svc writes files, dedups by sha
   FOR file IN files_written:
     sha = sha256(file_bytes)
     INSERT INTO bs_artifact (sha, bytes, ...) ON CONFLICT DO NOTHING
     INSERT bs_run_artifact (run_id, artifact_sha=sha, name=file.name)

   INSERT bs_run_event (kind=status_change, running → done)
   UPDATE bs_run SET status=done, finished_at=NOW()

3. (No further PATCH to bs_run for KPI data. Done.)
```

### 5.2 Read the report

```
GET /v1/runs/{id}/report  →  report-svc executes roughly:

  SELECT
    r.*                                      AS run,
    (SELECT json_agg(s) FROM bs_run_spec WHERE run_id=r.id) AS specs,
    (SELECT to_jsonb(c) FROM bs_run_engine_call c
       WHERE c.run_id=r.id AND c.is_best
         AND c.engine_name='surrogate-analytical')          AS predict,
    (SELECT to_jsonb(c) FROM bs_run_engine_call c
       WHERE c.run_id=r.id AND c.is_best
         AND c.engine_name='tco-analytical')                AS tco,
    (SELECT json_agg(ra || jsonb_build_object('sha', a.sha256, 'bytes', a.bytes, 'mime', a.mime))
       FROM bs_run_artifact ra JOIN bs_artifact a ON ra.artifact_sha=a.sha256
       WHERE ra.run_id=r.id)                                 AS artifacts
  FROM bs_run r
  WHERE r.id=$1
```

UI receives:

```jsonc
{
  "run":     { "id": "...", "status": "done", "started_at": "...", ... },
  "specs":   [ { "kind": "hwspec", "hash": "...", "body": {...}, "stale": false }, ... ],
  "predict": {
    "engine":           { "name": "surrogate-analytical", "version": "0.2.0" },
    "contract_version": "v4",
    "response": {                                  // verbatim EnginePredictResponse
      "mfu_pct": 62.3,
      "step_ms": 485,
      "ttft_ms": 142,
      "breakdown": { ... },
      "phase_breakdown": [ ... ],
      "bottleneck": { "primary": "...", "links": [ { "contributes_ms": ... } ] },
      "kv_hit_rate": 0.61,
      "collective_times": { "tp_allreduce": {...} },
      "hbm_breakdown": { ... },
      "boundaries":      [ { "severity": "med", "message": "...", "direction": "underestimate", ... } ],
      "confidence":      0.84,
      "confidence_sub":  { "topology": 0.92, "extrapolation": 0.71, "calibration": 0.96 },
      "recommendations": [ { "category": "parallel", "action": "...", ... } ],
      "calibration":     { "version": "r7", "loaded_at": "...", "age_days": 28 },
      "engine_info":     { "name": "surrogate-analytical", "version": "0.2.0" }
    }
  },
  "tco":     { "engine": {...}, "response": { "total_usd": 48.6e6, "buckets": {...} } },
  "artifacts": [ { "sha": "...", "name": "result.json", "bytes": ..., "mime": "..." }, ... ]
}
```

### 5.3 Live updates

```
WS /v1/runs/{id}/stream
  → report-svc subscribes to bs_run_event inserts for this run_id
  → pushes each as it arrives
```

Frontend consumers:
- `EnginePhases` listens for `kind=stage_start | stage_end`, renders stepper.
- `EngineLog` listens for `kind=log`, renders log lines.
- `RunHeader` listens for `kind=status_change`, updates status chip.

The current PATCH-driven mechanism (engine_svc PATCHes `run_svc` with
`log_append` strings) goes away. Logs are events, not row updates.

---

## 6. v4 prototype → data path mapping

Every section of `docs/run_detail_prototype.html` resolves to a direct read
from the response payload. No allowlist, no synthesis.

| Section | UI element | Source field (under `report.predict.response.*` unless noted) |
|---------|------------|--------------------------------------------------------------|
| 1 优化建议 | RecommendationsCard | `recommendations[]` |
| 2 关键指标 | KpiGrid (TTFT/TPOT/QPS/cost) | `ttft_ms, tpot_ms, step_ms, mfu_pct` |
| 2 ±CI | uncertainty whisker | derived from `confidence_sub` |
| 2 vs 上一跑 | delta column | client-side via recentRuns ring (unchanged) |
| 3 瓶颈 Top-N | BottleneckCard | `bottleneck.links[]` (with `contributes_ms`) |
| 4 step 6 桶 | PhaseBreakdown | `phase_breakdown[]` |
| 4 集合通信 | CollectiveTimesCard | `collective_times` |
| 4 HBM 占用 | HbmStackBar | `hbm_breakdown` |
| 4 热点链路 | HotLinksTable | `link_util_top` or `bottleneck.links` |
| 4 KV 健康 | KvHealthCard | `kv_hit_rate / cache_pressure_pct / spill_bytes_per_s` |
| 5 成本拆解 | TcoBreakdownCard | `report.tco.response.*` |
| 6 输入参数 | InputSpecTabs | `report.specs[]` |
| 7 引擎日志 | EngineLog (WS) | events with `kind=log` |
| 8 总置信度 + 三维 | ConfidenceCard | `confidence`, `confidence_sub` |
| 8 结构化边界 | BoundariesList | `boundaries[]` |
| 8 calibration 新鲜度 | calibration footer | `calibration` |
| 9 输出产物 | ArtifactsList | `report.artifacts[]` |
| Header engine fingerprint | RunHeader chip | `engine_info` |

**The pattern is uniform**: every card reads its data with a single
property-access expression. Adding a new field requires only a frontend
component + an `if (response.X)` presence guard.

---

## 7. Capabilities unlocked

1. **Multi-engine A/B**: `surrogate-analytical` and `chakra-trace` can both produce predictions for the same run. Both rows kept; one flagged `is_best=true`. UI offers an engine-switch toggle.
2. **Full audit trail**: All 24 scan candidates are queryable. "Why did we pick this strategy?" answered without rerun.
3. **Replay and version comparison**: `bs_run_engine_call.request_jsonb` is the engine's full input. Re-running with a newer engine version produces a new row, never overwrites the old one — direct delta available.
4. **Zero-cost contract evolution**: Contract v5 adds fields → DB / report-svc / bff unchanged. Frontend adds a card with a presence guard.
5. **Artifact deduplication**: Two runs with identical `phase_breakdown.json` content share one `bs_artifact` row.
6. **Tractable garbage collection**: Unreferenced `bs_artifact` rows and stale `bs_calibration_snapshot` rows can be swept independently.

---

## 8. Trade-offs

| Decision | Choice | Cost / Risk |
|----------|--------|-------------|
| Persist full response (JSONB) vs flatten to columns | JSONB | No column-level indexes; report query is always single-row by `run_id` so impact is negligible |
| Keep all candidates vs only `is_best` | Keep all | Storage ≈ ×24 per run (few KB → low MB); worth it for audit + what-if UI |
| Event table vs frequent PATCH on `bs_run` | Event table | Slightly more write rows but cheaper per-write, natural time-ordering for free, simpler streaming model |
| TCO via engine contract vs separate API | Engine contract | tco-engine must adopt `EnginePredictRequest/Response` shape — request side may feel awkward (no `strategy` in pure TCO call) but the gain in pipeline uniformity is real |
| Add `report-svc` vs aggregate in bff | New service / module | One more deployable unit; offset by clearer separation between auth (bff) and aggregation (report-svc). Can ship as a bff-internal module if a separate process is overkill |
| Multi-engine in same table vs per-engine tables | Same table, discriminator column | Row width grows with the largest engine's response shape; JSONB compression mitigates |
| WS-only live updates vs poll fallback | WS primary, REST fallback for the same `/report` endpoint | Standard pattern; no new risk |

---

## 9. Migration path

Migration is out of scope for this design, but a reasonable sequence is:

1. **Introduce `bs_run_engine_call` table.** engine_svc dual-writes (old `bs_run.kpis` AND new table). No reader change yet.
2. **Stand up `report-svc`.** It reads from the new table. Wire `bff` to call `report-svc` for a new `/v1/runs/{id}/report` endpoint, keep the legacy `/full` endpoint for back-compat.
3. **Migrate frontend section by section** to the new endpoint. Verify each card reads from `report.predict.response.*` correctly.
4. **Move artifacts to content-addressing.** Backfill `bs_artifact` from existing `bs_run.artifacts` JSONB. engine_svc starts using `bs_artifact` for new runs.
5. **Move TCO to engine contract.** tco_engine_svc registers itself with engine-registry. engine_svc invokes via `/v1/predict`.
6. **Switch event log to `bs_run_event`.** engine_svc INSERTs events instead of `log_append` PATCHes. WS endpoint reads from event table.
7. **Cut the allowlist and placeholder boundaries from `engine_svc/pipeline.py`.**
8. **Drop legacy columns** from `bs_run` (`kpis`, `boundaries`, `artifacts`, `confidence`, `surrogate_ver`). Verify nothing reads them. Apply migration.

Each step is independently shippable and reversible.

---

## 10. Open questions

- **Reporting analytics**: do we want a separate OLAP-style read path (e.g. Materialize / DuckDB) for cross-run analytics, or is per-run point-lookup sufficient? This design assumes the latter.
- **Stream retention**: how long do we keep `bs_run_event` rows? For completed runs > N days, can we compact log events to a single artifact and drop event rows?
- **Multi-tenant isolation**: do we need per-project schemas or row-level security? Out of scope here.
- **Candidate retention policy**: keep all 24 candidates forever, or compact non-best ones to a summary after run completes? Probably keep first-30-days, summarize after.

---

## 11. References

- `services/engine_svc/app/pipeline.py:288` — current allowlist (the thing being replaced).
- `shared/engine_contracts/predict.py` — `EnginePredictResponse` schema (the thing being persisted verbatim).
- `services/surrogate_svc/app/main.py` — engine that emits the structured response.
- `docs/run_detail_prototype.html` — UI v4 that drives requirements.
