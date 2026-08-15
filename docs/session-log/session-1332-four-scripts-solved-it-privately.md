# Session 1332

## Four scripts solved it privately

A hook that runs git inside a fixture repo inherits `GIT_DIR` from the environment and writes to the
**real** repository (#3722). The repo already had a shared helper for this — `scripts/lib/git-scratch-guard.sh`.

Exactly **one** script used it.

Four others hand-rolled their own private `unset GIT_DIR GIT_WORK_TREE …` block, each written
independently after a separate incident: `check-migrations-immutable.sh`, `test-related-rust.sh`,
`check-sqlx-cache-drift.sh`, and `check-session-log-numbering.sh` — the last not even setting
`GIT_CEILING_DIRECTORIES`, so it was the least protected of the five while looking like the other four.

That is the shape worth recording. The fix existed, was correct, and sat in `scripts/lib/`. It did not
spread, because nothing made the next author look for it. Five independent solutions to one problem is
not five people being careless; it is a missing enforcement.

So the durable half is the meta-guard: `check-git-fixture-isolation.mjs` scans every `.sh` under
`scripts/` and fails on a hand-rolled unset block, or a `git init` without sourcing the shared helper.

### The guard had two fail-open evasions of its own

Review attacked the scanner with four adversarial fixtures rather than reading it, and two passed when
they should not have:

- **A prose mention counted as sourcing.** `sourcesSharedGuard` did a raw substring match over the
  whole file, comments included — so a script that merely *named* `git-scratch-guard.sh` in a docstring,
  while running a bare `git -C "$tmp" init` with no isolation at all, was reported clean.
- **A backslash line-continuation hid the `git init`.** `hasFixtureGitInit` never joined continuations,
  even though its sibling `hasHandRolledGitEnvUnset` in the same file already did. Splitting
  `git -C "$tmp" \` / `init` across two lines slipped straight through.

Both closed and regression-tested. A third — indirecting the command name through a variable
(`GITBIN=git; "$GITBIN" init`) — is left open and **documented in the file's header**, because closing it
needs real shell parsing rather than a textual scan. A stated limitation is a different object from an
unnoticed one.

### A sourcing hazard nobody was looking for

Found while migrating: sourcing the library from a top-level `if [ "${1:-}" = "--self-test" ]` block
inherits the *caller's* `$1`, so the library's **own** self-test fires as a side effect — printing its
output and leaking `set -uo pipefail` into the caller's shell.

Three of the four scripts were never at risk, because they gate on a variable set by a `shift`-ing
argument loop before sourcing. Only `check-session-log-numbering.sh` had the raw `$1` check. Fixed with
an explicit `shift`.

Worth noticing that this bug only becomes reachable *by centralising* — it does not exist while everyone
hand-rolls. Sharing code moves the failure modes rather than removing them, and the new ones are the
ones nobody has met yet.

### The leak, reproduced against a victim rather than reasoned about

Two disposable repos under `mktemp -d`. Under a hostile environment exporting `GIT_DIR`,
`GIT_WORK_TREE` and `GIT_INDEX_FILE`, the pre-fix shape genuinely overwrote the victim's `user.email`
and `user.name` — and never created the fixture at all. The shared helper, under the identical
environment, left the victim's config, index and refs byte-identical by sha256 and diff, and built the
fixture where it belonged.

The real repository was never used for any of it, which is the only responsible way to demonstrate a
bug whose symptom is "writes to the real repository".

Nothing safety-relevant was lost in migrating: the helper's 17-variable list is a strict superset of
every private one, and `check-session-log-numbering.sh` gains `GIT_CEILING_DIRECTORIES` for the first
time.

### The pinning half

prek, taplo-cli and typos-cli were unpinned across all four `taiki-e/install-action` sites, while zizmor
and sqruff were pinned *with incident comments* — the shape existed and had simply not been extended.

The failure mode is nastier than version skew: CI and local disagree about what passes, so a developer
cannot reproduce a red, and a green tree goes red with no repo change.

Pinned at `prek@0.3.8` — the version every "Verified against prek 0.3.8" comment in `prek.toml` already
named, and the one the issue's own binary search identified. `setup-hooks.sh`'s existing
`pinned_version_for` mechanism extended to all three, plus a consistency guard following the zizmor
precedent exactly.

The guard is not the vacuous shape it could easily have been: it extracts from `setup-hooks.sh` and
scans the workflows independently, so it compares two genuinely different sources — proven by injecting
`0.4.11` into one workflow only and watching it name all five sites and both disagreeing values.
