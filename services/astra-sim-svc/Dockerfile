# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the astra-sim wrapper service.
#
#   stage 1 (sim-builder)  — Ubuntu + cmake + boost + abseil + protobuf-from-source
#                             → compiles AstraSim_Analytical_Congestion_(Un)Aware
#   stage 2 (py-builder)   — pip install Python deps into a venv
#   stage 3 (runtime)      — slim base + binary + venv + Python svc
#
# astra-sim's analytical backend doesn't need ns-3 / htsim, so we only
# vendor (engine/astra-sim/) the analytical-path submodules. abseil + protobuf
# are pinned to the same versions as upstream's own astra-sim Dockerfile.

# ── Stage 1: build astra-sim binary ─────────────────────────────────
FROM ubuntu:22.04 AS sim-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget git \
        gcc g++ make cmake \
        libboost-dev libboost-program-options-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Abseil 20240722.0 — pinned to match upstream astra-sim's Dockerfile.
ARG ABSL_VER=20240722.0
WORKDIR /opt
RUN wget -q https://github.com/abseil/abseil-cpp/releases/download/${ABSL_VER}/abseil-cpp-${ABSL_VER}.tar.gz \
 && tar -xf abseil-cpp-${ABSL_VER}.tar.gz \
 && rm abseil-cpp-${ABSL_VER}.tar.gz \
 && mkdir -p /opt/abseil-cpp-${ABSL_VER}/build
WORKDIR /opt/abseil-cpp-${ABSL_VER}/build
RUN cmake .. \
        -DCMAKE_CXX_STANDARD=14 \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/opt/abseil-cpp-${ABSL_VER}/install \
 && cmake --build . --target install --config Release --parallel 2
ENV absl_DIR=/opt/abseil-cpp-${ABSL_VER}/install

# Protobuf 29.0 — same pinning rationale.
ARG PROTOBUF_VER=29.0
WORKDIR /opt
RUN wget -q https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOBUF_VER}/protobuf-${PROTOBUF_VER}.tar.gz \
 && tar -xf protobuf-${PROTOBUF_VER}.tar.gz \
 && rm protobuf-${PROTOBUF_VER}.tar.gz \
 && mkdir -p /opt/protobuf-${PROTOBUF_VER}/build
WORKDIR /opt/protobuf-${PROTOBUF_VER}/build
RUN cmake .. \
        -DCMAKE_CXX_STANDARD=14 \
        -DCMAKE_BUILD_TYPE=Release \
        -Dprotobuf_BUILD_TESTS=OFF \
        -Dprotobuf_ABSL_PROVIDER=package \
        -DCMAKE_INSTALL_PREFIX=/opt/protobuf-${PROTOBUF_VER}/install \
 && cmake --build . --target install --config Release --parallel 2
ENV PATH=/opt/protobuf-${PROTOBUF_VER}/install/bin:$PATH
ENV protobuf_DIR=/opt/protobuf-${PROTOBUF_VER}/install
ENV PROTOBUF_FROM_SOURCE=True

# Vendored astra-sim source (analytical path only).
COPY engine/astra-sim /src/astra-sim

# Pre-compile the chakra .proto schema so the build doesn't require protoc
# discovery surprises.
RUN cd /src/astra-sim/extern/graph_frontend/chakra/schema/protobuf \
 && protoc et_def.proto --proto_path=. --cpp_out=.

# Build only the analytical congestion-(un)aware binaries via the upstream
# build.sh — do NOT touch ns-3 / htsim (they're not vendored).
# Default `-t all` builds both congestion-{unaware,aware} → ~3-4 min.
RUN cd /src/astra-sim/build/astra_analytical \
 && bash build.sh -t all

# Verify the binary actually got built — fail early if not.
RUN test -x /src/astra-sim/build/astra_analytical/build/bin/AstraSim_Analytical_Congestion_Unaware


# ── Stage 2: Python venv with svc deps ──────────────────────────────
FROM python:3.12-slim AS py-builder
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /build
COPY services/astra-sim-svc/requirements.lock ./
RUN pip install -r requirements.lock


# ── Stage 3: runtime ────────────────────────────────────────────────
FROM python:3.12-slim AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/bytesim/shared \
    ASTRASIM_BIN=/opt/astra-sim/AstraSim_Analytical_Congestion_Unaware \
    ASTRASIM_EXAMPLES=/opt/astra-sim/examples \
    ASTRASIM_CHAKRA_CACHE=/var/cache/bytesim/chakra

# libstdc++ already in slim; we additionally need libgomp for OpenMP-linked
# astra-sim binaries (yaml-cpp / fmt may pull it in) and zlib1g for the
# protobuf gzip_stream the chakra graph frontend depends on.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 zlib1g \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --no-create-home app

# Python deps.
COPY --from=py-builder /opt/venv /opt/venv

# Astra-sim binary + bundled examples (workload traces, network YAMLs).
COPY --from=sim-builder /src/astra-sim/build/astra_analytical/build/bin/AstraSim_Analytical_Congestion_Unaware /opt/astra-sim/AstraSim_Analytical_Congestion_Unaware
COPY --from=sim-builder /src/astra-sim/build/astra_analytical/build/bin/AstraSim_Analytical_Congestion_Aware     /opt/astra-sim/AstraSim_Analytical_Congestion_Aware
# --chown matters because astra-sim's chakra ETFeeder opens .et files with
# std::ios::in|std::ios::app — that requires WRITE permission on the file
# even though we never actually append. Without --chown the runtime user
# `app` (uid 1001) gets a generic "Failed to open file" mid-simulation.
COPY --chown=app:app --from=sim-builder /src/astra-sim/examples /opt/astra-sim/examples

# Astra-sim links dynamically against the from-source protobuf 29.0 + abseil
# we built in stage 1 — neither has a matching apt package on debian bookworm
# (slim base is 3.21 / 20230802). Copy their install dirs and prepend their
# lib paths so ld.so finds .so.29 etc. at startup.
COPY --from=sim-builder /opt/protobuf-29.0/install/lib       /opt/astra-sim-libs/protobuf
COPY --from=sim-builder /opt/abseil-cpp-20240722.0/install/lib /opt/astra-sim-libs/abseil
ENV LD_LIBRARY_PATH=/opt/astra-sim-libs/protobuf:/opt/astra-sim-libs/abseil

# Validate the binary's dynamic linker can resolve every dep at image-build
# time. ldd's "not found" rows are what would otherwise blow up the first
# /v1/predict — fail loudly here instead.
RUN ldd /opt/astra-sim/AstraSim_Analytical_Congestion_Unaware | tee /tmp/ldd.txt \
 && ! grep -q 'not found' /tmp/ldd.txt

WORKDIR /app
COPY --chown=app:app services/astra-sim-svc/app ./app

# RFC-001 v2 — shared engine_contracts + engine_runtime packages live in the
# repo's `shared/` tree and get installed into the image as a flat copy.
# PYTHONPATH (set above) puts them on sys.path without needing pip install.
COPY --chown=app:app shared /opt/bytesim/shared

# RFC-003 — chakra trace cache. Mounted as a named volume in compose so traces
# survive container restarts (encoding ETs is cheap but redundant work adds up
# during e2e + smoke runs).
RUN mkdir -p /var/cache/bytesim/chakra && chown -R app:app /var/cache/bytesim

USER app
EXPOSE 8092

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8092/healthz', timeout=2).getcode()==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8092"]
