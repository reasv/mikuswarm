#!/usr/bin/env bash
set -euo pipefail

# Build the MikuSwarm sandbox image. Run from the repo root or anywhere — the
# build context is the docker/ directory next to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${MIKUSWARM_SANDBOX_IMAGE:-mikuswarm-sandbox:24.04}"

docker build -t "${IMAGE_NAME}" -f "${SCRIPT_DIR}/Dockerfile.sandbox" "${SCRIPT_DIR}"

cat <<NOTE
Built ${IMAGE_NAME}

Next steps:
  - Set [sandbox] enabled = true and image = "${IMAGE_NAME}" in config/90-local.toml.
  - The container is created/started automatically at agent startup when enabled.

Notes:
  - cargo/uv/brew installs made at runtime live under /home/sandbox inside the
    container and do NOT survive container recreation unless that path is
    bind-mounted from the host (see [sandbox].binds).
  - The workspace is bind-mounted at /workspace; files created there by the
    bash tool are owned by the harness uid (the container runs with --user).
NOTE
