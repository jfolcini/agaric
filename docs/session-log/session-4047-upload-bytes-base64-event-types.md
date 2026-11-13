# Session 4047 — Upload bytes cross IPC as base64; three event payloads are typed from Rust

The two open boxes of #6539, one commit each.

## Upload bytes

The issue prescribed a raw invoke body for `add_attachment_with_bytes`, for the phone user saving a recording. That premise does not hold on Android: Tauri's `ipc-protocol.js` sets `canUseCustomProtocol = osName !== 'android'`, so every Android invoke goes through `postMessage`, and `process-ipc-message-fn.js` turns a `Uint8Array` payload back into `Array.from` plus JSON. The desktop would have gained and the phone nothing, and the command would have left the generated bindings and the mock's typed handlers.

Built instead: the bytes cross as one standard base64 string, on every platform.

- `agaric_core::base64_bytes::Base64Bytes` is the wire type of `add_attachment_with_bytes`'s `bytes`, `MeetingFileInput.bytes` and `VaultFile.bytes`. All three commands, since the type made the second and third as cheap as the first.
- It is a newtype with its own `Deserialize`, not `#[serde(deserialize_with)]` on a `Vec<u8>` field: specta splits every type holding a field with a serde codec attribute into `_Serialize` and `_Deserialize` twins, which tripled `VaultFile`, `VaultImport`, `MeetingFileInput` and `AddMeetingInput` in `bindings.ts`.
- The frontend encodes with `blobToBase64` (`src/lib/file-utils.ts`, `FileReader.readAsDataURL`); `readFileBytes` is gone. The mock decodes with `atob`.
- `scripts/measure-upload-encoding.mjs` measures both shapes in Chromium. The Rust side is not measured.

Traps:

- jsdom settles `FileReader` on a task `act` does not flush. Component tests that asserted right after `act` now wait for the upload's toast; without the wait a negative assertion passes before the upload has run.
- Under vitest's vm pool, `new Blob([arrayBuffer])` stringifies a bare `ArrayBuffer` to `[object ArrayBuffer]`; a `Uint8Array` is read correctly. `PdfViewerDialog`'s test mock returned a bare buffer where pdf.js resolves a `Uint8Array`.

## Event types

`SyncEvent`, `SyncErrorCode` and `BlocksChangedEvent` derive `specta::Type` and are registered in `specta_builder` with `.typ` and, for the three event names, `.constant`. `useSyncEvents.ts` takes its payload types and names from `bindings.ts`; its hand-written interfaces are deleted.

Not tauri-specta's `collect_events!`: its `Event` maps one type to one event name, and `SyncEvent` is one enum riding several names. Splitting the enum would change producers across the sync crate for no gain here. `SyncEvent` has `skip_serializing_if` fields, so it is generated as `SyncEvent_Serialize` (the shape the frontend receives) and a `_Deserialize` twin nothing uses.

The other listeners (`pages:renamed`, `mcp:activity`, deep links, the status events) are still typed by hand, as the issue scopes it.

## Verified

- Red first: `blobToBase64` tests (not a function, then on a broken prefix strip); the mock's decode (conformance replay, voice note and undo suites); `Base64Bytes` (the URL-safe alphabet); a renamed `changed_blocks` (`ts_bindings_up_to_date` in Rust, `tsc` in `useSyncEvents.ts`).
- Full vitest, `npm run typecheck`, `npm run lint`, `cargo nextest run --workspace` in two halves, `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo test --doc --workspace`, `prek run --hook-stage manual --all-files`; `just gen-sqlx` and the bindings regeneration leave no diff. All before merging `main`; after the merge, the bindings regeneration, `typecheck`, the hook suites and clippy.
- Playwright: the eleven specs that upload (`attachments`, `attachment-link-6032`, `drop-upload`, `import-export`, `inline-image-1434`, `inline-image-fold`, `md-attachment-render-1451`, `meeting-attachments`, `pdf-annotation-1452`, `voice-note-record`, `page-mode`). `voice-note-record`'s WebM case missed its timer second once while clippy ran beside it and passed alone. The rest of the lane is CI's.
- Merging `main` brought #6671's `local_ops_appended` on `BlocksChangedEvent`: the hand-written interface it extended is deleted here, and the field arrives by regenerating the bindings.
- Not run: `e2e-tauri/attachment-paste-roundtrip.e2e.ts`'s new multi-megabyte case has no local run (this container has no WebKit driver) and was not shown red; CI's real-backend lane is its first run.
