#!/usr/bin/env bash
set -euo pipefail

# HARDENING (operator-run, requires root). Restrict the sandbox bridge so the
# agent's `bash` tool can reach the public internet but NOT local/private
# networks (the harness, DB, other host services, the LAN, link-local, loopback).
#
# This is NOT run by the harness (which has no root). Run it once after the
# network exists; reapply on reboot (e.g. via systemd) unless you persist
# iptables rules. IMPORTANT: also reapply after every network (re)creation — the
# bridge name is derived from the network ID, so recreating the network yields a
# new bridge and any rules keyed on the old bridge go stale. The script
# flush-by-comment removes its previous rules and re-derives them for the
# current bridge on every run, so re-running is always safe and self-correcting.
# The dedicated bridge alone (ensure-sandbox-network.sh) already keeps the
# sandbox off other docker networks; these rules add RFC1918 blocking.
#
# Usage: sudo MIKUSWARM_SANDBOX_NETWORK=mikuswarm-sandbox docker/sandbox-egress-rules.sh

NETWORK_NAME="${MIKUSWARM_SANDBOX_NETWORK:-mikuswarm-sandbox}"

# Tag every rule this script owns so we can flush exactly our rules (and only
# ours) at the start, re-deriving them for the current bridge each run.
COMMENT="mikuswarm-sandbox-egress"

# Pinned public resolvers (matching --dns on the container/network). DNS is
# permitted to these destinations only — not to arbitrary hosts on port 53,
# which would otherwise allow DNS-tunnel exfil to the LAN/harness/DB.
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

echo "Applying egress rules to bridge $BRIDGE (network $NETWORK_NAME)" >&2

# Remove any rules this script previously installed (matched by comment), across
# any stale bridge name, so each run starts clean and re-derives for the current
# bridge. Iterate because a single -D removes one matching rule at a time.
flush_owned_rules() {
  local ipt="$1"
  command -v "$ipt" >/dev/null 2>&1 || return 0
  # DOCKER-USER may not exist (e.g. ip6tables on a host with no IPv6 docker
  # rules); tolerate that without aborting the whole script.
  while "$ipt" -S DOCKER-USER 2>/dev/null | grep -q -- "--comment $COMMENT"; do
    # Translate the first matching "-A ..." rule spec into a "-D ..." delete.
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
# -I prepends, so we add in REVERSE priority order: drops first, then the DNS
# RETURNs on top, so DNS-to-public-resolvers is evaluated before the RFC1918
# drops.
PRIVATE_RANGES_V4=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8)

flush_owned_rules iptables

# Drop traffic originating from the sandbox bridge to private ranges.
for range in "${PRIVATE_RANGES_V4[@]}"; do
  add_rule iptables -i "$BRIDGE" -d "$range" -j DROP
done

# Permit DNS to the pinned public resolvers only (udp + tcp). Inserted last so
# they sit above the private-range drops; scoped by -d so they cannot be abused
# to reach arbitrary port-53 services on the LAN/harness/DB.
for resolver in "${PUBLIC_RESOLVERS[@]}"; do
  add_rule iptables -i "$BRIDGE" -p udp -d "$resolver" --dport 53 -j RETURN
  add_rule iptables -i "$BRIDGE" -p tcp -d "$resolver" --dport 53 -j RETURN
done

# --- IPv6 ----------------------------------------------------------------
# The bridge is created with IPv6 disabled (ensure-sandbox-network.sh), so the
# sandbox should have no IPv6 address. As defense-in-depth, if ip6tables is
# available we still drop the IPv6 private/link-local/loopback ranges from the
# bridge so a misconfigured (v6-enabled) bridge cannot bypass the v4 block.
# No public IPv6 DNS is permitted because the pinned resolvers are IPv4.
if command -v ip6tables >/dev/null 2>&1; then
  if ip6tables -L DOCKER-USER -n >/dev/null 2>&1; then
    PRIVATE_RANGES_V6=(fc00::/7 fe80::/10 ::1/128)
    flush_owned_rules ip6tables
    for range in "${PRIVATE_RANGES_V6[@]}"; do
      add_rule ip6tables -i "$BRIDGE" -d "$range" -j DROP
    done
  else
    echo "warning: ip6tables present but DOCKER-USER chain missing; skipping IPv6 rules" >&2
    echo "         (the sandbox bridge has IPv6 disabled, so this is expected)" >&2
  fi
else
  echo "warning: ip6tables not found; relying on IPv6 being disabled on the bridge" >&2
fi

echo "Done. Verify with: iptables -L DOCKER-USER -n -v (and ip6tables ...)" >&2
