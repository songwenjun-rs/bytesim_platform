package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"

	"github.com/bytesim/asset-svc/internal/model"
	"github.com/bytesim/asset-svc/internal/store"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) getLatest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	out, err := s.PG.GetLatest(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "spec not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listSpecs(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	out, err := s.PG.ListSpecs(r.Context(), kind)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listVersions(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	vs, err := s.PG.ListVersions(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

func (s *Server) diff(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		writeErr(w, http.StatusBadRequest, "from and to query params required")
		return
	}
	fromV, err := s.PG.GetVersion(r.Context(), from)
	if err != nil {
		writeErr(w, http.StatusNotFound, "from version not found: "+from)
		return
	}
	toV, err := s.PG.GetVersion(r.Context(), to)
	if err != nil {
		writeErr(w, http.StatusNotFound, "to version not found: "+to)
		return
	}
	if fromV.SpecID != id || toV.SpecID != id {
		writeErr(w, http.StatusBadRequest, "from/to must belong to the same spec_id")
		return
	}
	var fb, tb any
	if err := json.Unmarshal(fromV.Body, &fb); err != nil {
		writeErr(w, http.StatusInternalServerError, "from body parse: "+err.Error())
		return
	}
	if err := json.Unmarshal(toV.Body, &tb); err != nil {
		writeErr(w, http.StatusInternalServerError, "to body parse: "+err.Error())
		return
	}
	entries := computeDiff("", fb, tb)
	writeJSON(w, http.StatusOK, model.DiffResult{From: *fromV, To: *toV, Entries: entries})
}

func (s *Server) fork(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.ForkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	out, err := s.PG.Fork(r.Context(), id, req)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "spec not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// computeDiff walks two JSON-decoded values and emits added / removed / changed.
// Recursive into objects; arrays/scalars compared by value.
func computeDiff(path string, a, b any) []model.DiffEntry {
	if jsonEqual(a, b) {
		return nil
	}
	am, aok := a.(map[string]any)
	bm, bok := b.(map[string]any)
	if !aok || !bok {
		return []model.DiffEntry{{Path: path, Op: "changed", From: a, To: b}}
	}
	out := []model.DiffEntry{}
	keys := map[string]bool{}
	for k := range am {
		keys[k] = true
	}
	for k := range bm {
		keys[k] = true
	}
	// stable order
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	for _, k := range sorted {
		av, aok := am[k]
		bv, bok := bm[k]
		child := k
		if path != "" {
			child = path + "." + k
		}
		switch {
		case aok && !bok:
			out = append(out, model.DiffEntry{Path: child, Op: "removed", From: av})
		case !aok && bok:
			out = append(out, model.DiffEntry{Path: child, Op: "added", To: bv})
		default:
			out = append(out, computeDiff(child, av, bv)...)
		}
	}
	return out
}

func jsonEqual(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

func (s *Server) snapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.SnapshotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	v, err := s.PG.Snapshot(r.Context(), id, req)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "spec not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, v)
}

// ── Catalog (parts + presets) handlers ──────────────────────────────────────

func (s *Server) listCatalog(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	items, err := s.PG.ListCatalog(r.Context(), kind)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) upsertCatalog(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	pathID := r.PathValue("id") // empty on POST, set on PUT
	var req model.UpsertCatalogRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	id := req.ID
	if pathID != "" {
		id = pathID // PUT path id wins
	}
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	if req.Name == "" {
		req.Name = id
	}
	if len(req.Body) == 0 {
		req.Body = []byte("{}")
	}
	if err := s.PG.UpsertCatalog(r.Context(), kind, id, req.Name, req.Body); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, model.CatalogItem{
		Kind: kind, ID: id, Name: req.Name, Body: req.Body,
	})
}

func (s *Server) deleteCatalog(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	id := r.PathValue("id")
	if err := s.PG.DeleteCatalog(r.Context(), kind, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
