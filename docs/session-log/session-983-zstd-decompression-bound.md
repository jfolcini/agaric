## Session 983 — bound snapshot zstd decompression (decompression-bomb guard) (#428) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#428` |
| **Dimension** | robustness (DoS gated behind authenticated pairing; medium) |
| **Tests added** | +2 (bomb rejected cleanly; normal snapshot still decodes) |
| **Files touched** | 2 |
| **Schema / wire-format** | none (no signature/format change) |

**Summary:** `decode_snapshot` fed a bare `zstd::Decoder` straight to ciborium
with **no bound** on the decompressed byte count or the zstd window. The only
upstream guard caps the *compressed* blob at `MAX_SNAPSHOT_SIZE` (256 MB), but
zstd hits 10–100× on repetitive CBOR, so a compromised/buggy **already-paired**
peer (transport is mTLS + TOFU cert-pinned — not an arbitrary network attacker)
could advertise a sub-256 MB blob that expands into a multi-GB `SnapshotData`,
an allocation-driven crash rather than a clean rejection.

Fix — cap the decompression **ratio** on the fly:
- A `CompressedCounter` wraps the input and tallies compressed bytes pulled; a
  `RatioLimitedReader` wraps the decoder output and errors once `decompressed >
  compressed × MAX_DECOMPRESSION_RATIO + DECOMPRESSION_SLACK`. The error surfaces
  through `ciborium::from_reader` and maps to `AppError::Snapshot` — a clean
  rejection, no OOM.
- `Decoder::window_log_max(27)` additionally caps the zstd window memory.

**Why a ratio bound, not a fixed ceiling:** the legitimate decompressed size
scales with vault size, not the 256 MB compressed figure (per the audit), so a
fixed absolute ceiling would either reject huge-but-legit vaults or still permit
a multi-GB blow-up. The ratio bound catches a small-blob bomb early (after at
most ~`DECOMPRESSION_SLACK` bytes) while never rejecting real data: snapshots
carry high-entropy ULIDs/hashes and compress only single-digit×, far under the
100× bound (`RATIO`=100, `SLACK`=64 MiB are wide-margin constants, not signature
changes — no call-site churn across `apply_snapshot`'s ~20 callers).

**Files touched:**
- `snapshot/codec.rs` — `CompressedCounter` + `RatioLimitedReader` + the three bound constants; `decode_snapshot` now wraps the reader/decoder and sets `window_log_max`.
- `snapshot/tests.rs` — `decode_snapshot_rejects_decompression_bomb` (a ~70 MB single-byte `content` compresses to a few KB → cleanly rejected) and `decode_snapshot_accepts_normal_snapshot` (no false positive).

**Verification:**
- New tests pass; `cargo nextest run snapshot::` → **66 passed** — every existing
  `apply_snapshot` roundtrip still decodes (the bound never false-trips real
  data). clippy + rustfmt clean.

**Commit plan:** single commit; branched off `main`; PR against `main`.
