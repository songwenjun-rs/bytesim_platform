package store

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bytesim/asset-svc/internal/model"
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

func (p *PG) GetLatest(ctx context.Context, specID string) (*model.SpecLatest, error) {
	const q = `
SELECT s.id, s.kind, s.name, s.project_id, s.latest_hash, s.created_at,
       v.hash, v.spec_id, v.parent_hash, v.version_tag, v.body, v.created_at
FROM bs_spec s
JOIN bs_spec_version v ON v.hash = s.latest_hash
WHERE s.id = $1`
	var out model.SpecLatest
	err := p.pool.QueryRow(ctx, q, specID).Scan(
		&out.Spec.ID, &out.Spec.Kind, &out.Spec.Name, &out.Spec.ProjectID, &out.Spec.LatestHash, &out.Spec.CreatedAt,
		&out.Version.Hash, &out.Version.SpecID, &out.Version.ParentHash, &out.Version.VersionTag, &out.Version.Body, &out.Version.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &out, err
}

func (p *PG) ListSpecs(ctx context.Context, kind string) ([]model.Spec, error) {
	const q = `
SELECT id, kind, name, project_id, latest_hash, created_at
FROM bs_spec WHERE kind = $1 ORDER BY created_at ASC, id ASC`
	rows, err := p.pool.Query(ctx, q, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Spec{}
	for rows.Next() {
		var s model.Spec
		if err := rows.Scan(&s.ID, &s.Kind, &s.Name, &s.ProjectID, &s.LatestHash, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PG) ListVersions(ctx context.Context, specID string) ([]model.SpecVersion, error) {
	const q = `
SELECT hash, spec_id, parent_hash, version_tag, '{}'::jsonb, created_at
FROM bs_spec_version WHERE spec_id = $1 ORDER BY created_at DESC`
	rows, err := p.pool.Query(ctx, q, specID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.SpecVersion
	for rows.Next() {
		var v model.SpecVersion
		if err := rows.Scan(&v.Hash, &v.SpecID, &v.ParentHash, &v.VersionTag, &v.Body, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Snapshot freezes a body into a new immutable version and bumps spec.latest_hash.
// The hash is sha1 of canonical body bytes (caller must canonicalize OR we accept
// raw bytes as-is — slice 2 takes the second route to keep parity simple).
func (p *PG) Snapshot(ctx context.Context, specID string, req model.SnapshotRequest) (*model.SpecVersion, error) {
	if len(req.Body) == 0 {
		return nil, errors.New("body required")
	}
	hash := sha1Hex(req.Body)

	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Resolve parent hash + figure out next version tag if absent.
	var (
		currentLatest string
		existing      []string
	)
	if err := tx.QueryRow(ctx, `SELECT latest_hash FROM bs_spec WHERE id=$1 FOR UPDATE`, specID).Scan(&currentLatest); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Self-create the bs_spec row so a from-scratch UI flow (DB just
			// got wiped, user clicks 「保存」 in 集群配置) works without an
			// admin-only seed step. Default kind/name are derived from id.
			kind := "hwspec"
			if len(specID) > 0 {
				switch {
				case len(specID) >= 6 && specID[:6] == "model_":
					kind = "model"
				case len(specID) >= 9 && specID[:9] == "strategy_":
					kind = "strategy"
				case len(specID) >= 9 && specID[:9] == "workload_":
					kind = "workload"
				}
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO bs_spec (id, kind, name, project_id, latest_hash)
				 VALUES ($1, $2, $1, 'p_default', $3)`,
				specID, kind, hash); err != nil {
				return nil, err
			}
			currentLatest = hash // first version
		} else {
			return nil, err
		}
	}
	parent := req.ParentHash
	if parent == "" {
		parent = currentLatest
	}
	versionTag := req.VersionTag
	if versionTag == "" {
		rows, err := tx.Query(ctx, `SELECT version_tag FROM bs_spec_version WHERE spec_id=$1`, specID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var t string
			_ = rows.Scan(&t)
			existing = append(existing, t)
		}
		rows.Close()
		versionTag = nextVersionTag(existing)
	}

	// Idempotent: if this hash already exists for this spec, just bump latest_hash.
	var existingTag string
	err = tx.QueryRow(ctx, `SELECT version_tag FROM bs_spec_version WHERE hash=$1 AND spec_id=$2`, hash, specID).Scan(&existingTag)
	if err == nil {
		if _, err := tx.Exec(ctx, `UPDATE bs_spec SET latest_hash=$1 WHERE id=$2`, hash, specID); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return p.getVersion(ctx, hash)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO bs_spec_version (hash, spec_id, parent_hash, version_tag, body) VALUES ($1,$2,$3,$4,$5)`,
		hash, specID, nullableStr(parent), versionTag, req.Body,
	); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE bs_spec SET latest_hash=$1 WHERE id=$2`, hash, specID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return p.getVersion(ctx, hash)
}

func (p *PG) getVersion(ctx context.Context, hash string) (*model.SpecVersion, error) {
	const q = `SELECT hash, spec_id, parent_hash, version_tag, body, created_at FROM bs_spec_version WHERE hash=$1`
	var v model.SpecVersion
	if err := p.pool.QueryRow(ctx, q, hash).Scan(&v.Hash, &v.SpecID, &v.ParentHash, &v.VersionTag, &v.Body, &v.CreatedAt); err != nil {
		return nil, err
	}
	return &v, nil
}

// GetVersion is a public alias for the diff handler.
func (p *PG) GetVersion(ctx context.Context, hash string) (*model.SpecVersion, error) {
	return p.getVersion(ctx, hash)
}

// Fork creates a new bs_spec rooted at an existing version. The first version
// of the fork carries `parent_hash = source` so the lineage is traceable.
func (p *PG) Fork(ctx context.Context, sourceSpecID string, req model.ForkRequest) (*model.SpecLatest, error) {
	if req.NewName == "" {
		return nil, fmt.Errorf("new_name required")
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Resolve source row + the version hash to seed from.
	var sourceLatest, sourceProject string
	if err := tx.QueryRow(ctx,
		`SELECT latest_hash, project_id FROM bs_spec WHERE id=$1`, sourceSpecID,
	).Scan(&sourceLatest, &sourceProject); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	fromHash := req.FromHash
	if fromHash == "" {
		fromHash = sourceLatest
	}
	var (
		body       []byte
		sourceKind string
	)
	if err := tx.QueryRow(ctx,
		`SELECT v.body, s.kind FROM bs_spec_version v
		 JOIN bs_spec s ON s.id = v.spec_id
		 WHERE v.hash=$1 AND v.spec_id=$2`,
		fromHash, sourceSpecID,
	).Scan(&body, &sourceKind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("from_hash %s not found for spec %s", fromHash, sourceSpecID)
		}
		return nil, err
	}

	newSpecID := req.NewSpecID
	if newSpecID == "" {
		newSpecID = fmt.Sprintf("%s_fork_%s", sourceSpecID, randomHex(3))
	}
	versionTag := req.VersionTag
	if versionTag == "" {
		versionTag = "v1"
	}
	// First version of the fork: hash = sha1(body) just like Snapshot does.
	newHash := sha1Hex(body)

	if _, err := tx.Exec(ctx,
		`INSERT INTO bs_spec (id, kind, name, project_id, latest_hash) VALUES ($1, $2, $3, $4, $5)`,
		newSpecID, sourceKind, req.NewName, sourceProject, newHash,
	); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO bs_spec_version (hash, spec_id, parent_hash, version_tag, body)
		 VALUES ($1, $2, $3, $4, $5)`,
		newHash, newSpecID, fromHash, versionTag, body,
	); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return p.GetLatest(ctx, newSpecID)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "deadbe"[:n*2]
	}
	return hex.EncodeToString(b)
}

// sha1Hex / nextVersionTag live below — declared once in slice-2.

func sha1Hex(b []byte) string {
	sum := sha1.Sum(b)
	return hex.EncodeToString(sum[:])
}

// nextVersionTag returns "vN+1" where N = max numeric suffix among existing tags
// of the form "vN". Non-numeric tags ("v3-gb300") are ignored for the bump.
func nextVersionTag(existing []string) string {
	max := 0
	for _, t := range existing {
		t = strings.TrimSpace(t)
		if !strings.HasPrefix(t, "v") {
			continue
		}
		num, err := strconv.Atoi(strings.SplitN(t[1:], "-", 2)[0])
		if err == nil && num > max {
			max = num
		}
	}
	sort.Strings(existing) // stable across runs for tests
	return fmt.Sprintf("v%d", max+1)
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ── Catalog (bs_catalog) ────────────────────────────────────────────────────

func (p *PG) ListCatalog(ctx context.Context, kind string) ([]model.CatalogItem, error) {
	rows, err := p.pool.Query(ctx,
		`SELECT kind, id, name, body FROM bs_catalog
		 WHERE kind = $1 ORDER BY created_at, id`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.CatalogItem, 0)
	for rows.Next() {
		var c model.CatalogItem
		if err := rows.Scan(&c.Kind, &c.ID, &c.Name, &c.Body); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *PG) UpsertCatalog(ctx context.Context, kind, id, name string, body []byte) error {
	_, err := p.pool.Exec(ctx,
		`INSERT INTO bs_catalog (kind, id, name, body, updated_at)
		 VALUES ($1, $2, $3, $4::jsonb, now())
		 ON CONFLICT (kind, id) DO UPDATE
		   SET name = EXCLUDED.name, body = EXCLUDED.body, updated_at = now()`,
		kind, id, name, body)
	return err
}

func (p *PG) DeleteCatalog(ctx context.Context, kind, id string) error {
	tag, err := p.pool.Exec(ctx,
		`DELETE FROM bs_catalog WHERE kind=$1 AND id=$2`, kind, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
