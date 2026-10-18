# Session 2626 — a release publishes only after the real-backend lane passes, and never with an unsigned APK

An audit of the 0.19.0 release run found two gaps.

- **The real-backend lane never ran on a release.** `release.yml` now has an `e2e-tauri` job that calls `e2e-tauri-weekly.yml`, which gains `on: workflow_call`, and `publish-release` requires it.
  - It runs every spec: a tag push has no diff, so the classifier selects the whole set.
  - It needs only `verify-version`, so it runs beside the builds.
  - It uses the read-only top-level permissions and reads no secret.
- **The lane's concurrency group now includes `github.workflow`.** Under a call that is the caller's name, so dispatching the lane on a release tag can no longer cancel the release's own run.
- **Android staged an unsigned APK when `ANDROID_KEYSTORE_BASE64` was missing,** and the job still passed. The signing step now fails with `::error::`. The `stage` output it fed to the second alignment check had only one value left, so that check passes `--stage=post-zipalign` directly.
- **Docs:**
  - `docs/BUILD.md` § Releasing lists the new job.
  - Its Android signing section drops the unsigned fallback and gives the `zipalign -P 16 -f 4` flags CI actually runs.
  - `.github/AGENTS.md` says the lane gates releases, and that the lane restores caches but ships nothing.

Checked: `prek run --files` on the four files, which includes actionlint and zizmor. Removing `workflow_call` makes actionlint reject `release.yml`. The no-keystore branch, run locally, exits 1 and writes no `apk` output. With the release run's env, `classify-changes.sh` prints `real_backend=true` and an empty `real_backend_specs`. No tag has run it yet.
