package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteJSONAndErr(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]string{"k": "v"})
	if w.Code != 200 {
		t.Errorf("code=%d", w.Code)
	}
	if w.Header().Get("Content-Type") == "" {
		t.Errorf("missing content-type")
	}

	w2 := httptest.NewRecorder()
	writeErr(w2, 500, "boom")
	if w2.Code != 500 {
		t.Errorf("err code=%d", w2.Code)
	}
}

func TestServerHealthz(t *testing.T) {
	s := &Server{}
	w := httptest.NewRecorder()
	s.healthz(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != http.StatusOK {
		t.Errorf("code=%d", w.Code)
	}
}

func TestRoutesAndCORS(t *testing.T) {
	s := &Server{}
	h := s.Routes()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != http.StatusOK {
		t.Errorf("healthz=%d", w.Code)
	}
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, httptest.NewRequest("OPTIONS", "/v1/specs/hwspec/x", nil))
	if w2.Code != http.StatusNoContent {
		t.Errorf("OPTIONS=%d", w2.Code)
	}
	if w2.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Errorf("missing CORS")
	}
}

func TestDiffMissingQueryParams(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest("GET", "/v1/specs/hwspec/x/diff", nil)
	req.SetPathValue("id", "x")
	w := httptest.NewRecorder()
	s.diff(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}
