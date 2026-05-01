package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bytesim/run-svc/internal/model"
	"github.com/bytesim/run-svc/internal/store"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode error: %v", err)
	}
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	run, err := s.PG.GetRun(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "run not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) getSpecs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	specs, err := s.PG.SpecsForRun(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, specs)
}

func (s *Server) getLineage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	lin, err := s.PG.Lineage(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "run not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, lin)
}

func (s *Server) claimNext(w http.ResponseWriter, r *http.Request) {
	project := orDefault(r.URL.Query().Get("project"), "p_default")
	run, err := s.PG.ClaimNextQueued(r.Context(), project)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNoContent, nil) // empty queue
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) cancelRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	run, wasRunning, err := s.PG.CancelRun(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "run not found or not cancellable: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.Artifacts.AppendLog(id, "[--:--:--] ENGINE · cancelled by user")
	writeJSON(w, http.StatusOK, map[string]any{"run": run, "was_running": wasRunning})
}

func (s *Server) deleteRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.PG.DeleteRun(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "run not found: "+id)
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Best-effort artifact cleanup; don't fail the request if disk delete trips.
	if err := s.Artifacts.RemoveAll(id); err != nil {
		// log only — DB row is already gone, the disk dir is now an orphan
		// and will be re-created if a new run with the same id ever lands.
		_ = err
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) patchRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.PatchRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	if req.LogAppend != "" {
		if err := s.Artifacts.AppendLog(id, req.LogAppend); err != nil {
			log.Printf("appendlog %s: %v", id, err)
		}
	}
	run, err := s.PG.PatchRun(r.Context(), id, req)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "run not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) listRuns(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.ListRunsFilter{
		ProjectID: orDefault(q.Get("project"), "p_default"),
		Statuses:  splitCSV(q.Get("status")),
		Kinds:     splitCSV(q.Get("kind")),
		Limit:     atoi(q.Get("limit"), 20),
	}
	runs, err := s.PG.ListRuns(r.Context(), f)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) listStaleRuns(w http.ResponseWriter, r *http.Request) {
	project := orDefault(r.URL.Query().Get("project"), "p_default")
	limit := atoi(r.URL.Query().Get("limit"), 10)
	runs, err := s.PG.StaleRuns(r.Context(), project, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) runStats(w http.ResponseWriter, r *http.Request) {
	project := orDefault(r.URL.Query().Get("project"), "p_default")
	monthStart := time.Now().UTC().AddDate(0, 0, -30) // last 30 days as "本月"
	monthCount, err := s.PG.CountRunsSince(r.Context(), project, monthStart)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	avgConf, err := s.PG.AvgConfidence(r.Context(), project)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"runs_last_30d":   monthCount,
		"avg_confidence":  avgConf,
		"window_starts":   monthStart.Format(time.RFC3339),
	})
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func atoi(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func (s *Server) createRun(w http.ResponseWriter, r *http.Request) {
	var req model.CreateRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	// Slice-6 hardcodes the project; switch to header-derived once auth lands.
	run, err := s.PG.CreateRun(r.Context(), "p_default", req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, run)
}

func (s *Server) getPlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	pl, err := s.PG.GetPlan(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "plan not found: "+id)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, pl)
}

func (s *Server) createPlan(w http.ResponseWriter, r *http.Request) {
	var req model.CreatePlanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	pl, err := s.PG.CreatePlan(r.Context(), "p_default", req)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, pl)
}

func (s *Server) addPlanSlot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.AddSlotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	pl, err := s.PG.AddPlanSlot(r.Context(), id, req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, pl)
}

func (s *Server) removePlanSlot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	slot := r.PathValue("slot")
	pl, err := s.PG.RemovePlanSlot(r.Context(), id, slot)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, pl)
}

func (s *Server) getArtifact(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	name := r.PathValue("name")
	rc, size, err := s.Artifacts.Open(runID, name)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	if _, err := io.Copy(w, rc); err != nil {
		log.Printf("artifact stream error: %v", err)
	}
}
