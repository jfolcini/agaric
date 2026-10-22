# Session 2849 — a release APK is launched on an emulator before it ships

This fixes #6050, following the maintainer's decision: launch checks at release and weekly, never per PR. Version 0.15.0 crashed on every Android launch with CI green, because CI only compiled the APK.

- **New workflow `android-launch-smoke.yml`.** It is reusable and can also be dispatched. It builds an x86_64 **release-profile** APK; only a release build has `panic = "abort"`, and a debug build unwinds instead. It signs the APK with a throwaway key, boots an API 34 emulator (`ReactiveCircus/android-emulator-runner`, SHA-pinned), and runs `scripts/android-launch-smoke.mjs`. That script installs the APK and starts the app, then watches it for 25 s. It fails if the process never appears, dies or restarts, or if logcat shows `FATAL EXCEPTION`, `SIGABRT` or a Rust panic from the app. A crash line counts only when it carries the app's pid or names the package, since the buffer is device-wide and a system process crashing must not block a release; the PR reviewer caught that. It also fails closed: a logcat that never mentions the app counts as a failure.
- **`release.yml`** runs the smoke beside the desktop matrix. `android-build-and-release` needs it to pass, so a launch crash keeps the signed APK, and the publish, from happening.
- **`scheduled-deep-checks.yml`** gains an `android-launch` lane.
- **No AVD cache.** `.github/AGENTS.md` § Caches keeps data that is read only weekly out of the Actions cache.

**The issue was partly stale.** `release.yml` already smoke-boots the repacked AppImage under Xvfb (#4080/#4418) on a throwaway data dir, and fails on an exit, an abort or a hang. #6050's body and #6055 said the release workflow checked only the AppImage's icon and size. So the AppImage needed nothing new.

**Shown red:** the abort and panic predicates were blanked in the scan script, and the 0.15.0-style abort log went red in `android-launch-smoke.test.mjs`, and with the pid scoping removed so did the case of another process crashing (6 cases, now in `_validate.yml`'s `node --test` list).

**Ran:** `prek` over the changed files (actionlint with shellcheck, zizmor, the version-pin hooks, oxlint, typos, markdownlint), and `prek --hook-stage manual --all-files`.

**Not run here:** the emulator path itself, since this container has no KVM. A `workflow_dispatch` of `scheduled-deep-checks.yml` on the branch with `lanes=android-launch` is the check.
