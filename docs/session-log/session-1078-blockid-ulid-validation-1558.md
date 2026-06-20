# Session 1078 — /batch-issues loop: BlockId untrusted-path canonicalization, batch 26 (2026-06-20)

## What happened

Single focused correctness fix from the overnight `/loop /batch-issues` run, built in
worktree `wt-batch26`. Scoped carefully to the genuine untrusted surface so the
pervasive synthetic-id test fixtures stay intact.

## Shipped

PR `fix/blockid-ulid-validation-1558`:

- **#1558** (correctness/security) — `BlockId`'s `Deserialize` / `from_trusted` / `From`
  impls only ASCII-uppercased with no ULID canonicalization, so an id reaching the hash
  preimage was used verbatim; two encodings of the same logical ULID (case variants,
  leading-char overflow) could produce divergent hash preimages. Scoped the fix to the
  one genuinely-untrusted entry point that reaches the preimage — `BlockId::Deserialize`
  (remote op-log payloads, sync messages, IPC) — which now canonicalizes a VALID ULID
  through the same `ulid::Ulid::from_str().to_string()` path `from_string` uses, so all
  encodings of one ULID collapse to a single byte-identical preimage. A non-ULID string
  falls back to the prior lenient uppercase (no error), preserving the 554 synthetic-id
  trusted/test call sites. `from_trusted` / `From` / `test_id` stay lenient by design
  (trust boundary now documented). `PageId::Deserialize` inherits via delegation;
  `ActiveBlockId` is left unchanged (it never appears in a serialized op payload).

## Scoping & premise correction

- The issue premise (I/L/O decode-equivalence) doesn't apply to this crate: `ulid`
  v1.2.1 is strict-alphabet and rejects I/L/O/U as `InvalidChar` (verified against the
  crate's `base32.rs` LOOKUP). The real residual fixed was the lenient "accept any
  string, just uppercase" path letting untrusted input carry a non-canonical valid ULID
  into the preimage.
- Residual after the fix (non-ULID strings still enter the preimage non-canonically) is
  benign: a non-ULID string has no other encoding of the same value to collide with —
  uppercase is itself a deterministic, idempotent canonicalization — so the
  non-determinism the issue described can't recur.

## Review pass

Reviewer (APPROVE, issue closed): independently verified the I/L/O/U rejection (the
load-bearing claim), confirmed the case/leading-char-overflow variants collapse to a
byte-identical `serde_json` form + equal hash (not merely `==`), confirmed
`normalize_block_ids` is a genuine pre-existing no-op delegating to construction-time
canonicalization, and that `ActiveBlockId` never reaches a hash preimage. Fixed one
stale docstring on the `from_trusted`↔`Deserialize` parity proptest (the invariant
narrowed — they now diverge for a valid ULID with a high leading char, unreachable in
production). 426 scoped tests pass; `clippy --all-targets` clean.

## Notes

- Files: `src-tauri/src/ulid.rs`, `src-tauri/src/ulid/tests.rs` only. No caller impact,
  no `.sqlx` change.
- Branch base is current `origin/main`.
