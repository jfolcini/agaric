# Session 4430 — the workflow_run jobs commit through the API and never check out the PR branch

**Ask.** Code-scanning alert #300 (OpenSSF Scorecard Dangerous-Workflow) on `gradle-verification-commit.yml`, keeping its automation. `advisory-waiver-prune.yml` uses the same pattern: a `workflow_run` job with `contents: write` that checks out the PR's `head_branch`. Scorecard had not flagged it yet only because Scorecard scans weekly. The maintainer chose to keep both automations and remove the checkout from both.

**Fix.** New `scripts/commit-via-api.sh <branch> <head-sha> <message> <dir> <path>...`, run by both jobs from the default branch:
- It commits the files that differ from the branch's copy at `head-sha`, as one commit, through the Git Data API: blobs, a tree on `head-sha`'s tree, then a commit whose parent is `head-sha`.
- The commit is authored by `github-actions[bot]`, with the matching `Signed-off-by` that `dco.yml` checks.
- The ref moves only by a fast-forward (`force=false`), so a push that lands in between makes the update fail instead of being overwritten. The old flow had the same guarantee through a non-force `git push`.
- It prints nothing, and exits 0, when the branch has moved past `head-sha` or when no file differs.

Changes to the two workflows:
- `gradle-verification-commit.yml` checks out the default branch only, validates the artifact as before, and hands it to the script.
- `advisory-waiver-prune.yml` drops its `pr/` checkout. It reads the two waiver files from the PR's head commit through the contents API (`application/vnd.github.raw+json`, byte-exact), prunes them with the default branch's scripts, and commits the waiver files plus their derived files through the script.

**Also.** `scripts/merge-ready.sh` read 10 completed `main` CI runs. Since #7013 a newer `main` push cancels the run before it, so on 2026-11-25 all ten were cancelled and the check refused every merge, though the last finished run was green. It now reads a full page (100). The test fixture's route key moved with it.

**cargo-sweep.** Documented in `docs/BUILD.md` § Troubleshooting and in the batch-issues skill's disk line:
- `cargo sweep --installed` after a toolchain bump, with the old toolchain uninstalled first.
- `cargo sweep --time 14`.

On this box, `--installed` after uninstalling 1.95.0 and 1.99.1 freed 25.5 GiB of `src-tauri/target`.

**Ran:**
- Live run against a throwaway branch on origin, with no PR so no CI, deleted afterwards. The advisory step body, verbatim apart from the PR comment, ran against a branch carrying a fake waiver `RUSTSEC-2099-0001`. It committed `deny.toml` and its three derived files in one commit with the expected author and trailer, skipped the two unchanged files, and left the branch tree identical to `main`.
- On the same branch, the gradle step body committed a modified 246 KB `verification-metadata.xml`. The committed blob was byte-identical to the input. That file is past the per-argument size limit, which is why the blob goes through a pipe.
- A stale `head-sha` printed the "moved past" note and no commit. Unchanged input printed "nothing to commit". A direct non-fast-forward `PATCH` of the ref got HTTP 422 ("Update is not a fast forward"), and the branch stayed put.
- `node --test scripts/merge-ready.test.mjs`: 24 pass. With `per_page=10` restored in the script, 22 fail on "the completed ci.yml runs could not be read".
- shellcheck, shfmt, zizmor and actionlint on the changed files.
