## Session 940 — FEAT-11 OS-notification path (slice) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (issue `#138` left open — slice only) |
| **Items modified** | `#138` |
| **Tests added** | +7 (frontend) / +8 (backend) |
| **Files touched** | 9 |

**Summary:** Wired up `tauri-plugin-notification` as a minimal, shippable vertical
slice of FEAT-11 (#138). Added the Cargo + npm deps, registered the plugin and the
`notification:default` capability, added a `notify_task` Rust command (with a
testable `prepare_notification` validator), and exposed `notifyTask` +
`ensureNotificationPermission` frontend wrappers. The full L-scope scheduler /
dedupe ledger / Settings sub-tab / Android permission flow remain open follow-up
work on #138.

**Files touched (this session):**
- `src-tauri/Cargo.toml` — `tauri-plugin-notification = "2"` dep (+8)
- `src-tauri/capabilities/default.json` — `notification:default` permission (+1)
- `src-tauri/src/lib.rs` — plugin registration + command in the specta macro (+11)
- `src-tauri/src/commands/mod.rs` — `pub(crate) mod notifier;` (+1)
- `src-tauri/src/commands/notifier.rs` — new module: `TaskNotification`,
  `prepare_notification`, `notify_task`, 8 unit tests (new)
- `src/lib/bindings.ts` — regenerated specta bindings (`notifyTask`, `TaskNotification`)
- `src/lib/tauri.ts` — `notifyTask` + `ensureNotificationPermission` wrappers
- `src/lib/tauri-mock/handlers.ts` — `notify_task` mock handler
- `src/lib/__tests__/tauri.test.ts` — 7 wrapper/permission tests
- `package.json` / `package-lock.json` — `@tauri-apps/plugin-notification` dep

**Verification:**
- `cd src-tauri && cargo nextest run notifier` — 8 passed.
- `cargo test -- specta_tests --ignored` — bindings regenerated (1 passed).
- `cargo check --all-targets` — clean (620 crates).
- `vitest run src/lib/__tests__/tauri.test.ts` — 216 passed.
- `vitest run src/lib/__tests__/tauri-mock.test.ts` — 245 passed.

**Process notes:** `npm install` in the worktree replaced the `node_modules`
symlink with a real, complete install (665 pkgs) — the worktree is now fully
self-contained and the main tree's `node_modules` is untouched.

**Commit plan:** single commit; PR opened against `main`; not merged.
