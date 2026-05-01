package model

import (
	"encoding/json"
	"time"
)

type Spec struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"`
	Name       string    `json:"name"`
	ProjectID  string    `json:"project_id"`
	LatestHash string    `json:"latest_hash"`
	CreatedAt  time.Time `json:"created_at"`
}

type SpecVersion struct {
	Hash       string          `json:"hash"`
	SpecID     string          `json:"spec_id"`
	ParentHash *string         `json:"parent_hash,omitempty"`
	VersionTag string          `json:"version_tag"`
	Body       json.RawMessage `json:"body"`
	CreatedAt  time.Time       `json:"created_at"`
}

type SpecLatest struct {
	Spec    Spec        `json:"spec"`
	Version SpecVersion `json:"version"`
}

type SnapshotRequest struct {
	Body       json.RawMessage `json:"body"`
	VersionTag string          `json:"version_tag,omitempty"` // optional, defaults to vN+1
	ParentHash string          `json:"parent_hash,omitempty"` // hash being forked from; defaults to latest
}

type ForkRequest struct {
	NewName    string `json:"new_name"`              // required
	FromHash   string `json:"from_hash,omitempty"`   // optional; defaults to source spec's latest_hash
	NewSpecID  string `json:"new_spec_id,omitempty"` // optional; defaults to {source_id}_fork_<rand>
	VersionTag string `json:"version_tag,omitempty"` // optional; defaults to "v1"
}

type DiffEntry struct {
	Path string `json:"path"`              // dotted path; "" = root replaced
	Op   string `json:"op"`                // added | removed | changed
	From any    `json:"from,omitempty"`    // nil for "added"
	To   any    `json:"to,omitempty"`      // nil for "removed"
}

type DiffResult struct {
	From    SpecVersion `json:"from"`
	To      SpecVersion `json:"to"`
	Entries []DiffEntry `json:"entries"`
}

// ── §1 Resource Ontology types ────────────────────────────────────────────

type Resource struct {
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	ParentID       *string         `json:"parent_id,omitempty"`
	VendorSKU      *string         `json:"vendor_sku,omitempty"`
	Attrs          json.RawMessage `json:"attrs"`
	Lifecycle      string          `json:"lifecycle"`
	CostCapexUSD   *float64        `json:"cost_capex_usd,omitempty"`
	PowerWMax      *int            `json:"power_w_max,omitempty"`
	FailureDomain  *string         `json:"failure_domain,omitempty"`
	Source         string          `json:"source"`
}

type Link struct {
	ID     string          `json:"id"`
	SrcID  string          `json:"src_id"`
	DstID  string          `json:"dst_id"`
	Fabric string          `json:"fabric"`
	BWGbps float64         `json:"bw_gbps"`
	RTTUs  *float64        `json:"rtt_us,omitempty"`
	Attrs  json.RawMessage `json:"attrs"`
	Source string          `json:"source"`
}

// ResourceTreeNode is a Resource with its children inlined for the catalog
// /tree response.
type ResourceTreeNode struct {
	Resource
	Children []ResourceTreeNode `json:"children"`
}

type CatalogStats struct {
	Total       int            `json:"total"`
	ByKind      map[string]int `json:"by_kind"`
	ByLifecycle map[string]int `json:"by_lifecycle"`
}

// CatalogItem — generic key-value entry stored in bs_catalog. The body
// JSONB is interpreted by the frontend per kind (硬件部件 / sim preset).
type CatalogItem struct {
	Kind string          `json:"kind"`
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Body json.RawMessage `json:"body"`
}

type UpsertCatalogRequest struct {
	ID   string          `json:"id"`            // optional on POST; required on PUT
	Name string          `json:"name"`
	Body json.RawMessage `json:"body"`
}
