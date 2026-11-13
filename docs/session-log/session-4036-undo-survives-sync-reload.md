# Session 4036 — A sync keeps the open page's undo and redo

Last checkbox of #6541, continued in a cloud session from the overnight batch's parked `wip:` commit (#6667).

**What it does.** `sync:complete` and `blocks:changed` used to empty the open page's undo and redo stacks (`reanchorAfterRemoteOps`, #731). A sync session appends only the peer's ops, as replicated rows the positional undo filters out (`is_replicated = 0` in `history.rs`), so the reset protected nothing and cost the user their redo. An MCP write is different: its `agent:%` ops are positional-undo targets, so keeping the stacks across one mis-targets `Ctrl+Z`. The maintainer approved a field on `BlocksChangedEvent` (2026-11-13): `local_ops_appended`.

- Rust: `ViewChangeEmitter::emit_blocks_changed` sends `true` (MCP writes, the Markdown mirror's ingest, a post-sync placement or repair); the new `emit_blocks_changed_by_peer` sends `false`, used only by `SpacePlacementSink` when the session placed and repaired nothing. Its default forwards to the re-anchoring form, so test emitters that do not care keep compiling.
- Frontend: `sync:complete` reloads with `reanchorUndo: false`; `blocks:changed` re-anchors unless the field is `false`, so an older backend without the field behaves as before.
- A snapshot catch-up is a Loro merge with no local op rows, so `sync:complete` keeps the stacks there too.

**Tests.** `useSyncEvents.undo-stacks.test.ts` drives the real undo store through both events; four assertions in `useSyncEvents.test.ts` that pinned the re-anchor on `sync:complete` now assert the stacks are kept (the old behaviour the issue changes). `e2e/reload-keeps-editor.spec.ts` gains three cases on the mock; `e2e-tauri/sync-two-device.e2e.ts` gains the two-device case (redo after a peer's edit to another block; an undo of an op the peer wrote over puts back the text before it, which is what the backend's reverse op already did). Rust: the wire shape of both forms and `local_ops_appended` per producer.

**Falsified.** Each frontend arm reverted alone reddens its vitest cases; reverting both reddens the two peer e2e cases. The agent e2e case is the regression guard for the `true` arm.

**Ran.** vitest (`useSyncEvents*`, `undo`), typecheck, lint, the Playwright spec, targeted Rust tests. The real-backend lane runs in CI (no WebdriverIO here).
