-- ByteSim P-Domain-2: 标记 fabric-aware 引擎
--
-- engine-registry 路由时检查 cluster.fabric_topology 是否传入；
-- 若传入但选中的引擎 capabilities.fabric_aware != true，则在 _provenance
-- 里附 fabric_warning。本迁移把参考引擎 surrogate-analytical 标为 fabric-aware
-- （surrogate-svc P-Domain-2.2 已实现 link_util_top 计算）。
--
-- 不引入新列：fabric_aware 是 capabilities JSONB 内的约定字段，未来引擎只
-- 需在自注册请求里带 capabilities.fabric_aware=true 即可被路由识别。

UPDATE bs_engine
SET capabilities = capabilities || '{"fabric_aware": true, "fabric_types": ["nvlink","infiniband","roce","cxl","pcie","ethernet"]}'::jsonb
WHERE name = 'surrogate-analytical';
