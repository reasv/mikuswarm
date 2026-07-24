# Releasing MikuSwarm

A release is one pushed `vX.Y.Z` tag. Pushing that tag is the only trigger: CI
builds and pushes every container image to GHCR, then publishes a GitHub release
whose notes are the `CHANGELOG.md` section for that version. Nothing else
publishes a release, and no other event triggers the workflow. See
[.github/workflows/release.yml](.github/workflows/release.yml) and
[scripts/changelog.py](scripts/changelog.py).

This file is the runbook for cutting one. Steps 1 to 8 are the preparation an
agent does on request; the final section is the single command block the
maintainer runs to publish.

## Version sources

| File | Version | Bump on release? |
|---|---|---|
| `package.json` | canonical MikuSwarm version | **Yes.** CI fails the release if this does not equal the tag. |
| `native/crates/matrix-core/Cargo.toml` | Rust NAPI module | Keep in sync with `package.json`. |
| `console/package.json` | observability console | Independent. Bump only if the console shipped a change worth its own number. |

Container image tags are derived from the git tag by the workflow, so there is
nothing to bump for those.

## Preparing a release

1. **Reconcile the changelog against the commit history first.** The
   `## [Unreleased]` section is a draft that may be incomplete or empty; it is
   not the source of truth. Find the previous release tag and read every commit
   since it:

   ```
   git describe --tags --abbrev=0   # the previous vX.Y.Z
   git log --no-merges vPREV..HEAD
   ```

   Go through that log and make sure every user-visible change is represented in
   the Unreleased section: added features, changed behavior, fixes, removals.
   Add anything missing, in the project's changelog voice (full sentences, most
   important first). Ignore commits with no user-visible effect (refactors,
   internal docs, test-only, CI). The finished Unreleased section must describe
   the whole span `vPREV..HEAD`, not only what someone happened to jot down as
   they worked.

2. **Pick the version `X.Y.Z`** from the reconciled entries, following
   [Semantic Versioning](https://semver.org/spec/v2.0.0.html): breaking changes
   bump major, backward-compatible features bump minor, fixes bump patch.

3. **CHANGELOG.md.** Rename the `## [Unreleased]` heading to
   `## [vX.Y.Z] - YYYY-MM-DD` (today's date, UTC). Add a fresh, empty
   `## [Unreleased]` section above it, carrying the guidance comment. The version
   section must not be empty and its bullets are the release notes, so read them
   as the notes a user will see: full sentences, newest and most important first.

4. **`package.json`.** Set `"version"` to `X.Y.Z`.

5. **`native/crates/matrix-core/Cargo.toml`.** Set `version` to `X.Y.Z` to keep
   the Rust module in step with the package.

6. **`console/package.json`.** Bump only if the console changed; otherwise leave
   it.

7. **Validate locally.** Both must succeed:

   ```
   python3 scripts/changelog.py validate
   python3 scripts/changelog.py extract --tag vX.Y.Z
   ```

   The first fails on a malformed changelog; the second prints exactly the notes
   CI will attach to the release. If `extract` errors, the version section is
   missing or empty, which is the same failure CI would hit.

8. **Commit.** One commit, subject only, under 80 characters, no body and no
   trailer:

   ```
   git add CHANGELOG.md package.json native/crates/matrix-core/Cargo.toml
   git commit -m "Release vX.Y.Z"
   ```

   Leave the commit local. Do not push, and do not create the tag: pushing the
   tag is the maintainer's step, because it is what triggers the build and the
   published release.

## Publishing (maintainer)

Review the release commit, then run:

```
git push origin master
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The last line triggers the release. The workflow builds and pushes the images,
checks that `vX.Y.Z` matches `package.json`, extracts the changelog section, and
publishes the GitHub release with those notes. Watch it under the repository's
Actions tab.

### If it goes wrong

- **Build fails:** no release is published. Fix forward, then move the tag:
  `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`.
- **Wrong notes or version:** because the tag is the trigger, deleting and
  re-pushing it re-runs everything:
  `git push origin :vX.Y.Z` to delete the remote tag, correct the changelog or
  `package.json`, then re-tag and push again.
