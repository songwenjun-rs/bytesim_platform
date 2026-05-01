-- ByteSim §2: Engine Plugin Registry — 把"内嵌引擎"拆成"注册式插件"
--
-- 产品边界（强）：平台不实现仿真引擎；引擎以独立服务形态向 registry 注册自己
-- 的能力描述，registry 路由请求 + 标注 provenance。surrogate-svc 是参考实现，
-- 跟未来接入的 ns3-network / gem5-microarch / roofline-v2 是同等地位的插件。
--
-- 注意：011 编号紧跟 010_tco；009 仍为 §6 (production_assets) 预留。

CREATE TABLE bs_engine (
  name           TEXT PRIMARY KEY,                -- "surrogate-analytical"
  version        TEXT NOT NULL,                   -- "v0.1.0"
  domain         TEXT NOT NULL CHECK (domain IN (
                   'compute','network','memory','power','kvcache','scheduler'
                 )),                              -- 引擎覆盖的仿真维度
  granularity    TEXT NOT NULL CHECK (granularity IN (
                   'coarse','analytical','cycle-accurate'
                 )),                              -- 精细度
  sla_p99_ms     INT NOT NULL,                    -- 期望 p99 延迟 — Tuner 用来做"快引擎"vs"准引擎"取舍
  endpoint       TEXT NOT NULL,                   -- HTTP base URL（k8s svc / 域名）
  predict_path   TEXT NOT NULL DEFAULT '/v1/predict',
  capabilities   JSONB NOT NULL DEFAULT '{}'::jsonb,
                                                 -- {gpu_models:[...], modes:[...], notes:...}
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','deprecated','disabled')),
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ,                    -- registry 周期 healthcheck 写入
  notes          TEXT
);
CREATE INDEX bs_engine_domain_status ON bs_engine (domain, status);

-- Bootstrap：把 surrogate-svc 注册为 compute 域的 analytical 引擎
INSERT INTO bs_engine (name, version, domain, granularity, sla_p99_ms,
                        endpoint, predict_path, capabilities, notes) VALUES
  ('surrogate-analytical', 'v0.1.0', 'compute', 'analytical', 100,
   'http://surrogate-svc:8083', '/v1/predict',
   '{"gpu_models":["B200","H200","GB300","MI355X","H100","NPU-910"],"modes":["training","inference"],"quants":["BF16","FP8"]}'::jsonb,
   'Bootstrap reference engine. Replaces hardcoded surrogate.predict() call sites.');
