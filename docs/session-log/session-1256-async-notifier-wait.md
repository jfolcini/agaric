## Session 1256 — Async notifier wait (2026-08-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-05 |
| **Subagents** | 1 build + 2 review |
| **Items closed** | #3266 |
| **Items modified** | — |
| **Tests added** | +0 (frontend) / +4 (backend) |
| **Files touched** | 4 |

**Summary:** Replaced the Linux notification command's synchronous channel wait with a
Tokio oneshot awaited under the existing five-second timeout, so a wedged notification
daemon no longer parks a Tokio worker. The dedicated native OS thread remains isolated
and detached, with explicit timeout, cancellation, disconnect, and late-send behavior.

**Files touched (this session):**
- `src-tauri/src/commands/notifier.rs` (+215/-79)
- `src-tauri/Cargo.toml` (+1/-1)
- `src/lib/bindings.ts` (+2/-3, generated documentation only)
- `docs/session-log/session-1256-async-notifier-wait.md` (new)

**Verification:**
- Focused notifier + binding-freshness nextest — 15 tests run, 15 passed.
- `cd src-tauri && cargo nextest run --workspace` — 5,479 tests run; 5,478 passed and
  the stale-binding check failed before canonical regeneration. The exact failing check
  passed afterward.
- `cd src-tauri && cargo check --workspace --all-targets` — passed.
- `cd src-tauri && cargo clippy --workspace --all-targets -- -D warnings` — passed.
- `cd src-tauri && cargo fmt --all -- --check` — passed.
- `git diff --check` — passed.
- pre-commit hook — pending commit.
- pre-push hook — pending push.

**Process notes:** The runtime-liveness regression uses a current-thread Tokio runtime
and a handshaken, releasable OS worker. Timeout and cancellation tests also release and
observe their synthetic workers, avoiding the previous test's detached 30-second sleeper.

**Lessons learned (for future sessions):** Public Tauri-command Rustdoc is part of the
generated Specta artifact. Regenerate bindings even when a command's wire signature is
unchanged if its exported documentation changes.

**Commit plan:** single commit, then push and open a stacked PR.
