package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bytesim/asset-svc/internal/store"
)

// ── §1 Catalog API: read-only over bs_resource / bs_link ──

func (s *Server) listResources(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.ResourceFilter{
		Kind:           q.Get("kind"),
		ParentID:       q.Get("parent_id"),
		FailureDomain:  q.Get("failure_domain"),
		IncludeRetired: q.Get("include_retired") == "true",
	}
	if ls := q.Get("lifecycle"); ls != "" {
		f.Lifecycles = strings.Split(ls, ",")
	}
	out, err := s.PG.ListResources(r.Context(), f)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) getResource(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	out, err := s.PG.GetResource(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "resource not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) getResourceTree(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	out, err := s.PG.ResourceTree(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "resource not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listLinks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out, err := s.PG.ListLinks(r.Context(), q.Get("src"), q.Get("dst"), q.Get("fabric"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) catalogStats(w http.ResponseWriter, r *http.Request) {
	out, err := s.PG.CatalogStats(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
