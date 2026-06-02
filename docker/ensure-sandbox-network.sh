#!/usr/bin/env bash
set -euo pipefail

# Idempotently create the dedicated bridge network for the Miku sandbox.
# A dedicated bridge keeps the sandbox off the harness/DB/internal networks
# (no access to local services). Outbound internet works via the bridge's NAT.
#
# For stricter isolation (block RFC1918/link-local egress while keeping the
# public internet) run docker/sandbox-egress-rules.sh as root — that is a
# separate operator/hardening step, not performed here.
#
# The SandboxManager invokes this at startup; it can also be run manually.

NETWORK_NAME="${MIKUSWARM_SANDBOX_NETWORK:-mikuswarm-sandbox}"

case "$NETWORK_NAME" in
  bridge|none|host|container:*)
    # Standard/built-in network modes need no creation.
    exit 0
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "warning: docker not found; cannot ensure sandbox network $NETWORK_NAME" >&2
  exit 0
fi

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  exit 0
fi

docker network create --driver bridge "$NETWORK_NAME" >/dev/null
echo "Created sandbox Docker network: $NETWORK_NAME" >&2
