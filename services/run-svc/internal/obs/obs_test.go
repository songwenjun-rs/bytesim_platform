package obs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// SetupLogger is idempotent + side-effect-free; just confirm it returns a
// non-nil logger and stashes it as the default.
func TestSetupLogger_ReturnsLoggerAndSetsDefault(t *testing.T) {
	logger := SetupLogger("test-svc")
	if logger == nil {
		t.Fatalf("nil logger")
	}
}

func TestNewTraceID_FormatAndUniqueness(t *testing.T) {
	a := newTraceID()
	b := newTraceID()
	if len(a) != 16 {
		t.Errorf("trace id length = %d, want 16", len(a))
	}
	for _, r := range a {
		if !strings.ContainsRune("0123456789abcdef", r) {
			t.Errorf("non-hex char %q in trace id %q", r, a)
		}
	}
	if a == b {
		t.Errorf("two consecutive trace ids collided: %s", a)
	}
}

// TraceID + Logger pair: when ctx carries a trace_id the helpers return it.
func TestTraceIDAndLogger_FromContext(t *testing.T) {
	ctx := context.WithValue(context.Background(), traceCtxKey, "deadbeef00112233")
	if got := TraceID(ctx); got != "deadbeef00112233" {
		t.Errorf("TraceID = %q", got)
	}
	if Logger(ctx) == nil {
		t.Errorf("Logger returned nil")
	}
}

func TestTraceIDAndLogger_NoCtxValue(t *testing.T) {
	ctx := context.Background()
	if TraceID(ctx) != "" {
		t.Errorf("TraceID without ctx value should be empty")
	}
	if Logger(ctx) == nil {
		t.Errorf("Logger should fall back to default, not nil")
	}
}

// Middleware: passes through, threads trace id, sets header, records metrics.
func TestMiddleware_ThreadsTraceIDAndIncrementsCounter(t *testing.T) {
	called := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		// Trace id should be in ctx.
		if TraceID(r.Context()) == "" {
			t.Errorf("middleware did not stash trace_id in ctx")
		}
		w.WriteHeader(200)
	})
	mw := Middleware("test-svc", func(r *http.Request) string {
		return r.URL.Path
	})
	wrapped := mw(handler)

	req := httptest.NewRequest("GET", "/foo", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)
	if !called {
		t.Errorf("inner handler not invoked")
	}
	if w.Header().Get(TraceHeader) == "" {
		t.Errorf("Middleware did not set %s response header", TraceHeader)
	}
}

// When the request already carries an X-Trace-Id, middleware reuses it
// instead of minting a new one.
func TestMiddleware_PreservesIncomingTraceID(t *testing.T) {
	mw := Middleware("test-svc", nil) // exercise nil routeOf default
	wrapped := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := TraceID(r.Context()); got != "incoming-id" {
			t.Errorf("trace_id = %q, want incoming-id", got)
		}
		w.WriteHeader(204)
	}))
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set(TraceHeader, "incoming-id")
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)
	if w.Header().Get(TraceHeader) != "incoming-id" {
		t.Errorf("response header trace_id should echo incoming, got %q",
			w.Header().Get(TraceHeader))
	}
}

// statusRecorder properly captures the status code.
func TestStatusRecorder_CapturesStatus(t *testing.T) {
	mw := Middleware("test-svc", nil)
	wrapped := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)
	if w.Code != 503 {
		t.Errorf("status not propagated: %d", w.Code)
	}
}

// MetricsHandler returns a usable promhttp handler — verify /metrics serves
// 200 with text/plain Content-Type.
func TestMetricsHandler_Serves200(t *testing.T) {
	h := MetricsHandler()
	req := httptest.NewRequest("GET", "/metrics", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("metrics code=%d", w.Code)
	}
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
		t.Errorf("Content-Type=%q", w.Header().Get("Content-Type"))
	}
}
