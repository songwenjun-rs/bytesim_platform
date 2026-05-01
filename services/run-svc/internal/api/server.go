package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/bytesim/run-svc/internal/model"
	"github.com/bytesim/run-svc/internal/obs"
	"github.com/bytesim/run-svc/internal/store"
)

// Store is the subset of *store.PG that handlers depend on. Defined as an
// interface so unit tests can plug in a mock without bringing up Postgres.
// *store.PG satisfies it implicitly; cmd/run-svc/main.go injection is
// unchanged.
type Store interface {
	GetRun(ctx context.Context, id string) (*model.Run, error)
	SpecsForRun(ctx context.Context, runID string) ([]model.SpecRef, error)
	Lineage(ctx context.Context, runID string) (*model.Lineage, error)
	CreateRun(ctx context.Context, projectID string, req model.CreateRunRequest) (*model.Run, error)
	DeleteRun(ctx context.Context, id string) error
	ClaimNextQueued(ctx context.Context, projectID string) (*model.Run, error)
	CancelRun(ctx context.Context, runID string) (*model.Run, bool, error)
	PatchRun(ctx context.Context, runID string, req model.PatchRunRequest) (*model.Run, error)
	ListRuns(ctx context.Context, f store.ListRunsFilter) ([]model.Run, error)
	CountRunsSince(ctx context.Context, projectID string, since time.Time) (int, error)
	AvgConfidence(ctx context.Context, projectID string) (float64, error)
	StaleRuns(ctx context.Context, projectID string, limit int) ([]model.Run, error)
	GetPlan(ctx context.Context, planID string) (*model.Plan, error)
	CreatePlan(ctx context.Context, projectID string, req model.CreatePlanRequest) (*model.Plan, error)
	AddPlanSlot(ctx context.Context, planID string, req model.AddSlotRequest) (*model.Plan, error)
	RemovePlanSlot(ctx context.Context, planID, slot string) (*model.Plan, error)
}

// ArtifactStore is the subset of *store.FSArtifacts handlers depend on.
type ArtifactStore interface {
	Open(runID, name string) (io.ReadCloser, int64, error)
	RemoveAll(runID string) error
	AppendLog(runID, line string) error
}

type Server struct {
	PG        Store
	Artifacts ArtifactStore
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.Handle("GET /metrics", obs.MetricsHandler())
	mux.HandleFunc("GET /v1/runs", s.listRuns)
	mux.HandleFunc("GET /v1/runs/{id}", s.getRun)
	mux.HandleFunc("POST /v1/runs", s.createRun)
	mux.HandleFunc("PATCH /v1/runs/{id}", s.patchRun)
	mux.HandleFunc("DELETE /v1/runs/{id}", s.deleteRun)
	mux.HandleFunc("POST /v1/runs/claim", s.claimNext)
	mux.HandleFunc("POST /v1/runs/{id}/cancel", s.cancelRun)
	mux.HandleFunc("GET /v1/runs-stale", s.listStaleRuns)
	mux.HandleFunc("GET /v1/runs-stats", s.runStats)
	mux.HandleFunc("GET /v1/runs/{id}/specs", s.getSpecs)
	mux.HandleFunc("GET /v1/runs/{id}/lineage", s.getLineage)
	mux.HandleFunc("GET /v1/artifacts/{run_id}/{name}", s.getArtifact)
	mux.HandleFunc("GET /v1/streams/run/{id}/log", s.streamLog)
	mux.HandleFunc("GET /v1/plans/{id}", s.getPlan)
	mux.HandleFunc("POST /v1/plans", s.createPlan)
	mux.HandleFunc("POST /v1/plans/{id}/slots", s.addPlanSlot)
	mux.HandleFunc("DELETE /v1/plans/{id}/slots/{slot}", s.removePlanSlot)
	// Outermost: trace + metrics + cors. Order is metrics(cors(mux))
	// so cors writes its preflight 204 still get counted.
	return obs.Middleware("run-svc", routeTemplate)(cors(mux))
}

// routeTemplate maps a raw URL path to a stable Prometheus label so
// /v1/runs/sim-7f2a and /v1/runs/sim-7e90 collapse onto /v1/runs/{id}.
// Go 1.22's net/http doesn't expose pattern matches at request time, so
// we rebuild the mapping by hand. Keep in sync with Routes().
func routeTemplate(r *http.Request) string {
	p := r.URL.Path
	switch {
	case p == "/healthz", p == "/metrics", p == "/v1/runs",
		p == "/v1/runs/claim", p == "/v1/runs-stale", p == "/v1/runs-stats",
		p == "/v1/plans":
		return p
	case strings.HasPrefix(p, "/v1/runs/") && strings.HasSuffix(p, "/specs"):
		return "/v1/runs/{id}/specs"
	case strings.HasPrefix(p, "/v1/runs/") && strings.HasSuffix(p, "/lineage"):
		return "/v1/runs/{id}/lineage"
	case strings.HasPrefix(p, "/v1/runs/") && strings.HasSuffix(p, "/cancel"):
		return "/v1/runs/{id}/cancel"
	case strings.HasPrefix(p, "/v1/runs/") && strings.Contains(p, "/log"):
		return "/v1/streams/run/{id}/log"
	case strings.HasPrefix(p, "/v1/runs/"):
		return "/v1/runs/{id}"
	case strings.HasPrefix(p, "/v1/artifacts/"):
		return "/v1/artifacts/{run_id}/{name}"
	case strings.HasPrefix(p, "/v1/plans/") && strings.Contains(p, "/slots"):
		return "/v1/plans/{id}/slots"
	case strings.HasPrefix(p, "/v1/plans/"):
		return "/v1/plans/{id}"
	default:
		return p
	}
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
