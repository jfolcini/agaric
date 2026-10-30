# Session 3178 — the fuzzer adds and deletes attachments

Item B5 of #6054. The fuzzer's header listed the attachment ops as a blind spot. The mock handlers and three fixtures (`attachment_add_bytes`, `attachment_writes`, `query_attachments`) already existed; the fuzzer dropped `AddAttachment` and `DeleteAttachment`.

**Change.**
- `AddAttachment` renders as `add_attachment_with_bytes` and `DeleteAttachment` as `delete_attachment`.
- Each stack mints its own attachment id, so `An` names the attachment the n-th add made. It is resolved on both runners (`resolve_attachment_label`, `resolveAttachmentLabel`). A label past the last add fails loudly.
- After the chain, every `An` is deleted once more. Each record says whether the row still stood, which also covers rows a purge removed. No stack-minted row is left behind.

**Not compared.** An added attachment's row (id, path, hash, clock) and its bytes on disk. Rename and undo of an added attachment are not generated.

**Mock.** No divergence in 256 or 1000 cases, so it is unchanged. A mock `delete_attachment` that keeps the row turns the lane red on the sweep's `not_found` record.

**Review.** A separate reviewer confirmed the Rust and TS label twins agree, including on undo, redo and refused adds. It found the weekly lane's 256 cases fit nextest's timeout. It flagged a `list_attachments_batch` read that could never answer rows (the seed holds no attachment and the sweep deletes the rest), so the read was deleted.

**Suites:** conformance nextest, the fuzz lane at 256 cases (and 1000 via `cargo test`), vitest over `src/lib/tauri-mock`, typecheck, knip, clippy, fmt.
