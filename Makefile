.PHONY: up down logs ps reset psql tidy fmt e2e e2e-ci e2e-engines

up:
	docker-compose up --build -d
	@echo "→ http://localhost:5173 (web)  ·  http://localhost:8080/healthz (bff)  ·  http://localhost:8081/healthz (data_svc)"

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
	@docker-compose exec data_svc sh -c "tail -F /artifacts/$(RUN)/engine.log 2>/dev/null"

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

# Fast iteration on engine-layer changes — 5 stages (health → login → registry
# visibility → envelope-miss 503 → auto-routing). Same assertions as
# scripts/e2e.sh engine slice lifted into a standalone script.
e2e-engines:
	@bash scripts/e2e_engines.sh

