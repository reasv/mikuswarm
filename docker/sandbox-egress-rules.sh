#!/usr/bin/env bash
set -euo pipefail

# HARDENING (operator-run, requires root). Restrict the sandbox bridge so the
# agent's `bash` tool can reach the public internet but NOT local/private
# networks (the harness, DB, other host services, the LAN, link-local, loopback).
#
# This is NOT run by the harness (which has no root). Run it once after the
# network exists; reapply on reboot (e.g. via systemd) unless you persist
# iptables rules. The dedicated bridge alone (ensure-sandbox-network.sh) already
# keeps the sandbox off other docker networks; these rules add RFC1918 blocking.
#
# Usage: sudo MIKUSWARM_SANDBOX_NETWORK=mikuswarm-sandbox docker/sandbox-egress-rules.sh

NETWORK_NAME="${MIKUSWARM_SANDBOX_NETWORK:-mikuswarm-sandbox}"

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

# Allow DNS and established/related; drop private destinations; allow the rest
# (public internet). Inserted into DOCKER-USER so they run before docker's own
# allow rules. -I prepends; we add in reverse priority order.
PRIVATE_RANGES=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8)

# Drop traffic originating from the sandbox bridge to private ranges.
for range in "${PRIVATE_RANGES[@]}"; do
  iptables -C DOCKER-USER -i "$BRIDGE" -d "$range" -j DROP 2>/dev/null \
    || iptables -I DOCKER-USER -i "$BRIDGE" -d "$range" -j DROP
done

# But still permit DNS (often a private resolver). Prefer pinning a public DNS
# via the container/network (--dns 1.1.1.1) so resolution survives the DROP rules.
iptables -C DOCKER-USER -i "$BRIDGE" -p udp --dport 53 -j RETURN 2>/dev/null \
  || iptables -I DOCKER-USER -i "$BRIDGE" -p udp --dport 53 -j RETURN
iptables -C DOCKER-USER -i "$BRIDGE" -p tcp --dport 53 -j RETURN 2>/dev/null \
  || iptables -I DOCKER-USER -i "$BRIDGE" -p tcp --dport 53 -j RETURN

echo "Done. Verify with: iptables -L DOCKER-USER -n -v" >&2
