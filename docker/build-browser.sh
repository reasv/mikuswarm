#!/usr/bin/env bash
set -euo pipefail

# Build the CloakBrowser-Manager image from the pinned git submodule
# (vendor/cloakbrowser-manager). The Manager bundles a FastAPI control plane,
# KasmVNC, and the stealth CloakBrowser Chromium binary (pulled at build time via
# `cloakbrowser.download.ensure_binary()` — see the submodule's Dockerfile).
#
# We build from the submodule (rather than pulling cloakhq/cloakbrowser-manager
# from Docker Hub) so the exact source is pinned and reproducible. Update path:
#   git submodule update --remote vendor/cloakbrowser-manager   # bump the pin
#   docker/build-browser.sh                                     # rebuild
#
# This is an OPERATOR step. The harness does not build or manage this image; it
# only connects to a running Manager over HTTP (ARCHITECTURE.md browser section).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SUBMODULE_DIR="${REPO_ROOT}/vendor/cloakbrowser-manager"
IMAGE_NAME="${MIKUSWARM_BROWSER_IMAGE:-mikuswarm-cloakbrowser-manager:pinned}"

if [ ! -f "${SUBMODULE_DIR}/Dockerfile" ]; then
  echo "error: ${SUBMODULE_DIR}/Dockerfile not found." >&2
  echo "       Initialize the submodule first: git submodule update --init vendor/cloakbrowser-manager" >&2
  exit 1
fi

echo "Building ${IMAGE_NAME} from ${SUBMODULE_DIR} (this pulls the CloakBrowser binary, ~2GB)..." >&2
docker build -t "${IMAGE_NAME}" "${SUBMODULE_DIR}"

cat <<NOTE
Built ${IMAGE_NAME}

Next steps (operator):
  1. Create the dedicated bridge:   docker/ensure-browser-network.sh
  2. (hardening, as root) block RFC1918 egress:
       sudo MIKUSWARM_BROWSER_NETWORK=mikuswarm-browser docker/browser-egress-rules.sh
  3. Bring up the Manager:
       MIKUSWARM_BROWSER_IMAGE=${IMAGE_NAME} BROWSER_AUTH_TOKEN=<token> \\
         docker compose -f docker/docker-compose.browser.yml up -d
  4. In config (config/90-local.toml), set [browser] enabled = true,
     manager_url = "http://127.0.0.1:8080", auth_token = "\${BROWSER_AUTH_TOKEN}".

Notes:
  - The Manager binds 127.0.0.1:8080 only. Reach the noVNC GUI via SSH tunnel.
  - The persistent "miku" identity (cookies/logins/fingerprint) lives on the
    /data volume and survives restarts. The harness creates the profile lazily on
    first browser-tool use; no orchestration is needed on bring-up.
NOTE
