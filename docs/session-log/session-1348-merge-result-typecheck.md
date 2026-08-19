# Session 1348 — the merge-result check learns to compile

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | 0 (single-session CI change) |
| **Items shipped, PR open** | `#4078` |

**Summary:** `pr-merge-result-check.sh` computed the real merge of a PR and `main` and
then ran only the six whole-tree ratchet guards against it. The same failure class in
ordinary source — each branch correct alone, the merge wrong, no textual conflict —
walked straight through with a green "merge result verified". It did, on 2026-08-18.
This session added a typecheck of the merged tree, with the falsification the issue
asked for demonstrated RED against the pre-change script first.

### The incident the check could not see

`#4074` consolidated the property seeds in `markdown-roundtrip.property.test.ts` and
deleted `hasKnownIssue4049Drift`. `#4075` added three properties to the *same file*
still referencing both. The hunks were disjoint, so git merged them silently; both PRs
were green because each branch was internally consistent; the merged tree did not
compile. `main` sat un-compilable until a release build failed on it (`#4077`).

Per-PR CI structurally cannot see this — it tests the branch, not the branch merged
into whatever `main` has become. `pr-merge-result-check.sh` *can*: it already builds
the actual merge in a disposable worktree. It simply declined to look at anything but
ratchets.

### What was added

The merged tree is now type-checked with `npm run typecheck` — the repo's single
definition of "does this tree compile" (`tsc -b --noEmit`), the same one prek,
`_validate.yml` and `tauri.conf.json` invoke, so this does not become a sixth spelling
that can drift.

A new exit code, 4, rather than reusing exit 1. Exit 1 renders in `pr-overlap.yml` as
"a ratchet guard fails on the merge result" and points the author at
`prek --all-files` — the wrong instrument for a TS2304, and a guard-shaped message for
a compiler error is how a real finding gets dismissed as ratchet noise. Exit 1 keeps
precedence when both are true: a ratchet violation names a file and a line.

`node_modules` is **borrowed, not installed**. The workflow runs `npm ci` once in its
own checkout — which for a `pull_request` event is `refs/pull/N/merge`, all but
identical to the tree the script computes — and `provision_node_modules` symlinks that
install's top-level entries into the merged worktree. One `ln -s -t` for ~710 entries,
not one `ln` per entry (0.03 s vs 1.28 s, measured; this runs inside a prek hook). The
entries are symlinked into a *real* directory rather than the whole tree being
symlinked, because the tsconfigs put `tsBuildInfoFile` under `node_modules/.tmp/` and a
whole-tree symlink would write the merged tree's incremental state into the caller's
install.

If the merged tree's `package-lock.json` disagrees with the borrowed install's, the
borrowed tree is the wrong dependency set and the script re-installs in the worktree
instead; if it cannot, that is exit 3 (verified nothing), never a quiet pass against
the wrong dependencies. Same for every other way the stage can fail to run: no install
to borrow, an empty one, a merged tree with no `package.json`, no `typecheck` script or
no `tsconfig.json`. Half a verdict is not a pass.

### The falsification, demonstrated RED

The issue asked for it in this exact shape: two branches that each typecheck alone and
whose merge does not — one deleting an export, the other adding a reference to it —
with the current script shown exiting 0 on that input first.

`mr_make_typecheck_near_miss_repo` builds it, modelled on the real incident: `main`
consolidates the seeds and re-points its own use at the *top* of the file; the PR adds
one more property using the deleted symbol at the *bottom*; eight filler lines keep the
hunks further apart than git's three lines of context, so this merges cleanly rather
than conflicting.

Run against `origin/main`'s copy of the script: **exit 0**, empty stderr. Run against
this branch's: **exit 4**, `src/typecheck/props.ts(16,22): error TS2304: Cannot find
name 'NESTING_SEED'.` — the same error class as the incident. The self-test pins the
red half as an assertion rather than a claim: no guard reports a failure on that merged
tree, so the guards-only script really did have nothing to say about it.

The fixtures type-check in ~0.1 s each: `types: []`, `lib: ["ES2022"]`, no DOM, no
`@types`. What is under test is the stage, not TypeScript, and a fixture that could go
red because this repo's dependency tree moved would be testing the wrong thing.

### Cost, measured rather than estimated

On GitHub `ubuntu-24.04` runners, sampled from real runs of this repo:

- `npm ci`, `actions/setup-node` npm cache warm — 21 s, 19 s, 16 s
- `npm run typecheck` cold, no `.tsbuildinfo` — 8 s, 7 s (3.1–3.4 s locally; TypeScript
  7.0.2 is the native compiler, and 1757 files / ~535k lines go through it in seconds)
- Node setup — 5–8 s
- the `merge-result` job before this change — 25 s, 23 s

So roughly +35 s on a job that was ~25 s, for ~55–65 s inside an unchanged 10-minute
ceiling. The self-test went 25 s → 35 s. That is the trade against `main` sitting
un-compilable until a release build notices.

### Notes

`.npmrc` already sets `ignore-scripts=true` repo-wide (`#816`), which matters more in
this job than in `_validate.yml`: `merge-result` is one of the two jobs in
`pr-overlap.yml` that checks out PR-authored code. It holds `contents: read` and no
secrets, and it still should not be running a fork's postinstall.

The two things this does *not* fix, both pre-existing and both already documented in
the job's own header: the lane is not a required check, and its green is fresh only as
of the PR's last push, not as of the merge click.
