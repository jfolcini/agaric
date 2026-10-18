# Session 2561 — `just push -- <args>` works, and `check` / `verify` say what they run

A `just` audit found that the documented `just push -- -u origin my-branch` never
worked: just hands `--` through, `preflight_push_target` forwards its arguments
verbatim, and `git push -- -u origin x` reads `-u` as the repository ("failed to
push some refs to '-u'"). `scripts/push.sh` now drops one leading `--`, so the
documented form and the bare form behave the same; `--` never reaches git.

Shown in a throwaway repo with a bare `file://` remote and a stub verifier: before,
`push.sh -- -u origin work` failed with that error and pushed nothing; after, it
pushed and passed the landed check. No harness tests `push.sh`, so this check is
manual.

**Descriptions corrected:** `just check` runs the pre-commit-stage hooks over the
whole tree, not all of CI's validate job; `just verify` runs the range-scoped tests
and the sqlx check, while clippy, knip, lychee and npm-audit run only in the
pre-push hook. Fixed the same claims in `README.md`, `docs/BUILD.md`,
`CONTRIBUTING.md` and `push.sh`'s own header (Phase A is range-scoped with
`--from-ref`).
