# Session 2911 — Tauri 2.12.4 stack in one commit

Dependabot split the Tauri bump into three PRs, and none could go green alone:
- **#6109 (npm):** failed the bundle build's mismatch check, which requires each `@tauri-apps/plugin-*` to share a major/minor with its crate.
- **#6111 (cargo):** failed to compile `tauri-plugin-deep-link` 2.6.2.
- **#6112 (fuzz lock):** failed the same way.

AGENTS.md moves the stack in one commit, so this does that.

**Why deep-link stays at 2.6.1.** 2.6.2 builds `ini::ParseOption` with a struct literal. `rust-ini` 0.21.3, which `main` already locks, added two public fields, so that literal no longer compiles. 2.6.3 fixes it, but it was published today, inside the seven-day cargo cooldown (#816). Both halves therefore keep deep-link on 2.6.1, which shares its minor with the npm side, and Dependabot will offer 2.6.3 once the cooldown passes.

**How the locks were made.**
- **Main lock:** targeted `cargo update -p <crate> --precise <ver>` on `main`'s lock, not Dependabot's snapshot, for:
  - `tauri` 2.12.4, `tauri-build` 2.7.4;
  - `opener` 2.7.2, `clipboard-manager` 2.5.0, `notification` 2.7.0, `single-instance` 2.5.4, `updater` 2.14.0.
  - The diff moves only those, plus `tauri-runtime`, `tauri-runtime-wry` and the new `static_vcruntime`.
  - wry and tao do not move, so the Android JNI note in AGENTS.md does not apply.
- **Fuzz lock:** the same targeted updates, plus #6112's `rustls`, `libc` and `unicode-normalization`, which bring it level with the main lock. `cargo metadata` resolves it.
- **npm:** `npm install --package-lock-only` for `@tauri-apps/api`, `cli`, `plugin-clipboard-manager`, `plugin-notification` and `plugin-updater`. The lock diff touches only those packages.

**Not run locally.** Nothing was compiled, because another build held the box. CI's cargo, bundle and real-backend lanes are the check.
