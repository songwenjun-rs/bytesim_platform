package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/bytesim/asset-svc/internal/model"
	"github.com/bytesim/asset-svc/internal/store"
)

// ── Mock Store ─────────────────────────────────────────────────────────

type fakeStore struct {
	getLatest      func(string) (*model.SpecLatest, error)
	listSpecs      func(string) ([]model.Spec, error)
	listVersions   func(string) ([]model.SpecVersion, error)
	getVersion     func(string) (*model.SpecVersion, error)
	snapshot       func(string, model.SnapshotRequest) (*model.SpecVersion, error)
	fork           func(string, model.ForkRequest) (*model.SpecLatest, error)
	listResources  func(store.ResourceFilter) ([]model.Resource, error)
	getResource    func(string) (*model.Resource, error)
	resourceTree   func(string) (*model.ResourceTreeNode, error)
	listLinks      func(string, string, string) ([]model.Link, error)
	catalogStats   func() (*model.CatalogStats, error)
	listCatalog    func(string) ([]model.CatalogItem, error)
	upsertCatalog  func(string, string, string, []byte) error
	deleteCatalog  func(string, string) error
}

func (f *fakeStore) GetLatest(_ context.Context, specID string) (*model.SpecLatest, error) {
	return f.getLatest(specID)
}
func (f *fakeStore) ListSpecs(_ context.Context, kind string) ([]model.Spec, error) {
	return f.listSpecs(kind)
}
func (f *fakeStore) ListVersions(_ context.Context, specID string) ([]model.SpecVersion, error) {
	return f.listVersions(specID)
}
func (f *fakeStore) GetVersion(_ context.Context, hash string) (*model.SpecVersion, error) {
	return f.getVersion(hash)
}
func (f *fakeStore) Snapshot(_ context.Context, specID string, req model.SnapshotRequest) (*model.SpecVersion, error) {
	return f.snapshot(specID, req)
}
func (f *fakeStore) Fork(_ context.Context, src string, req model.ForkRequest) (*model.SpecLatest, error) {
	return f.fork(src, req)
}
func (f *fakeStore) ListResources(_ context.Context, ff store.ResourceFilter) ([]model.Resource, error) {
	return f.listResources(ff)
}
func (f *fakeStore) GetResource(_ context.Context, id string) (*model.Resource, error) {
	return f.getResource(id)
}
func (f *fakeStore) ResourceTree(_ context.Context, rootID string) (*model.ResourceTreeNode, error) {
	return f.resourceTree(rootID)
}
func (f *fakeStore) ListLinks(_ context.Context, src, dst, fabric string) ([]model.Link, error) {
	return f.listLinks(src, dst, fabric)
}
func (f *fakeStore) CatalogStats(_ context.Context) (*model.CatalogStats, error) {
	return f.catalogStats()
}
func (f *fakeStore) ListCatalog(_ context.Context, kind string) ([]model.CatalogItem, error) {
	return f.listCatalog(kind)
}
func (f *fakeStore) UpsertCatalog(_ context.Context, kind, id, name string, body []byte) error {
	return f.upsertCatalog(kind, id, name, body)
}
func (f *fakeStore) DeleteCatalog(_ context.Context, kind, id string) error {
	return f.deleteCatalog(kind, id)
}

func mkServer(t *testing.T) (*Server, *fakeStore) {
	t.Helper()
	fs := &fakeStore{}
	return &Server{PG: fs}, fs
}

// ── Spec handlers ──────────────────────────────────────────────────────

func TestGetLatest_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.getLatest = func(id string) (*model.SpecLatest, error) {
		return &model.SpecLatest{
			Spec:    model.Spec{ID: id, Kind: "hwspec"},
			Version: model.SpecVersion{Hash: "h1", SpecID: id},
		}, nil
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x", nil)
	req.SetPathValue("kind", "hwspec")
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getLatest(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetLatest_NotFound(t *testing.T) {
	s, fs := mkServer(t)
	fs.getLatest = func(string) (*model.SpecLatest, error) { return nil, store.ErrNotFound }
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x", nil)
	req.SetPathValue("kind", "hwspec")
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getLatest(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetLatest_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.getLatest = func(string) (*model.SpecLatest, error) { return nil, errors.New("boom") }
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getLatest(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListSpecs_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.listSpecs = func(kind string) ([]model.Spec, error) {
		if kind != "hwspec" {
			t.Errorf("kind=%q", kind)
		}
		return []model.Spec{{ID: "x", Kind: "hwspec"}}, nil
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec", nil)
	req.SetPathValue("kind", "hwspec")
	w := httptest.NewRecorder()
	s.listSpecs(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListSpecs_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.listSpecs = func(string) ([]model.Spec, error) { return nil, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/specs/hwspec", nil)
	w := httptest.NewRecorder()
	s.listSpecs(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListVersions_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.listVersions = func(string) ([]model.SpecVersion, error) {
		return []model.SpecVersion{{Hash: "h1"}, {Hash: "h2"}}, nil
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/versions", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.listVersions(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListVersions_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.listVersions = func(string) ([]model.SpecVersion, error) { return nil, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/versions", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.listVersions(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestSnapshot_Happy_201(t *testing.T) {
	s, fs := mkServer(t)
	fs.snapshot = func(specID string, req model.SnapshotRequest) (*model.SpecVersion, error) {
		if specID != "x" {
			t.Errorf("specID=%q", specID)
		}
		return &model.SpecVersion{Hash: "newh", SpecID: specID}, nil
	}
	body := `{"body":{"foo":"bar"}}`
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/snapshot",
		bytes.NewBufferString(body))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.snapshot(w, req)
	if w.Code != 201 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestSnapshot_NotFound(t *testing.T) {
	s, fs := mkServer(t)
	fs.snapshot = func(string, model.SnapshotRequest) (*model.SpecVersion, error) {
		return nil, store.ErrNotFound
	}
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/snapshot",
		bytes.NewBufferString(`{"body":{}}`))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.snapshot(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestSnapshot_BadJSON_400(t *testing.T) {
	s, _ := mkServer(t)
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/snapshot",
		bytes.NewBufferString("not json"))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.snapshot(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestSnapshot_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.snapshot = func(string, model.SnapshotRequest) (*model.SpecVersion, error) {
		return nil, errors.New("write failed")
	}
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/snapshot",
		bytes.NewBufferString(`{"body":{}}`))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.snapshot(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestFork_Happy_201(t *testing.T) {
	s, fs := mkServer(t)
	fs.fork = func(src string, req model.ForkRequest) (*model.SpecLatest, error) {
		if src != "x" || req.NewName != "fork-1" {
			t.Errorf("src=%q name=%q", src, req.NewName)
		}
		return &model.SpecLatest{
			Spec:    model.Spec{ID: "x_fork_abc", Kind: "hwspec", Name: "fork-1"},
			Version: model.SpecVersion{Hash: "fh"},
		}, nil
	}
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/fork",
		bytes.NewBufferString(`{"new_name":"fork-1"}`))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.fork(w, req)
	if w.Code != 201 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestFork_NotFound(t *testing.T) {
	s, fs := mkServer(t)
	fs.fork = func(string, model.ForkRequest) (*model.SpecLatest, error) {
		return nil, store.ErrNotFound
	}
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/fork",
		bytes.NewBufferString(`{"new_name":"x"}`))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.fork(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestFork_BadJSON_400(t *testing.T) {
	s, _ := mkServer(t)
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/fork",
		bytes.NewBufferString("not json"))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.fork(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestFork_400OnStoreError(t *testing.T) {
	s, fs := mkServer(t)
	fs.fork = func(string, model.ForkRequest) (*model.SpecLatest, error) {
		return nil, errors.New("invalid name")
	}
	req := httptest.NewRequest("POST", "/v1/specs/hwspec/x/fork",
		bytes.NewBufferString(`{"new_name":""}`))
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.fork(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── diff (most complex handler — JSON walk + 4 error branches) ─────────

func TestDiff_Happy_ReturnsEntries(t *testing.T) {
	s, fs := mkServer(t)
	fromBody := json.RawMessage(`{"a":1,"b":2}`)
	toBody := json.RawMessage(`{"a":1,"b":3,"c":4}`)
	fs.getVersion = func(hash string) (*model.SpecVersion, error) {
		if hash == "from" {
			return &model.SpecVersion{Hash: "from", SpecID: "x", Body: fromBody}, nil
		}
		return &model.SpecVersion{Hash: "to", SpecID: "x", Body: toBody}, nil
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/diff?from=from&to=to", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.diff(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
	var got model.DiffResult
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	// Expect 2 entries: b changed, c added. (a unchanged is filtered.)
	ops := map[string]string{}
	for _, e := range got.Entries {
		ops[e.Path] = e.Op
	}
	if ops["b"] != "changed" {
		t.Errorf("b op=%q want changed", ops["b"])
	}
	if ops["c"] != "added" {
		t.Errorf("c op=%q want added", ops["c"])
	}
}

func TestDiff_MissingQueryParams_400(t *testing.T) {
	s, _ := mkServer(t)
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/diff", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.diff(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDiff_FromNotFound_404(t *testing.T) {
	s, fs := mkServer(t)
	fs.getVersion = func(string) (*model.SpecVersion, error) {
		return nil, errors.New("no row")
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/diff?from=a&to=b", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.diff(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDiff_ToNotFound_404(t *testing.T) {
	s, fs := mkServer(t)
	calls := 0
	fs.getVersion = func(hash string) (*model.SpecVersion, error) {
		calls++
		if calls == 1 {
			return &model.SpecVersion{Hash: "a", SpecID: "x", Body: json.RawMessage(`{}`)}, nil
		}
		return nil, errors.New("no row")
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/diff?from=a&to=b", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.diff(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDiff_DifferentSpecIDs_400(t *testing.T) {
	s, fs := mkServer(t)
	calls := 0
	fs.getVersion = func(string) (*model.SpecVersion, error) {
		calls++
		spec := "x"
		if calls == 2 {
			spec = "y"
		}
		return &model.SpecVersion{Hash: "h", SpecID: spec, Body: json.RawMessage(`{}`)}, nil
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/diff?from=a&to=b", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.diff(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDiff_ParseError_500(t *testing.T) {
	s, fs := mkServer(t)
	calls := 0
	fs.getVersion = func(string) (*model.SpecVersion, error) {
		calls++
		body := json.RawMessage(`{}`)
		if calls == 1 {
			body = json.RawMessage(`not-json`)
		}
		return &model.SpecVersion{Hash: "h", SpecID: "x", Body: body}, nil
	}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/diff?from=a&to=b", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.diff(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── Catalog (resource ontology) handlers ────────────────────────────────

func TestListResources_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.listResources = func(f store.ResourceFilter) ([]model.Resource, error) {
		// No special filter — defaults applied by the store, not the handler.
		return []model.Resource{{ID: "r1", Kind: "gpu"}}, nil
	}
	req := httptest.NewRequest("GET", "/v1/catalog/resources", nil)
	w := httptest.NewRecorder()
	s.listResources(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListResources_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.listResources = func(store.ResourceFilter) ([]model.Resource, error) {
		return nil, errors.New("x")
	}
	req := httptest.NewRequest("GET", "/v1/catalog/resources", nil)
	w := httptest.NewRecorder()
	s.listResources(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetResource_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.getResource = func(id string) (*model.Resource, error) {
		return &model.Resource{ID: id, Kind: "gpu"}, nil
	}
	req := httptest.NewRequest("GET", "/v1/catalog/resources/r1", nil)
	req.SetPathValue("id", "r1")
	w := httptest.NewRecorder()
	s.getResource(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetResource_NotFound(t *testing.T) {
	s, fs := mkServer(t)
	fs.getResource = func(string) (*model.Resource, error) { return nil, store.ErrNotFound }
	req := httptest.NewRequest("GET", "/v1/catalog/resources/x", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getResource(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetResourceTree_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.resourceTree = func(rootID string) (*model.ResourceTreeNode, error) {
		return &model.ResourceTreeNode{
			Resource: model.Resource{ID: rootID, Kind: "site"},
			Children: nil,
		}, nil
	}
	req := httptest.NewRequest("GET", "/v1/catalog/resources/site-bj1/tree", nil)
	req.SetPathValue("id", "site-bj1")
	w := httptest.NewRecorder()
	s.getResourceTree(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestGetResourceTree_NotFound(t *testing.T) {
	s, fs := mkServer(t)
	fs.resourceTree = func(string) (*model.ResourceTreeNode, error) {
		return nil, store.ErrNotFound
	}
	req := httptest.NewRequest("GET", "/v1/catalog/resources/x/tree", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.getResourceTree(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListLinks_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.listLinks = func(src, dst, fabric string) ([]model.Link, error) {
		if src != "a" || dst != "b" || fabric != "ib" {
			t.Errorf("filters not propagated: src=%q dst=%q fabric=%q", src, dst, fabric)
		}
		return []model.Link{{ID: "l1", SrcID: "a", DstID: "b"}}, nil
	}
	req := httptest.NewRequest("GET", "/v1/catalog/links?src=a&dst=b&fabric=ib", nil)
	w := httptest.NewRecorder()
	s.listLinks(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListLinks_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.listLinks = func(string, string, string) ([]model.Link, error) {
		return nil, errors.New("x")
	}
	req := httptest.NewRequest("GET", "/v1/catalog/links", nil)
	w := httptest.NewRecorder()
	s.listLinks(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestCatalogStats_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.catalogStats = func() (*model.CatalogStats, error) {
		return &model.CatalogStats{Total: 47, ByKind: map[string]int{"gpu": 32}}, nil
	}
	req := httptest.NewRequest("GET", "/v1/catalog/stats", nil)
	w := httptest.NewRecorder()
	s.catalogStats(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestCatalogStats_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.catalogStats = func() (*model.CatalogStats, error) { return nil, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/catalog/stats", nil)
	w := httptest.NewRecorder()
	s.catalogStats(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── catalog/items (parts + presets) handlers ────────────────────────────

func TestListCatalog_Happy(t *testing.T) {
	s, fs := mkServer(t)
	fs.listCatalog = func(kind string) ([]model.CatalogItem, error) {
		if kind != "cpu" {
			t.Errorf("kind=%q", kind)
		}
		return []model.CatalogItem{
			{Kind: kind, ID: "amd-9755", Name: "AMD EPYC 9755"},
		}, nil
	}
	req := httptest.NewRequest("GET", "/v1/catalog/items/cpu", nil)
	req.SetPathValue("kind", "cpu")
	w := httptest.NewRecorder()
	s.listCatalog(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestListCatalog_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.listCatalog = func(string) ([]model.CatalogItem, error) { return nil, errors.New("x") }
	req := httptest.NewRequest("GET", "/v1/catalog/items/cpu", nil)
	req.SetPathValue("kind", "cpu")
	w := httptest.NewRecorder()
	s.listCatalog(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestUpsertCatalog_POST_NewItem(t *testing.T) {
	s, fs := mkServer(t)
	captured := ""
	fs.upsertCatalog = func(kind, id, name string, body []byte) error {
		captured = kind + "|" + id + "|" + name
		return nil
	}
	body := `{"id":"cpu-1","name":"my-cpu","body":{"cores":64}}`
	req := httptest.NewRequest("POST", "/v1/catalog/items/cpu",
		bytes.NewBufferString(body))
	req.SetPathValue("kind", "cpu")
	w := httptest.NewRecorder()
	s.upsertCatalog(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d body=%s", w.Code, w.Body.String())
	}
	if captured != "cpu|cpu-1|my-cpu" {
		t.Errorf("captured=%q", captured)
	}
}

func TestUpsertCatalog_PUT_OverridesPathID(t *testing.T) {
	s, fs := mkServer(t)
	captured := ""
	fs.upsertCatalog = func(kind, id, name string, body []byte) error {
		captured = id
		return nil
	}
	// Body says id=ignored; URL path says cpu-real → path wins.
	body := `{"id":"ignored","name":"x","body":{}}`
	req := httptest.NewRequest("PUT", "/v1/catalog/items/cpu/cpu-real",
		bytes.NewBufferString(body))
	req.SetPathValue("kind", "cpu")
	req.SetPathValue("id", "cpu-real")
	w := httptest.NewRecorder()
	s.upsertCatalog(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
	if captured != "cpu-real" {
		t.Errorf("path id should win: got %q", captured)
	}
}

func TestUpsertCatalog_DefaultsNameAndBody(t *testing.T) {
	s, fs := mkServer(t)
	gotName := ""
	gotBody := ""
	fs.upsertCatalog = func(kind, id, name string, body []byte) error {
		gotName = name
		gotBody = string(body)
		return nil
	}
	// Body has only id → name defaults to id, body defaults to "{}".
	req := httptest.NewRequest("POST", "/v1/catalog/items/cpu",
		bytes.NewBufferString(`{"id":"cpu-1"}`))
	req.SetPathValue("kind", "cpu")
	w := httptest.NewRecorder()
	s.upsertCatalog(w, req)
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
	if gotName != "cpu-1" {
		t.Errorf("name default = %q, want id", gotName)
	}
	if gotBody != "{}" {
		t.Errorf("body default = %q, want {}", gotBody)
	}
}

func TestUpsertCatalog_BadJSON_400(t *testing.T) {
	s, _ := mkServer(t)
	req := httptest.NewRequest("POST", "/v1/catalog/items/cpu",
		bytes.NewBufferString("not json"))
	req.SetPathValue("kind", "cpu")
	w := httptest.NewRecorder()
	s.upsertCatalog(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestUpsertCatalog_MissingID_400(t *testing.T) {
	s, _ := mkServer(t)
	// POST with no path id and empty body id → 400.
	req := httptest.NewRequest("POST", "/v1/catalog/items/cpu",
		bytes.NewBufferString(`{"name":"x","body":{}}`))
	req.SetPathValue("kind", "cpu")
	w := httptest.NewRecorder()
	s.upsertCatalog(w, req)
	if w.Code != 400 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestUpsertCatalog_500OnStoreError(t *testing.T) {
	s, fs := mkServer(t)
	fs.upsertCatalog = func(string, string, string, []byte) error { return errors.New("pg fail") }
	req := httptest.NewRequest("POST", "/v1/catalog/items/cpu",
		bytes.NewBufferString(`{"id":"cpu-1"}`))
	req.SetPathValue("kind", "cpu")
	w := httptest.NewRecorder()
	s.upsertCatalog(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDeleteCatalog_Happy_204(t *testing.T) {
	s, fs := mkServer(t)
	fs.deleteCatalog = func(kind, id string) error {
		if kind != "cpu" || id != "cpu-1" {
			t.Errorf("path mismatch: kind=%q id=%q", kind, id)
		}
		return nil
	}
	req := httptest.NewRequest("DELETE", "/v1/catalog/items/cpu/cpu-1", nil)
	req.SetPathValue("kind", "cpu")
	req.SetPathValue("id", "cpu-1")
	w := httptest.NewRecorder()
	s.deleteCatalog(w, req)
	if w.Code != 204 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDeleteCatalog_NotFound(t *testing.T) {
	s, fs := mkServer(t)
	fs.deleteCatalog = func(string, string) error { return store.ErrNotFound }
	req := httptest.NewRequest("DELETE", "/v1/catalog/items/cpu/x", nil)
	req.SetPathValue("kind", "cpu")
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.deleteCatalog(w, req)
	if w.Code != 404 {
		t.Errorf("code=%d", w.Code)
	}
}

func TestDeleteCatalog_500(t *testing.T) {
	s, fs := mkServer(t)
	fs.deleteCatalog = func(string, string) error { return errors.New("boom") }
	req := httptest.NewRequest("DELETE", "/v1/catalog/items/cpu/x", nil)
	req.SetPathValue("kind", "cpu")
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.deleteCatalog(w, req)
	if w.Code != 500 {
		t.Errorf("code=%d", w.Code)
	}
}

// ── Routes registration smoke ──────────────────────────────────────────

func TestServerRoutesHealthz(t *testing.T) {
	s, _ := mkServer(t)
	h := s.Routes()
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("healthz code=%d", w.Code)
	}
}
