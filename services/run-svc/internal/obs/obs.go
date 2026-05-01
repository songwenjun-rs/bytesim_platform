// Package obs provides Phase 0.3 observability primitives for run-svc:
//
//   - SetupLogger() — slog JSON handler with service tag, replaces stdlib log.
//   - Middleware()  — wraps handlers to record per-route Prometheus RED metrics
//     and to thread an X-Trace-Id through ctx + log + outbound responses.
//   - Logger(ctx)   — returns a slog.Logger bound to the request's trace_id.
//   - MetricsHandler() — exposes /metrics for Prometheus scraping.
//
// Mirrors the Python services/{bff,engine-svc}/app/_obs.py contract:
// the same labels (service, method, route, status), the same trace header,
// the same JSON log shape (ts, level, logger, event, service, trace_id).
package obs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const TraceHeader = "X-Trace-Id"

type ctxKey int

const (
	traceCtxKey ctxKey = iota
)

var (
	requests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bytesim_requests_total",
		Help: "HTTP requests by service / method / route / status.",
	}, []string{"service", "method", "route", "status"})

	duration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "bytesim_request_duration_seconds",
		Help:    "HTTP request duration histogram.",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0},
	}, []string{"service", "method", "route"})
)

// SetupLogger configures slog with JSON handler and service tag. Returns the
// logger so main can stash it as the package default. Idempotent.
func SetupLogger(service string) *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	logger := slog.New(h).With("service", service)
	slog.SetDefault(logger)
	return logger
}

// Logger returns a logger bound to the trace_id stashed in ctx by Middleware.
// Falls back to the default if no trace_id is present (e.g. background tasks
// not driven by an incoming request).
func Logger(ctx context.Context) *slog.Logger {
	if tid, ok := ctx.Value(traceCtxKey).(string); ok && tid != "" {
		return slog.Default().With("trace_id", tid)
	}
	return slog.Default()
}

// TraceID returns the trace_id from ctx, or "" if none. Used by handlers that
// want to forward it to outbound HTTP calls.
func TraceID(ctx context.Context) string {
	if tid, ok := ctx.Value(traceCtxKey).(string); ok {
		return tid
	}
	return ""
}

// Middleware wraps an HTTP handler to emit RED metrics and thread a trace_id.
// Pass `routeOf` to map the raw URL path to the route template (e.g.
// /v1/runs/{id}) so per-request labels don't explode by run id. Pass nil to
// use the raw path (acceptable for a small endpoint count).
func Middleware(service string, routeOf func(r *http.Request) string) func(http.Handler) http.Handler {
	if routeOf == nil {
		routeOf = func(r *http.Request) string { return r.URL.Path }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tid := r.Header.Get(TraceHeader)
			if tid == "" {
				tid = newTraceID()
			}
			ctx := context.WithValue(r.Context(), traceCtxKey, tid)
			w.Header().Set(TraceHeader, tid)

			rw := &statusRecorder{ResponseWriter: w, status: 200}
			start := time.Now()
			next.ServeHTTP(rw, r.WithContext(ctx))
			elapsed := time.Since(start).Seconds()

			route := routeOf(r)
			requests.WithLabelValues(service, r.Method, route, strconv.Itoa(rw.status)).Inc()
			duration.WithLabelValues(service, r.Method, route).Observe(elapsed)
		})
	}
}

// MetricsHandler returns the /metrics handler for Prometheus scraping.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

func newTraceID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "0000000000000000"
	}
	return hex.EncodeToString(b[:])
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
