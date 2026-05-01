//go:build integration

// Real-Postgres integration tests. Run with:
//   PG_DSN=postgres://bytesim:bytesim@localhost:5432/bytesim \
//   go test -tags=integration ./internal/store/...
//
// Requires the database to already have the migrations applied. Use the
// running docker-compose stack's PG (`make up`).
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bytesim/asset-svc/internal/model"
)

// json.RawMessage is used; suppress unused-import lint for older Go versions.
var _ = json.RawMessage{}

func dsn(t *testing.T) string {
	d := os.Getenv("PG_DSN")
	if d == "" {
		t.Skip("PG_DSN not set; skipping integration test")
	}
	return d
}

func openPG(t *testing.T) *PG {
	t.Helper()
	pg, err := NewPG(context.Background(), dsn(t))
	if err != nil {
		t.Fatalf("NewPG: %v", err)
	}
	t.Cleanup(pg.Close)
	return pg
}

// fixturesNeedHash returns a known-seeded hwspec hash from migration 002.
func fixtureHwspec() string { return "hwspec_topo_b1" }

func TestIntegration_GetLatest_ReturnsSeededHwspec(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()

	got, err := pg.GetLatest(ctx, fixtureHwspec())
	if err != nil {
		t.Fatalf("GetLatest: %v", err)
	}
	if got.Spec.ID != fixtureHwspec() {
		t.Errorf("Spec.ID = %q, want %q", got.Spec.ID, fixtureHwspec())
	}
	if got.Version.Hash == "" {
		t.Errorf("Version.Hash should be populated")
	}
}

func TestIntegration_Snapshot_AddsNewVersion(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()

	body := json.RawMessage(fmt.Sprintf(
		`{"datacenter":{"id":"it-%d","name":"it","clusters":[]},"_marker":"integration-test"}`,
		time.Now().UnixNano(),
	))
	v, err := pg.Snapshot(ctx, fixtureHwspec(), model.SnapshotRequest{Body: body})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if v.Hash == "" || v.SpecID != fixtureHwspec() {
		t.Errorf("Snapshot returned unexpected version: %+v", v)
	}

	// Round-trip: GetVersion should return the same body
	got, err := pg.GetVersion(ctx, v.Hash)
	if err != nil {
		t.Fatalf("GetVersion: %v", err)
	}
	if got.Hash != v.Hash {
		t.Errorf("GetVersion round-trip hash mismatch: %q vs %q", got.Hash, v.Hash)
	}
}

func TestIntegration_ListSpecs_ContainsSeededRows(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	rows, err := pg.ListSpecs(ctx, "hwspec")
	if err != nil {
		t.Fatalf("ListSpecs: %v", err)
	}
	if len(rows) == 0 {
		t.Fatalf("expected ≥1 hwspec, got empty list (migrations not applied?)")
	}
	found := false
	for _, r := range rows {
		if r.ID == fixtureHwspec() {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("hwspec_topo_b1 missing from ListSpecs output")
	}
}

func TestIntegration_Catalog_UpsertGetDelete(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	cpuID := fmt.Sprintf("cpu-it-%d", time.Now().UnixNano())
	body := []byte(`{"vendor":"TestCorp","cores":64}`)

	if err := pg.UpsertCatalog(ctx, "cpu", cpuID, "Test CPU IT", body); err != nil {
		t.Fatalf("UpsertCatalog: %v", err)
	}
	t.Cleanup(func() { _ = pg.DeleteCatalog(ctx, "cpu", cpuID) })

	rows, err := pg.ListCatalog(ctx, "cpu")
	if err != nil {
		t.Fatalf("ListCatalog: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.ID == cpuID && r.Name == "Test CPU IT" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("upserted CPU %q not in ListCatalog response", cpuID)
	}

	// Update path: same id, different name
	if err := pg.UpsertCatalog(ctx, "cpu", cpuID, "Test CPU IT renamed", body); err != nil {
		t.Fatalf("UpsertCatalog (update): %v", err)
	}
	rows, _ = pg.ListCatalog(ctx, "cpu")
	for _, r := range rows {
		if r.ID == cpuID {
			if r.Name != "Test CPU IT renamed" {
				t.Errorf("rename did not persist; got %q", r.Name)
			}
		}
	}

	// Delete path
	if err := pg.DeleteCatalog(ctx, "cpu", cpuID); err != nil {
		t.Fatalf("DeleteCatalog: %v", err)
	}
}

func TestIntegration_Fork_CreatesNewSpec(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	newName := fmt.Sprintf("forked-it-%d", time.Now().UnixNano())
	v, err := pg.Fork(ctx, fixtureHwspec(), model.ForkRequest{NewName: newName})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if v.Spec.ID == fixtureHwspec() {
		t.Errorf("fork should produce a new spec ID; got original %q", v.Spec.ID)
	}
	if v.Spec.Name != newName {
		t.Errorf("forked spec name = %q, want %q", v.Spec.Name, newName)
	}
}

// ── Versions / Diff ────────────────────────────────────────────────────

func TestIntegration_ListVersions_ReturnsHistory(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	versions, err := pg.ListVersions(ctx, fixtureHwspec())
	if err != nil {
		t.Fatalf("ListVersions: %v", err)
	}
	if len(versions) == 0 {
		t.Fatalf("expected ≥1 version, got 0 — migration 002 should seed at least one")
	}
}

func TestIntegration_GetLatest_NotFound(t *testing.T) {
	pg := openPG(t)
	if _, err := pg.GetLatest(context.Background(), "no-such-spec-xyz"); err == nil {
		t.Errorf("expected error on missing spec")
	}
}

// ── Snapshot edge cases ────────────────────────────────────────────────

func TestIntegration_Snapshot_OnUnknownSpec_AutoCreates(t *testing.T) {
	// asset-svc's Snapshot self-creates the bs_spec row when missing
	// (used by frontend bootstrapDefaultSpecs on a freshly-wiped DB).
	pg := openPG(t)
	ctx := context.Background()
	stamp := time.Now().UnixNano()
	specID := fmt.Sprintf("hwspec_it_self_create_%d", stamp)
	// Body must be unique on each run — bs_spec_version PK is the sha1(body),
	// so a constant body collides across reruns.
	body := json.RawMessage(fmt.Sprintf(
		`{"datacenter":{"id":"x","name":"x","clusters":[]},"_marker":%d}`, stamp))
	v, err := pg.Snapshot(ctx, specID, model.SnapshotRequest{Body: body})
	if err != nil {
		t.Fatalf("Snapshot on unknown spec: %v", err)
	}
	if v == nil || v.SpecID != specID {
		t.Errorf("self-create produced unexpected version: %+v", v)
	}
}

// ── Catalog (Resource Ontology) ────────────────────────────────────────

func TestIntegration_CatalogStats_HasCounts(t *testing.T) {
	pg := openPG(t)
	stats, err := pg.CatalogStats(context.Background())
	if err != nil {
		t.Fatalf("CatalogStats: %v", err)
	}
	if stats == nil {
		t.Fatalf("nil stats")
	}
	// Migration 008 + 009 seed resources; total should be > 0 on a populated DB.
	// On a totally empty DB the value is 0 — accept either, just exercise the
	// query path.
	if stats.Total < 0 {
		t.Errorf("Total = %d (negative is impossible)", stats.Total)
	}
}

func TestIntegration_ListResources_AppliesFilter(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	// Default filter: lifecycle=active.
	all, err := pg.ListResources(ctx, ResourceFilter{})
	if err != nil {
		t.Fatalf("ListResources(default): %v", err)
	}
	for _, r := range all {
		if r.Lifecycle != "active" {
			t.Errorf("default filter should include only active, got %q", r.Lifecycle)
		}
	}
	// IncludeRetired bypasses the lifecycle default.
	_, err = pg.ListResources(ctx, ResourceFilter{IncludeRetired: true})
	if err != nil {
		t.Fatalf("ListResources(include retired): %v", err)
	}
	// Filter by kind = gpu.
	gpus, err := pg.ListResources(ctx, ResourceFilter{Kind: "gpu"})
	if err != nil {
		t.Fatalf("ListResources(kind=gpu): %v", err)
	}
	for _, r := range gpus {
		if r.Kind != "gpu" {
			t.Errorf("kind filter leaked %q", r.Kind)
		}
	}
}

func TestIntegration_GetResource_NotFound(t *testing.T) {
	pg := openPG(t)
	_, err := pg.GetResource(context.Background(), "no-such-resource-xyz")
	if err == nil {
		t.Errorf("expected error on missing resource")
	}
}

func TestIntegration_ResourceTree_NotFound(t *testing.T) {
	pg := openPG(t)
	_, err := pg.ResourceTree(context.Background(), "no-such-root-xyz")
	if err == nil {
		t.Errorf("expected error on missing root")
	}
}

func TestIntegration_ResourceTree_Happy(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	// Pick any active resource as a root candidate. Empty DB → skip.
	rows, _ := pg.ListResources(ctx, ResourceFilter{})
	if len(rows) == 0 {
		t.Skip("no resources seeded; ResourceTree happy-path skipped")
	}
	root, err := pg.ResourceTree(ctx, rows[0].ID)
	if err != nil {
		t.Fatalf("ResourceTree(%s): %v", rows[0].ID, err)
	}
	if root.ID != rows[0].ID {
		t.Errorf("returned tree root id = %q, want %q", root.ID, rows[0].ID)
	}
}

func TestIntegration_ListLinks_NoFilters(t *testing.T) {
	pg := openPG(t)
	_, err := pg.ListLinks(context.Background(), "", "", "")
	if err != nil {
		t.Errorf("ListLinks(no filters): %v", err)
	}
}

func TestIntegration_ListLinks_WithFilters(t *testing.T) {
	pg := openPG(t)
	// Apply all three filters simultaneously to exercise the AND chain.
	_, err := pg.ListLinks(context.Background(), "src-a", "dst-b", "infiniband")
	if err != nil {
		t.Errorf("ListLinks(filtered): %v", err)
	}
}

// ── Catalog items (CRUD edge cases) ────────────────────────────────────

func TestIntegration_DeleteCatalog_ReturnsErrNotFound(t *testing.T) {
	pg := openPG(t)
	err := pg.DeleteCatalog(context.Background(), "cpu", "no-such-cpu-xyz")
	if err == nil {
		t.Errorf("delete missing should return error")
	}
}

// ── ResourceTree + attachChildren — seed a 3-level hierarchy ───────────

// seedHierarchy inserts a root → child → grandchild chain into bs_resource.
// All three use a unique stamp suffix so reruns don't collide. Cleanup runs
// even when the test fails.
func seedHierarchy(t *testing.T, pg *PG) (rootID, childID, grandchildID string) {
	t.Helper()
	stamp := time.Now().UnixNano()
	rootID = fmt.Sprintf("it-root-%d", stamp)
	childID = fmt.Sprintf("it-child-%d", stamp)
	grandchildID = fmt.Sprintf("it-gc-%d", stamp)
	ctx := context.Background()
	for _, q := range []struct {
		id, kind string
		parent   *string
	}{
		{rootID, "site", nil},
		{childID, "rack", &rootID},
		{grandchildID, "server", &childID},
	} {
		_, err := pg.pool.Exec(ctx, `
INSERT INTO bs_resource (id, kind, parent_id, attrs, lifecycle, source)
VALUES ($1, $2, $3, '{}'::jsonb, 'active', 'demo')`,
			q.id, q.kind, q.parent)
		if err != nil {
			t.Fatalf("seed %s: %v", q.id, err)
		}
	}
	t.Cleanup(func() {
		// Delete in reverse order to respect FK.
		for _, id := range []string{grandchildID, childID, rootID} {
			_, _ = pg.pool.Exec(ctx, "DELETE FROM bs_resource WHERE id = $1", id)
		}
	})
	return
}

func TestIntegration_ResourceTree_BuildsRecursively(t *testing.T) {
	pg := openPG(t)
	root, child, grandchild := seedHierarchy(t, pg)

	tree, err := pg.ResourceTree(context.Background(), root)
	if err != nil {
		t.Fatalf("ResourceTree: %v", err)
	}
	if tree.ID != root {
		t.Errorf("tree.ID = %q, want %q", tree.ID, root)
	}
	if len(tree.Children) != 1 {
		t.Fatalf("expected 1 child of root, got %d", len(tree.Children))
	}
	got := tree.Children[0]
	if got.ID != child {
		t.Errorf("child id = %q, want %q", got.ID, child)
	}
	if len(got.Children) != 1 {
		t.Fatalf("expected 1 grandchild, got %d", len(got.Children))
	}
	if got.Children[0].ID != grandchild {
		t.Errorf("grandchild id = %q, want %q", got.Children[0].ID, grandchild)
	}
}

func TestIntegration_CatalogStats_AggregatesByKindAndLifecycle(t *testing.T) {
	pg := openPG(t)
	// Seed three rows of a known kind + lifecycle to make the assertion
	// concrete regardless of what migrations 008/009 already inserted.
	_, _, _ = seedHierarchy(t, pg)

	stats, err := pg.CatalogStats(context.Background())
	if err != nil {
		t.Fatalf("CatalogStats: %v", err)
	}
	if stats.Total <= 0 {
		t.Errorf("Total should be > 0 after seed, got %d", stats.Total)
	}
	if stats.ByKind["site"] < 1 || stats.ByKind["rack"] < 1 || stats.ByKind["server"] < 1 {
		t.Errorf("expected ByKind to count seeded kinds: %v", stats.ByKind)
	}
	if stats.ByLifecycle["active"] < 3 {
		t.Errorf("expected ByLifecycle[active] >= 3, got %d", stats.ByLifecycle["active"])
	}
}

// ── Filter-branch coverage for ListResources ────────────────────────────

func TestIntegration_ListResources_FilterByParentAndFailureDomain(t *testing.T) {
	pg := openPG(t)
	root, child, _ := seedHierarchy(t, pg)
	ctx := context.Background()

	// Filter by parent_id — should return exactly the seeded child.
	rows, err := pg.ListResources(ctx, ResourceFilter{ParentID: root})
	if err != nil {
		t.Fatalf("ListResources(ParentID): %v", err)
	}
	found := false
	for _, r := range rows {
		if r.ID == child {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("ParentID filter did not return seeded child %q in result of size %d", child, len(rows))
	}

	// Failure domain filter — exercise the branch even though seeded rows
	// have no failure_domain (filter just shouldn't error).
	if _, err := pg.ListResources(ctx, ResourceFilter{FailureDomain: "rack-A"}); err != nil {
		t.Errorf("ListResources(FailureDomain): %v", err)
	}

	// Multiple lifecycles via explicit list.
	if _, err := pg.ListResources(ctx, ResourceFilter{Lifecycles: []string{"active", "retired"}}); err != nil {
		t.Errorf("ListResources(multiple Lifecycles): %v", err)
	}
}

// ── Snapshot error branches — invalid JSON body ─────────────────────────

func TestIntegration_Snapshot_InvalidJSONBody(t *testing.T) {
	pg := openPG(t)
	specID := fmt.Sprintf("hwspec_invalid_json_%d", time.Now().UnixNano())
	_, err := pg.Snapshot(context.Background(), specID, model.SnapshotRequest{
		Body: []byte("not valid json"),
	})
	if err == nil {
		t.Errorf("expected error on invalid JSON body")
	}
}

// ── Fork from explicit hash ─────────────────────────────────────────────

func TestIntegration_Fork_FromExplicitHash(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	// First snapshot a known body so we have a hash to fork from.
	stamp := time.Now().UnixNano()
	specID := fmt.Sprintf("hwspec_forkfrom_%d", stamp)
	body := []byte(fmt.Sprintf(`{"_marker":%d}`, stamp))
	v, err := pg.Snapshot(ctx, specID, model.SnapshotRequest{Body: body})
	if err != nil {
		t.Fatalf("seed Snapshot: %v", err)
	}
	// Fork from that explicit hash.
	out, err := pg.Fork(ctx, specID, model.ForkRequest{
		NewName:  fmt.Sprintf("forked-from-hash-%d", stamp),
		FromHash: v.Hash,
	})
	if err != nil {
		t.Fatalf("Fork(FromHash): %v", err)
	}
	if out.Spec.ID == specID {
		t.Errorf("fork should produce a new spec id, got original")
	}
}
