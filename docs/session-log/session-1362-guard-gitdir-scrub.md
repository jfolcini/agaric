# Session 1362 — guard git-context scrub: the redirect variables, the cwd-anchored root, and the orphan warm-up (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review of an inherited working-tree diff) |
| **Items closed** | `#4191` `#4192` `#4193` |
| **Items modified** | — |
| **Tests added** | +8 guard assertions (4 in `runSourceScenarios`, so ×4 consuming guards; 4 in the py guard file-source suite), on top of the ~20 the inherited diff already added |
| **Files touched** | 10 (+ this log) |

**Summary:** Reviewed, corrected and shipped a trust-boundary fix to the guard
infrastructure: `gitEnv`/`git_env` now scrub the whole git-redirect variable family
from the environment every guard `git` call runs under (#4191), the cwd-anchored
`.mjs` guards root through one shared `repoRootFromCwd` that asks
`--show-toplevel` under that same scrubbed environment (#4192), and
`check-dynamic-sql.py`'s orphan sweep warms only the baseline entries it will
actually read (#4193). The inherited diff's central design claim — that every
scrubbed variable is *redundant with discovery*, so scrubbing is a provable no-op
under an honest commit hook and corrective under a leak — was re-measured from
scratch and holds; but the scrub list was incomplete, and the review closed the
gap plus three stale statements the diff's own edits had falsified.

**Files touched (this session):**
- `scripts/lib/guard-file-source.mjs` (+228/−45)
- `scripts/lib/guard_file_source.py` (+128/−30)
- `scripts/lib/git-scratch-guard.mjs` (+283/−48)
- `scripts/test-py-guard-file-source.sh` (+226/−0)
- `scripts/check-md-link-targets.mjs` (+14/−15)
- `scripts/check-doc-code-paths.mjs` (+13/−13)
- `scripts/check-architecture-citations.mjs` (+14/−15)
- `scripts/check-dead-symbol-citations.mjs` (+14/−15)
- `scripts/check-remove-after-markers.mjs` (+7/−10)
- `scripts/check-dynamic-sql.py` (+29/−3)

## What the hook environment actually exports

Re-measured from scratch on this machine (git 2.43.0) rather than taken on trust,
because it is the load-bearing evidence for the whole design. A `pre-commit` hook
was installed in a scratch repo and its `GIT_*` environment plus `pwd` dumped
across every invocation shape:

- **main checkout, plain `git commit`** — no `GIT_DIR` at all; `GIT_INDEX_FILE`
  is the RELATIVE `.git/index`; hook cwd is the work-tree toplevel.
- **main checkout, `git commit -a`** — no `GIT_DIR`; `GIT_INDEX_FILE` is the
  ABSOLUTE `<root>/.git/index.lock`.
- **main checkout, `git commit -- <path>`** — no `GIT_DIR`; `GIT_INDEX_FILE` is
  the ABSOLUTE `<root>/.git/next-index-<pid>.lock`.
- **linked worktree** — an ABSOLUTE `GIT_DIR=<main>/.git/worktrees/<name>`, with
  the index beside it (`index`, `index.lock`, `next-index-<pid>.lock` for the
  three shapes respectively).
- **from a SUBDIRECTORY** — the hook's cwd is still the toplevel; `GIT_PREFIX`
  carries the subdir. So the relative `.git/index` form always resolves against
  the tree being committed, which is the premise the kept-`GIT_INDEX_FILE`
  exception depends on.

Every row the diff claimed reproduced. One shape it did not mention: a checkout
whose `.git` is a GITFILE (`git init --separate-git-dir`, and every submodule) is
a MAIN checkout that DOES export an absolute `GIT_DIR`. It is equally redundant —
discovery reads the same target out of the gitfile — so the design line survives,
but "a main checkout exports none" was a falsifiable way to state it and has been
corrected in both twins to rest on redundancy rather than on absence.

## Findings fixed

- **`GIT_ALTERNATE_OBJECT_DIRECTORIES` was missing from the scrub list.** It is
  the other half of `GIT_OBJECT_DIRECTORY`, which the diff already scrubbed —
  `receive-pack`'s quarantine exports the pair together, so scrubbing one leaves a
  half-configured object store. Measured: `git cat-file` does **not** verify that
  an object's body hashes to the name it was asked for, and an alternate is
  consulted for any oid the primary store lacks. Reproduced end to end against
  `check-raw-tx.py --cached` over a staged violation whose loose object had been
  removed: the fail-closed exit 2 became **exit 0 over an attacker-forged clean
  body**. Added to both lists, with a fixture on each side.
- **Three statements the diff falsified but left standing.** `indexBelongsTo` /
  `_index_belongs_to` still promised that `gitEnv`/`git_env` "strips only
  `GIT_INDEX_FILE`", which #4191 had just made false in the same file; and three
  comments still counted "four" guards after the fifth
  (`check-remove-after-markers.mjs`) joined the list. Corrected in place — the
  module's own rule is that a claim written down twice is a claim that will be
  true in one place.

## Findings recorded rather than fixed

Each candidate was measured, not reasoned about, against the three commands a
guard actually runs (`rev-parse --show-toplevel`, `ls-files -s -z`, `cat-file`):

- `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_COUNT` /
  `GIT_CONFIG_PARAMETERS` — **cannot redirect.** git ignores `core.worktree` and
  `core.bare` from anywhere but the repository's own config; all three injection
  spellings left every command answering about the tree at `cwd`. Scrubbing them
  would also be a regression rather than a no-op: a fixture that isolates itself
  with `GIT_CONFIG_GLOBAL` would find the guard reading the developer's real
  `~/.gitconfig`.
- `GIT_PREFIX` — exported to every hook, consumed by none of these commands.
- `GIT_CEILING_DIRECTORIES` / `GIT_DISCOVERY_ACROSS_FILESYSTEM` — these bound the
  UPWARD walk rather than aiming it, so the worst either can do is truncate or
  extend the ANCESTRY of `cwd`; neither can name an unrelated repository, and both
  measured inert when `cwd` IS the toplevel, which is the only shape a guard runs
  in. They are also the one class where removal is not provably a no-op —
  `git_scratch_guard` sets a ceiling deliberately — so keeping them is what lets
  the "every name on the list is redundant with discovery" invariant stay true of
  the list as a whole. The reasoning is recorded in both twins so the next reader
  does not have to re-derive it.

## Verification

- The honest commit path was exercised for real, not only in fixtures: a scratch
  repo with a guard installed as an actual `pre-commit` hook, across plain,
  `-a`, pathspec and subdirectory commits, in a main checkout AND in a linked
  worktree — with a matching set where the violation is STAGED, so "allowed" is
  distinguished from "never looked". Every case behaved as expected both before
  and after the change, and the guard's own banner confirms it judged the staged
  index each time.
- All eight guards run green against the real tree under this checkout's own
  linked-worktree hook environment (absolute `GIT_DIR` + its index).
- The `GIT_INDEX_FILE` exception was probed directly: with NO `GIT_DIR` present,
  the belonging rule rejects a foreign absolute index, collapses `..` traversal
  before comparing, and accepts a linked worktree's own index nested under the
  main `.git`. That hole is closed.
- `repoRootFromCwd`'s error handling was probed outside a repo, in a bare repo,
  on a permission error, on a nonexistent cwd, with `git` absent from `PATH`, and
  through a symlinked path (it answers the physical path, exactly as the private
  `execSync` copies it replaced did). All fall back to `cwd`; the downstream
  fail-open on "not a git repository" is pre-existing and unchanged.
- Mutation-tested rather than trusted. Reverting `gitEnv`'s scrub reddens four
  assertions; reverting ONLY `repoRootFromCwd`'s scrub reddens exactly the two
  labelled #4192 and leaves the two labelled #4191 green, which is the isolation
  those labels claim; reverting `git_env`'s scrub reddens the two new py
  assertions; reverting the orphan warm-up filter reddens the three #4193 ones;
  dropping `GIT_ALTERNATE_OBJECT_DIRECTORIES` from either list reddens exactly the
  new alternates assertion on that side. A "reddens on any `GIT_DIR`" mutant — the
  mirror image of the defect — reddens the not-red-on-anything CONTROL and nothing
  else, so that control genuinely discriminates.
- `bash scripts/test-py-guard-file-source.sh`, `bash scripts/lib/git-scratch-guard.sh --self-test`,
  `--self-test` on all five `.mjs` guards and all three python guards,
  `check-git-fixture-isolation.mjs` (and its own `--self-test`), every guard
  against the real tree, `npx oxlint` + `npx oxfmt --check` on the changed `.mjs`,
  `ruff check` on the changed `.py`, `shellcheck` on the changed `.sh` — all green,
  foreground, in one run.

**Process notes:** the fixture-isolation guard (#4043–#4045, #4064) constrains how
these suites may build scratch repos, so the new fixtures go through
`_new_fixture`/`fixture` and reuse the existing `env -u GIT_INDEX_FILE python3`
shape rather than hand-rolling a scrub; the guard passes on the result. Each new
assertion is preceded by the checks that make it non-vacuous — that the fixture
really stages the violation, that the object store really is damaged, and that git
itself really would honour the leak — because the interesting assertion in a
security fixture is a non-event.

**Lessons learned (for future sessions):** #4061's original completeness survey
(session 1354) probed the candidate variables against `rev-parse --absolute-git-dir`
only, which was the whole surface at the time. #4191 widened the same scrub to the
guard's CONTENT reads without re-running that survey against the new commands —
and `GIT_ALTERNATE_OBJECT_DIRECTORIES`, inert for `rev-parse`, is not inert for
`cat-file`. When a scrub's scope grows, the completeness argument does not come
along for free; re-measure the list against the commands it now covers.

**Commit plan:** single commit.
