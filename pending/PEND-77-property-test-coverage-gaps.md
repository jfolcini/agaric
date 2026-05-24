# PEND-77 — Property-test coverage gaps

Extend property-based testing (`proptest`, already a dev-dependency) to the
leaf transforms and invariant-rich logic that currently rely on example-based
unit tests only. Triggered by a 2026-05-24 audit of where `proptest!` is and
isn't used.

> **The inventory below is a dated snapshot (2026-05-24), indicative not
> authoritative.** It records which modules *have* a property test, not counts.
> Re-run the "How to re-audit" command for fresh state. Do not add a hook that
> polices this list.

## Already covered (no work — baseline)

`proptest!` is live in eight modules. These are the right shape and need nothing:

| Module | Property under test |
|--------|---------------------|
| `snapshot/tests.rs` | CBOR snapshot encode→decode roundtrip (`arb_snapshot_data`) — *the serializer* |
| `op.rs` | op serde roundtrip + `OpType` display↔`from_str` roundtrip |
| `ulid/tests.rs` | case-normalization idempotence + serde roundtrip |
| `hash.rs` | op-hash determinism / collision / 64-char hex format |
| `pagination/tests.rs` | pagination cursor encode→decode roundtrip |
| `loro/engine_proptest.rs` | CRDT concurrent set-property convergence / LWW resolution |
| `mcp/tools_ro/tests.rs` | search tool ↔ `search_blocks_inner` oracle parity |
| `gcal_push/digest.rs` | digest property |

Roundtrips and the CRDT merge core are well covered. The gaps are leaf
transforms and DB-bound invariants.

## Tier A — pure functions, cheap, no DB (do first)

### A1. `word_diff.rs::compute_word_diff` (`src-tauri/src/word_diff.rs:26`)

Today: 8 example tests (incl. Unicode/decomposition pins).

Properties to add:

- **Reconstruction invariant** — for any `(old, new)`, dropping every `Delete`
  span and concatenating the remaining span values must reproduce `new`
  exactly.
- **Old-side reconstruction** — dropping every `Insert` span and concatenating
  must reproduce `old`.
- **Order preservation** — spans stay in source order; no reordering.
- **Unicode robustness** — generate decomposed/precomposed strings so the
  existing decomposition pins become universally quantified, not single cases.

### A2. `space_filter_canonical.rs::normalize` (`src-tauri/src/space_filter_canonical.rs:89`)

Today: two parity/canonical-form example tests.

Properties to add:

- **Idempotence** — `normalize(normalize(s)) == normalize(s)` for arbitrary
  SQL-like input.
- **Whitespace-equivalence** — strings differing only in whitespace /
  line-continuations / `?N`-vs-`?<digits>` placeholders normalize identically.
- **Structure preservation** — parens stay balanced; SQL keywords survive.

## Tier B — DB-bound, higher value, needs a seeded fixture harness

These require an in-memory seeded DB (random valid block trees / op chains).
The cost is the generator/fixture harness, not the assertions. Build the
harness once, then B1–B4 share it.

### B1. `reverse/mod.rs::compute_reverse` (`src-tauri/src/reverse/mod.rs:19`)

Today: ~20 example tests (one per op type).

Properties to add:

- **Inverse** — `apply(op)` then `apply(compute_reverse(op))` returns to the
  prior observable state (for reversible op types).
- **Determinism** — same op + same prior state always yields the same reverse
  op.
- **Type mapping** — every `OpType` variant maps to its correct inverse type;
  non-reversible variants (e.g. purge) are rejected, not mis-reversed. This
  also catches a future op-type being added without a reverse.

### B2. `dag.rs::walk_edit_chain` / `find_lca` (`src-tauri/src/dag.rs:150`)

Today: oracle-parity example test (`walk_edit_chain_oracle`).

Properties to add:

- **Termination** — any chain, including a deliberately corrupted/cyclic one,
  halts within `MAX_LCA_STEPS` (`dag.rs:28`) and never hangs.
- **Cycle detection** — a chain seeded with a cycle yields the visited prefix,
  not an infinite walk.
- **LCA commutativity** — `find_lca(a, b) == find_lca(b, a)` whenever an LCA
  exists.
- **Chain ordering** — walked ancestors are monotonic in depth.

### B3. `soft_delete/mod.rs` cascade / restore

Today: 12 example tests (`cascade_soft_delete_*`, `restore_block_*`).

Properties to add:

- **Cascade idempotence** — soft-deleting the same subtree twice equals once.
- **Restore inverse** — `restore ∘ cascade == identity` for a subtree with no
  independently-deleted descendants (the existing example pins the *with*-case;
  the property generalizes the clean case).
- **Subtree isolation** — cascade on block B touches only B and its
  descendants; sibling trees are untouched for any random tree shape.

### B4. `block_descendants.rs` / `block_positions.rs` tree CTEs

Today: no dedicated property tests.

Properties to add:

- **Descendant closure** — `descendants(B)` is exactly the transitive children
  of B; no unrelated blocks, none missing.
- **Soft-delete filtering** — the `_active` CTE variant excludes every
  soft-deleted descendant.
- **Position monotonicity** — `next_sibling_position` never reuses an existing
  sibling position.

## Recommended action order

1. **A1 `word_diff`** — highest ROI; pure, fast, turns hand-pinned Unicode
   cases into universal invariants.
2. **A2 `space_filter_canonical`** — pure idempotence; a few lines, load-bearing
   for SQL canonicalization.
3. **Build the seeded-DB fixture harness** (random valid block tree + op chain
   generators). One-time cost that unblocks B1–B4.
4. **B1 `compute_reverse` inverse property** — the inverse law is exactly what
   per-op example tests under-cover, and it future-proofs new op types.
5. **B2 `dag` termination/cycle/LCA** — hardens the `MAX_LCA_STEPS` bound
   against corrupted chains.
6. **B3 `soft_delete` idempotence/inverse**, then **B4 tree-CTE closure** —
   reuse the B-tier harness.

## Notes

- `proptest = "1.11.0"` is already in `src-tauri/Cargo.toml` dev-dependencies;
  no new dependency.
- Use proptest's default case count and shrinking — do not hand-pick a case
  budget without a measured reason.
- No `cargo-fuzz` target exists and none is proposed here; these are
  property tests (bounded, deterministic seeds), not continuous fuzzing. A
  separate `cargo-fuzz` effort for the CBOR/zstd decode path on *untrusted*
  bytes could be a future PEND if snapshots ever cross a trust boundary.

## Cost / Impact / Risk

- **Cost:** Tier A — **S** (~half a day, both). Tier B — **M-L** (the fixture
  harness is the bulk; B1–B4 are small once it exists).
- **Impact:** Medium. Closes invariant gaps in leaf transforms and the
  reverse/cascade/dag logic that example tests sample thinly. The serializer
  and CRDT core are already covered, so this is hardening, not a hole-plug.
- **Risk:** Low. Test-only; no production code changes. Main risk is flaky
  generators (mitigate: shrink-to-minimal repros, fixed seeds in CI).

## How to re-audit

```bash
# Which modules currently have property tests
grep -rln --include=*.rs -e 'proptest!' -e 'use proptest' src-tauri/src
```
