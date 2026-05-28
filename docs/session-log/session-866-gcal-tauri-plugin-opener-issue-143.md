## Session 866 — gcal OAuth: migrate `tauri-plugin-shell::open` → `tauri-plugin-opener` (#143) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | #143 (MAINT-227) |
| **Items modified** | — |
| **Tests added** | 0 (callback-only swap; existing 22 gcal tests cover the surface) |
| **Files touched** | 4 (Cargo.toml, lib.rs, capabilities/default.json, commands/gcal.rs) + Cargo.lock |

**Summary:** Removes the `#[allow(deprecated)]` from the gcal OAuth browser-open callback (`commands/gcal.rs:550-557`) by routing through the modern `tauri-plugin-opener` crate instead of the deprecated `tauri-plugin-shell::open`. The two plugins are registered side-by-side rather than wholesale-swapping shell to opener — the frontend (`src/lib/open-url.ts`) still imports `@tauri-apps/plugin-shell` for the BugReport "open issue in browser" path, so dropping the shell Rust plugin would break that IPC. Migrating the frontend to `@tauri-apps/plugin-opener` is out of scope for this S-cost item.

**Diff shape:**
- `src-tauri/Cargo.toml` — add `tauri-plugin-opener = "2"` (keep `tauri-plugin-shell` for the frontend's JS-side shell plugin).
- `src-tauri/src/lib.rs` — register `tauri_plugin_opener::init()` alongside `tauri_plugin_shell::init()` at the existing builder chain.
- `src-tauri/capabilities/default.json` — add `"opener:allow-open-url"` permission alongside the existing `"shell:allow-open"`.
- `src-tauri/src/commands/gcal.rs` — swap `app.shell().open(url, None)` for `app.opener().open_url(url, None::<&str>)`; drop `#[allow(deprecated)]` and the migration TODO comment.

**Files touched (this session):**
- `src-tauri/Cargo.toml` (+1 line — new dep)
- `src-tauri/src/lib.rs` (+1 line — new plugin init)
- `src-tauri/capabilities/default.json` (+1 line — new permission grant)
- `src-tauri/src/commands/gcal.rs` (-3 / +2 net — swap callback body, drop `#[allow(deprecated)]`)
- `src-tauri/Cargo.lock` — regenerated for `tauri-plugin-opener` and its transitive deps
- `docs/session-log/session-866-…md` (new — this log)

**Verification:**
- `cd src-tauri && cargo check --tests` — clean compile.
- `cd src-tauri && cargo clippy --tests` — no new warnings (the two pre-existing `very complex type used` warnings on the maintenance daemon's type aliases pre-date this PR).
- `cd src-tauri && cargo nextest run -E 'package(agaric) and test(/^commands::gcal/)'` — 22/22 pass.

**Note on scope:** the issue explicitly framed this as an "S (1-line callback swap)" item, blocked on the dep landing. The dep is `tauri-plugin-opener = "2"` and adds ~20 LOC to Cargo.lock; the actual callback swap is 2 LOC net. A future PR can complete the migration end-to-end by also moving `src/lib/open-url.ts` to `@tauri-apps/plugin-opener` and dropping `tauri-plugin-shell` entirely — at that point the `"shell:allow-open"` permission can also go. That work is left for whoever next bumps the Tauri plugin set, per AGENTS.md §"Coupled Dependency Updates".

**Commit plan:** single commit on branch `chore/gcal-tauri-plugin-opener-143`; PR against `main`. Closes #143.
