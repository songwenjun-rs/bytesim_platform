-- ByteSim §1: Resource Ontology — 把 HwSpec 的 jsonb 块拆成可索引的实体树。
--
-- 现有 HwSpec.body 仍保留作为"显示用快照"，但新一代代码（catalog-svc / tco-engine /
-- tuner 约束求解）通过这两张表查询硬件实体。
--
-- 设计要点：
--   * 单一 bs_resource 表 + kind 区分（site/pod/row/rack/pdu/server/gpu/nic/link/cooling），
--     避免每加一种实体就开新表。强 schema 校验放在应用层（catalog-svc）。
--   * 时间窗 effective tstzrange：什么时候上线/退役，长时仿真 (§3) 必需。
--   * failure_domain 字段：为 §3 故障模型做铺垫（同一 PDU 共因故障）。
--   * source 字段：区分 demo / hand_curated / imported_from_snapshot（为 §6 留位）。

CREATE TABLE bs_resource (
  id              TEXT PRIMARY KEY,                -- "rack-bj1-r03" / "gpu-bj1-r03-srv-01-g0"
  kind            TEXT NOT NULL CHECK (kind IN (
                    'site','pod','row','rack','pdu','cooling',
                    'server','gpu','cpu','nic','switch','link'
                  )),
  parent_id       TEXT REFERENCES bs_resource(id),
  vendor_sku      TEXT,                            -- "Nvidia/H200-NVL-141GB"
  attrs           JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                   -- per-kind 字段（hbm_gb, fp8_pflops, tdp_kw 等）
  lifecycle       TEXT NOT NULL DEFAULT 'active'
                  CHECK (lifecycle IN ('planned','ordered','installed','active','retired')),
  effective       TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL, '[)'),
  cost_capex_usd  NUMERIC,                         -- 用于 §5 TCO 计算
  power_w_max     INT,                             -- 用于 §5 TCO + §1 容量约束
  failure_domain  TEXT,                            -- 用于 §3 故障共因
  source          TEXT NOT NULL DEFAULT 'hand_curated'
                  CHECK (source IN ('demo','hand_curated','imported_from_snapshot')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_resource_kind_lifecycle ON bs_resource (kind, lifecycle);
CREATE INDEX bs_resource_parent ON bs_resource (parent_id);
CREATE INDEX bs_resource_failure_domain ON bs_resource (failure_domain);
CREATE INDEX bs_resource_effective ON bs_resource USING gist (effective);

-- 链路：任意 resource 间，可携带带宽/延迟/拥塞模型。
-- 不复用 parent_id 是因为 link 是 N:N 关系，硬件树是 1:N。
CREATE TABLE bs_link (
  id              TEXT PRIMARY KEY,
  src_id          TEXT NOT NULL REFERENCES bs_resource(id),
  dst_id          TEXT NOT NULL REFERENCES bs_resource(id),
  fabric          TEXT NOT NULL CHECK (fabric IN (
                    'nvlink','infiniband','roce','cxl','pcie','ethernet'
                  )),
  bw_gbps         NUMERIC NOT NULL,
  rtt_us          NUMERIC,
  attrs           JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                   -- ECMP, buffer_kb, DCQCN params
  source          TEXT NOT NULL DEFAULT 'hand_curated'
                  CHECK (source IN ('demo','hand_curated','imported_from_snapshot'))
);
CREATE INDEX bs_link_src ON bs_link (src_id);
CREATE INDEX bs_link_dst ON bs_link (dst_id);

-- HwSpec body 的可选扩展字段：root_resource_ids
-- 旧代码读 body.cluster/gpu/interconnect 仍然能跑（向后兼容）；
-- 新代码读 body.root_resource_ids 并通过 catalog API 展开。
-- 不改 bs_spec_version 的列结构，仅约定 jsonb 内字段。

-- ── Demo 数据：把 hwspec_topo_b1 (v4) 的 1024-GPU B200 集群拆成实体树 ──
-- 顺序：site → pod → rack(s) → server(s) → gpu(s)；
-- 演示用，仅创建 1 个 site / 2 个 rack / 4 个 server / 32 个 GPU 作为骨架样本，
-- 不为 demo 完整建 1024 个 GPU 实体（无意义）。生产环境通过 §6 导入真实拓扑。

INSERT INTO bs_resource (id, kind, parent_id, vendor_sku, attrs, power_w_max, failure_domain, cost_capex_usd, source) VALUES
  -- site
  ('site-bj1', 'site', NULL, NULL,
    '{"location":"Beijing-1","pue_assumed":1.18,"electricity_usd_per_kwh":0.092}'::jsonb,
    1000000, NULL, NULL, 'demo'),
  -- pod
  ('pod-bj1-p1', 'pod', 'site-bj1', NULL,
    '{"name":"Pod-1","topology":"spine-leaf"}'::jsonb,
    900000, NULL, NULL, 'demo'),
  -- racks (2 sample)
  ('rack-bj1-p1-r03', 'rack', 'pod-bj1-p1', 'Schneider/AR3300',
    '{"u_height":42,"density_kw":35}'::jsonb,
    35000, 'pdu-bj1-p1-r03-A', 12000, 'demo'),
  ('rack-bj1-p1-r04', 'rack', 'pod-bj1-p1', 'Schneider/AR3300',
    '{"u_height":42,"density_kw":35}'::jsonb,
    35000, 'pdu-bj1-p1-r04-A', 12000, 'demo'),
  -- pdus (failure domain anchors)
  ('pdu-bj1-p1-r03-A', 'pdu', 'rack-bj1-p1-r03', 'Schneider/PDU-32A',
    '{"phase":"3P","amperage":32,"redundancy":"N+1"}'::jsonb,
    18000, 'pdu-bj1-p1-r03-A', 800, 'demo'),
  ('pdu-bj1-p1-r04-A', 'pdu', 'rack-bj1-p1-r04', 'Schneider/PDU-32A',
    '{"phase":"3P","amperage":32,"redundancy":"N+1"}'::jsonb,
    18000, 'pdu-bj1-p1-r04-A', 800, 'demo'),
  -- servers (2 per rack, 4 total)
  ('srv-bj1-r03-01', 'server', 'rack-bj1-p1-r03', 'Supermicro/SYS-821GE-TNHR',
    '{"u":4,"numa_nodes":2,"cpu":"Intel/Xeon-8480C","memory_gb":2048,"local_nvme_tb":15.36}'::jsonb,
    9600, 'pdu-bj1-p1-r03-A', 65000, 'demo'),
  ('srv-bj1-r03-02', 'server', 'rack-bj1-p1-r03', 'Supermicro/SYS-821GE-TNHR',
    '{"u":4,"numa_nodes":2,"cpu":"Intel/Xeon-8480C","memory_gb":2048,"local_nvme_tb":15.36}'::jsonb,
    9600, 'pdu-bj1-p1-r03-A', 65000, 'demo'),
  ('srv-bj1-r04-01', 'server', 'rack-bj1-p1-r04', 'Supermicro/SYS-821GE-TNHR',
    '{"u":4,"numa_nodes":2,"cpu":"Intel/Xeon-8480C","memory_gb":2048,"local_nvme_tb":15.36}'::jsonb,
    9600, 'pdu-bj1-p1-r04-A', 65000, 'demo'),
  ('srv-bj1-r04-02', 'server', 'rack-bj1-p1-r04', 'Supermicro/SYS-821GE-TNHR',
    '{"u":4,"numa_nodes":2,"cpu":"Intel/Xeon-8480C","memory_gb":2048,"local_nvme_tb":15.36}'::jsonb,
    9600, 'pdu-bj1-p1-r04-A', 65000, 'demo');

-- 32 个 B200 GPU（4 server × 8 卡）—— attrs 字段是 surrogate 现在硬编码的内容
INSERT INTO bs_resource (id, kind, parent_id, vendor_sku, attrs, power_w_max, failure_domain, cost_capex_usd, source)
SELECT
  format('gpu-bj1-%s-g%s', srv, gpu_idx),
  'gpu',
  srv,
  'Nvidia/B200-180GB',
  '{"hbm_gb":192,"fp8_pflops":4.9,"nvlink_domain":72,"quant_supported":["BF16","FP8","FP4"]}'::jsonb,
  1200,
  fd,
  39200,
  'demo'
FROM (VALUES
  ('srv-bj1-r03-01', 'pdu-bj1-p1-r03-A'),
  ('srv-bj1-r03-02', 'pdu-bj1-p1-r03-A'),
  ('srv-bj1-r04-01', 'pdu-bj1-p1-r04-A'),
  ('srv-bj1-r04-02', 'pdu-bj1-p1-r04-A')
) AS s(srv, fd)
CROSS JOIN generate_series(0, 7) AS gpu_idx;

-- 链路样本：同 server 内 8 卡 NVLink full-mesh 用聚合链路简化表示，跨 rack 走 IB
INSERT INTO bs_link (id, src_id, dst_id, fabric, bw_gbps, rtt_us, attrs, source) VALUES
  ('link-srv-r03-01-nvl', 'srv-bj1-r03-01', 'srv-bj1-r03-01', 'nvlink', 1800, 0.5,
    '{"topology":"full_mesh_8gpu","note":"intra-server NVLink-5 aggregate"}'::jsonb, 'demo'),
  ('link-srv-r03-02-nvl', 'srv-bj1-r03-02', 'srv-bj1-r03-02', 'nvlink', 1800, 0.5,
    '{"topology":"full_mesh_8gpu"}'::jsonb, 'demo'),
  ('link-srv-r04-01-nvl', 'srv-bj1-r04-01', 'srv-bj1-r04-01', 'nvlink', 1800, 0.5,
    '{"topology":"full_mesh_8gpu"}'::jsonb, 'demo'),
  ('link-srv-r04-02-nvl', 'srv-bj1-r04-02', 'srv-bj1-r04-02', 'nvlink', 1800, 0.5,
    '{"topology":"full_mesh_8gpu"}'::jsonb, 'demo'),
  ('link-r03-r04-ib', 'rack-bj1-p1-r03', 'rack-bj1-p1-r04', 'infiniband', 400, 2.5,
    '{"hops":2,"path":"leaf-spine-leaf"}'::jsonb, 'demo');

-- 把现有 hwspec_topo_b1 的 latest version 的 jsonb body 加上 root_resource_ids 锚点。
-- 旧字段保留（cluster/gpu/interconnect/datacenter），新字段是 root_resource_ids。
UPDATE bs_spec_version
SET body = body || jsonb_build_object('root_resource_ids', ARRAY['site-bj1'])
WHERE spec_id = 'hwspec_topo_b1';
