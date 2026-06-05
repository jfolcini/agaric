## Session 974 — snapshot create: streaming encode + 100k codec bench (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | 0 (orchestrator direct) |
| **Items closed** | `#416` (create-side transient peak trimmed; full streaming *format* stays deferred, now bench-gated) |
| **Items modified** | — |
| **Tests added** | +1 criterion bench group (`snapshot_codec`, 1k/10k/100k) |
| **Files touched** | 3 |

**Summary:** First of the `backend-audit` SQL set, taken largest-first and
**bench-gated** (per the "measure, don't imagine" rule). #416 flagged that the
snapshot **create** path materialises the entire derived state three times at
peak: the `SnapshotData` Vecs, the full uncompressed CBOR buffer (`cbor_buf`),
**and** the zstd-compressed output. (The **restore** path already streams via
`decode_snapshot` — L-67.)

- **Fix (no wire-format change):** `encode_snapshot` now serialises CBOR
  *directly into* a `zstd::stream::Encoder` instead of into an intermediate
  `Vec<u8>` handed to `zstd::encode_all`. The uncompressed CBOR buffer (the
  largest of the three transients) is never materialised — at peak only the
  `SnapshotData` Vecs and the compressed output are live. Output is still a
  single zstd frame over the same one CBOR value, so `decode_snapshot` is
  unchanged and encoding stays deterministic.
- **Bench-gate decision:** added a `snapshot_codec` bench (1k/10k/**100k**
  blocks) measuring encode/decode time and compressed payload. **Measured at
  100k blocks: compressed payload 2.98 MiB, encode ~159 ms, decode ~236 ms.**
  The durable artifact is well within budget, so the *full row-batched
  streaming snapshot format* — which would remove the `SnapshotData` Vecs
  themselves but is a **wire-format change gated by AGENTS.md "Architectural
  Stability"** — is correctly **NOT** triggered and stays deferred behind this
  bench. The transient removed by the streaming-encode fix (~30–40 MiB
  uncompressed CBOR at 100k) already exceeds the 24 MB Android heap, so the
  safe win is real and worth landing on its own.

**Files touched (this session):**
- `src-tauri/src/snapshot/codec.rs` — `encode_snapshot` streams CBOR → zstd
  (drops the `cbor_buf` transient); doc updated.
- `src-tauri/src/snapshot/create.rs` — L-105 comment updated to reflect the
  reduced encode-side peak; residual ceiling is the `SnapshotData` Vecs (gated
  format change).
- `src-tauri/benches/snapshot_bench.rs` — new `snapshot_codec` bench group +
  synthetic `SnapshotData` builder; registered in `criterion_main!`.

**Verification:**
- `cargo nextest run snapshot` — 142 passed (incl. `snapshot_cbor_roundtrip`
  and `snapshot_encode_deterministic` property tests — streaming preserves both).
- `cargo bench --bench snapshot_bench -- --quick snapshot_codec` — runs clean;
  numbers above.
- No SQL touched → no `.sqlx` regen.

**Commit plan:** single commit; pushed; PR against `main`.
