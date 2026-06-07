# syntax=docker/dockerfile:1.7
#
# MikuSwarm image. Encapsulates the full build: native npm modules
# (better-sqlite3, sharp, onnxruntime-node/fastembed) AND the Rust NAPI matrix
# module (native/crates/matrix-core → npm/). Runs the app via tsx (no JS emit,
# matching the project's no-build-step convention).
#
# Two stages on the SAME Debian/glibc base — the compiled .node artifacts are
# ABI-specific, so builder and runtime must share libc and the Node major.
# Do NOT switch to Alpine/musl.
#
# See ARCHITECTURE.md "Running in Docker" and docker-compose.yml.

# -----------------------------------------------------------------------------
# Builder — toolchains + compile native artifacts. None of this ships to runtime.
# -----------------------------------------------------------------------------
FROM node:24-bookworm AS builder

ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential \
       pkg-config \
       python3 \
       curl \
       ca-certificates \
       git \
  && rm -rf /var/lib/apt/lists/*

# Rust toolchain pinned to match rust-toolchain.toml (channel 1.93.0). napi build
# invokes cargo; the pin keeps the matrix module's compiler identical to dev.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain 1.93.0

# pnpm via corepack, pinned to packageManager in package.json.
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

# JS deps first (cached until manifests change). This compiles the native npm
# modules listed under pnpm.onlyBuiltDependencies (better-sqlite3, sharp,
# onnxruntime-node, esbuild).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build the Rust NAPI matrix module → /app/npm (needs rust-toolchain.toml at the
# repo root so the pinned toolchain is selected, and the @napi-rs/cli devDep).
# This emits only the platform .node binary (+ an empty index.d.ts); the JS loader
# wrapper (npm/index.js, npm/package.json) is a committed artifact added to the
# runtime stage below. Mirrors the project's own build:native (debug profile).
COPY rust-toolchain.toml ./
COPY native ./native
RUN pnpm build:native

# -----------------------------------------------------------------------------
# Runtime — slim base + only what the agent needs at run time.
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Runtime system deps:
#  - ffmpeg/ffprobe : media transcode + probe (src/media/*, captioning/animated)
#  - ripgrep        : host fallback for search_files when the sandbox is disabled
#  - docker-ce-cli  : the agent shells out to `docker` to create/exec the sandbox
#                     container (no daemon here — it talks to the mounted socket)
#  - tini           : PID 1 / signal forwarding for clean shutdown
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       gnupg \
       tini \
       ffmpeg \
       ripgrep \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

# Compiled deps + native matrix module from the builder (same glibc/Node ABI).
COPY --from=builder /app/node_modules ./node_modules
# Built .node + empty index.d.ts from the builder, then the committed JS loader
# wrapper (index.js + package.json) from context — native-binding.ts requires
# "../../npm/index.js" at runtime, and `napi build` does not emit it.
COPY --from=builder /app/npm ./npm
COPY npm/index.js npm/package.json ./npm/

# App sources + manifests (tsx reads tsconfig.json; lockfile kept for parity).
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src

# Baked config: shipped defaults + the container-infrastructure overlay. The
# operator's identity config (config/90-local.toml — models/matrix/captioning)
# is bind-mounted in by docker-compose. Lexicographic merge:
#   00-defaults.toml < 90-local.toml(mounted) < 95-docker.toml
COPY config/00-defaults.toml ./config/00-defaults.toml
COPY docker/95-docker.toml ./config/95-docker.toml

# Runs as root: the bind-mounted /var/run/docker.sock is root:docker on the host,
# and sandbox files are written as the agent's uid (process.getuid()=0 here).
# See ARCHITECTURE.md for the non-root hardening path (match the host docker GID).
ENTRYPOINT ["tini", "--"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
