package api

import (
	"context"
	"net/http"

	"github.com/bytesim/asset-svc/internal/model"
	"github.com/bytesim/asset-svc/internal/store"
)

// Store is the subset of *store.PG that handlers depend on. Defined as an
// interface so unit tests can plug in a mock without bringing up Postgres.
// *store.PG satisfies it implicitly; cmd/asset-svc/main.go injection is
// unchanged.
type Store interface {
	GetLatest(ctx context.Context, specID string) (*model.SpecLatest, error)
	ListSpecs(ctx context.Context, kind string) ([]model.Spec, error)
	ListVersions(ctx context.Context, specID string) ([]model.SpecVersion, error)
	GetVersion(ctx context.Context, hash string) (*model.SpecVersion, error)
	Snapshot(ctx context.Context, specID string, req model.SnapshotRequest) (*model.SpecVersion, error)
	Fork(ctx context.Context, sourceSpecID string, req model.ForkRequest) (*model.SpecLatest, error)
	ListResources(ctx context.Context, f store.ResourceFilter) ([]model.Resource, error)
	GetResource(ctx context.Context, id string) (*model.Resource, error)
	ResourceTree(ctx context.Context, rootID string) (*model.ResourceTreeNode, error)
	ListLinks(ctx context.Context, srcID, dstID, fabric string) ([]model.Link, error)
	CatalogStats(ctx context.Context) (*model.CatalogStats, error)
	ListCatalog(ctx context.Context, kind string) ([]model.CatalogItem, error)
	UpsertCatalog(ctx context.Context, kind, id, name string, body []byte) error
	DeleteCatalog(ctx context.Context, kind, id string) error
}

type Server struct {
	PG Store
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /v1/specs/{kind}", s.listSpecs)
	mux.HandleFunc("GET /v1/specs/{kind}/{id}", s.getLatest)
	mux.HandleFunc("GET /v1/specs/{kind}/{id}/versions", s.listVersions)
	mux.HandleFunc("POST /v1/specs/{kind}/{id}/snapshot", s.snapshot)
	mux.HandleFunc("GET /v1/specs/{kind}/{id}/diff", s.diff)
	mux.HandleFunc("POST /v1/specs/{kind}/{id}/fork", s.fork)
	// §1 Catalog API
	mux.HandleFunc("GET /v1/catalog/resources", s.listResources)
	mux.HandleFunc("GET /v1/catalog/resources/{id}", s.getResource)
	mux.HandleFunc("GET /v1/catalog/resources/{id}/tree", s.getResourceTree)
	mux.HandleFunc("GET /v1/catalog/links", s.listLinks)
	mux.HandleFunc("GET /v1/catalog/stats", s.catalogStats)
	// 硬件部件 + sim presets — kind in (cpu/gpu/nic/ssd/train_preset/infer_preset)
	mux.HandleFunc("GET /v1/catalog/items/{kind}", s.listCatalog)
	mux.HandleFunc("POST /v1/catalog/items/{kind}", s.upsertCatalog)
	mux.HandleFunc("PUT /v1/catalog/items/{kind}/{id}", s.upsertCatalog)
	mux.HandleFunc("DELETE /v1/catalog/items/{kind}/{id}", s.deleteCatalog)
	return cors(mux)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
