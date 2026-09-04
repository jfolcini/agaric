# Session 1519 — a profile that can actually run the suite with release semantics

Issue #4677. `cargo test --profile release` cannot build this workspace at all, so the
release-profile run that #4638's assert promotion and #4640's arithmetic audit were supposed to
be checked against had never been run. It is now.

## Why `[profile.release]` could not run the tests

`panic = "abort"` makes cargo build every dependency twice — abort for the lib, unwind for the
test harness — and the `agaric` self dev-dependency (#4499) puts both builds in the same
dependency graph. A test target then links an abort-built `agaric_lib` against an unwind-built
`agaric_store`, and the mismatch surfaces as 1164 `expected X, found X` errors on
identically-named types (`Pool<DB>`, `LoroState`). It reads like a stale target directory. It is
not: it reproduces on a clean one.

`[profile.release-test]` inherits `release` and flips `panic = "unwind"`. That is the whole fix.
It is also the only way `#[should_panic]` runs at all — under abort a tripped invariant is a
SIGABRT no harness can catch.

LTO and codegen-units are relaxed deliberately. The profile exists to check which code the
compiler **keeps** (`debug_assertions` off) and which checks it **emits** (`overflow-checks` on).
Neither depends on how the result is then optimised, and inheriting `codegen-units = 1` costs
~50 minutes a run to prove nothing. `[profile.release]` stays the only thing that ships, and the
profile's doc comment says so.

## What the first run found

`cargo test --no-run --workspace --profile release-test` finished in 24m08s and linked every
test target, `command_integration` included — the target that produced the 1164 errors.

The suite: **6339 tests, 6337 passed, 2 failed**. Both were diagnosed rather than assumed:

- `export_import_export_list_style_fixpoint_4552` **passes in isolation**. It is sensitive to
  load in a full parallel run, not to release semantics. The same run independently marked
  `snapshot::tests::old_snapshots_accumulate` FLAKY, which is the corroborating signal.
- `payload_with_embedded_null_byte_panics` was the only genuine failure, and it was a
  **duplicate**.

## The one real failure was a duplicate, not a gap

`null_byte_assert_fires_for_payload` sits 200 lines below it in the same file: same
`compute_op_hash` call with a `\0` payload, same `#[should_panic(expected = …)]` string. The
difference is `#[cfg(debug_assertions)]`, which the sibling carries and this one did not.

That gate is load-bearing, and the block comment above the siblings already spells out exactly
this failure mode: `hash.rs`'s null-byte checks are `debug_assert!`s — the one place AGENTS.md
sanctions them, because the check is measured hot (#1600) — so a release build never panics and
an ungated `#[should_panic]` fails.

So the assertion stayed and the duplicate went. Falsified: breaking the payload `debug_assert!`
reddens `null_byte_assert_fires_for_payload`; restored and `cmp`-verified byte-identical. All
four gated null-byte tests still pass under the dev profile.

## What this independently confirmed

An earlier release-profile attempt in this session listed four failures. Two of them —
`materializer::tests::fifo_status::dispatch_bg_empty_block_id` and
`recovery::tests::find_prev_edit_panics_on_like_wildcard_block_id` — are gone, because #4638
promoted those sites to `assert!` / `return Err` and they now hold in release. That claim had
only ever been asserted; this is the first time it has been run.

Releases themselves were never broken: `[profile.release]` bundles build, and CI's `build` job
was green throughout. The failure was confined to `cargo test --profile release`.
