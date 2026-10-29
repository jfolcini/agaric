# Session 3068 — a new upstream advisory no longer reds a PR that changes no dependency

A CI-log survey counted 24 red lint jobs whose only failure was a `cargo deny`, `cargo audit` or `npm audit` advisory. The PRs changed no dependency; RustSec or GitHub had published an advisory against something already in the tree. This is a CI-policy change, so the maintainer merges it.

**Changed (`_validate.yml`, `lint` job):**
- A step sets `DEPS_CHANGED`. It is `false` only on a `pull_request` whose own diff (`base.sha...head.sha`) touches no `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`, `deny.toml`, `audit.toml` or `.nsprc` (the npm audit waivers). A push to `main`, a schedule, a release, or a diff that cannot be computed counts as changed.
- With no dependency change:
  - the `cargo-deny` hook is skipped;
  - `cargo deny check licenses bans sources` runs in its own step and still blocks;
  - `cargo deny check advisories` runs with `continue-on-error`;
  - the `npm audit` and `cargo audit` steps are `continue-on-error`. They still run, and a finding shows as a red step on a green job.
- With a dependency change, and on every non-PR run, nothing changes: all checks block.
- `npm audit signatures` checks provenance, not advisories, and stays blocking.

**Suites:** actionlint and zizmor over the workflow; the workflow-structure scripts (`check-zizmor-version-pin`, `check-remove-after-markers`, `check-android-trigger`). The gating has not run in CI before the PR.
