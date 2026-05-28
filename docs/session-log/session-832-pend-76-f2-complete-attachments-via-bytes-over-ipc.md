## Session 832 — PEND-76 F2: complete attachments via bytes-over-IPC (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | 2 Explore (F2 intent + plumbing) + 1 build (FE UI wiring) + orchestrator |
| **Items closed** | PEND-76 F2 (attachment upload/render pipeline was unwired end-to-end) |
| **Items modified** | PEND-76 (F2 → done via bytes-over-IPC; purge-leak + large-file IPC deferred) |
| **Tests added** | ~+25 (frontend) / +4 (backend) |
| **Files touched** | ~16 |

**Summary:** Completed the attachment feature using a **bytes-over-IPC** design
(chosen with the maintainer over the originally-sketched plugin-fs + assetProtocol
path — simpler, no native dep/capability/assetProtocol config, and testable). The
**backend is the sole writer**: new `add_attachment_with_bytes` writes the raw bytes
under `attachments/<ULID>` then delegates to `add_attachment_inner` (cleaning up the
file on any rejection); `read_attachment` returns the bytes, which the renderer wraps
in a `blob:` URL (CSP already allows `blob:`). FE upload sites read the file to bytes
+ pre-validate MIME/size (closing the FE/BE MIME-divergence MINOR) → the new IPC;
`AttachmentRenderer` renders images / opens PDFs / downloads other files all from the
bytes (no more broken absolute-`file.path` or `asset:` URLs).

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-76 cluster; no REVIEW-LATER rows touched).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `src-tauri/src/commands/attachments.rs` (add_attachment_with_bytes_inner + read_attachment_inner + 2 command wrappers)
- `src-tauri/src/commands/mod.rs` (re-exports), `src-tauri/src/lib.rs` (handler registration)
- `src-tauri/src/commands/tests/block_cmd_tests.rs` (+4 backend tests)
- `src/lib/bindings.ts` (2 commands), `src/lib/tauri.ts` (2 wrappers), `src/lib/tauri-mock/{seed,handlers}.ts` (mock + bytes store)
- `src/lib/file-utils.ts` (isAttachmentAllowed + readFileBytes), `src/components/EditableBlock.tsx`, `src/hooks/useBlockSlashCommands/useSlashCommandProperty.ts`, `src/components/AttachmentRenderer.tsx`, `src/components/StaticBlock.tsx`, `src/lib/attachment-utils.ts`
- i18n keys; FE test files (file-utils, AttachmentRenderer, useSlashCommandProperty, EditableBlock, StaticBlock, BlockTree, attachment-utils)
- `pending/PEND-76-preexisting-data-integrity-bugs.md` (F2 status)

**Verification:**
- `cargo nextest run -p agaric add_attachment read_attachment` — 20 pass (+4 new).
- `npx tsc -b --noEmit` clean; `npx vitest run` on affected suites — all pass.
- `prek run --all-files` — run at commit.

**Process notes:** Investigated the plugin-fs-vs-IPC fork first; bytes-over-IPC won on
verifiability + single-writer ownership. bindings.ts was hand-edited (2 lines in the
committed biome-format) rather than committing the full `cargo test specta` regen,
which drifts ~287 lines (raw-specta vs biome format) and broke an unrelated file.

**Lessons learned:** **Cannot fully verify here** — the actual upload→write→read→render
round-trip + backend MIME/size enforcement only run in a real Tauri build (vitest
mocks IPC). Needs a manual smoke test before relying on it.

**Commit plan:** single commit; not pushed.
