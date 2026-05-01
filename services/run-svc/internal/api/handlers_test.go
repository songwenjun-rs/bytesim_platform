package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// pure helper coverage

func TestSplitCSV(t *testing.T) {
	if got := splitCSV(""); got != nil {
		t.Errorf("empty should be nil, got %v", got)
	}
	got := splitCSV("a, b ,c")
	want := []string{"a", "b", "c"}
	if len(got) != 3 {
		t.Fatalf("len=%d, got %v", len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] %q != %q", i, got[i], want[i])
		}
	}
}

func TestOrDefault(t *testing.T) {
	if orDefault("", "x") != "x" {
		t.Error("empty should fall to default")
	}
	if orDefault("a", "x") != "a" {
		t.Error("non-empty should pass through")
	}
}

func TestAtoi(t *testing.T) {
	if atoi("", 7) != 7 {
		t.Error("empty should fall to default")
	}
	if atoi("garbage", 7) != 7 {
		t.Error("invalid should fall to default")
	}
	if atoi("12", 7) != 12 {
		t.Error("valid number should parse")
	}
}

func TestWriteJSONAndErr(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]string{"k": "v"})
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct == "" {
		t.Errorf("missing content-type")
	}

	w2 := httptest.NewRecorder()
	writeErr(w2, 502, "downstream")
	if w2.Code != 502 {
		t.Errorf("err code=%d", w2.Code)
	}
}

func TestServerHealthz(t *testing.T) {
	s := &Server{} // healthz doesn't touch PG
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	s.healthz(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("code=%d", w.Code)
	}
}

func TestRoutesRegistration(t *testing.T) {
	s := &Server{}
	h := s.Routes()
	// hit /healthz via the mux to confirm the route is wired up.
	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("healthz code=%d", w.Code)
	}
	// CORS preflight should return 204
	pf := httptest.NewRequest("OPTIONS", "/v1/runs", nil)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, pf)
	if w2.Code != http.StatusNoContent {
		t.Errorf("OPTIONS preflight code=%d", w2.Code)
	}
	if w2.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Errorf("missing CORS header")
	}

	// DELETE /v1/runs/{id} added in the 仿真报告 slice — verify CORS preflight
	// surfaces DELETE in Allow-Methods so cross-origin browsers don't bounce.
	dpf := httptest.NewRequest("OPTIONS", "/v1/runs/sim-001", nil)
	w3 := httptest.NewRecorder()
	h.ServeHTTP(w3, dpf)
	if w3.Code != http.StatusNoContent {
		t.Errorf("OPTIONS for DELETE preflight code=%d", w3.Code)
	}
	allow := w3.Header().Get("Access-Control-Allow-Methods")
	if allow == "" || !contains(allow, "DELETE") {
		t.Errorf("Access-Control-Allow-Methods missing DELETE: %q", allow)
	}
}

func TestRouteTemplateCollapsesIDs(t *testing.T) {
	cases := map[string]string{
		"/v1/runs/sim-001":          "/v1/runs/{id}",
		"/v1/runs/sim-001/specs":    "/v1/runs/{id}/specs",
		"/v1/runs/sim-001/lineage":  "/v1/runs/{id}/lineage",
		"/v1/runs/sim-001/cancel":   "/v1/runs/{id}/cancel",
		"/v1/runs":                  "/v1/runs",
		"/v1/runs/claim":            "/v1/runs/claim",
		"/v1/runs-stats":            "/v1/runs-stats",
		"/v1/plans/plan-x/slots":    "/v1/plans/{id}/slots",
		"/v1/plans/plan-x":          "/v1/plans/{id}",
		"/v1/artifacts/sim-1/x.txt": "/v1/artifacts/{run_id}/{name}",
	}
	for in, want := range cases {
		req := httptest.NewRequest("GET", in, nil)
		got := routeTemplate(req)
		if got != want {
			t.Errorf("routeTemplate(%q) = %q, want %q", in, got, want)
		}
	}
}

// contains is a tiny dep-free substring check for Allow-Methods asserting.
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
