#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper around docker/egress-rules.sh for the sandbox bridge (the agent's
# `bash` tool). Restricts it to the public internet only — no host/LAN/loopback.
# The dedicated bridge (ensure-sandbox-network.sh) already keeps the sandbox off
# other docker networks; these iptables rules add RFC1918/link-local blocking.
# See docker/egress-rules.sh for the full rule set and operational notes.
#
# Usage: sudo MIKUSWARM_SANDBOX_NETWORK=mikuswarm-sandbox docker/sandbox-egress-rules.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/egress-rules.sh" "${MIKUSWARM_SANDBOX_NETWORK:-mikuswarm-sandbox}" "mikuswarm-sandbox-egress"
