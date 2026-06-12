#!/bin/sh
set -u

# =============================================================================
# Entrypoint for the mikuswarm-egress firewall sidecar (docker/Dockerfile.egress,
# `egress` service in docker-compose.yml).
#
# Runs in the HOST network namespace (network_mode: host) with CAP_NET_ADMIN and
# reconciles the egress firewall (docker/egress-rules.sh) for the bridges this
# compose deployment owns:
#
#   - the agent bridge (MIKUSWARM_AGENT_NETWORK, default "miku") with --allow-intra —
#     REQUIRED for health: the agent runs with the app-layer SSRF guard off
#     (docker/95-docker.toml), so this firewall is the boundary. The agent
#     service `depends_on` this container being healthy (fail-closed: no rules,
#     no agent).
#   - the sandbox bridge (MIKUSWARM_SANDBOX_NETWORK, default "mikuswarm-sandbox") — the
#     agent CREATES this network lazily at sandbox startup, so its absence is
#     tolerated; once it appears the loop picks it up within one interval (this
#     replaces the manual rerun the sandbox_network_created warning asks for).
#
# The browser bridge (mikuswarm-browser) belongs to the separately operated
# CloakBrowser-Manager compose file and is NOT handled here.
#
# Reconcile loop, not one-shot: egress-rules.sh is idempotent and self-correcting
# (flush-by-comment + re-derive per run), so reapplying every INTERVAL seconds
# self-heals reboots, `docker compose up` network recreation, and daemon
# restarts without operator action. Health marker = last pass applied the agent
# rules successfully.
# =============================================================================

AGENT_NET="${MIKUSWARM_AGENT_NETWORK:-miku}"
SANDBOX_NET="${MIKUSWARM_SANDBOX_NETWORK:-mikuswarm-sandbox}"
INTERVAL="${MIKUSWARM_EGRESS_INTERVAL_S:-60}"
MARKER="${MIKUSWARM_EGRESS_MARKER:-/tmp/egress-applied}"
RULES=/opt/egress/egress-rules.sh

# The host kernel holds ONE ruleset, but it is reachable through two userspace
# backends (legacy x_tables vs nf_tables). Docker's DOCKER-USER chain exists in
# whichever backend the host daemon uses; writing through the other one would
# install rules into a chain docker never consults. Pick the variant that can
# see DOCKER-USER and front-run PATH with it so egress-rules.sh (which invokes
# plain `iptables`/`ip6tables`) uses the right backend.
detect_backend() {
  for variant in iptables-nft iptables-legacy iptables; do
    command -v "$variant" >/dev/null 2>&1 || continue
    if "$variant" -S DOCKER-USER >/dev/null 2>&1; then
      echo "$variant"
      return 0
    fi
  done
  return 1
}

if ! IPT="$(detect_backend)"; then
  echo "error: no iptables backend exposes docker's DOCKER-USER chain — is the" >&2
  echo "       container running with network_mode: host and CAP_NET_ADMIN?" >&2
  exit 1
fi
mkdir -p /usr/local/sbin
ln -sf "$(command -v "$IPT")" /usr/local/sbin/iptables
IP6T="$(echo "$IPT" | sed 's/^iptables/ip6tables/')"
if command -v "$IP6T" >/dev/null 2>&1; then
  ln -sf "$(command -v "$IP6T")" /usr/local/sbin/ip6tables
fi
PATH="/usr/local/sbin:$PATH"
export PATH
echo "egress sidecar: using $IPT (DOCKER-USER found); reconciling every ${INTERVAL}s" >&2

while :; do
  agent_ok=0
  if docker network inspect "$AGENT_NET" >/dev/null 2>&1; then
    if "$RULES" "$AGENT_NET" mikuswarm-egress --allow-intra; then
      agent_ok=1
    fi
  else
    echo "egress sidecar: agent network $AGENT_NET not found yet; retrying" >&2
  fi
  if docker network inspect "$SANDBOX_NET" >/dev/null 2>&1; then
    "$RULES" "$SANDBOX_NET" mikuswarm-sandbox-egress \
      || echo "egress sidecar: sandbox rules failed; will retry" >&2
  fi
  if [ "$agent_ok" = 1 ]; then
    touch "$MARKER"
  else
    rm -f "$MARKER"
  fi
  sleep "$INTERVAL"
done
