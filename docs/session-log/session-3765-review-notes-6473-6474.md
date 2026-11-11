# Session 3765 — review notes from #6473 and #6474

The batched follow-up for the non-blocking notes on #6473 and #6474. #6457's notes wait for its code (F4) to reach main.

## Taken

- **#6473, `mcp/mod.rs`.** The third copy of the stub-binary smoke command takes `--lib`, like `_validate.yml` and the `Cargo.toml` comment.
- **#6474, `MirrorIngested`.** Its `specta::Type` derive is gone. `specta_builder()` registers `agaric_commands!()` and no types, so no event payload reaches `bindings.ts`, and the derive put the type nowhere. Exporting payloads would be new machinery for one type, so `useMirrorIngestEvents.ts` stays its one TypeScript copy, and a doc line says so. `ts_bindings_up_to_date` still passes, which confirms the derive never reached the bindings.
- **#6474, `changed_files`.** A comment on its cost: one stat per mirrored file every tick, cheap at today's vault sizes, and the cadence to slow if a vault ever feels it. There's no cheap gate, since the stat is the change detector.

Suites run: `scripts/clippy-sqlx-check.sh` (clippy `-D warnings`, all four `.sqlx` caches), nextest over `mirror`, `stub_binary` and `ts_bindings_up_to_date` (69 passed), and `cargo fmt --check`.
