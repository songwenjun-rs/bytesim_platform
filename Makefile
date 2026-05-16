.PHONY: up up-all down logs ps reset psql tidy fmt e2e e2e-ci e2e-engines surrogate-bench hwspec-doc engine-kick

# Default `up` skips bytesim_svc because its build requires external
# engine assets (engine/bytesim/synverse/src, extern/charon, topo_files,
# network_config.toml) that aren't in this repo. Use `make up-all` once
# those paths are populated.
up:
	docker compose up --build -d postgres data_svc tco_svc surrogate_svc engine_svc bff web
	@echo "→ http://localhost:5173 (web)  ·  http://localhost:8080/healthz (bff)  ·  http://localhost:8081/healthz (data_svc)  ·  http://localhost:8087/healthz (engine_svc + registry)"

up-all:
	docker compose up --build -d
	@echo "→ http://localhost:5173 (web)  ·  http://localhost:8080/healthz (bff)  ·  http://localhost:8081/healthz (data_svc)  ·  http://localhost:8087/healthz (engine_svc + registry)  ·  http://localhost:8086/healthz (bytesim)"

down:
	docker compose down

reset:
	docker compose down -v
	$(MAKE) up

logs:
	docker compose logs -f --tail=120

ps:
	docker compose ps

psql:
	docker compose exec postgres psql -U bytesim -d bytesim

tidy:
	cd service/data_svc && go mod tidy

fmt:
	cd service/data_svc && go fmt ./...

surrogate-bench:
	@curl -s -X POST http://localhost:8083/v1/predict/timed \
	  -H 'content-type: application/json' \
	  -d '{"cluster":{"gpu_model":"B200","gpu_count":1024},"workload":{"mode":"training","seq_len":8192,"global_batch":4096,"activated_params_b":8.0,"total_params_b":512,"quant":"FP8"},"strategy":{"TP":4,"PP":8,"EP":8,"CP":2,"recompute":"selective","overlap":"ZBv2"}}' | python3 -m json.tool

hwspec-doc:
	@echo "查 hwspec 当前版本与历史："
	@curl -s http://localhost:8080/v1/specs/hwspec/hwspec_topo_b1 | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['version']['version_tag'], d['version']['hash'][:12])"
	@curl -s http://localhost:8080/v1/specs/hwspec/hwspec_topo_b1/versions | python3 -c "import sys,json;[print(v['version_tag'], v['hash'][:12], v['created_at']) for v in json.load(sys.stdin)]"

engine-kick:
	@curl -s -X POST http://localhost:8080/v1/runs/$(RUN)/kick | python3 -m json.tool

# Vertical e2e — assumes stack already up via `make up`.
e2e:
	@bash scripts/e2e.sh

# CI: build + up + e2e + dump logs on failure + tear down. Can also run locally (pulls images).
e2e-ci:
	@bash scripts/e2e_ci.sh

# Fast iteration on engine-layer changes — 5 stages
# (health → login → registry visibility → envelope-miss 503 → auto-routing).
e2e-engines:
	@bash scripts/e2e_engines.sh
