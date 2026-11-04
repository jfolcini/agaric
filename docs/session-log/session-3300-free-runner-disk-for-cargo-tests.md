# Session 3300 — free runner disk for cargo-tests

`validate / cargo-tests (1)` died mid-test twice on 2026-11-04, on #6262 and
on #6272. Neither job had a test result or a log. The job annotations named the
cause: `No space left on device`, raised as the runner wrote its own log. The
e2e-tauri real-backend specs on each PR were cancelled with it. Both runs
build parking_lot 0.13 next to the 0.12 copy loro and tao still pull, inside
the coverage-instrumented test build. That points at headroom already thin on
the default ubuntu-24.04 runner, not at anything large in the bump. The ~70 CI
runs since 2026-11-01 before that show no out-of-disk failure.

`cargo-tests` now drops the preinstalled toolchains it never uses before the
build, as `ci.yml`'s android-build already does after the same failure: .NET,
GHC, PowerShell, Chromium, the Android SDK, the CodeQL toolcache and Docker
images. Nothing the job runs reads them: nextest's PowerShell setup script is
Windows-only, and the LAN tests only name `docker0` as an interface.

A PR that touches only `_validate.yml` does not run cargo-tests, so the step
was exercised by a `workflow_dispatch` of `_validate.yml` on the branch, which
has no base commit to diff against and so runs every job.
