# local-cross-host — 4-host cross-machine simulation

Validates cross-machine deployment locally **without** spinning up real VMs
or a k8s cluster. Each "host" is its own isolated docker bridge network;
services on different "hosts" can only reach each other through
`host.docker.internal:<published-port>` — same path real cross-machine
traffic takes through a router / LB.

## Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│ Host A (host-a-net) — edge                                           │
│   dashboard_nginx      :80 → published :8443                          │
│   serves dist/ + reverse-proxies /v1/* + WS to bff via 18080         │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ HTTP/WS via host.docker.internal:18080
┌────────────────────────────┴─────────────────────────────────────────┐
│ Host B (host-b-net) — gateway                                        │
│   bff                  :8080 → published :18080                       │
│   fans out via host.docker.internal:{18081,18087,18090}              │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────────┐
        │                    │                        │
┌───────┴─────────┐  ┌──────┴────────────────┐       │
│ Host C          │  │ Host D                │       │
│  (host-c-net)   │  │  (host-d-net)         │       │
│                 │  │                       │       │
│  postgres       │  │  surrogate_svc        │       │
│   :5432 → 15432 │  │   :8083 → 18083       │       │
│                 │  │  tco_svc              │       │
│  data_svc       │  │   :8090 → 18090       │       │
│   :8081 → 18081 │  │  engine_svc + reg     │       │
│                 │  │   :8087 → 18087       │       │
└─────────────────┘  └───────────────────────┘       │
        ▲                    ▲                        │
        └────────────────────┴────────────────────────┘
                             │ PG connection from C and D services
                             │ goes through host.docker.internal:15432
```

`bytesim_svc` is **omitted** because its build needs external engine
assets (`engine/bytesim/synverse/src`, `extern/charon`, `topo_files`,
`network_config.toml`) not present in this dev environment. Add it to
`docker-compose.host-d.yml` once those assets are in place.

## Prerequisites

- Docker Desktop running (any recent version with `host.docker.internal`)
- `dashboard/output/dist/` exists — run `cd dashboard && ./build.sh` first
- ~3GB free disk for the 5 Python service images + postgres + nginx
- First-time `up.sh` runs `docker build` on all backend services
  (~10–15 min on first run; subsequent runs reuse layer cache)

## Usage

```bash
cd deploy/local-cross-host

bash up.sh        # 4 hosts up in dependency order
sleep 10          # let engines self-register

bash verify.sh    # 7-level health + cross-host plumbing check

# manual: open the SPA
open http://localhost:8443/

bash down.sh             # stop everything (preserves postgres data)
bash down.sh --clean     # stop + wipe postgres data volume
```

## What it actually proves (and what it doesn't)

### Validates ✓

- Every cross-service URL flows through env vars (no service-name DNS shortcut)
- `ENGINE_SELF_URL` correctness — registry has to reach surrogate back via
  the host-published port, not the in-container port
- nginx reverse-proxy of `/v1/*` HTTP + WS upgrade chain
- bff JWT + CORS handling under nginx-fronted access
- Graceful degradation when a "host" goes down (level 6 fault injection)
- Postgres connectivity from services on different "hosts"
- Submodule layout / build context paths after the platform restructure

### Does NOT validate ✗

- Real cross-host network characteristics (latency, MTU, packet loss)
- Real OS / kernel / glibc differences between deployment hosts
- TLS at the edge (everything is plain HTTP locally — use the
  containerised production deploy for HTTPS)
- HA failover with multiple replicas per service — single-instance per "host"
- k8s-specific concerns (Service DNS, NetworkPolicy, sidecars) —
  use k3d / kind for those

## Verify levels — what each one tests

| L | what | how it catches misconfig |
|---|---|---|
| 1 | per-host /healthz | service didn't start at all |
| 2 | engine self-registration | `ENGINE_SELF_URL` / `ENGINE_REGISTRY_URL` wrong |
| 3 | nginx → bff → upstreams | bff env URLs wrong, JWT chain broken, CORS misfire |
| 4 | direct registry /v1/predict | registry → engine routing (validates `ENGINE_SELF_URL` is reachable from outside the engine's own host) |
| 5 | WS upgrade | nginx `Upgrade: websocket` headers missing, bff `--proxy-headers` not set |
| 6 | fault injection (registry down) | 5xx vs hang behaviour; re-register on recovery |
| 7 | end-to-end run | (manual via UI — out of scope for the script) |

## Common breakages and fixes

| symptom | likely cause |
|---|---|
| `bff` exits with `BFF_JWT_SECRET is required` | `env/host-b.env` not picked up — check compose `env_file` |
| `/v1/engines` returns empty list | `ENGINE_SELF_URL` doesn't match host-published port |
| WS connect hangs forever | nginx `Connection: upgrade` header missing — check `nginx.conf` |
| Postgres "connection refused" from host D | `15432` not actually published on host C, or `host.docker.internal` not resolving (Docker Desktop only) |
| `cross-host-data-svc` fails healthcheck | data_svc's binary's `LISTEN_ADDR` doesn't match what healthcheck probes (both default to `:8081`) |

## Why not just use the main `docker-compose.yml`?

The main compose puts all services on one shared bridge network. They reach
each other via service-name DNS (`data_svc:8081`, `engine_svc:8087`).
That works perfectly in production-ish docker-compose deploys, but it lets
misconfigured `ENGINE_SELF_URL` / hardcoded localhost references slip
through — because everything happens to be on the same docker network.

This 4-host setup deliberately **breaks** the service-name DNS shortcut so
those config mistakes surface during the local validation pass.
