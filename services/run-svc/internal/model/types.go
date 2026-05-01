package model

import (
	"encoding/json"
	"time"
)

type CreateRunRequest struct {
	Kind             string         `json:"kind"`               // train / infer / batch / agent / tco
	Title            string         `json:"title"`
	HwSpecHash       string         `json:"hwspec_hash"`        // bs_spec_version.hash
	ModelHash        string         `json:"model_hash"`
	StrategyHash     string         `json:"strategy_hash,omitempty"`
	WorkloadHash     string         `json:"workload_hash,omitempty"`
	ParentRunID      *string        `json:"parent_run_id,omitempty"`
	DerivedFromStudy *string        `json:"derived_from_study,omitempty"`
	DerivedFromTrial *int           `json:"derived_from_trial,omitempty"`
	StrategyOverride map[string]any `json:"strategy_override,omitempty"`
	ClusterOverride  map[string]any `json:"cluster_override,omitempty"`
	WorkloadOverride map[string]any `json:"workload_override,omitempty"`
	// Pin the registry to a specific engine (e.g. "astra-sim") for every
	// predict the pipeline issues. When unset, the registry routes by
	// fidelity / calibration MAPE / SLA per RFC-001 §2.5.
	EnginePreference string `json:"engine_preference,omitempty"`
	SurrogateVer     string `json:"surrogate_ver,omitempty"`
	BudgetGPUH       *float64       `json:"budget_gpuh,omitempty"`
	CreatedBy        string         `json:"created_by,omitempty"`
}

// PatchRunRequest — engine-svc uses this to advance queued → running → done.
// Nil fields are left unchanged; slices replace; KPIs merge (shallow).
type PatchRunRequest struct {
	Status      *string          `json:"status,omitempty"`
	ProgressPct *float64         `json:"progress_pct,omitempty"`
	KPIs        map[string]any   `json:"kpis,omitempty"`
	Artifacts   []map[string]any `json:"artifacts,omitempty"`
	Boundaries  []map[string]any `json:"boundaries,omitempty"`
	Confidence  *float64         `json:"confidence,omitempty"`
	StartedAt   *string          `json:"started_at,omitempty"`
	FinishedAt  *string          `json:"finished_at,omitempty"`
	LogAppend   string           `json:"log_append,omitempty"` // raw text appended to engine.log
}

type Run struct {
	ID            string          `json:"id"`
	ProjectID     string          `json:"project_id"`
	Kind          string          `json:"kind"`
	Title         string          `json:"title"`
	Status        string          `json:"status"`
	ProgressPct   *float64        `json:"progress_pct,omitempty"`
	InputsHash    string          `json:"inputs_hash"`
	SurrogateVer  *string         `json:"surrogate_ver,omitempty"`
	Confidence    *float64        `json:"confidence,omitempty"`
	ParentRunID   *string         `json:"parent_run_id,omitempty"`
	BudgetGPUH    *float64        `json:"budget_gpuh,omitempty"`
	CostUSD       *float64        `json:"cost_usd,omitempty"`
	StartedAt     *time.Time      `json:"started_at,omitempty"`
	FinishedAt    *time.Time      `json:"finished_at,omitempty"`
	KPIs          json.RawMessage `json:"kpis"`
	Artifacts     json.RawMessage `json:"artifacts"`
	Boundaries    json.RawMessage `json:"boundaries"`
	CreatedBy     *string         `json:"created_by,omitempty"`
	CreatedAt     time.Time       `json:"created_at"`
}

type SpecRef struct {
	Hash       string          `json:"hash"`
	SpecID     string          `json:"spec_id"`
	Kind       string          `json:"kind"`        // hwspec | model | strategy | workload
	Name       string          `json:"name"`
	VersionTag string          `json:"version_tag"` // v3, v4, ...
	Body       json.RawMessage `json:"body"`
	Stale      bool            `json:"stale"`       // true if spec.latest_hash != hash
}

type LineageNode struct {
	Kind   string `json:"kind"`   // run | calibration
	ID     string `json:"id"`
	Title  string `json:"title,omitempty"`
	Status string `json:"status,omitempty"`
	Stale  bool   `json:"stale"`
}

type LineageEdge struct {
	SrcKind string `json:"src_kind"`
	SrcID   string `json:"src_id"`
	DstKind string `json:"dst_kind"`
	DstID   string `json:"dst_id"`
	Rel     string `json:"rel"`
}

type PlanSlot struct {
	Slot    string `json:"slot"`
	RunID   string `json:"run_id"`
	AddedAt string `json:"added_at"`
	Run     *Run   `json:"run,omitempty"` // populated by GetPlan aggregator
}

type Plan struct {
	ID                string     `json:"id"`
	ProjectID         string     `json:"project_id"`
	Name              string     `json:"name"`
	RecommendedRunID  *string    `json:"recommended_run_id,omitempty"`
	CreatedBy         *string    `json:"created_by,omitempty"`
	CreatedAt         string     `json:"created_at"`
	Slots             []PlanSlot `json:"slots"`
}

type CreatePlanRequest struct {
	Name             string  `json:"name"`
	RecommendedRunID *string `json:"recommended_run_id,omitempty"`
	CreatedBy        string  `json:"created_by,omitempty"`
}

type AddSlotRequest struct {
	Slot  string `json:"slot,omitempty"` // optional; empty → next free A..H
	RunID string `json:"run_id"`
}

type Lineage struct {
	Self     LineageNode    `json:"self"`
	Parents  []LineageNode  `json:"parents"`
	Children []LineageNode  `json:"children"`
	Edges    []LineageEdge  `json:"edges"`
}
