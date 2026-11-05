# Session 3551 — a PR that edits a CI job runs that job

Part of the slow-tests sweep. #6373 changed cargo-tests' nextest command and #6375 its cache key, and both merged without cargo-tests running: `scripts/classify-changes.sh` read `_validate.yml` and `.github/actions/` as `ci` alone, which runs only `lint`. The maintainer decided that a PR editing a CI job runs that job.

`_validate.yml`, and any composite under `.github/actions/` except the two already routed (`playwright-setup` to Playwright, `sqlx-offline-check` to `lint`), now set `frontend`, `backend` and `rust_tests` and run vitest and Playwright whole. Per-job routing would mean a map from each `_validate.yml` hunk to its job, and such PRs are rare, so every `_validate.yml` lane runs. `ci.yml`'s bundle builds and the real-backend lane keep their own rules: `_validate.yml` runs neither.

`src/__tests__/classify-changes.test.ts` gained a case for `_validate.yml`, the `toolchain` composite and the `setup-node` composite. It was red on main (all three classified as `ci` alone) and passes with the change, with the other 81 cases unchanged.

This PR also carries #6375's two review notes: `docs/architecture/ci-and-tooling.md` named the cargo-tests key `rust-cov`, and a comment in `_validate.yml` called it the "rust-cov cache". Because it touches `_validate.yml`, this PR's own CI is the first to run every lane on a workflow edit.
