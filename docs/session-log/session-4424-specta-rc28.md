# Session 4424 — specta rc.28 and tauri-specta rc.29

**Ask.** Bump the specta stack, which Dependabot ignored until #7042 made it a group.

**Versions.** tauri-specta rc.29 (2026-11-13) and rc.28 both require `specta =2.0.0-rc.28` and the `specta-*` 0.0.15 line, so the pair is specta rc.28 / tauri-specta rc.29, with specta-typescript, specta-serde and specta-util at 0.0.15. All were published more than seven days before the bump. One `cargo update -p tauri-specta --precise 2.0.0-rc.29` moved exactly those seven crates. Cargo also pointed some existing dependency edges (`windows-sys`, `syn`, `darling`, `proc-macro-crate`) at versions already in the lock, without adding or removing a package. The fuzz lock moved the same seven.

**What upstream changed.** tauri-specta rc.26 changed two defaults.
- `ErrorHandlingMode::Throw`: commands return the bare `invoke` promise. Every caller unwraps the `{ status, data | error }` result, so `specta_builder` opts back into `ErrorHandlingMode::Result`. The `typedError` runtime is byte-identical.
- Phase-split serde export: nearly every type becomes `X_Serialize` / `X_Deserialize`, and generic page responses come out as `PageResponse_Serialize<T>` with `T` unbound. `disable_serde_phases()` keeps one shape per type. rc.25 had already split seven types (`PropertyRow`, `SyncEvent`, …). Their unified shape equals the old `_Serialize` field for field, and none of them is a command argument. The three frontend references to `SyncEvent_Serialize` / `ActivityEntry_Serialize` now name the unified type.

**What remains in `bindings.ts`.**
- Every command takes a trailing `options?: InvokeOptions` and forwards it to `invoke`. This is unconditional upstream (`js_ts.rs`).
- Nine inline argument or return shapes are now named types that already existed.
- `createBlock`'s `parentId` and `blockId` are typed `BlockId`.

The frontend call surface is otherwise unchanged.

**The test fallout.** Forwarding `options` means each `invoke` call now ends in `undefined`. That reddened 802 vitest tests in 111 files that assert `toHaveBeenCalledWith('cmd', args)`. Rather than rewrite them all, `ignoreUnsetOptions` (`src/__tests__/helpers/invoke.ts`) wraps the shared `invoke` mock and the private ones the strict-invoke guard allows. It drops trailing `undefined` arguments before the mock records the call. Two tests in `strict-invoke.test.ts` pin both arms (unset options dropped, set options kept), and each was shown red by breaking its arm.

**Ran.**
- `ts_bindings_up_to_date`: red before the regeneration, green after.
- `cargo clippy --workspace --all-targets -- -D warnings` and `SQLX_OFFLINE=true cargo check --workspace --all-targets`.
- `cargo deny check`, `npm run typecheck` and `npm run lint`.
- Vitest: the full suite before the helper, then the 111 red files and the private-mock files after it.
- `node scripts/check-strict-invoke-optout.mjs`.
