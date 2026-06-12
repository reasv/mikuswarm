#!/usr/bin/env bash
set -euo pipefail

# SUPERSEDED for the standard deployment: the egress sidecar (egress-entrypoint.sh)
# now reconciles the mikuswarm-browser bridge automatically in its loop, so this manual
# root step is no longer part of `docker compose up`. RETAINED for the manual /
# non-compose bring-up path only (see docker/docker-compose.browser.yml).
#
# Thin wrapper around docker/egress-rules.sh for the CloakBrowser-Manager bridge.
# This is the network-layer SSRF boundary for browsing — enforced where a JS
# redirect inside the page cannot bypass it (the tool-layer scheme check in
# src/browser/url-policy.ts is defense-in-depth on top). Restricts the bridge to
# the public internet only — no host/LAN/loopback.
# See docker/egress-rules.sh for the full rule set and operational notes.
#
# Usage: sudo MIKUSWARM_BROWSER_NETWORK=mikuswarm-browser docker/browser-egress-rules.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/egress-rules.sh" "${MIKUSWARM_BROWSER_NETWORK:-mikuswarm-browser}" "mikuswarm-browser-egress"
