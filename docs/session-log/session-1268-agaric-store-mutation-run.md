# Session 1268 — the first mutation coverage `agaric-store` has ever had

## Why this was worth doing locally

The scheduled Rust mutation lane tests **13 of 607** mutants inside its 90-minute budget, and mutants are ordered by package:

```
src/reverse             1–137
agaric-engine/src/loro  138–509
agaric-store            510–607   <-- never reached
```

`agaric-store` — the hash-chain core the mutants config names as the lane's whole reason to exist — sits permanently past the budget. Not "uncovered this week": unreachable in any run, at any budget, under that ordering (#3393).

Locally the arithmetic is different enough to change the answer:

| | CI (4-vCPU runner) | local (8-core/16-thread Ryzen 7 250) |
|---|---|---|
| per mutant | ~415 s | **~38 s** |
| per-mutant test scope | whole `agaric` suite (~378 s) | `agaric-store` only (~21 s) |
| 98 `agaric-store` mutants | never reached | **42 min** |

That ~18× difference is the *test scope*, not the hardware. It is the concrete argument for per-package scoping in #3393.

## Result

```
98 mutants tested in 42m: 82 caught, 5 missed, 11 unviable
```

94% of viable mutants caught. The five survivors fall on exactly two accessors, and only one is a real gap.

### What "98 mutants" actually covers — read this before generalising

`examine_globs` in `.cargo/mutants.toml` scopes `agaric-store` to **`op.rs` and `op_log/**` only**. That is deliberate ("only mutate the invariant core"), but it means the 94% figure describes the op-log core, **not the crate**:

| | non-test LOC |
|---|--:|
| mutated (`op.rs` + `op_log/**`) | **3,005** |
| never mutated (`db/`, `snapshots/`, `tag_query/`, `tag_inheritance/`, `pagination/`, `backlink/`, `cache/`, `peer_refs.rs`, `space_filter_canonical.rs`, `cancellation.rs`) | **37,024** |

So **7.5%** of the crate was mutated. "`agaric-store` is well tested" would be an unearned generalisation from a twelfth of it, and the first draft of this log made exactly that claim.

This compounds with #3393 rather than being covered by it: even a perfectly right-sized lane that reached `agaric-store` would still only mutate these globs. Widening the globs is a separate decision from fixing the budget, and the two are easy to conflate.

## The real gap — `OpPayload::attachment_id`

All three variants cargo-mutants generates for `Option<&str>` survived:

```
op.rs:426:9  replace OpPayload::attachment_id -> Option<&str> with None
op.rs:426:9  replace OpPayload::attachment_id -> Option<&str> with Some("")
op.rs:426:9  replace OpPayload::attachment_id -> Option<&str> with Some("xyzzy")
```

Exhausting the variant set with zero kills means the return value was asserted nowhere.

It is load-bearing: the accessor populates the indexed `op_log.attachment_id` column (migration 0064) from `append_local_op_in_tx`, `dag::append_merge_op`, and `dag::insert_remote_op`, so reverse-attachment lookups are O(log N) instead of scanning every `add_attachment` row. Had it regressed to `None`, every attachment op would have written a NULL index column and reverse lookups would have quietly stopped resolving.

**Why the gap existed** is the interesting part. Assertions on `attachment_id` were plentiful — but all against the payload *struct field* (`p.attachment_id`). The nearest column read-back, `ingest_remote_op_in_tx_lands_row_and_is_idempotent`, populates the column through the JSON extractor `extract_indexed_ids_from_payload`, not through this accessor. So the column was covered, the field was covered, and the function joining them was not.

Closed with two tests in `agaric-store` (they must live there for `-p agaric-store` to kill the mutants):

- all three `Some` arms — `AddAttachment` / `DeleteAttachment` / `RenameAttachment` — each with a **distinct** id, so a wrong-arm or constant return cannot pass;
- `CreateBlock` / `AddTag` pinned to NULL. Without the negative case an unconditional `Some(..)` would still satisfy the positive one, and NULL is load-bearing anyway because the partial index `idx_op_log_attachment_id` excludes NULL rows.

Verified by re-running the mutants rather than by the tests passing:

```
$ cargo mutants -p agaric-store --re 'OpPayload::attachment_id' --timeout 900
Found 3 mutants to test
ok       Unmutated baseline in 38s build + 39s test
3 mutants tested in 4m: 3 caught
```

## The two survivors that are NOT a gap

```
op_log/record.rs:75:9  <impl HashableOpRecord for OpRecord>::parent_seqs -> None
op_log/record.rs:75:9  <impl HashableOpRecord for OpRecord>::parent_seqs -> Some("")
```

These read as hash-chain integrity going untested, which would be serious. They are **equivalent mutants**. `compute_op_hash` (`agaric-core/src/hash.rs:63`) opens with:

```rust
let parent_seqs_canonical = parent_seqs.unwrap_or("");
```

so `None` and `Some("")` produce byte-identical preimages by construction — no test can distinguish them, and cargo-mutants never generated the discriminating `Some("xyzzy")` for this function. Coverage is in fact fine: `verify_op_record_detects_tamper_on_stored_op` appends a real op, reads it back, and pins both halves — a mutated hash-covered field trips the verifier, a mutated uncovered field does not.

Recorded in #3452 as known-equivalent so future runs do not re-surface them. Worth stating plainly: the alarming write-up was drafted before `compute_op_hash` was read. A surviving mutant on a scary-looking function is a hypothesis, not a finding.

## Follow-ups

- #3452 — this issue; the `attachment_id` half is now closed.
- #3393 — per-package scoping, now with measured per-mutant costs rather than projections.
- #3443 — inter-crate contract tests, the precondition that makes per-package scoping trustworthy for `agaric-engine`/`agaric-sync`, whose tests still live in the app crate (#3120, #3299).
