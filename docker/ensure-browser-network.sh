#!/usr/bin/env bash
set -euo pipefail

# SUPERSEDED for the standard deployment: the root docker-compose.yml now owns the
# mikuswarm-browser network (compose creates it) and the egress sidecar hardens it. This
# script is RETAINED for the manual / non-compose bring-up path only (see
# docker/docker-compose.browser.yml).
#
# Idempotently create the dedicated bridge network for the CloakBrowser-Manager.
# A dedicated bridge keeps the browser off the harness/DB/sandbox/internal
# networks (no access to local services) while still reaching the public internet
# via the bridge's NAT. This is the browser's SSRF boundary, analogous to the
# sandbox's mikuswarm-sandbox network.
#
# For stricter isolation (block RFC1918/link-local egress while keeping the
# public internet) run docker/browser-egress-rules.sh as root — a separate
# operator/hardening step, not performed here.
#
# Run before `docker compose -f docker/docker-compose.browser.yml up -d`.

NETWORK_NAME="${MIKUSWARM_BROWSER_NETWORK:-mikuswarm-browser}"

case "$NETWORK_NAME" in
  bridge|none|host|container:*)
    # Standard/built-in network modes need no creation.
    exit 0
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "warning: docker not found; cannot ensure browser network $NETWORK_NAME" >&2
  exit 0
fi

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  exit 0
fi

# IPv6 disabled for the same reason as the sandbox bridge: the egress hardening
# (browser-egress-rules.sh) pins IPv4 public resolvers and its DROP rules only
# cover IPv4. A v6-enabled bridge would route IPv6 around that block.
docker network create --driver bridge --ipv6=false "$NETWORK_NAME" >/dev/null
echo "Created browser Docker network: $NETWORK_NAME" >&2
