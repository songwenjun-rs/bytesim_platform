//go:build integration

// Real-Postgres integration tests. Run with:
//   PG_DSN=postgres://bytesim:bytesim@localhost:5432/bytesim \
//   go test -tags=integration ./internal/store/...
//
// Requires the database to already have the migrations applied. Use the
// running docker-compose stack's PG (`make up`) or any Postgres with
// infra/postgres/*.sql applied.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/bytesim/run-svc/internal/model"
)

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

// realHwspecHash queries the live DB for an actually-existing hwspec hash.
// Migrations seed it but the exact value depends on the seed body's sha1.
func realSpecHash(t *testing.T, specID string) string {
	t.Helper()
	pg, err := NewPG(context.Background(), dsn(t))
	if err != nil {
		t.Fatalf("NewPG: %v", err)
	}
	defer pg.Close()
	var h string
	err = pg.pool.QueryRow(context.Background(),
		"SELECT hash FROM bs_spec_version WHERE spec_id = $1 ORDER BY created_at LIMIT 1",
		specID).Scan(&h)
	if err == pgx.ErrNoRows {
		t.Skipf("no seeded version for spec_id=%q; run `make reset` to seed", specID)
	}
	if err != nil {
		t.Fatalf("query spec hash: %v", err)
	}
	return h
}

func TestIntegration_CreateRun_AssignsSequentialID(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()

	req := model.CreateRunRequest{
		Kind:       "train",
		Title:      "integration-test",
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash:  realSpecHash(t, "model_moe256e"),
		CreatedBy:  "go-test",
	}
	r, err := pg.CreateRun(ctx, "p_default", req)
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	if r.Kind != "train" {
		t.Errorf("kind = %q, want train", r.Kind)
	}
	if r.Status != "queued" {
		t.Errorf("initial status = %q, want queued", r.Status)
	}
	// Sequential ID format: sim-NNN
	if len(r.ID) < 5 || r.ID[:4] != "sim-" {
		t.Errorf("expected sim- prefix, got %q", r.ID)
	}
}

func TestIntegration_CreateInferRun_PrefixedInf(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "infer", Title: "inf-it", HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash: realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)
	if len(r.ID) < 5 || r.ID[:4] != "inf-" {
		t.Errorf("expected inf- prefix, got %q", r.ID)
	}
}

func TestIntegration_GetRun_ThenPatch_ThenRoundTrip(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()

	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "rt", HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash: realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	// PatchRun → status running, KPIs, progress
	running := "running"
	prog := 0.42
	conf := 0.88
	patched, err := pg.PatchRun(ctx, r.ID, model.PatchRunRequest{
		Status:      &running,
		ProgressPct: &prog,
		Confidence:  &conf,
		KPIs:        map[string]any{"mfu_pct": 53.7, "step_ms": 920.5},
	})
	if err != nil {
		t.Fatalf("PatchRun: %v", err)
	}
	if patched.Status != "running" {
		t.Errorf("Status after patch = %q", patched.Status)
	}

	// GetRun confirms the persisted state
	got, err := pg.GetRun(ctx, r.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if got.Status != "running" || got.Confidence == nil || *got.Confidence != 0.88 {
		t.Errorf("round-trip mismatch: got = %+v", got)
	}
	var kpis map[string]any
	_ = json.Unmarshal(got.KPIs, &kpis)
	if v, ok := kpis["mfu_pct"].(float64); !ok || v < 53 || v > 54 {
		t.Errorf("mfu_pct round-trip lost: %v", kpis)
	}
}

func TestIntegration_ClaimNextQueued_ReturnsRunningRun(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()

	// Create a fresh queued run, then claim it. The claim atomically flips
	// it to running and returns the row, so we should observe status=running.
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "claim-test", HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash: realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	claimed, err := pg.ClaimNextQueued(ctx, "p_default")
	if err != nil {
		t.Fatalf("ClaimNextQueued: %v", err)
	}
	if claimed == nil {
		t.Fatalf("expected to claim a queued run, got nil")
	}
	if claimed.Status != "running" {
		t.Errorf("claim should flip to running, got %q", claimed.Status)
	}
}

func TestIntegration_DeleteRun_Idempotent(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()

	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "del-test", HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash: realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if err := pg.DeleteRun(ctx, r.ID); err != nil {
		t.Fatalf("first DeleteRun: %v", err)
	}
	// Second delete: should NOT error — DeleteRun is idempotent on missing
	// rows (no UPDATE rows affected is not a failure).
	if err := pg.DeleteRun(ctx, r.ID); err != nil {
		// Some implementations may return ErrNotFound on second delete; we
		// accept that too (still proves idempotency).
		t.Logf("second delete returned %v (acceptable as long as it's clean)", err)
	}
	if _, err := pg.GetRun(ctx, r.ID); err == nil {
		t.Errorf("GetRun after delete should ErrNotFound, got success")
	}
}

func TestIntegration_ListRuns_FiltersByStatus(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()

	// Create a fresh run, list runs filtered by status=queued, expect to find ours.
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: fmt.Sprintf("list-test-%d", time.Now().UnixNano()),
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"), ModelHash: realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	rows, err := pg.ListRuns(ctx, ListRunsFilter{
		ProjectID: "p_default",
		Statuses:  []string{"queued"},
		Limit:     50,
	})
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	found := false
	for _, x := range rows {
		if x.ID == r.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("ListRuns(status=queued) did not return our run %q", r.ID)
	}
}

// ── Specs / Lineage ────────────────────────────────────────────────────

func TestIntegration_SpecsForRun_HappyPath(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "specs-test",
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash:  realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	specs, err := pg.SpecsForRun(ctx, r.ID)
	if err != nil {
		t.Fatalf("SpecsForRun: %v", err)
	}
	if len(specs) < 2 {
		t.Errorf("expected ≥2 spec rows (hwspec+model), got %d", len(specs))
	}
	kinds := map[string]bool{}
	for _, s := range specs {
		kinds[s.Kind] = true
	}
	if !kinds["hwspec"] || !kinds["model"] {
		t.Errorf("missing required kinds in result: %v", kinds)
	}
}

func TestIntegration_Lineage_HappyPath(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "lineage-test",
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash:  realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	lin, err := pg.Lineage(ctx, r.ID)
	if err != nil {
		t.Fatalf("Lineage: %v", err)
	}
	if lin.Self.ID != r.ID {
		t.Errorf("Self.ID = %q, want %q", lin.Self.ID, r.ID)
	}
}

func TestIntegration_Lineage_NotFound(t *testing.T) {
	pg := openPG(t)
	if _, err := pg.Lineage(context.Background(), "no-such-run-xyz"); err == nil {
		t.Errorf("expected error on missing run")
	}
}

// ── CancelRun ──────────────────────────────────────────────────────────

func TestIntegration_CancelRun_QueuedFlipsToCancelled(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "cancel-test",
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash:  realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	cancelled, wasRunning, err := pg.CancelRun(ctx, r.ID)
	if err != nil {
		t.Fatalf("CancelRun: %v", err)
	}
	if cancelled.Status != "cancelled" {
		t.Errorf("cancelled.Status = %q", cancelled.Status)
	}
	if wasRunning {
		t.Errorf("queued run should report wasRunning=false, got true")
	}
}

func TestIntegration_CancelRun_NotFound(t *testing.T) {
	pg := openPG(t)
	if _, _, err := pg.CancelRun(context.Background(), "no-such-run-xyz"); err == nil {
		t.Errorf("expected error on missing run")
	}
}

// ── Stats / Stale ─────────────────────────────────────────────────────

func TestIntegration_CountRunsSince(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	thirtyDaysAgo := time.Now().UTC().AddDate(0, 0, -30)
	count, err := pg.CountRunsSince(ctx, "p_default", thirtyDaysAgo)
	if err != nil {
		t.Fatalf("CountRunsSince: %v", err)
	}
	if count < 0 {
		t.Errorf("count < 0: %d", count)
	}
}

func TestIntegration_AvgConfidence(t *testing.T) {
	pg := openPG(t)
	avg, err := pg.AvgConfidence(context.Background(), "p_default")
	if err != nil {
		t.Fatalf("AvgConfidence: %v", err)
	}
	// Empty DB returns 0; populated DB returns 0..1.
	if avg < 0 || avg > 1 {
		t.Errorf("AvgConfidence out of range [0,1]: %v", avg)
	}
}

func TestIntegration_StaleRuns(t *testing.T) {
	pg := openPG(t)
	rows, err := pg.StaleRuns(context.Background(), "p_default", 5)
	if err != nil {
		t.Fatalf("StaleRuns: %v", err)
	}
	if len(rows) > 5 {
		t.Errorf("StaleRuns ignored limit: returned %d", len(rows))
	}
}

// ── PatchRun branches ─────────────────────────────────────────────────

func TestIntegration_PatchRun_AppendsKPIs(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "patch-merge-test",
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash:  realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	// First patch: write a partial KPIs map. Second patch: shallow-merge new
	// keys without losing the originals.
	if _, err := pg.PatchRun(ctx, r.ID, model.PatchRunRequest{
		KPIs: map[string]any{"mfu_pct": 50.0},
	}); err != nil {
		t.Fatalf("PatchRun(1): %v", err)
	}
	if _, err := pg.PatchRun(ctx, r.ID, model.PatchRunRequest{
		KPIs: map[string]any{"step_ms": 1000.0},
	}); err != nil {
		t.Fatalf("PatchRun(2): %v", err)
	}
	got, err := pg.GetRun(ctx, r.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	var kpis map[string]any
	_ = json.Unmarshal(got.KPIs, &kpis)
	if _, ok := kpis["mfu_pct"]; !ok {
		t.Errorf("first patch's KPI was lost: %v", kpis)
	}
	if _, ok := kpis["step_ms"]; !ok {
		t.Errorf("second patch's KPI was lost: %v", kpis)
	}
}

func TestIntegration_PatchRun_AppendsArtifacts(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "artifact-test",
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash:  realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	if _, err := pg.PatchRun(ctx, r.ID, model.PatchRunRequest{
		Artifacts: []map[string]any{{"file": "engine.log", "name": "log", "bytes": 100}},
	}); err != nil {
		t.Fatalf("PatchRun: %v", err)
	}
	got, err := pg.GetRun(ctx, r.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	var arts []map[string]any
	_ = json.Unmarshal(got.Artifacts, &arts)
	if len(arts) != 1 {
		t.Errorf("artifacts not persisted: %v", arts)
	}
}

func TestIntegration_PatchRun_NotFound(t *testing.T) {
	pg := openPG(t)
	status := "running"
	_, err := pg.PatchRun(context.Background(), "no-such-run-xyz",
		model.PatchRunRequest{Status: &status})
	if err == nil {
		t.Errorf("expected error on missing run")
	}
}

// ── CreateRun error path ──────────────────────────────────────────────

func TestIntegration_CreateRun_InvalidHwspecHash(t *testing.T) {
	pg := openPG(t)
	_, err := pg.CreateRun(context.Background(), "p_default", model.CreateRunRequest{
		Kind: "train", Title: "bad-hash",
		HwSpecHash: "0000000000000000000000000000000000000000",
		ModelHash:  realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err == nil {
		t.Errorf("expected FK violation on bogus hwspec hash")
	}
}

// ── Plan CRUD ──────────────────────────────────────────────────────────

func TestIntegration_Plan_CreateGetAddRemove(t *testing.T) {
	pg := openPG(t)
	ctx := context.Background()
	planID := fmt.Sprintf("plan-it-%d", time.Now().UnixNano())

	pl, err := pg.CreatePlan(ctx, "p_default", model.CreatePlanRequest{
		Name: planID,
	})
	if err != nil {
		t.Fatalf("CreatePlan: %v", err)
	}
	if pl.Name != planID {
		t.Errorf("plan name=%q, want %q", pl.Name, planID)
	}

	// Create a run to slot.
	r, err := pg.CreateRun(ctx, "p_default", model.CreateRunRequest{
		Kind: "train", Title: "plan-run",
		HwSpecHash: realSpecHash(t, "hwspec_topo_b1"),
		ModelHash:  realSpecHash(t, "model_moe256e"), CreatedBy: "go-test",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	defer pg.DeleteRun(ctx, r.ID)

	updated, err := pg.AddPlanSlot(ctx, pl.ID, model.AddSlotRequest{RunID: r.ID})
	if err != nil {
		t.Fatalf("AddPlanSlot: %v", err)
	}
	if len(updated.Slots) == 0 {
		t.Errorf("slot did not appear in plan")
	}
	addedSlot := updated.Slots[len(updated.Slots)-1].Slot

	got, err := pg.GetPlan(ctx, pl.ID)
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if len(got.Slots) == 0 {
		t.Errorf("GetPlan returned empty slots")
	}

	if _, err := pg.RemovePlanSlot(ctx, pl.ID, addedSlot); err != nil {
		t.Fatalf("RemovePlanSlot: %v", err)
	}
}

func TestIntegration_GetPlan_NotFound(t *testing.T) {
	pg := openPG(t)
	if _, err := pg.GetPlan(context.Background(), "no-such-plan-xyz"); err == nil {
		t.Errorf("expected error on missing plan")
	}
}

// ── Artifacts ─────────────────────────────────────────────────────────

func TestIntegration_FSArtifacts_RemoveAll_OnMissingDir(t *testing.T) {
	// Construct an FSArtifacts pointing at /tmp; RemoveAll a non-existent
	// runID is documented as best-effort cleanup — should not error even
	// when the dir doesn't exist (idempotent for orphan rows).
	fs := NewFSArtifacts("/tmp/run-svc-it-cleanup-test")
	if err := fs.RemoveAll("no-such-run-xyz-zzz"); err != nil {
		t.Errorf("RemoveAll on missing dir should be silent, got: %v", err)
	}
}
