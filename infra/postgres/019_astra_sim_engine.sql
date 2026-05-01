-- ByteSim §2 后续插件：注册 astra-sim 作为 network 域引擎
--
-- astra-sim 是分布式 AI 训练的网络/集合通信仿真器（事件驱动 · cycle-accurate）。
-- 与 surrogate-analytical（compute 域）正交，不会抢路由：engine-registry 的
-- select_engine 只在 status='active' AND domain=:domain 的候选中挑最低
-- sla_p99_ms 的引擎，network 与 compute 候选不重叠。
--
-- 真实仿真器：services/astra-sim-svc 在 :8092 暴露 /v1/predict，内部 spawn
-- AstraSim_Analytical_Congestion_Unaware 二进制（vendored at engine/astra-sim，
-- analytical-only）跑给定的 collective × topology × bandwidth 配置，从 stdout
-- 解析出 wall_time / comm_time 返回。bundled workload 仅 4/8/16 NPU × 1MB
-- 微基准；超出范围的请求会自动 snap 到最近 preset 并把 confidence 降到 0.65。
--
-- 编号说明：018 是最近一个落地的 up 迁移；本迁移延续单调递增。

INSERT INTO bs_engine (name, version, domain, granularity, sla_p99_ms,
                        endpoint, predict_path, capabilities, status, notes) VALUES
  ('astra-sim', 'v1.0.0-analytical', 'network', 'cycle-accurate', 5000,
   'http://astra-sim-svc:8092', '/v1/predict',
   '{
      "fabric_aware": true,
      "fabric_types": ["nvlink","infiniband","roce","ethernet"],
      "collectives": ["allreduce","allgather","reducescatter","alltoall","broadcast"],
      "topologies": ["ring","switch","fattree","torus2d","torus3d"],
      "modes": ["training","inference"],
      "workloads": ["transformer","moe","dlrm"]
    }'::jsonb,
   'active',
   'astra-sim analytical congestion-unaware backend, vendored at engine/astra-sim (commit 518bd51). Snaps requests to bundled 4/8/16 NPU × 1MB microbench presets.')
ON CONFLICT (name) DO UPDATE SET
  version       = EXCLUDED.version,
  domain        = EXCLUDED.domain,
  granularity   = EXCLUDED.granularity,
  sla_p99_ms    = EXCLUDED.sla_p99_ms,
  endpoint      = EXCLUDED.endpoint,
  predict_path  = EXCLUDED.predict_path,
  capabilities  = EXCLUDED.capabilities,
  status        = EXCLUDED.status,
  notes         = EXCLUDED.notes;
