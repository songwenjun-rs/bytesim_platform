.PHONY: up down logs ps reset psql tidy fmt e2e e2e-ci e2e-engines migrate-down obs-up obs-down obs-status

up:
	docker-compose up --build -d
	@echo "→ http://localhost:5173 (web)  ·  http://localhost:8080/healthz (bff)  ·  http://localhost:8081/healthz (run-svc)"

down:
	docker-compose down

reset:
	docker-compose down -v
	docker-compose up --build -d

logs:
	docker-compose logs -f --tail=120

ps:
	docker-compose ps

psql:
	docker-compose exec postgres psql -U bytesim -d bytesim

tidy:
	cd services/run-svc && go mod tidy
	cd services/asset-svc && go mod tidy

fmt:
	cd services/run-svc && go fmt ./...
	cd services/asset-svc && go fmt ./...

surrogate-bench:
	@curl -s -X POST http://localhost:8083/v1/predict/timed \
	  -H 'content-type: application/json' \
	  -d '{"cluster":{"gpu_model":"B200","gpu_count":1024},"workload":{"mode":"training","seq_len":8192,"global_batch":4096,"activated_params_b":8.0,"total_params_b":512,"quant":"FP8"},"strategy":{"TP":4,"PP":8,"EP":8,"CP":2,"recompute":"selective","overlap":"ZBv2"}}' | python3 -m json.tool

hwspec-doc:
	@echo "查 hwspec 当前版本与历史："
	@curl -s http://localhost:8080/v1/specs/hwspec/hwspec_topo_b1 | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['version']['version_tag'], d['version']['hash'][:12])"
	@curl -s http://localhost:8080/v1/specs/hwspec/hwspec_topo_b1/versions | python3 -c "import sys,json;[print(v['version_tag'], v['hash'][:12], v['created_at']) for v in json.load(sys.stdin)]"

kafka-topics:
	@docker-compose exec redpanda rpk -X brokers=localhost:9092 topic list

kafka-tail:
	@echo "tail bs.events from latest · ctrl-C 退出"
	@docker-compose exec redpanda rpk -X brokers=localhost:9092 topic consume bs.events --offset end

run-create:
	@HW=$$(curl -s http://localhost:8080/v1/specs/hwspec/hwspec_topo_b1 | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['hash'])"); \
	MD=$$(curl -s http://localhost:8080/v1/specs/model/model_moe256e | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['hash'])"); \
	ST=$$(curl -s http://localhost:8080/v1/specs/strategy/strategy_moescan | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['hash'])"); \
	WL=$$(curl -s http://localhost:8080/v1/specs/workload/workload_train | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['hash'])"); \
	curl -s -X POST http://localhost:8080/v1/runs \
	  -H 'content-type: application/json' \
	  -d "{\"kind\":\"train\",\"title\":\"slice-10 真跑 demo\",\"hwspec_hash\":\"$$HW\",\"model_hash\":\"$$MD\",\"strategy_hash\":\"$$ST\",\"workload_hash\":\"$$WL\",\"surrogate_ver\":\"v2.4\",\"created_by\":\"makefile\"}" \
	  | python3 -c "import sys,json;r=json.load(sys.stdin);print('RUN=' + r['id'], '· status', r['status'])"

run-status:
	@curl -s http://localhost:8080/v1/runs/$(RUN) | python3 -c "import sys,json;r=json.load(sys.stdin);print('status', r['status'], '· progress', r.get('progress_pct'),'%','· MFU', r['kpis'].get('mfu_pct'),'· step', r['kpis'].get('step_ms'),'ms · cost \$$' + str(r['kpis'].get('cost_per_m_tok_usd')))"

run-watch:
	@echo "tail engine.log（管线产物 · ctrl-C 退出）"
	@docker-compose exec run-svc sh -c "tail -F /artifacts/$(RUN)/engine.log 2>/dev/null"

engine-kick:
	@curl -s -X POST http://localhost:8080/v1/runs/$(RUN)/kick | python3 -m json.tool

run-artifacts:
	@curl -s http://localhost:8080/v1/runs/$(RUN)/full | python3 -c "import sys,json;d=json.load(sys.stdin);[print(' -', a['file'].ljust(15), str(a['bytes']).rjust(8),'B ·', a['name']) for a in d['run']['artifacts']]"

# Vertical e2e — assumes stack already up via `make up`.
e2e:
	@bash scripts/e2e.sh

# CI 用：build + up + e2e + 失败时 dump 日志 + 拆 stack。本地也可跑（会拉镜像）。
e2e-ci:
	@bash scripts/e2e_ci.sh

# Fast iteration on engine-layer changes — 6 stages (health → login → registry
# visibility → astra-sim chakra round-trip → envelope-miss 503 → auto-routing).
# Same assertions as scripts/e2e.sh engine slice lifted into a standalone script.
e2e-engines:
	@bash scripts/e2e_engines.sh

# Roll back the last N migrations that ship a down/NNN_*.sql counterpart.
# Errors out if a down script is missing — the convention is enforced.
# Usage: make migrate-down N=1
# Bring up Prometheus + Grafana sidecars (opt-in).  Grafana on :3000 (anon viewer).
obs-up:
	docker-compose -f docker-compose.yml -f docker-compose.observability.yml up -d prometheus grafana
	@echo "→ Prometheus http://localhost:9090   ·   Grafana http://localhost:3000 (ByteSim · RED)"

obs-down:
	docker-compose -f docker-compose.observability.yml down

# Quick check of which targets Prometheus is currently scraping (and their state).
obs-status:
	@curl -s http://localhost:9090/api/v1/targets | python3 -c "import sys,json; \
ts=json.load(sys.stdin)['data']['activeTargets']; \
[print(t['labels'].get('service','?').ljust(20), t['health'].ljust(8), t['lastError'][:80] if t['lastError'] else '') for t in ts]"

migrate-down:
	@if [ -z "$(N)" ]; then echo "Usage: make migrate-down N=<count>"; exit 2; fi
	@bash -c '\
	  scripts=( $$(ls -1 infra/postgres/down/*.sql 2>/dev/null | sort -r) ); \
	  if [ $${#scripts[@]} -lt $(N) ]; then \
	    echo "only $${#scripts[@]} down scripts available; cannot roll back $(N)"; exit 1; \
	  fi; \
	  for i in $$(seq 0 $$(($(N) - 1))); do \
	    f=$${scripts[$$i]}; \
	    echo "→ rolling back $$f"; \
	    docker-compose exec -T postgres psql -U bytesim -d bytesim -v ON_ERROR_STOP=1 < $$f \
	      || { echo "rollback failed at $$f"; exit 1; }; \
	  done; \
	  echo "rolled back $(N) migration(s)"'
