package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/bytesim/asset-svc/internal/model"
)

// ── Catalog (§1 Resource Ontology) ──
//
// Reads bs_resource / bs_link. Lifecycle filter defaults to 'active' so demo
// SKUs that have been retired don't pollute live searches.

type ResourceFilter struct {
	Kind           string   // optional, exact match
	Lifecycles     []string // defaults to {"active"} if empty
	ParentID       string   // optional, exact match
	FailureDomain  string   // optional, exact match
	IncludeRetired bool     // if true, ignores Lifecycles default and returns everything
}

func (p *PG) ListResources(ctx context.Context, f ResourceFilter) ([]model.Resource, error) {
	q := `
SELECT id, kind, parent_id, vendor_sku, attrs, lifecycle,
       cost_capex_usd, power_w_max, failure_domain, source
FROM bs_resource
WHERE 1=1`
	args := []any{}
	idx := 1
	if f.Kind != "" {
		q += fmt.Sprintf(" AND kind = $%d", idx)
		args = append(args, f.Kind)
		idx++
	}
	if f.ParentID != "" {
		q += fmt.Sprintf(" AND parent_id = $%d", idx)
		args = append(args, f.ParentID)
		idx++
	}
	if f.FailureDomain != "" {
		q += fmt.Sprintf(" AND failure_domain = $%d", idx)
		args = append(args, f.FailureDomain)
		idx++
	}
	if !f.IncludeRetired {
		ls := f.Lifecycles
		if len(ls) == 0 {
			ls = []string{"active"}
		}
		q += fmt.Sprintf(" AND lifecycle = ANY($%d)", idx)
		args = append(args, ls)
		idx++
	}
	q += " ORDER BY kind, id"

	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Resource{}
	for rows.Next() {
		var r model.Resource
		if err := rows.Scan(&r.ID, &r.Kind, &r.ParentID, &r.VendorSKU, &r.Attrs,
			&r.Lifecycle, &r.CostCapexUSD, &r.PowerWMax, &r.FailureDomain, &r.Source); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PG) GetResource(ctx context.Context, id string) (*model.Resource, error) {
	const q = `
SELECT id, kind, parent_id, vendor_sku, attrs, lifecycle,
       cost_capex_usd, power_w_max, failure_domain, source
FROM bs_resource WHERE id = $1`
	var r model.Resource
	err := p.pool.QueryRow(ctx, q, id).Scan(
		&r.ID, &r.Kind, &r.ParentID, &r.VendorSKU, &r.Attrs,
		&r.Lifecycle, &r.CostCapexUSD, &r.PowerWMax, &r.FailureDomain, &r.Source,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &r, err
}

// ResourceTree returns rootID and all of its descendants assembled into a
// nested structure. Walks via parent_id; cycles are impossible since the
// schema forbids them (parent must exist and tree depth is bounded by kind).
func (p *PG) ResourceTree(ctx context.Context, rootID string) (*model.ResourceTreeNode, error) {
	root, err := p.GetResource(ctx, rootID)
	if err != nil {
		return nil, err
	}
	// Pull every descendant in one query then assemble in memory.
	const q = `
WITH RECURSIVE descendants AS (
  SELECT id, kind, parent_id, vendor_sku, attrs, lifecycle,
         cost_capex_usd, power_w_max, failure_domain, source, 0 AS depth
  FROM bs_resource WHERE id = $1
  UNION ALL
  SELECT r.id, r.kind, r.parent_id, r.vendor_sku, r.attrs, r.lifecycle,
         r.cost_capex_usd, r.power_w_max, r.failure_domain, r.source, d.depth+1
  FROM bs_resource r JOIN descendants d ON r.parent_id = d.id
  WHERE d.depth < 12
)
SELECT id, kind, parent_id, vendor_sku, attrs, lifecycle,
       cost_capex_usd, power_w_max, failure_domain, source
FROM descendants WHERE id != $1`
	rows, err := p.pool.Query(ctx, q, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byParent := map[string][]model.ResourceTreeNode{}
	for rows.Next() {
		var r model.Resource
		if err := rows.Scan(&r.ID, &r.Kind, &r.ParentID, &r.VendorSKU, &r.Attrs,
			&r.Lifecycle, &r.CostCapexUSD, &r.PowerWMax, &r.FailureDomain, &r.Source); err != nil {
			return nil, err
		}
		pid := ""
		if r.ParentID != nil {
			pid = *r.ParentID
		}
		byParent[pid] = append(byParent[pid], model.ResourceTreeNode{Resource: r})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	tree := model.ResourceTreeNode{Resource: *root}
	attachChildren(&tree, byParent)
	return &tree, nil
}

func attachChildren(n *model.ResourceTreeNode, byParent map[string][]model.ResourceTreeNode) {
	kids := byParent[n.ID]
	n.Children = make([]model.ResourceTreeNode, len(kids))
	for i := range kids {
		n.Children[i] = kids[i]
		attachChildren(&n.Children[i], byParent)
	}
}

func (p *PG) ListLinks(ctx context.Context, srcID, dstID, fabric string) ([]model.Link, error) {
	q := `
SELECT id, src_id, dst_id, fabric, bw_gbps, rtt_us, attrs, source
FROM bs_link WHERE 1=1`
	args := []any{}
	idx := 1
	if srcID != "" {
		q += fmt.Sprintf(" AND src_id = $%d", idx)
		args = append(args, srcID)
		idx++
	}
	if dstID != "" {
		q += fmt.Sprintf(" AND dst_id = $%d", idx)
		args = append(args, dstID)
		idx++
	}
	if fabric != "" {
		q += fmt.Sprintf(" AND fabric = $%d", idx)
		args = append(args, fabric)
		idx++
	}
	q += " ORDER BY id"
	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Link{}
	for rows.Next() {
		var l model.Link
		if err := rows.Scan(&l.ID, &l.SrcID, &l.DstID, &l.Fabric, &l.BWGbps, &l.RTTUs, &l.Attrs, &l.Source); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (p *PG) CatalogStats(ctx context.Context) (*model.CatalogStats, error) {
	rows, err := p.pool.Query(ctx, "SELECT kind, lifecycle, count(*) FROM bs_resource GROUP BY kind, lifecycle")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	stats := &model.CatalogStats{ByKind: map[string]int{}, ByLifecycle: map[string]int{}}
	for rows.Next() {
		var kind, lifecycle string
		var n int
		if err := rows.Scan(&kind, &lifecycle, &n); err != nil {
			return nil, err
		}
		stats.Total += n
		stats.ByKind[kind] += n
		stats.ByLifecycle[lifecycle] += n
	}
	return stats, rows.Err()
}
