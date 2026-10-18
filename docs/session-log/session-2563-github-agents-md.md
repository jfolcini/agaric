# Session 2563 — `.github/AGENTS.md`: what an edit to CI can break

The maintainer asked for an AGENTS.md beside the workflows after a CI audit (#5853)
found facts an agent editing them would miss. `.github/AGENTS.md` holds them: how
`validate-all` aggregates and fails closed, gating through `classify-changes.sh`
rather than `on: paths:`, the non-gating real-backend lane, `_validate.yml`'s two
callers, DCO and the "Update branch" ban, slots versus minutes and the cancel
rules, cache-key ownership and the shared quota, the pins, and reading a run.

Every line was checked against the file or symbol it rests on; the draft's claims
that did not hold were corrected or dropped (the toolchain's nightly `fuzz`
exception, `mutation-pr.yml` as the one non-gating `paths:` workflow, read-only
rather than `contents: read` top-level permissions, which weekly lanes take a
cache key). `gh run view --log` does work on a completed run and refuses only
while the run is in progress, so `e2e-tauri/AGENTS.md`'s "prints nothing" line,
which was wrong, now points here. Whether the ruleset's bare `validate-all`
matches the posted `validate / validate-all` is left open in #5853, not asserted.

Root `AGENTS.md`'s Documentation Map lists the new file.
