## Session 907 — Dependabot tar bump + CodeQL bench false-positive dismissals (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-only |
| **Items closed** | Dependabot alert #11 (tar), CodeQL alerts #131 #132 |
| **Items modified** | — |
| **Tests added** | +0 / +0 (lockfile bump + alert triage; no code paths changed) |
| **Files touched** | 1 |

**Summary:** Resolved one Dependabot security alert and two CodeQL alerts as quick wins. Bumped the transitive `tar` crate 0.4.45 → 0.4.46 to clear GHSA-3pv8-6f4r-ffg2 (PAX header desynchronization, medium). Dismissed CodeQL alerts #131/#132 (`rust/unused-variable` on `commands_bench.rs`) as false positives: the variable `i` is used inside the inline format-args capture `format!("… {i} …")`, which CodeQL's Rust query does not model as a use.

**Files touched (this session):**
- `src-tauri/Cargo.lock` (tar 0.4.45 → 0.4.46; lockfile-only, transitive via `tauri-plugin-updater`)

**Verification:**
- `cd src-tauri && cargo check -p agaric --lib` — clean (patch-level transitive bump; `tar` is used only by `tauri-plugin-updater` for self-update tarball extraction).
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:**
- CodeQL `rust/unused-variable` has a blind spot for inline format-string capture (`{i}`). Dismissed-with-reason rather than degrading idiomatic code to the positional `format!("…{}", i)` form purely to satisfy the analyzer. The CodeQL dismissals are GitHub-side API actions (no commit); only the tar bump ships in this PR.

**Commit plan:** single commit / pushed.
