package store

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bytesim/run-svc/internal/model"
)

var ErrNotFound = errors.New("not found")

type PG struct {
	pool *pgxpool.Pool
}

func NewPG(ctx context.Context, dsn string) (*PG, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgx connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("pgx ping: %w", err)
	}
	return &PG{pool: pool}, nil
}

func (p *PG) Close() { p.pool.Close() }

func (p *PG) GetRun(ctx context.Context, id string) (*model.Run, error) {
	const q = `
SELECT id, project_id, kind, title, status, progress_pct, inputs_hash,
       surrogate_ver, confidence, parent_run_id, budget_gpuh, cost_usd,
       started_at, finished_at, kpis, artifacts, boundaries, created_by, created_at
FROM bs_run WHERE id = $1`
	var r model.Run
	err := p.pool.QueryRow(ctx, q, id).Scan(
		&r.ID, &r.ProjectID, &r.Kind, &r.Title, &r.Status, &r.ProgressPct, &r.InputsHash,
		&r.SurrogateVer, &r.Confidence, &r.ParentRunID, &r.BudgetGPUH, &r.CostUSD,
		&r.StartedAt, &r.FinishedAt, &r.KPIs, &r.Artifacts, &r.Boundaries, &r.CreatedBy, &r.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SpecsForRun resolves the four input specs and marks them stale when their
// version no longer matches bs_spec.latest_hash.
func (p *PG) SpecsForRun(ctx context.Context, runID string) ([]model.SpecRef, error) {
	const q = `
SELECT v.hash, s.id, s.kind, s.name, v.version_tag, v.body,
       (s.latest_hash <> v.hash) AS stale
FROM bs_run_uses_spec rus
JOIN bs_spec_version v ON v.hash = rus.spec_hash
JOIN bs_spec s ON s.id = v.spec_id
WHERE rus.run_id = $1
ORDER BY CASE s.kind WHEN 'hwspec' THEN 1 WHEN 'model' THEN 2 WHEN 'strategy' THEN 3 ELSE 4 END`
	rows, err := p.pool.Query(ctx, q, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.SpecRef
	for rows.Next() {
		var s model.SpecRef
		if err := rows.Scan(&s.Hash, &s.SpecID, &s.Kind, &s.Name, &s.VersionTag, &s.Body, &s.Stale); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Lineage walks parent (one hop) and children (recursive via derived_from edge).
func (p *PG) Lineage(ctx context.Context, runID string) (*model.Lineage, error) {
	self, err := p.runNode(ctx, runID)
	if err != nil {
		return nil, err
	}
	out := &model.Lineage{Self: *self}

	// Parent (one hop, edges where src=runID rel=derived_from)
	const parentQ = `
SELECT r.id, r.title, r.status,
       EXISTS (
         SELECT 1 FROM bs_run_uses_spec rus
         JOIN bs_spec_version v ON v.hash = rus.spec_hash
         JOIN bs_spec s ON s.id = v.spec_id
         WHERE rus.run_id = r.id AND s.latest_hash <> v.hash
       ) AS stale
FROM bs_lineage_edge e
JOIN bs_run r ON r.id = e.dst_id
WHERE e.src_kind='run' AND e.src_id=$1 AND e.dst_kind='run' AND e.rel='derived_from'`
	rows, err := p.pool.Query(ctx, parentQ, runID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n model.LineageNode
		n.Kind = "run"
		if err := rows.Scan(&n.ID, &n.Title, &n.Status, &n.Stale); err != nil {
			rows.Close()
			return nil, err
		}
		out.Parents = append(out.Parents, n)
		out.Edges = append(out.Edges, model.LineageEdge{
			SrcKind: "run", SrcID: runID, DstKind: "run", DstID: n.ID, Rel: "derived_from",
		})
	}
	rows.Close()

	// Children (one hop downstream, edges where dst=runID rel=derived_from)
	const childQ = `
SELECT r.id, r.title, r.status,
       EXISTS (
         SELECT 1 FROM bs_run_uses_spec rus
         JOIN bs_spec_version v ON v.hash = rus.spec_hash
         JOIN bs_spec s ON s.id = v.spec_id
         WHERE rus.run_id = r.id AND s.latest_hash <> v.hash
       ) AS stale
FROM bs_lineage_edge e
JOIN bs_run r ON r.id = e.src_id
WHERE e.dst_kind='run' AND e.dst_id=$1 AND e.src_kind='run' AND e.rel='derived_from'`
	rows, err = p.pool.Query(ctx, childQ, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var n model.LineageNode
		n.Kind = "run"
		if err := rows.Scan(&n.ID, &n.Title, &n.Status, &n.Stale); err != nil {
			return nil, err
		}
		out.Children = append(out.Children, n)
		out.Edges = append(out.Edges, model.LineageEdge{
			SrcKind: "run", SrcID: n.ID, DstKind: "run", DstID: runID, Rel: "derived_from",
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	// Append study bridges (slice 6: Run derived from Tuner study trial).
	studyNodes, studyEdges, err := p.StudiesLineageOf(ctx, runID)
	if err == nil {
		out.Parents = append(out.Parents, studyNodes...)
		out.Edges = append(out.Edges, studyEdges...)
	}
	return out, nil
}

// CreateRun materializes a queued Run from the four input spec hashes,
// records spec dependencies, and writes lineage edges (parent + study + trial).
// All in a single transaction so partial state is impossible.
func (p *PG) CreateRun(ctx context.Context, projectID string, req model.CreateRunRequest) (*model.Run, error) {
	if req.HwSpecHash == "" || req.ModelHash == "" {
		return nil, fmt.Errorf("hwspec_hash and model_hash are required")
	}
	kind := req.Kind
	if kind == "" {
		kind = "train"
	}
	prefix := map[string]string{
		"train": "sim", "infer": "inf", "batch": "bat",
		"agent": "agt", "tco": "tco",
	}[kind]
	if prefix == "" {
		prefix = "sim"
	}
	// Per-kind monotonic sequence — see migrations/023_run_sequences.sql.
	// Format: <prefix>-<3-or-more-digits zero-padded>. The %03d is a
	// minimum width; once a kind crosses 999 runs the suffix grows naturally.
	seqName := map[string]string{
		"train": "bs_run_train_seq", "infer": "bs_run_infer_seq",
		"batch": "bs_run_batch_seq", "agent": "bs_run_agent_seq",
		"tco":   "bs_run_tco_seq",
	}[kind]

	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var seqN int64
	if err := tx.QueryRow(ctx, fmt.Sprintf("SELECT nextval('%s')", seqName)).Scan(&seqN); err != nil {
		return nil, fmt.Errorf("nextval(%s): %w", seqName, err)
	}
	id := fmt.Sprintf("%s-%03d", prefix, seqN)
	if req.Title == "" {
		req.Title = "新 Run · " + id
	}

	hashes := []string{req.HwSpecHash, req.ModelHash, req.StrategyHash, req.WorkloadHash}
	inputsHash := sha1Joined(hashes)

	overrideJSON := []byte("null")
	if req.StrategyOverride != nil {
		overrideJSON, _ = json.Marshal(req.StrategyOverride)
	}
	kpis := map[string]any{}
	if req.DerivedFromTrial != nil {
		kpis["_derived_from_trial"] = *req.DerivedFromTrial
	}
	if req.DerivedFromStudy != nil {
		kpis["_derived_from_study"] = *req.DerivedFromStudy
	}
	if req.StrategyOverride != nil {
		kpis["_strategy_override"] = req.StrategyOverride
		_ = overrideJSON
	}
	if req.ClusterOverride != nil {
		kpis["_cluster_override"] = req.ClusterOverride
	}
	if req.WorkloadOverride != nil {
		kpis["_workload_override"] = req.WorkloadOverride
	}
	if req.EnginePreference != "" {
		kpis["_engine_preference"] = req.EnginePreference
	}
	kpisJSON, _ := json.Marshal(kpis)

	_, err = tx.Exec(ctx, `
INSERT INTO bs_run (id, project_id, kind, title, status, inputs_hash,
                    surrogate_ver, parent_run_id, budget_gpuh, kpis, artifacts, boundaries, created_by)
VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9::jsonb, '[]'::jsonb, '[]'::jsonb, $10)
`,
		id, projectID, kind, req.Title, inputsHash, nilIfEmpty(req.SurrogateVer),
		req.ParentRunID, req.BudgetGPUH, kpisJSON, nilIfEmpty(req.CreatedBy),
	)
	if err != nil {
		return nil, err
	}

	for _, h := range hashes {
		if h == "" {
			continue
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO bs_run_uses_spec (run_id, spec_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			id, h,
		); err != nil {
			return nil, err
		}
	}

	if req.ParentRunID != nil {
		if _, err := tx.Exec(ctx, `
INSERT INTO bs_lineage_edge (src_kind, src_id, dst_kind, dst_id, rel)
VALUES ('run', $1, 'run', $2, 'derived_from')
ON CONFLICT DO NOTHING`, id, *req.ParentRunID); err != nil {
			return nil, err
		}
	}
	if req.DerivedFromStudy != nil {
		meta := map[string]any{}
		if req.DerivedFromTrial != nil {
			meta["trial_index"] = *req.DerivedFromTrial
		}
		mb, _ := json.Marshal(meta)
		if _, err := tx.Exec(ctx, `
INSERT INTO bs_lineage_edge (src_kind, src_id, dst_kind, dst_id, rel, meta)
VALUES ('run', $1, 'study', $2, 'derived_from_study', $3::jsonb)
ON CONFLICT DO NOTHING`, id, *req.DerivedFromStudy, mb); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return p.GetRun(ctx, id)
}

// StudiesLineageOf returns adjacent study nodes (derived_from_study edges) so
// the Run-detail lineage graph can render the bridge node from §3.
func (p *PG) StudiesLineageOf(ctx context.Context, runID string) ([]model.LineageNode, []model.LineageEdge, error) {
	const q = `
SELECT s.id, s.name, s.status
FROM bs_lineage_edge e
JOIN bs_tuner_study s ON s.id = e.dst_id
WHERE e.src_kind='run' AND e.src_id=$1 AND e.dst_kind='study' AND e.rel='derived_from_study'`
	rows, err := p.pool.Query(ctx, q, runID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var nodes []model.LineageNode
	var edges []model.LineageEdge
	for rows.Next() {
		var n model.LineageNode
		n.Kind = "study"
		if err := rows.Scan(&n.ID, &n.Title, &n.Status); err != nil {
			return nil, nil, err
		}
		nodes = append(nodes, n)
		edges = append(edges, model.LineageEdge{
			SrcKind: "run", SrcID: runID,
			DstKind: "study", DstID: n.ID, Rel: "derived_from_study",
		})
	}
	return nodes, edges, rows.Err()
}

// DeleteRun removes a run + the FK rows that don't already cascade.
// `bs_run_uses_spec` and `bs_accuracy_record` cascade automatically; the
// other two (`bs_plan_slot`, `bs_tco_breakdown`) are NO-ACTION FKs from
// older migrations, so we explicitly clean them inside the same tx.
func (p *PG) DeleteRun(ctx context.Context, id string) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM bs_plan_slot WHERE run_id = $1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM bs_tco_breakdown WHERE run_id = $1`, id); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM bs_run WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ClaimNextQueued atomically marks the next queued Run as running and returns it.
// engine-svc workers race on this; SQL `UPDATE ... RETURNING` guarantees only
// one worker sees each Run. Returns ErrNotFound when the queue is empty.
func (p *PG) ClaimNextQueued(ctx context.Context, projectID string) (*model.Run, error) {
	const q = `
WITH picked AS (
  SELECT id FROM bs_run
  WHERE project_id = $1 AND status = 'queued'
  ORDER BY COALESCE(started_at, created_at)
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE bs_run SET status = 'running', started_at = COALESCE(started_at, now()), progress_pct = 0
WHERE id IN (SELECT id FROM picked)
RETURNING id`
	var rid string
	err := p.pool.QueryRow(ctx, q, projectID).Scan(&rid)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return p.GetRun(ctx, rid)
}

// CancelRun flips a queued or running Run to 'cancelled'. Returns the run +
// whether engine work was already in flight (caller may want to signal).
func (p *PG) CancelRun(ctx context.Context, runID string) (*model.Run, bool, error) {
	const q = `
UPDATE bs_run SET status='cancelled', finished_at=now()
WHERE id=$1 AND status IN ('queued','running')
RETURNING (SELECT status FROM bs_run WHERE id=$1) AS prev`
	var prev string
	err := p.pool.QueryRow(ctx, q, runID).Scan(&prev)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	wasRunning := prev == "running"
	r, err := p.GetRun(ctx, runID)
	return r, wasRunning, err
}

// PatchRun applies engine-svc updates: status / progress / kpis (shallow-merged) /
// artifacts (replace) / confidence / timestamps. Returns the post-update Run.
func (p *PG) PatchRun(ctx context.Context, runID string, req model.PatchRunRequest) (*model.Run, error) {
	sets := []string{}
	args := []any{runID}

	if req.Status != nil {
		args = append(args, *req.Status)
		sets = append(sets, fmt.Sprintf("status = $%d", len(args)))
	}
	if req.ProgressPct != nil {
		args = append(args, *req.ProgressPct)
		sets = append(sets, fmt.Sprintf("progress_pct = $%d", len(args)))
	}
	if req.Confidence != nil {
		args = append(args, *req.Confidence)
		sets = append(sets, fmt.Sprintf("confidence = $%d", len(args)))
	}
	if req.KPIs != nil {
		patch, err := json.Marshal(req.KPIs)
		if err != nil {
			return nil, err
		}
		args = append(args, string(patch))
		// Deep-merge so a later progress patch can't clobber a previously-stamped
		// nested object (e.g. _engine_provenance written at attribution time).
		// jsonb_deep_merge is defined in infra/postgres/017_jsonb_deep_merge.sql.
		sets = append(sets, fmt.Sprintf("kpis = jsonb_deep_merge(COALESCE(kpis, '{}'::jsonb), $%d::jsonb)", len(args)))
	}
	if req.Artifacts != nil {
		buf, err := json.Marshal(req.Artifacts)
		if err != nil {
			return nil, err
		}
		args = append(args, string(buf))
		sets = append(sets, fmt.Sprintf("artifacts = $%d::jsonb", len(args)))
	}
	if req.Boundaries != nil {
		buf, err := json.Marshal(req.Boundaries)
		if err != nil {
			return nil, err
		}
		args = append(args, string(buf))
		sets = append(sets, fmt.Sprintf("boundaries = $%d::jsonb", len(args)))
	}
	if req.StartedAt != nil {
		if *req.StartedAt == "" {
			sets = append(sets, "started_at = NULL")
		} else {
			ts, err := time.Parse(time.RFC3339, *req.StartedAt)
			if err != nil {
				return nil, fmt.Errorf("started_at: %w", err)
			}
			args = append(args, ts)
			sets = append(sets, fmt.Sprintf("started_at = $%d", len(args)))
		}
	}
	if req.FinishedAt != nil {
		if *req.FinishedAt == "" {
			sets = append(sets, "finished_at = NULL")
		} else {
			ts, err := time.Parse(time.RFC3339, *req.FinishedAt)
			if err != nil {
				return nil, fmt.Errorf("finished_at: %w", err)
			}
			args = append(args, ts)
			sets = append(sets, fmt.Sprintf("finished_at = $%d", len(args)))
		}
	}

	if len(sets) == 0 {
		return p.GetRun(ctx, runID)
	}
	q := fmt.Sprintf("UPDATE bs_run SET %s WHERE id = $1", strings.Join(sets, ", "))
	tag, err := p.pool.Exec(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return p.GetRun(ctx, runID)
}

// ── List ────────────────────────────────────────────────────────────────

type ListRunsFilter struct {
	ProjectID string
	Statuses  []string // empty = no filter
	Kinds     []string
	Limit     int
}

// ListRuns powers the dashboard "进行中 / failed / 近期" rows. We deliberately
// keep this lean — no full-text or pagination cursors, just enough to hydrate
// 4-row cards. Add cursor pagination once the dashboard grows infinite-scroll.
func (p *PG) ListRuns(ctx context.Context, f ListRunsFilter) ([]model.Run, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 20
	}
	clauses := []string{}
	args := []any{}
	if f.ProjectID != "" {
		args = append(args, f.ProjectID)
		clauses = append(clauses, fmt.Sprintf("project_id = $%d", len(args)))
	}
	if len(f.Statuses) > 0 {
		args = append(args, f.Statuses)
		clauses = append(clauses, fmt.Sprintf("status = ANY($%d::text[])", len(args)))
	}
	if len(f.Kinds) > 0 {
		args = append(args, f.Kinds)
		clauses = append(clauses, fmt.Sprintf("kind = ANY($%d::text[])", len(args)))
	}
	q := `SELECT id, project_id, kind, title, status, progress_pct, inputs_hash,
	             surrogate_ver, confidence, parent_run_id, budget_gpuh, cost_usd,
	             started_at, finished_at, kpis, artifacts, boundaries, created_by, created_at
	      FROM bs_run`
	if len(clauses) > 0 {
		q += " WHERE " + strings.Join(clauses, " AND ")
	}
	args = append(args, f.Limit)
	q += fmt.Sprintf(` ORDER BY COALESCE(started_at, created_at) DESC LIMIT $%d`, len(args))

	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Run{}
	for rows.Next() {
		var r model.Run
		if err := rows.Scan(
			&r.ID, &r.ProjectID, &r.Kind, &r.Title, &r.Status, &r.ProgressPct, &r.InputsHash,
			&r.SurrogateVer, &r.Confidence, &r.ParentRunID, &r.BudgetGPUH, &r.CostUSD,
			&r.StartedAt, &r.FinishedAt, &r.KPIs, &r.Artifacts, &r.Boundaries, &r.CreatedBy, &r.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CountRunsSince powers the dashboard "本月 Runs" counter.
func (p *PG) CountRunsSince(ctx context.Context, projectID string, since time.Time) (int, error) {
	const q = `SELECT COUNT(*) FROM bs_run WHERE project_id = $1 AND created_at >= $2`
	var n int
	err := p.pool.QueryRow(ctx, q, projectID, since).Scan(&n)
	return n, err
}

// AvgConfidence reports the platform average over completed Runs.
func (p *PG) AvgConfidence(ctx context.Context, projectID string) (float64, error) {
	const q = `SELECT COALESCE(AVG(confidence), 0) FROM bs_run WHERE project_id=$1 AND confidence IS NOT NULL`
	var v float64
	err := p.pool.QueryRow(ctx, q, projectID).Scan(&v)
	return v, err
}

// StaleRuns surfaces Runs whose pinned spec hash is no longer the latest. Used
// for the "spec stale → 待重算" inbox row.
func (p *PG) StaleRuns(ctx context.Context, projectID string, limit int) ([]model.Run, error) {
	if limit <= 0 || limit > 200 {
		limit = 10
	}
	// PG requires ORDER BY expressions to appear in the SELECT list when
	// SELECT DISTINCT is used. We dedupe at the run level (one row per run
	// even if it joins multiple stale specs) by promoting the join to an
	// EXISTS subquery so the outer SELECT stays free to ORDER BY any column.
	const q = `
SELECT r.id, r.project_id, r.kind, r.title, r.status, r.progress_pct, r.inputs_hash,
       r.surrogate_ver, r.confidence, r.parent_run_id, r.budget_gpuh, r.cost_usd,
       r.started_at, r.finished_at, r.kpis, r.artifacts, r.boundaries, r.created_by, r.created_at
FROM bs_run r
WHERE r.project_id = $1
  AND EXISTS (
      SELECT 1 FROM bs_run_uses_spec rus
      JOIN bs_spec_version v ON v.hash = rus.spec_hash
      JOIN bs_spec s ON s.id = v.spec_id
      WHERE rus.run_id = r.id AND s.latest_hash <> v.hash
  )
ORDER BY COALESCE(r.started_at, r.created_at) DESC
LIMIT $2`
	rows, err := p.pool.Query(ctx, q, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Run{}
	for rows.Next() {
		var r model.Run
		if err := rows.Scan(
			&r.ID, &r.ProjectID, &r.Kind, &r.Title, &r.Status, &r.ProgressPct, &r.InputsHash,
			&r.SurrogateVer, &r.Confidence, &r.ParentRunID, &r.BudgetGPUH, &r.CostUSD,
			&r.StartedAt, &r.FinishedAt, &r.KPIs, &r.Artifacts, &r.Boundaries, &r.CreatedBy, &r.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ── Plans ───────────────────────────────────────────────────────────────

var planSlots = []string{"A", "B", "C", "D", "E", "F", "G", "H"}

func (p *PG) GetPlan(ctx context.Context, planID string) (*model.Plan, error) {
	const planQ = `SELECT id, project_id, name, recommended_run_id, created_by, created_at FROM bs_plan WHERE id=$1`
	var pl model.Plan
	var ts time.Time
	err := p.pool.QueryRow(ctx, planQ, planID).Scan(
		&pl.ID, &pl.ProjectID, &pl.Name, &pl.RecommendedRunID, &pl.CreatedBy, &ts,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	pl.CreatedAt = ts.Format(time.RFC3339)

	rows, err := p.pool.Query(ctx,
		`SELECT slot, run_id, added_at FROM bs_plan_slot WHERE plan_id=$1 ORDER BY slot`,
		planID,
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var s model.PlanSlot
		var addedAt time.Time
		if err := rows.Scan(&s.Slot, &s.RunID, &addedAt); err != nil {
			rows.Close()
			return nil, err
		}
		s.AddedAt = addedAt.Format(time.RFC3339)
		pl.Slots = append(pl.Slots, s)
	}
	rows.Close()

	// Hydrate each slot's Run in parallel — but sequentially is fine at slice scale.
	for i := range pl.Slots {
		r, err := p.GetRun(ctx, pl.Slots[i].RunID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		pl.Slots[i].Run = r
	}
	return &pl, nil
}

func (p *PG) CreatePlan(ctx context.Context, projectID string, req model.CreatePlanRequest) (*model.Plan, error) {
	id := "plan-" + randomHex(3)
	if req.Name == "" {
		req.Name = "新方案对比 · " + id
	}
	_, err := p.pool.Exec(ctx,
		`INSERT INTO bs_plan (id, project_id, name, recommended_run_id, created_by) VALUES ($1,$2,$3,$4,$5)`,
		id, projectID, req.Name, req.RecommendedRunID, nilIfEmpty(req.CreatedBy),
	)
	if err != nil {
		return nil, err
	}
	return p.GetPlan(ctx, id)
}

func (p *PG) AddPlanSlot(ctx context.Context, planID string, req model.AddSlotRequest) (*model.Plan, error) {
	if req.RunID == "" {
		return nil, fmt.Errorf("run_id required")
	}
	slot := req.Slot
	if slot == "" {
		used := map[string]bool{}
		rows, err := p.pool.Query(ctx, `SELECT slot FROM bs_plan_slot WHERE plan_id=$1`, planID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var s string
			_ = rows.Scan(&s)
			used[s] = true
		}
		rows.Close()
		for _, candidate := range planSlots {
			if !used[candidate] {
				slot = candidate
				break
			}
		}
		if slot == "" {
			return nil, fmt.Errorf("plan is full (8 slots)")
		}
	}
	_, err := p.pool.Exec(ctx,
		`INSERT INTO bs_plan_slot (plan_id, slot, run_id) VALUES ($1, $2, $3)
		 ON CONFLICT (plan_id, slot) DO UPDATE SET run_id = EXCLUDED.run_id, added_at = now()`,
		planID, slot, req.RunID,
	)
	if err != nil {
		return nil, err
	}
	return p.GetPlan(ctx, planID)
}

func (p *PG) RemovePlanSlot(ctx context.Context, planID, slot string) (*model.Plan, error) {
	_, err := p.pool.Exec(ctx, `DELETE FROM bs_plan_slot WHERE plan_id=$1 AND slot=$2`, planID, slot)
	if err != nil {
		return nil, err
	}
	return p.GetPlan(ctx, planID)
}

// nilIfEmpty returns nil for empty strings so pgx writes SQL NULL.
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func sha1Joined(parts []string) string {
	h := sha1.New()
	for i, p := range parts {
		if i > 0 {
			h.Write([]byte{0})
		}
		h.Write([]byte(p))
	}
	sum := h.Sum(nil)
	return hex.EncodeToString(sum)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// extremely unlikely; fall back to a constant so we still produce a valid id
		return "deadbe"[:n*2]
	}
	return hex.EncodeToString(b)
}

func (p *PG) runNode(ctx context.Context, id string) (*model.LineageNode, error) {
	const q = `
SELECT r.id, r.title, r.status,
       EXISTS (
         SELECT 1 FROM bs_run_uses_spec rus
         JOIN bs_spec_version v ON v.hash = rus.spec_hash
         JOIN bs_spec s ON s.id = v.spec_id
         WHERE rus.run_id = r.id AND s.latest_hash <> v.hash
       ) AS stale
FROM bs_run r WHERE r.id = $1`
	n := &model.LineageNode{Kind: "run"}
	err := p.pool.QueryRow(ctx, q, id).Scan(&n.ID, &n.Title, &n.Status, &n.Stale)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return n, err
}
