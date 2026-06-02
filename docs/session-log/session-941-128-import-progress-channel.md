## Session 941 — #128 Import progress streaming over `Channel<T>` (PEND-38 / PEND-06 Tier 3) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator-only (single vertical slice, Rust + frontend, no overlap) |
| **Items closed** | #128 (full slice shipped) |
| **Items modified** | #128 |
| **Tests added** | 3 Rust (progress emission contract) + 2 frontend (channel wiring + UI) + 1 assertion update |
| **Files touched** | 7 source + 1 session log |

**Summary:** Implemented the deferred PEND-38 / PEND-06 Tier 3 idea: stream per-block import
progress to the frontend over a Tauri `Channel<ImportProgressUpdate>`. The issue was
deferred on the premise that `import_markdown` "applies the whole file in one transaction,
so the only progress signal is start/done." That premise is stale — `import_markdown_inner`
already iterates per-block over `parse_output.blocks` inside the transaction, so per-block
progress *is* available with no pipeline restructure. The slice surfaces that existing
signal rather than restructuring anything.

**Backend (`src-tauri`):**
- New `ImportProgressUpdate` tagged enum (`Started` / `Progress` / `Complete`) and an
  `ImportProgressSink` trait in `import.rs`, mirroring `sync_events::SyncProgressUpdate` +
  `SyncEventSink`. `Serialize + Type` only (one-way backend→frontend). `Channel<T>`
  implements the sink (best-effort `send`; a dropped channel never aborts the import).
- Renamed the body of `import_markdown_inner` to `import_markdown_with_progress`, taking an
  `Option<&dyn ImportProgressSink>`. `import_markdown_inner` is now a thin delegate passing
  `None`, so all ~10 existing test/bench callers and the MCP/sync-replay paths are
  unchanged. The Tauri command takes a `Channel<ImportProgressUpdate>` (mirroring
  `start_sync`) and passes `Some(&progress)`.
- Emission contract: exactly one `Started` (with parser block count) before the tx opens,
  one `Progress` per block created inside the tx, one `Complete` **after**
  `commit_and_dispatch` succeeds. A failed import (e.g. unknown space) emits `Started` +
  any `Progress` but never `Complete` — so the absence of `Complete` is the failure signal,
  consistent with the L-30 all-or-nothing rollback.

**Frontend (`src`):**
- `importMarkdown(content, filename, spaceId, onProgress?)` — wrapper now always creates a
  `Channel<ImportProgressUpdate>` (mirroring `startSync`) and wires `onProgress` to
  `channel.onmessage` when supplied.
- `DataSettingsTab` consumes the stream: a per-file intra-block progress bar +
  "Block N of M" label (`data.importingBlocks` i18n key) that gives forward motion within a
  single large file, complementing the existing file-level bar.
- Regenerated `src/lib/bindings.ts` (specta) — applied only the import-related delta
  (new type + the `progress` channel arg on `importMarkdown`); the trailing-whitespace
  churn specta emits on unrelated lines was discarded since the `trailing-whitespace` prek
  hook strips it and the `ts_bindings_up_to_date` gate normalizes it.

**Tests:**
- Rust (`page_cmd_tests.rs`): `RecordingImportSink` recorder + 3 tests — full
  `Started → 4×Progress → Complete` stream on a 4-block file; empty file emits
  `Started(total=0) → Complete(created=0)` with no `Progress`; failed import (no space)
  emits only `Started` and never `Complete`.
- Frontend: `tauri.test.ts` asserts the channel is always passed and `onProgress` receives
  events; `DataSettingsTab.test.tsx` drives streamed events through the mock and asserts the
  block bar/label render mid-import and unmount on completion. Updated the PEND-35 callsite
  assertion for the new 4th `onProgress` arg.

**Verification:** `cargo nextest run import_markdown` (11 passed); `cargo check --all-targets`
(benches compile); `ts_bindings_up_to_date` gate passes; `tsc -b` clean;
`check-tauri-bindings-parity.mjs` OK; affected vitest files pass.

**Files touched (this session):**
- `src-tauri/src/import.rs` — `ImportProgressUpdate` enum + `ImportProgressSink` trait.
- `src-tauri/src/commands/pages.rs` — `import_markdown_with_progress` + progress emits;
  command takes a `Channel`.
- `src-tauri/src/commands/mod.rs` — re-export `import_markdown_with_progress`.
- `src-tauri/src/commands/tests/page_cmd_tests.rs` — recorder + 3 progress tests.
- `src/lib/bindings.ts` — regenerated (import-related delta only).
- `src/lib/tauri.ts` — `onProgress` callback + channel wiring.
- `src/lib/i18n/common.ts` — `data.importingBlocks` key.
- `src/components/DataSettingsTab.tsx` — intra-file block progress bar.
- `src/components/__tests__/DataSettingsTab.test.tsx`,
  `src/lib/__tests__/tauri.test.ts` — tests.

**Scope:** import/progress domain only. Did NOT touch `src-tauri/src/db.rs`,
`src-tauri/migrations/`, the notification plugin / tauri.conf capabilities (#138), or
editor/emoji components (#319) — respecting concurrent-agent anti-collision.

**Commit plan:** single commit; PR opened against `main` (`Closes #128`), not merged, not
released.
