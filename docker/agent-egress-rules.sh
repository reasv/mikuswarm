#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper around docker/egress-rules.sh for the AGENT compose bridge (the
# `miku` network in docker-compose.yml). This is the egress boundary for the
# agent container's own outbound fetches (web_fetch, media/image downloads, …),
# letting docker/95-docker.toml switch the per-request app-layer guard OFF
# (network.ssrf_guard = false) without losing private-network protection.
#
# --allow-intra is REQUIRED here (unlike sandbox/browser): the agent must still
# reach its compose peers (console <-> agent) and the host-gateway
# (host.docker.internal, for the optional CloakBrowser-Manager), all of which sit
# inside the bridge's own RFC1918 subnet. The wrapper RETURNs that subnet above
# the private-range drops; everything else private is still blocked.
#
# Prereqs: the `miku` network must exist (docker compose up creates it) and the
# agent service should pin DNS to the public resolvers (see docker-compose.yml)
# so name resolution survives the RFC1918 drops. See docker/egress-rules.sh for
# the full rule set and operational notes.
#
# Under Compose this is normally NOT needed: the `egress` sidecar service
# applies/reconciles these rules automatically (docker/egress-entrypoint.sh).
# Kept for manual/debug use.
#
# Usage: sudo MIKUSWARM_AGENT_NETWORK=miku docker/agent-egress-rules.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/egress-rules.sh" "${MIKUSWARM_AGENT_NETWORK:-miku}" "mikuswarm-egress" --allow-intra
