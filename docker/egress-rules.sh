#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Unified network-egress hardening for a Miku docker bridge (operator-run, root).
#
# Restricts a bridge so its containers can reach the public internet but NOT
# local/private networks (the host, the LAN, other docker networks, link-local —
# which subsumes the 169.254.169.254 cloud-metadata endpoint — and loopback).
# This is the REAL SSRF boundary; the app-layer guard (network.ssrf_guard) is
# defense-in-depth on top and can be switched off where this firewall is in force.
#
# One engine, three callers (thin wrappers that just pass a network + tag):
#   docker/sandbox-egress-rules.sh   mikuswarm-sandbox  bash-tool isolation
#   docker/browser-egress-rules.sh   mikuswarm-browser  CloakBrowser-Manager isolation
#   docker/agent-egress-rules.sh     miku          agent container (--allow-intra)
#
# Usage:
#   sudo docker/egress-rules.sh <network-name> <comment-tag> [--allow-intra]
# or via env (wrappers use this form):
#   sudo MIKUSWARM_EGRESS_NETWORK=<net> MIKUSWARM_EGRESS_TAG=<tag> \
#        [MIKUSWARM_EGRESS_ALLOW_INTRA=1] docker/egress-rules.sh
#
# --allow-intra (agent network only): RETURN the bridge's own subnet(s) ABOVE the
# private-range drops, so intra-compose service traffic (console <-> agent) and
# the host-gateway (host.docker.internal) keep working while the rest of RFC1918
# is still blocked. Sandbox/browser bridges need no peers, so they omit it.
#
# NOT run by the harness (which has no root — the confined workload must never
# own its own firewall). Two callers:
#   - The `egress` compose sidecar (docker/Dockerfile.egress +
#     egress-entrypoint.sh) reconciles the agent + sandbox + browser bridges on a
#     loop from the host network namespace — the normal path under Compose; reboots
#     and network recreation self-heal, no operator action.
#   - Operator-run with sudo (the wrappers above) only for native/non-compose
#     deployments. Rules are NOT persistent: reapply on
#     reboot, and after every network (re)creation — the bridge name derives
#     from the network ID, so a recreated network yields a new bridge and rules
#     keyed on the old one go stale.
# The flush-by-comment below removes this script's previous rules and re-derives
# them for the current bridge on every run, so re-running (from either caller,
# in any order) is always safe and self-correcting.
# =============================================================================

NETWORK_NAME="${1:-${MIKUSWARM_EGRESS_NETWORK:-}}"
COMMENT="${2:-${MIKUSWARM_EGRESS_TAG:-}}"
ALLOW_INTRA="${MIKUSWARM_EGRESS_ALLOW_INTRA:-0}"
if [ "${3:-}" = "--allow-intra" ] || [ "${2:-}" = "--allow-intra" ]; then
  ALLOW_INTRA=1
fi

if [ -z "$NETWORK_NAME" ] || [ -z "$COMMENT" ] || [ "$COMMENT" = "--allow-intra" ]; then
  echo "usage: sudo $0 <network-name> <comment-tag> [--allow-intra]" >&2
  exit 2
fi

# Pinned public resolvers (matching --dns on the container/network). DNS is
# permitted to these destinations only — not to arbitrary hosts on port 53, which
# would otherwise allow DNS-tunnel exfil to the LAN/harness/DB.
PUBLIC_RESOLVERS=(1.1.1.1 8.8.8.8)

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "error: must run as root (iptables)" >&2
  exit 1
fi

NET_ID="$(docker network inspect -f '{{.Id}}' "$NETWORK_NAME")"
BRIDGE="br-${NET_ID:0:12}"

echo "Applying egress rules to bridge $BRIDGE (network $NETWORK_NAME, tag $COMMENT, allow_intra=$ALLOW_INTRA)" >&2

# The bridge's own subnet(s) — RETURNed above the drops when --allow-intra is set
# so same-network peers and the host-gateway remain reachable.
mapfile -t NET_SUBNETS < <(docker network inspect -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$NETWORK_NAME" | grep -v '^$' || true)

# Remove any rules this script previously installed (matched by comment), across
# any stale bridge name, so each run starts clean and re-derives for the current
# bridge. Iterate because a single -D removes one matching rule at a time.
flush_owned_rules() {
  local ipt="$1"
  command -v "$ipt" >/dev/null 2>&1 || return 0
  # DOCKER-USER may not exist (e.g. ip6tables on a host with no IPv6 docker
  # rules); tolerate that without aborting the whole script.
  while "$ipt" -S DOCKER-USER 2>/dev/null | grep -q -- "--comment $COMMENT"; do
    local rule
    rule="$("$ipt" -S DOCKER-USER 2>/dev/null | grep -m1 -- "--comment $COMMENT")" || break
    # shellcheck disable=SC2086
    "$ipt" -D DOCKER-USER ${rule#-A DOCKER-USER }
  done
}

# Insert a comment-tagged rule into DOCKER-USER if not already present.
add_rule() {
  local ipt="$1"; shift
  if ! "$ipt" -C DOCKER-USER "$@" -m comment --comment "$COMMENT" 2>/dev/null; then
    "$ipt" -I DOCKER-USER "$@" -m comment --comment "$COMMENT"
  fi
}

# --- IPv4 ----------------------------------------------------------------
# Rules are inserted into DOCKER-USER (runs before docker's own allow rules).
# -I prepends, so we add in REVERSE priority order: drops first, then the RETURNs
# (DNS, and the intra-subnet allow) on top, so they are evaluated before the
# RFC1918 drops.
# 169.254.0.0/16 is link-local; it subsumes the cloud metadata endpoint
# 169.254.169.254 (AWS/GCP/Azure IMDS), so that high-value SSRF target is blocked.
PRIVATE_RANGES_V4=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8)

flush_owned_rules iptables

# Drop traffic originating from the bridge to private ranges.
for range in "${PRIVATE_RANGES_V4[@]}"; do
  add_rule iptables -i "$BRIDGE" -d "$range" -j DROP
done

# Permit DNS to the pinned public resolvers only (udp + tcp). Inserted after the
# drops so they sit above them; scoped by -d so they cannot reach arbitrary
# port-53 services on the LAN/harness/DB.
for resolver in "${PUBLIC_RESOLVERS[@]}"; do
  add_rule iptables -i "$BRIDGE" -p udp -d "$resolver" --dport 53 -j RETURN
  add_rule iptables -i "$BRIDGE" -p tcp -d "$resolver" --dport 53 -j RETURN
done

# Optionally allow the bridge's own subnet(s) (intra-compose peers + host-gateway).
if [ "$ALLOW_INTRA" = "1" ]; then
  for subnet in "${NET_SUBNETS[@]}"; do
    case "$subnet" in
      *.*) add_rule iptables -i "$BRIDGE" -d "$subnet" -j RETURN ;;  # IPv4 only here
    esac
  done
fi

# --- IPv6 ----------------------------------------------------------------
# The bridge is created with IPv6 disabled (ensure-*-network.sh / compose), so
# containers should have no IPv6 address. As defense-in-depth, if ip6tables is
# available we still drop the IPv6 private/link-local/loopback ranges so a
# misconfigured (v6-enabled) bridge cannot bypass the v4 block. No public IPv6 DNS
# is permitted because the pinned resolvers are IPv4.
if command -v ip6tables >/dev/null 2>&1; then
  if ip6tables -L DOCKER-USER -n >/dev/null 2>&1; then
    PRIVATE_RANGES_V6=(fc00::/7 fe80::/10 ::1/128)
    flush_owned_rules ip6tables
    for range in "${PRIVATE_RANGES_V6[@]}"; do
      add_rule ip6tables -i "$BRIDGE" -d "$range" -j DROP
    done
    if [ "$ALLOW_INTRA" = "1" ]; then
      for subnet in "${NET_SUBNETS[@]}"; do
        case "$subnet" in
          *:*) add_rule ip6tables -i "$BRIDGE" -d "$subnet" -j RETURN ;;
        esac
      done
    fi
  else
    echo "warning: ip6tables present but DOCKER-USER chain missing; skipping IPv6 rules" >&2
    echo "         (the bridge has IPv6 disabled, so this is expected)" >&2
  fi
else
  echo "warning: ip6tables not found; relying on IPv6 being disabled on the bridge" >&2
fi

echo "Done. Verify with: iptables -L DOCKER-USER -n -v (and ip6tables ...)" >&2
