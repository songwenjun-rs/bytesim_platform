-- ByteSim §5: Technical TCO Engine — marginal, comparable, explainable cost
--
-- 设计哲学：
--   * 不做财务报表（没有 ops_staff / 折旧曲线 / 团队分摊）
--   * 服务于"两个设计方案之间的 ΔTCO"对比
--   * 每条规则版本化，对比时强制同口径
--   * 每个 Run 落 breakdown，可重放、可下钻、可回答"哪一项变了多少"
--
-- 为什么 010 而不是 009：009 留给 §6 (production data assets)，按 P0/P1 顺序部署。

CREATE TABLE bs_tco_rule (
  id                      TEXT PRIMARY KEY,            -- "gpu/B200/v2026q1"
  resource_kind           TEXT NOT NULL CHECK (resource_kind IN (
                            'gpu','cpu','nic','switch','rack','pdu','cooling','server','storage','link'
                          )),
  vendor_sku              TEXT,                        -- match against bs_resource.vendor_sku
  amortization_y          INT  NOT NULL DEFAULT 3,     -- tech 口径统一 3 年（不是会计 5 年）
  capex_usd               NUMERIC,                     -- 单位价格
  power_w_idle            INT,
  power_w_load            INT,
  pue_assumed             NUMERIC,                     -- 仅对耗电 SKU 有意义
  electricity_usd_per_kwh NUMERIC NOT NULL DEFAULT 0.092,
  storage_usd_per_gb_month NUMERIC,                    -- 用于 ckpt / KVCache 分层
  attrs                   JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                      -- failure_penalty_curve, contract_window 等
  notes                   TEXT,
  effective               TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL, '[)'),
  source                  TEXT NOT NULL DEFAULT 'hand_curated'
                          CHECK (source IN ('hand_curated','imported_from_snapshot')),
                                                      -- §6 校验器可以建议新规则
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bs_tco_rule_sku ON bs_tco_rule (resource_kind, vendor_sku);

-- 每个 Run / Scenario 完成后落一份 TCO breakdown，可重放、可对账。
CREATE TABLE bs_tco_breakdown (
  run_id                       TEXT PRIMARY KEY REFERENCES bs_run(id),
  hw_capex_amortized_usd       NUMERIC NOT NULL DEFAULT 0,
  power_opex_usd               NUMERIC NOT NULL DEFAULT 0,
  cooling_opex_usd             NUMERIC NOT NULL DEFAULT 0,
  network_opex_usd             NUMERIC NOT NULL DEFAULT 0,
  storage_opex_usd             NUMERIC NOT NULL DEFAULT 0,
  failure_penalty_usd          NUMERIC NOT NULL DEFAULT 0,
  total_usd                    NUMERIC NOT NULL DEFAULT 0,

  per_m_token_usd              NUMERIC,                -- 训练：million tokens cost
  per_gpu_hour_usd             NUMERIC,                -- 二级口径
  per_inference_request_usd    NUMERIC,                -- 推理：单请求成本

  -- 用了哪些规则版本：方案对比时强制同口径
  rule_versions                JSONB NOT NULL,         -- {"gpu/B200": "gpu/B200/v2026q1", ...}

  -- ∂TCO/∂{TP, PP, ckpt_interval, ...}：tuner 用来做梯度引导
  sensitivities                JSONB NOT NULL DEFAULT '{}'::jsonb,

  computed_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 种子规则：6 款常见 GPU + 关键基础设施 SKU
-- 数字与 surrogate-svc 当前 GPU_PROFILE 对齐，但显式拆出 CapEx 与功率字段
INSERT INTO bs_tco_rule (id, resource_kind, vendor_sku, capex_usd, power_w_idle, power_w_load, pue_assumed, attrs, notes) VALUES
  ('gpu/B200/v2026q1',   'gpu', 'Nvidia/B200-180GB',
    39200, 200, 1200, 1.18,
    '{"hbm_gb":192,"fp8_pflops":4.9}'::jsonb,
    'B200 NVL 平均整机 8-card 配置；价格随合同窗口浮动 ±10%'),

  ('gpu/H200/v2026q1',   'gpu', 'Nvidia/H200-141GB',
    28400, 150, 700, 1.20,
    '{"hbm_gb":141,"fp8_pflops":3.9}'::jsonb,
    'H200 SXM5；功率含 NVSwitch'),

  ('gpu/GB300/v2026q1',  'gpu', 'Nvidia/GB300-288GB',
    52800, 240, 1400, 1.18,
    '{"hbm_gb":288,"fp8_pflops":6.4}'::jsonb,
    'GB300 NVL72；价格为预估，C 区供货受限'),

  ('gpu/MI355X/v2026q1', 'gpu', 'AMD/MI355X-288GB',
    24100, 120, 750, 1.22,
    '{"hbm_gb":288,"fp8_pflops":4.2}'::jsonb,
    'MI355X；scale-up 域 8 GPU 受限'),

  ('gpu/H100/v2026q1',   'gpu', 'Nvidia/H100-80GB',
    24800, 130, 700, 1.20,
    '{"hbm_gb":80,"fp8_pflops":2.0}'::jsonb,
    'H100 SXM5；存量价'),

  ('gpu/NPU910/v2026q1', 'gpu', 'Huawei/NPU-910C-96GB',
    18000, 100, 550, 1.22,
    '{"hbm_gb":96,"fp8_pflops":2.4}'::jsonb,
    '昇腾 910C；功率与价格为典型公开口径'),

  -- 服务器底盘（不含 GPU）
  ('server/dgx-h200/v2026q1', 'server', 'Supermicro/SYS-821GE-TNHR',
    65000, 500, 1800, NULL,
    '{"u":4,"max_gpu":8}'::jsonb,
    '8-GPU 风冷服务器底盘；GPU 单算'),

  -- 机柜
  ('rack/std-42u/v2026q1', 'rack', 'Schneider/AR3300',
    12000, NULL, NULL, NULL,
    '{"u_height":42,"density_kw":35,"cooling":"air"}'::jsonb,
    '42U 标准机柜；液冷型号另起规则'),

  -- PDU
  ('pdu/32a-3p/v2026q1', 'pdu', 'Schneider/PDU-32A',
    800, NULL, NULL, NULL,
    '{"phase":"3P","amperage":32}'::jsonb,
    '3 相 32A PDU'),

  -- 存储（用于 ckpt 与 KVCache）
  ('storage/nvme-tlc/v2026q1', 'storage', 'Generic/NVMe-TLC',
    NULL, NULL, NULL, NULL,
    '{"tier":"hot"}'::jsonb,
    '本地 NVMe；典型按 GB-月计'),

  ('storage/object-warm/v2026q1', 'storage', 'Generic/S3-Compatible',
    NULL, NULL, NULL, NULL,
    '{"tier":"warm"}'::jsonb,
    '对象存储；ckpt 长期保存层')
;

-- 仅给 storage 类规则填存储单价（不能放在主 INSERT 里因为不是所有规则都有这个字段）
UPDATE bs_tco_rule SET storage_usd_per_gb_month = 0.05 WHERE id = 'storage/nvme-tlc/v2026q1';
UPDATE bs_tco_rule SET storage_usd_per_gb_month = 0.012 WHERE id = 'storage/object-warm/v2026q1';
