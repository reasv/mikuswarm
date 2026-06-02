#!/usr/bin/env python3
"""Vendor shadcn-svelte components directly from the registry.

The shadcn-svelte `init` CLI gates on an interactive design-system "preset"
(now a URL/code system) that cannot be driven non-interactively. We've already
done the equivalent of init by hand (components.json, utils.ts, theme CSS), so
this script does what `add` would do: fetch each registry item's inline files
and write them under the configured ui/lib aliases, resolving registryDependencies
recursively. npm deps each item declares are printed at the end to install.

Usage: python3 scripts/vendor-shadcn.py button badge card ...
"""
import json, os, sys, urllib.request

REGISTRY = "https://shadcn-svelte.com/registry"
UI_DIR = "src/lib/components/ui"
LIB_DIR = "src/lib"
HOOKS_DIR = "src/lib/hooks"

npm_deps: set[str] = set()
done: set[str] = set()


def fetch(name: str) -> dict:
    url = f"{REGISTRY}/{name}.json"
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def dir_for(item_type: str) -> str:
    if item_type == "registry:lib":
        return LIB_DIR
    if item_type == "registry:hook":
        return HOOKS_DIR
    return UI_DIR  # registry:ui and everything else → ui alias


def add(name: str) -> None:
    if name in done:
        return
    done.add(name)
    item = fetch(name)
    for dep in item.get("dependencies") or []:
        npm_deps.add(dep)
    for dep in item.get("devDependencies") or []:
        npm_deps.add(dep)
    for reg in item.get("registryDependencies") or []:
        # 'utils' was created during manual init; skip re-adding it.
        if reg == "utils":
            continue
        add(reg)
    base = dir_for(item.get("type", "registry:ui"))
    for f in item.get("files") or []:
        target = f["target"]
        dest = os.path.join(base, target)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w") as out:
            out.write(f["content"])
        print(f"  wrote {dest}")


def main() -> None:
    names = sys.argv[1:]
    if not names:
        print("usage: vendor-shadcn.py <component>...", file=sys.stderr)
        sys.exit(2)
    for n in names:
        print(f"== {n} ==")
        add(n)
    if npm_deps:
        print("\nNPM deps to install:")
        print(" ".join(sorted(npm_deps)))


if __name__ == "__main__":
    main()
