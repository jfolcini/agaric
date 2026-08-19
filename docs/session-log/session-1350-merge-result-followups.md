# Session 1350 — the #4169 follow-ups from #4162's review (2026-08-19)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | orchestrator-only (adversarial review of a pre-existing diff) |
| **Items closed** | #4169 |
| **Items modified** | — |
| **Tests added** | +6 (self-test assertions, `scripts/pr-merge-result-check.sh`) |
| **Files touched** | 3 |

**Summary:** Adversarially reviewed an uncommitted diff implementing all six
follow-ups deferred from PR #4162's review (#4169): a gated `npm ci` wrapper in
`pr-overlap.yml`'s `merge-result` job, a fix to `lockfiles_agree()` that stops
treating "the merge deleted `package-lock.json`" as agreement, an exercised
`MR_NODE_MODULES` override fixture, a gate that skips the tsc invocation when
its result cannot change the exit code, and two accuracy corrections to
existing comments (the `seed-worktree.sh` cross-reference, and the `.npmrc`
trust-boundary comment in `pr-overlap.yml`). Reviewed each of the six against
the issue and PR #4162's review comments, then falsified every new fixture by
hand — reverting each corresponding production change one at a time and
confirming the exact new assertion(s), and only those, went red. No defects
found; nothing needed fixing.

**Files touched (this session):** none — the diff was reviewed as-is, no
changes made. (For reference, the reviewed diff: `.github/workflows/pr-overlap.yml`
+35/-8, `scripts/pr-merge-result-check.sh` +157/-16, `scripts/seed-worktree.sh`
+8/-0.)

**Verification:**
- `bash scripts/pr-merge-result-check.sh --self-test` — all assertions pass
  (~50s).
- `node scripts/check-pr-overlap-trust-boundary.mjs --self-test` — all
  assertions pass.
- `shellcheck` on `scripts/pr-merge-result-check.sh` and
  `scripts/seed-worktree.sh` — clean (only pre-existing info-level SC2016/
  SC1091 notices, none new).
- `python3 -c 'yaml.safe_load(...)'` on `.github/workflows/pr-overlap.yml` —
  parses clean.
- Falsification, by construction, for every new fixture: reverted
  `lockfiles_agree()` to its pre-#4169 body (`[ -f "$a" ] || return 0`) — the
  new "merge that DELETES package-lock.json" assertion, and only it, went
  red (expected 3, got 0). Made `MR_NODE_MODULES` unread — the new
  "MR_NODE_MODULES, when set, is actually honored" assertion, and only it,
  went red (expected 0, got 3), confirming the variable is genuinely live,
  not dead. Removed the `run_typecheck` gate — the exit code held steady
  (confirming the PR's "byte-identical" claim by construction) and only the
  stderr-diagnostic-presence assertion went red, proving the gate really
  skips the call rather than merely happening not to change the outcome.
  Reverted the workflow's `npm ci` wrapper to a bare `run: npm ci` — all
  three of follow-up 1's new assertions, and only those, went red. Each
  revert was restored byte-for-byte afterward (`diff` confirmed identity
  against a saved copy before the next test), and the final `git diff --stat`
  matches the original diff exactly (43/173/8 insertions).

**Process notes:** Traced the exit-code precedence chain in `run_merge_check`
by hand to confirm follow-up 4's central claim: `missing` (exit 3) and
`failures` (exit 1) both `return` *before* `typecheck_rc` is ever consulted,
so gating `run_typecheck` on `[ -z "$missing" ] && [ "$failures" -eq 0 ]` is
exit-code-identical by construction, not merely by observation — and does
not undo #4162 (a merge whose guards actually pass still runs the typecheck
unconditionally). Confirmed `lockfiles_agree`'s new `git cat-file -e
"${base_tip}:package-lock.json"` / `"${head_sha}:..."` probes are valid
against the merged worktree because `git worktree add` shares the caller
repo's object store — no extra checkout needed, and both SHAs are already
fully resolved (`resolve_base_tip` returns a full commit SHA; `head_sha`
comes from `github.event.pull_request.head.sha`). Confirmed the real merge-
conflict path (`git ls-files -u` non-empty) returns exit 2 well before
`lockfiles_agree` is ever reached, so a genuine lockfile content conflict
can never be misread as the "merge deleted it" case. Verified follow-up 6's
`.npmrc`/trust-boundary comment against the actual workflow: the job's
`actions/checkout` step has no `ref:` (so `pull_request` gives
`refs/pull/N/merge`), the job trigger is `pull_request` not
`pull_request_target`, and the `merge-result` job's body contains no
`secrets.`/`GH_TOKEN`/`GITHUB_TOKEN` reference — all claims hold.

**Lessons learned (for future sessions):** Falsifying test fixtures by
reverting the corresponding production line (rather than reading the fixture
and trusting the prose) caught nothing wrong here, but is cheap relative to
the confidence it buys — every one of the six follow-ups' self-test
assertions reddened on exactly the input its comment claimed and nothing
else, including the "byte-identical exit codes" claim for follow-up 4, which
is the kind of claim that reads as a plausible rationalization until checked
by construction.

**Commit plan:** not pushed — review-only session; the diff was left
uncommitted in the worktree as found, verified sound.
