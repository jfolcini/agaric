# Session 1357 — CI guard completeness: run-step checkouts, bare citations, migration-test coverage (2026-08-19)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | orchestrator-only (adversarial review + fixes) |
| **Items closed** | `#4148` `#4135` `#4144` |
| **Items modified** | — |
| **Tests added** | +42 guard self-test assertions across the three guards (JS guards only; no Rust or frontend suite touched) |
| **Files touched** | 6 |

**Summary:** Three CI guards had blind spots that made them assert less than their
headers claimed. `check-pr-overlap-trust-boundary.mjs` only inspected `ref:` lines, so a
checkout done inside a `run:` step evaded every condition; `check-doc-code-paths.mjs`
could not see a code citation written as a bare filename; and the migration-test nextest
filter documented in `migrations/AGENTS.md` was prose with nothing running it. All three
are now closed, and an adversarial pass over the incoming work found six further defects
in the fixes themselves — five evasion classes the new trust-boundary patterns still
missed, a missing stale-entry check that made one "shrink-only" baseline shrink-only in
name alone, and a ceiling divergence that let a migration satisfy the coverage guard
while never being selected by the filter it reproduces.

**Files touched (this session):**
- `scripts/check-pr-overlap-trust-boundary.mjs` (+815 / −17)
- `scripts/check-doc-code-paths.mjs` (+260 / −2)
- `scripts/check-migration-test-coverage.mjs` (new, 808 lines)
- `scripts/doc-code-paths-baseline.json` (+710)
- `src-tauri/migrations-test-coverage-baseline.txt` (new, 111 lines)
- `prek.toml` (+56)

## `#4148` — the trust-boundary guard's `run:`-step blind spot

The guard detected a checkout of PR-authored content by scanning for `ref:` lines. A
`run:` step doing its own checkout writes no `ref:` line and is not an
`actions/checkout` step, so a write-scoped job whose ONLY checkout was `gh pr checkout`
satisfied every condition the guard checked while doing exactly the thing it exists to
prevent. `findCheckoutSteps` now also recognises that shape, feeding both the
trigger-gated condition and the write-scope-gated one.

Because the detector is a denylist — the weakest shape a security check can take — it
was attacked rather than reviewed. An evasion battery of 23 shapes was run against the
incoming patterns; 8 were caught. Each miss was then either closed with a pattern and a
falsifiable fixture, or documented in the header as structurally out of reach and filed:

- **`gh` with a global flag before the subcommand.** `gh -R owner/repo pr checkout` is
  the documented spelling for an explicitly named repo, and an anchored `gh\s+pr` cannot
  match it. Closed.
- **`gh pr diff`.** The PR's own patch, piped to `git apply`, puts fork-authored code in
  the workspace with no `checkout` verb anywhere. Closed.
- **Every git verb other than `checkout` that consumes a fetched `FETCH_HEAD`** —
  `switch --detach`, `worktree add`, `reset --hard`, `merge`, `cherry-pick`, `rebase`,
  `restore`, `am`, `apply`, `pull`. The anchored pattern matched one of ten. Closed with
  a verb alternation, deliberately not a bare `git … FETCH_HEAD`: a read-only
  `git rev-parse FETCH_HEAD` puts nothing in the tree and has its own negative-control
  fixture.
- **A command YAML itself splits across source lines.** A folded `run: >` scalar rejoins
  its lines before the shell sees them, so a fetch can run with no single source line
  carrying both halves. This is a YAML-level blindness rather than the shell-level
  obfuscation the guard disclaims, so the patterns now also match against the step's
  non-comment lines joined. The join is scoped to one step and its failure direction is
  toward false positives, never toward a missed violation.
- **`merge_commit_sha`.** GitHub's precomputed merge of head into base — the same content
  the already-listed `refs/pull/<n>/merge` names, spelled as an event field. The
  write-scope condition caught it; the two trigger-gated conditions, the only ones that
  fire in a job with no write scope, did not. Closed.
- **`repository:` laundering.** A checkout spelling `ref: …pull_request.base.sha` reads
  as base-pinned and is waved through, while `repository:` silently redirects the whole
  clone at the fork, so the base ref's name resolves against fork objects. This turned
  the guard's one ACCEPTANCE path into a bypass. Closed, with a negative control
  pinning that `repository: ${{ github.repository }}` is still fine.

Also fixed: the incoming diff prefixed an already-`ref:`-prefixed line with another
`ref: `, so a real failure printed `line 18: ref: ref: ${{ … }}`.

Five shapes remain uncaught, all in classes a single-file textual guard cannot decide —
a checkout behind a composite or third-party action (it lives in another file), PR
content pulled over the network (`curl`ed patch or tarball, a downloaded artifact), and
shell-level indirection. These are named explicitly in the header rather than left
implied, and tracked in `#4183`.

## `#4135` — a bare-filename citation is invisible

The citation guard required a repo-rooted prefix, so `` `session_supervisor.rs:708-716` ``
matched nothing — the shape prose most naturally takes once a paragraph has named the
file once, and the shape most likely to rot after a crate split. It is now flagged by
FORM: a citation carrying a line number must be repo-rooted.

Flagging by form is only safe if the form is unambiguous, so the false-positive surface
was probed rather than assumed. The pattern is anchored to the whole code span, which
keeps a quoted log line, a URL, a `file:LINE:COL` diagnostic coordinate and a bare
mention with no line number all green — now pinned by a fixture that goes red the moment
the anchors come off.

142 pre-existing citations were grandfathered. Several were spot-checked in their source
context and are genuine bare citations, not artefacts the new pattern invented; the
baseline diff is purely additive (no existing entry dropped), and it flows through the
same mechanism that already fails on a stale entry, proved in both directions by
fixture. The burn-down is `#4181`.

One residual gap is now documented rather than left implied: a *partially*-rooted
citation has a slash, so the bare-form pattern skips it, and its leading segment is not
a known root, so the resolving half skips it too. It falls between both gates. `#4184`.

## `#4144` — the documented migration-test filter had nothing running it

`migrations/AGENTS.md` documents a nextest filter selecting "the migration tests" as a
group, and grepping the tree found zero references to it in any workflow, recipe or
hook. A new guard makes the convention structural instead: every migration must have a
test whose name the documented filter would actually select.

The claim worth checking was that the guard reproduces the filter's own selection logic,
because a divergence means a migration can satisfy the guard and still never run. It
did diverge, in the exact case the issue's acceptance names:

- **The ceiling.** The filter's `_0[0-9]{3}_` spans `0000`–`0999` only. Migration `1000`
  with a perfectly conventional `t_1000_thing_1234` test satisfied the guard's substring
  rule while the filter selected nothing — guard green, test never in the group. The
  ceiling is now checked as data rather than assumed, and deliberately is NOT
  baseline-exemptible: a ceiling breach is a broken filter, not a missing test.
- **A `.sql` file the guard cannot number** — a five-digit prefix, say — was silently
  dropped while the guard still reported "clean" about a file it never looked at. Now a
  wiring failure.
- **Stale baseline entries were not detected at all.** The header and the hook comment
  both called the baseline shrink-only, but only the growth direction was enforced: a
  migration that later gained a correctly-named test kept its grandfathering forever,
  and a line naming a nonexistent migration was accepted in silence. Both are now red
  until pruned.

The 102 grandfathered numbers were verified against the tree: uncovered set and baseline
match exactly, with no stale and no new entries. Two of them (`0073`, `0099`) are a
scoping artefact rather than a coverage gap — their tests live in `db/recovery.rs`, which
the filter selects and this guard does not scan — recorded in the header and in the
sweep issue. The burn-down is `#4182`.

**Verification:**
- `node scripts/check-pr-overlap-trust-boundary.mjs --self-test` — all assertions pass;
  plain mode against the real `pr-overlap.yml` — clean.
- `node scripts/check-doc-code-paths.mjs --self-test` — pass; plain mode and `--worktree`
  against the real tree — clean.
- `node scripts/check-migration-test-coverage.mjs --self-test` — all assertions pass;
  plain mode against the real tree — clean.
- Every new assertion was mutation-tested: the production change it claims to protect
  was actually made, one at a time, and the assertion confirmed to go red. Eleven
  mutations, eleven reds, including two that pin negative controls (a read-only
  `FETCH_HEAD` inspection, a migration one number below the ceiling) rather than
  positives.
- `npx oxlint` on all three guards — no errors. The one warning
  (`runSelfTest` complexity) pre-exists on `main` and is a `warn`.
- `npx oxfmt --check` on every `scripts/*.mjs`, `taplo fmt --check prek.toml` — clean.
- `prek.toml` parses and carries no duplicate hook ids.

**Process notes:** The migration guard's prek hook was passing changed filenames to a
script that takes none, relying on it silently ignoring unrecognised argv; it now sets
`pass_filenames = false` and includes its own source in the trigger set, so editing the
scanner re-runs it against the real tree.

**Lessons learned (for future sessions):** A grandfathering baseline that records the
guard's own false positives is worse than no guard — it makes a broken detector look
adopted. Both baselines here were checked entry-by-entry against source context before
being accepted, and the migration one turned out to be missing half of what "shrink-only"
means. Separately: when a guard reproduces an external definition (here, a documented
nextest filter), the thing to test is not that the guard works but that the two agree at
their edges — the ceiling case was green on every other assertion in the file.

**Commit plan:** single commit / not pushed.
