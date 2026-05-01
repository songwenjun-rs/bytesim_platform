package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bytesim/run-svc/internal/model"
	"github.com/bytesim/run-svc/internal/store"
)

// ── Mock Store ─────────────────────────────────────────────────────────
//
// fakeStore implements the api.Store interface. Each method returns the
// corresponding fake* field. Tests set the fields they care about.

type fakeStore struct {
	getRun           func(string) (*model.Run, error)
	specsForRun      func(string) ([]model.SpecRef, error)
	lineage          func(string) (*model.Lineage, error)
	createRun        func(string, model.CreateRunRequest) (*model.Run, error)
	deleteRun        func(string) error
	claimNext        func(string) (*model.Run, error)
	cancelRun        func(string) (*model.Run, bool, error)
	patchRun         func(string, model.PatchRunRequest) (*model.Run, error)
	listRuns         func(store.ListRunsFilter) ([]model.Run, error)
	countRunsSince   func(string, time.Time) (int, error)
	avgConfidence    func(string) (float64, error)
	staleRuns        func(string, int) ([]model.Run, error)
	getPlan          func(string) (*model.Plan, error)
	createPlan       func(string, model.CreatePlanRequest) (*model.Plan, error)
	addPlanSlot      func(string, model.AddSlotRequest) (*model.Plan, error)
	removePlanSlot   func(string, string) (*model.Plan, error)
}

func (f *fakeStore) GetRun(_ context.Context, id string) (*model.Run, error) {
	return f.getRun(id)
}
func (f *fakeStore) SpecsForRun(_ context.Context, runID string) ([]model.SpecRef, error) {
	return f.specsForRun(runID)
}
func (f *fakeStore) Lineage(_ context.Context, runID string) (*model.Lineage, error) {
	return f.lineage(runID)
}
func (f *fakeStore) CreateRun(_ context.Context, projectID string, req model.CreateRunRequest) (*model.Run, error) {
	return f.createRun(projectID, req)
}
func (f *fakeStore) DeleteRun(_ context.Context, id string) error {
	return f.deleteRun(id)
}
func (f *fakeStore) ClaimNextQueued(_ context.Context, projectID string) (*model.Run, error) {
	return f.claimNext(projectID)
}
func (f *fakeStore) CancelRun(_ context.Context, runID string) (*model.Run, bool, error) {
	return f.cancelRun(runID)
}
func (f *fakeStore) PatchRun(_ context.Context, runID string, req model.PatchRunRequest) (*model.Run, error) {
	return f.patchRun(runID, req)
}
func (f *fakeStore) ListRuns(_ context.Context, filter store.ListRunsFilter) ([]model.Run, error) {
	return f.listRuns(filter)
}
func (f *fakeStore) CountRunsSince(_ context.Context, projectID string, since time.Time) (int, error) {
	return f.countRunsSince(projectID, since)
}
func (f *fakeStore) AvgConfidence(_ context.Context, projectID string) (float64, error) {
	return f.avgConfidence(projectID)
}
func (f *fakeStore) StaleRuns(_ context.Context, projectID string, limit int) ([]model.Run, error) {
	return f.staleRuns(projectID, limit)
}
func (f *fakeStore) GetPlan(_ context.Context, planID string) (*model.Plan, error) {
	return f.getPlan(planID)
}
func (f *fakeStore) CreatePlan(_ context.Context, projectID string, req model.CreatePlanRequest) (*model.Plan, error) {
	return f.createPlan(projectID, req)
}
func (f *fakeStore) AddPlanSlot(_ context.Context, planID string, req model.AddSlotRequest) (*model.Plan, error) {
	return f.addPlanSlot(planID, req)
}
func (f *fakeStore) RemovePlanSlot(_ context.Context, planID, slot string) (*model.Plan, error) {
	return f.removePlanSlot(planID, slot)
}

// ── Mock ArtifactStore ─────────────────────────────────────────────────

type fakeArtifacts struct {
	openFn      func(runID, name string) (io.ReadCloser, int64, error)
	removeAllFn func(runID string) error
	appendLogFn func(runID, line string) error

	appendCalls []string // captured for assertions
	removeCalls []string
}

func (f *fakeArtifacts) Open(runID, name string) (io.ReadCloser, int64, error) {
	if f.openFn == nil {
		return nil, 0, errors.New("not configured")
	}
	return f.openFn(runID, name)
}
func (f *fakeArtifacts) RemoveAll(runID string) error {
	f.removeCalls = append(f.removeCalls, runID)
	if f.removeAllFn == nil {
		return nil
	}
	return f.removeAllFn(runID)
}
func (f *fakeArtifacts) AppendLog(runID, line string) error {
	f.appendCalls = append(f.appendCalls, runID+":"+line)
	if f.appendLogFn == nil {
		return nil
	}
	return f.appendLogFn(runID, line)
}

func mkServer(t *testing.T) (*Server, *fakeStore, *fakeArtifacts) {
	t.Helper()
	fs := &fakeStore{}
	fa := &fakeArtifacts{}
	return &Server{PG: fs, Artifacts: fa}, fs, fa
}

func mkRun(id, status string) *model.Run {
	return &model.Run{
		ID: id, ProjectID: "p_default", Kind: "train", Title: "t",
		Status: status, InputsHash: "h",
		KPIs: json.RawMessage("{}"), Artifacts: json.RawMessage("[]"),
		Boundaries: json.RawMessage("[]"), CreatedAt: time.Now().UTC(),
	}
}

func decodeJSON(t *testing.T, w *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), into); err != nil {
		t.Fatalf("decode body %q: %v", w.Body.String(), err)
	}
}

// ── getRun ─────────────────────────────────────────────────────────────

func TestGetRun_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.getRun = func(id string) (*model.Run, error) {
		if id != "sim-1" {
			t.Errorf("unexpected id %q", id)
		}
		return mkRun("sim-1", "done"), nil
	}
	req := httptest.NewRequest("GET", "/v1/runs/sim-1", nil)
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.getRun(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
	var r model.Run
	decodeJSON(t, w, &r)
	if r.ID != "sim-1" {
		t.Errorf("id=%q", r.ID)
	}
}

func TestGetRun_NotFound(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.getRun = func(string) (*model.Run, error) { return nil, store.ErrNotFound }
	req := httptest.NewRequest("GET", "/v1/runs/missing", nil)
	req.SetPathValue("id", "missing")
	w := httptest.NewRecorder()
	s.getRun(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetRun_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.getRun = func(string) (*model.Run, error) { return nil, errors.New("pg down") }
	req := httptest.NewRequest("GET", "/v1/runs/x", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getRun(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── getSpecs / getLineage ──────────────────────────────────────────────

func TestGetSpecs_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.specsForRun = func(string) ([]model.SpecRef, error) {
		return []model.SpecRef{{Hash: "h1", SpecID: "hwspec_topo_b1"}}, nil
	}
	req := httptest.NewRequest("GET", "/v1/runs/sim-1/specs", nil)
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.getSpecs(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetSpecs_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.specsForRun = func(string) ([]model.SpecRef, error) { return nil, errors.New("boom") }
	req := httptest.NewRequest("GET", "/v1/runs/sim-1/specs", nil)
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.getSpecs(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetLineage_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.lineage = func(string) (*model.Lineage, error) {
		return &model.Lineage{Self: model.LineageNode{Kind: "run", ID: "sim-1"}}, nil
	}
	req := httptest.NewRequest("GET", "/v1/runs/sim-1/lineage", nil)
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.getLineage(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetLineage_NotFound(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.lineage = func(string) (*model.Lineage, error) { return nil, store.ErrNotFound }
	req := httptest.NewRequest("GET", "/v1/runs/x/lineage", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getLineage(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── claimNext ──────────────────────────────────────────────────────────

func TestClaimNext_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.claimNext = func(p string) (*model.Run, error) {
		if p != "p_default" {
			t.Errorf("default project not propagated, got %q", p)
		}
		return mkRun("sim-7", "running"), nil
	}
	req := httptest.NewRequest("POST", "/v1/runs/claim", nil)
	w := httptest.NewRecorder()
	s.claimNext(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestClaimNext_EmptyQueue_204(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.claimNext = func(string) (*model.Run, error) { return nil, store.ErrNotFound }
	req := httptest.NewRequest("POST", "/v1/runs/claim?project=p_lab", nil)
	w := httptest.NewRecorder()
	s.claimNext(w, req)
	if w.Code != 204 {
		t.Errorf("code=%d, want 204", w.Code)
	}
}

func TestClaimNext_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.claimNext = func(string) (*model.Run, error) { return nil, errors.New("boom") }
	req := httptest.NewRequest("POST", "/v1/runs/claim", nil)
	w := httptest.NewRecorder()
	s.claimNext(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── cancelRun ──────────────────────────────────────────────────────────

func TestCancelRun_Happy_AppendsLog(t *testing.T) {
	s, fs, fa := mkServer(t)
	fs.cancelRun = func(id string) (*model.Run, bool, error) {
		return mkRun(id, "cancelled"), true, nil
	}
	req := httptest.NewRequest("POST", "/v1/runs/sim-1/cancel", nil)
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.cancelRun(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
	if len(fa.appendCalls) != 1 || !strings.HasPrefix(fa.appendCalls[0], "sim-1:") {
		t.Errorf("expected one AppendLog call for sim-1, got %v", fa.appendCalls)
	}
}

func TestCancelRun_NotFound(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.cancelRun = func(string) (*model.Run, bool, error) { return nil, false, store.ErrNotFound }
	req := httptest.NewRequest("POST", "/v1/runs/x/cancel", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.cancelRun(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestCancelRun_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.cancelRun = func(string) (*model.Run, bool, error) { return nil, false, errors.New("boom") }
	req := httptest.NewRequest("POST", "/v1/runs/x/cancel", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.cancelRun(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── deleteRun ──────────────────────────────────────────────────────────

func TestDeleteRun_Happy_ClearsArtifacts(t *testing.T) {
	s, fs, fa := mkServer(t)
	fs.deleteRun = func(id string) error {
		if id != "sim-x" {
			t.Errorf("unexpected id %q", id)
		}
		return nil
	}
	req := httptest.NewRequest("DELETE", "/v1/runs/sim-x", nil)
	req.SetPathValue("id", "sim-x")
	w := httptest.NewRecorder()
	s.deleteRun(w, req)
	if w.Code != 204 {
		t.Errorf("code=%d", w.Code)
	}
	if len(fa.removeCalls) != 1 || fa.removeCalls[0] != "sim-x" {
		t.Errorf("expected RemoveAll(sim-x), got %v", fa.removeCalls)
	}
}

func TestDeleteRun_NotFound(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.deleteRun = func(string) error { return store.ErrNotFound }
	req := httptest.NewRequest("DELETE", "/v1/runs/x", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.deleteRun(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDeleteRun_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.deleteRun = func(string) error { return errors.New("boom") }
	req := httptest.NewRequest("DELETE", "/v1/runs/x", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.deleteRun(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDeleteRun_DiskFailure_StillSucceeds(t *testing.T) {
	// PG row is gone; FS leftover is logged + ignored. Endpoint stays 204.
	s, fs, fa := mkServer(t)
	fs.deleteRun = func(string) error { return nil }
	fa.removeAllFn = func(string) error { return errors.New("disk full") }
	req := httptest.NewRequest("DELETE", "/v1/runs/sim-x", nil)
	req.SetPathValue("id", "sim-x")
	w := httptest.NewRecorder()
	s.deleteRun(w, req)
	if w.Code != 204 {
		t.Errorf("code=%d (disk failure must be silent), body=%s", w.Code, w.Body.String())
	}
}

// ── patchRun ───────────────────────────────────────────────────────────

func TestPatchRun_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.patchRun = func(id string, req model.PatchRunRequest) (*model.Run, error) {
		if req.Status == nil || *req.Status != "running" {
			t.Errorf("status not propagated: %+v", req)
		}
		return mkRun(id, "running"), nil
	}
	body := `{"status":"running","progress_pct":0.42}`
	req := httptest.NewRequest("PATCH", "/v1/runs/sim-1", bytes.NewBufferString(body))
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.patchRun(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestPatchRun_LogAppend_FiresArtifact(t *testing.T) {
	s, fs, fa := mkServer(t)
	fs.patchRun = func(id string, _ model.PatchRunRequest) (*model.Run, error) {
		return mkRun(id, "running"), nil
	}
	body := `{"log_append":"[10:00:00] ENGINE step 1"}`
	req := httptest.NewRequest("PATCH", "/v1/runs/sim-1", bytes.NewBufferString(body))
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.patchRun(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
	if len(fa.appendCalls) != 1 {
		t.Errorf("expected AppendLog call, got %v", fa.appendCalls)
	}
}

func TestPatchRun_BadJSON_400(t *testing.T) {
	s, _, _ := mkServer(t)
	req := httptest.NewRequest("PATCH", "/v1/runs/x", bytes.NewBufferString("not json"))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.patchRun(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestPatchRun_NotFound(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.patchRun = func(string, model.PatchRunRequest) (*model.Run, error) {
		return nil, store.ErrNotFound
	}
	req := httptest.NewRequest("PATCH", "/v1/runs/x", bytes.NewBufferString("{}"))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.patchRun(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestPatchRun_400OnStoreError(t *testing.T) {
	// non-NotFound errors map to 400 (clients usually pass invalid status / kpis).
	s, fs, _ := mkServer(t)
	fs.patchRun = func(string, model.PatchRunRequest) (*model.Run, error) {
		return nil, errors.New("invalid status")
	}
	req := httptest.NewRequest("PATCH", "/v1/runs/x", bytes.NewBufferString("{}"))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.patchRun(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── listRuns / listStaleRuns / runStats ─────────────────────────────────

func TestListRuns_AppliesQueryFilters(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.listRuns = func(f store.ListRunsFilter) ([]model.Run, error) {
		// Query parsing must populate Statuses/Kinds/Limit; Project default
		// is "p_default".
		if f.ProjectID != "p_lab" {
			t.Errorf("project=%q", f.ProjectID)
		}
		if len(f.Statuses) != 2 || f.Statuses[0] != "queued" || f.Statuses[1] != "running" {
			t.Errorf("statuses=%v", f.Statuses)
		}
		if f.Limit != 5 {
			t.Errorf("limit=%d", f.Limit)
		}
		return []model.Run{*mkRun("sim-1", "running")}, nil
	}
	req := httptest.NewRequest("GET", "/v1/runs?project=p_lab&status=queued,running&limit=5", nil)
	w := httptest.NewRecorder()
	s.listRuns(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListRuns_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.listRuns = func(store.ListRunsFilter) ([]model.Run, error) {
		return nil, errors.New("boom")
	}
	req := httptest.NewRequest("GET", "/v1/runs", nil)
	w := httptest.NewRecorder()
	s.listRuns(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListStaleRuns_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.staleRuns = func(p string, limit int) ([]model.Run, error) {
		if limit != 7 {
			t.Errorf("limit not propagated: %d", limit)
		}
		return []model.Run{*mkRun("sim-stale", "running")}, nil
	}
	req := httptest.NewRequest("GET", "/v1/runs-stale?limit=7", nil)
	w := httptest.NewRecorder()
	s.listStaleRuns(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListStaleRuns_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.staleRuns = func(string, int) ([]model.Run, error) { return nil, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/runs-stale", nil)
	w := httptest.NewRecorder()
	s.listStaleRuns(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestRunStats_AggregatesCountAndConfidence(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.countRunsSince = func(p string, since time.Time) (int, error) {
		if p != "p_default" {
			t.Errorf("project=%q", p)
		}
		return 17, nil
	}
	fs.avgConfidence = func(string) (float64, error) { return 0.873, nil }
	req := httptest.NewRequest("GET", "/v1/runs-stats", nil)
	w := httptest.NewRecorder()
	s.runStats(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
	var got map[string]any
	decodeJSON(t, w, &got)
	if got["runs_last_30d"].(float64) != 17 {
		t.Errorf("runs_last_30d=%v", got["runs_last_30d"])
	}
	if got["avg_confidence"].(float64) != 0.873 {
		t.Errorf("avg_confidence=%v", got["avg_confidence"])
	}
}

func TestRunStats_500OnCountError(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.countRunsSince = func(string, time.Time) (int, error) { return 0, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/runs-stats", nil)
	w := httptest.NewRecorder()
	s.runStats(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestRunStats_500OnConfidenceError(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.countRunsSince = func(string, time.Time) (int, error) { return 1, nil }
	fs.avgConfidence = func(string) (float64, error) { return 0, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/runs-stats", nil)
	w := httptest.NewRecorder()
	s.runStats(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── createRun ──────────────────────────────────────────────────────────

func TestCreateRun_Happy_201(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.createRun = func(projectID string, req model.CreateRunRequest) (*model.Run, error) {
		if projectID != "p_default" {
			t.Errorf("project=%q", projectID)
		}
		if req.Kind != "train" {
			t.Errorf("kind=%q", req.Kind)
		}
		return mkRun("sim-new", "queued"), nil
	}
	body := `{"kind":"train","title":"x","hwspec_hash":"h","model_hash":"m","created_by":"alice"}`
	req := httptest.NewRequest("POST", "/v1/runs", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	s.createRun(w, req)
	if w.Code != 201 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestCreateRun_BadJSON_400(t *testing.T) {
	s, _, _ := mkServer(t)
	req := httptest.NewRequest("POST", "/v1/runs", bytes.NewBufferString("not json"))
	w := httptest.NewRecorder()
	s.createRun(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestCreateRun_StoreError_400(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.createRun = func(string, model.CreateRunRequest) (*model.Run, error) {
		return nil, errors.New("invalid hash")
	}
	req := httptest.NewRequest("POST", "/v1/runs", bytes.NewBufferString(`{"kind":"train"}`))
	w := httptest.NewRecorder()
	s.createRun(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── plan handlers ──────────────────────────────────────────────────────

func mkPlan(id string, slots int) *model.Plan {
	out := &model.Plan{
		ID: id, ProjectID: "p_default", Name: "demo",
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Slots:     []model.PlanSlot{},
	}
	for i := 0; i < slots; i++ {
		out.Slots = append(out.Slots, model.PlanSlot{
			Slot: string(rune('A' + i)), RunID: "sim-x",
		})
	}
	return out
}

func TestGetPlan_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.getPlan = func(id string) (*model.Plan, error) {
		if id != "plan-1" {
			t.Errorf("id=%q", id)
		}
		return mkPlan(id, 0), nil
	}
	req := httptest.NewRequest("GET", "/v1/plans/plan-1", nil)
	req.SetPathValue("id", "plan-1")
	w := httptest.NewRecorder()
	s.getPlan(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetPlan_NotFound(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.getPlan = func(string) (*model.Plan, error) { return nil, store.ErrNotFound }
	req := httptest.NewRequest("GET", "/v1/plans/x", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getPlan(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetPlan_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.getPlan = func(string) (*model.Plan, error) { return nil, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/plans/x", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getPlan(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestCreatePlan_Happy_201(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.createPlan = func(p string, req model.CreatePlanRequest) (*model.Plan, error) {
		if req.Name != "weekly" {
			t.Errorf("name=%q", req.Name)
		}
		return mkPlan("plan-new", 0), nil
	}
	req := httptest.NewRequest("POST", "/v1/plans", bytes.NewBufferString(`{"name":"weekly"}`))
	w := httptest.NewRecorder()
	s.createPlan(w, req)
	if w.Code != 201 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestCreatePlan_BadJSON_400(t *testing.T) {
	s, _, _ := mkServer(t)
	req := httptest.NewRequest("POST", "/v1/plans", bytes.NewBufferString("not json"))
	w := httptest.NewRecorder()
	s.createPlan(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestCreatePlan_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.createPlan = func(string, model.CreatePlanRequest) (*model.Plan, error) {
		return nil, errors.New("x")
	}
	req := httptest.NewRequest("POST", "/v1/plans", bytes.NewBufferString(`{"name":"x"}`))
	w := httptest.NewRecorder()
	s.createPlan(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestAddPlanSlot_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.addPlanSlot = func(planID string, req model.AddSlotRequest) (*model.Plan, error) {
		if req.RunID != "sim-1" {
			t.Errorf("run_id=%q", req.RunID)
		}
		return mkPlan(planID, 1), nil
	}
	req := httptest.NewRequest("POST", "/v1/plans/p1/slots",
		bytes.NewBufferString(`{"run_id":"sim-1"}`))
	req.SetPathValue("id", "p1")
	w := httptest.NewRecorder()
	s.addPlanSlot(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestAddPlanSlot_BadJSON_400(t *testing.T) {
	s, _, _ := mkServer(t)
	req := httptest.NewRequest("POST", "/v1/plans/p1/slots", bytes.NewBufferString("nope"))
	req.SetPathValue("id", "p1")
	w := httptest.NewRecorder()
	s.addPlanSlot(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestAddPlanSlot_400OnStoreError(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.addPlanSlot = func(string, model.AddSlotRequest) (*model.Plan, error) {
		return nil, errors.New("plan full")
	}
	req := httptest.NewRequest("POST", "/v1/plans/p1/slots",
		bytes.NewBufferString(`{"run_id":"sim-1"}`))
	req.SetPathValue("id", "p1")
	w := httptest.NewRecorder()
	s.addPlanSlot(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestRemovePlanSlot_Happy(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.removePlanSlot = func(planID, slot string) (*model.Plan, error) {
		if slot != "B" {
			t.Errorf("slot=%q", slot)
		}
		return mkPlan(planID, 0), nil
	}
	req := httptest.NewRequest("DELETE", "/v1/plans/p1/slots/B", nil)
	req.SetPathValue("id", "p1")
	req.SetPathValue("slot", "B")
	w := httptest.NewRecorder()
	s.removePlanSlot(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestRemovePlanSlot_500(t *testing.T) {
	s, fs, _ := mkServer(t)
	fs.removePlanSlot = func(string, string) (*model.Plan, error) {
		return nil, errors.New("x")
	}
	req := httptest.NewRequest("DELETE", "/v1/plans/p1/slots/B", nil)
	req.SetPathValue("id", "p1")
	req.SetPathValue("slot", "B")
	w := httptest.NewRecorder()
	s.removePlanSlot(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── getArtifact ────────────────────────────────────────────────────────

type readerCloser struct {
	*bytes.Reader
}

func (readerCloser) Close() error { return nil }

func TestGetArtifact_Happy_StreamsContent(t *testing.T) {
	s, _, fa := mkServer(t)
	body := []byte("artifact-bytes")
	fa.openFn = func(runID, name string) (io.ReadCloser, int64, error) {
		if runID != "sim-1" || name != "engine.log" {
			t.Errorf("path mismatch: runID=%q name=%q", runID, name)
		}
		return readerCloser{bytes.NewReader(body)}, int64(len(body)), nil
	}
	req := httptest.NewRequest("GET", "/v1/artifacts/sim-1/engine.log", nil)
	req.SetPathValue("run_id", "sim-1")
	req.SetPathValue("name", "engine.log")
	w := httptest.NewRecorder()
	s.getArtifact(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
	if !bytes.Equal(w.Body.Bytes(), body) {
		t.Errorf("body mismatch: %q", w.Body.String())
	}
	if w.Header().Get("Content-Length") != "14" {
		t.Errorf("Content-Length=%q", w.Header().Get("Content-Length"))
	}
}

func TestGetArtifact_NotFound(t *testing.T) {
	s, _, fa := mkServer(t)
	fa.openFn = func(string, string) (io.ReadCloser, int64, error) {
		return nil, 0, errors.New("missing")
	}
	req := httptest.NewRequest("GET", "/v1/artifacts/sim-1/x", nil)
	req.SetPathValue("run_id", "sim-1")
	req.SetPathValue("name", "x")
	w := httptest.NewRecorder()
	s.getArtifact(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── streamLog NotFound (full WS upgrade requires real conn; cover the
//    pre-upgrade error branch only). ────────────────────────────────────

func TestStreamLog_PreUpgradeNotFound(t *testing.T) {
	s, _, fa := mkServer(t)
	fa.openFn = func(string, string) (io.ReadCloser, int64, error) {
		return nil, 0, errors.New("no log")
	}
	req := httptest.NewRequest("GET", "/v1/streams/run/sim-1/log", nil)
	req.SetPathValue("id", "sim-1")
	w := httptest.NewRecorder()
	s.streamLog(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

// classify is independently exercised here for completeness.
func TestStreamClassify(t *testing.T) {
	cases := map[string]string{
		"WARN": "warn", "warn": "warn",
		"ERR": "err", "err": "err", "ERROR": "err",
		"INFO": "info", "ENGINE/scheduler": "info", "": "info",
	}
	for in, want := range cases {
		if got := classify(in); got != want {
			t.Errorf("classify(%q)=%q, want %q", in, got, want)
		}
	}
}

// healthz / writeJSON / writeErr are covered by handlers_test.go;
// here we add coverage for json encode error path on writeJSON via a
// non-encodable value (channel) to exercise the log.Printf branch.
type _unencodable chan int

func TestWriteJSON_LogsOnEncodeFailure(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, 200, _unencodable(make(chan int)))
	// We can't assert on the log line directly without a custom logger;
	// the test just ensures we don't panic. Code reaches the err branch.
	if w.Code != 200 {
		t.Errorf("status not written before encode fail: %d", w.Code)
	}
}
