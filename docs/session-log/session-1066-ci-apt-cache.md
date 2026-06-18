## Session 1066 — CI apt-archive cache (#1464) (2026-06-18)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-18 |
| **Subagents** | orchestrator-only |
| **Items closed** | `#1464` |
| **Items modified** | — |
| **Tests added** | — (CI infra; validated by the CI run itself) |
| **Files touched** | 2 |

**Summary:** Cache apt `.deb` archives across CI runs so the per-PR jobs stop
re-downloading system deps from the slow Ubuntu mirror (one run cost 760 s in
Playwright `install-deps` alone). Investigation found npm (`actions/setup-node`
`cache: npm`) and Rust crates (`Swatinem/rust-cache`, which caches
`~/.cargo/registry`) are **already** cached — apt was the only real gap.

The `prepare-apt` composite action now sets `APT::Keep-Downloaded-Packages
"true"` (apt stops deleting .debs post-install) and makes `/var/cache/apt/archives`
runner-writable (0777) so `actions/cache` can populate it before the sudo
`apt-get` reads it. Each apt-installing `_validate.yml` job gained an
`actions/cache` step on `/var/cache/apt/archives/*.deb`:
- the 3 Playwright e2e shards share `apt-playwright-${os}-${hash(package-lock)}`;
- lint / cargo-tests / mcp-tests share `apt-tauri-${os}-v1` (identical
  webkit/gtk/ssl/rsvg/soup/mold set).

On a hit, `apt-get install` / `install-deps` resolves from local .debs — no
mirror round-trip. Jobs share a key across runs (parallel jobs in one run each
restore independently, which is a fast GH-cache fetch, not the slow mirror).

**Files touched (this session):**
- `.github/actions/prepare-apt/action.yml` — keep-downloaded-packages + 0777 archive dir.
- `.github/workflows/_validate.yml` — 4 `actions/cache` steps (e2e ×1 shared across 3 shards, lint, cargo-tests, mcp-tests).

**Verification:**
- `python -c yaml.safe_load` parses both files; cache action pinned to the same SHA already vetted in-repo.
- CI infra can't be validated locally — confirmed by the PR's own CI run (first run populates the cache; subsequent runs hit).

**Out of scope (follow-up):** `ci.yml` / `release.yml` / `scheduled-deep-checks.yml`
have standalone apt blocks (no `prepare-apt`); they can adopt the same pattern later.

**Commit plan:** single commit; pushed; PR opened.
