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

- `payload_with_embedded_null_byte_panics` was a **duplicate**; see below.
- `export_import_export_list_style_fixpoint_4552` is a real finding, filed as **#4688**.

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

## The other failure was not a flake

The first instinct was to call it load sensitivity and move on. That was wrong, and worth
recording as a near miss: the profile's first run found something, and the cheap reading would
have discarded it.

It reproduces with 166 tests in 8.8 s, not just under whole-suite load, and it fails by
**reordering sibling blocks** — nondeterministically. The same test, retried once inside one
nextest invocation, produced two *different* wrong orderings. In the second, the reorder also
corrupted the #4552 positional ordinals: once `Step two` stopped being adjacent to `Step one`,
it renumbered to `1.`.

Export cannot be the source: its order is total, `(COALESCE(position, sentinel), id)` at
`markdown.rs:808` and again at `:1401`. So the variance is upstream — either import writing
colliding sibling positions, or `settle()` returning before the materializer is done. #4688
carries both hypotheses and the experiment that separates them; it is deliberately not fixed
here, because this session's change is a build profile.

The decisive measurement is that the dev profile passes 3/3 at ~27.7 s per run while
`release-test` fails at ~8.8 s. That is a **3x speed** difference, not a semantic one —
nothing in this test touches `debug_assertions` or `overflow-checks`. Which inverts the
severity: users run release builds, so if the ordering is timing-dependent, production is the
more exposed environment, not the less.

## What this independently confirmed

An earlier release-profile attempt in this session listed four failures. Two of them —
`materializer::tests::fifo_status::dispatch_bg_empty_block_id` and
`recovery::tests::find_prev_edit_panics_on_like_wildcard_block_id` — are gone, because #4638
promoted those sites to `assert!` / `return Err` and they now hold in release. That claim had
only ever been asserted; this is the first time it has been run.

Releases themselves were never broken: `[profile.release]` bundles build, and CI's `build` job
was green throughout. The failure was confined to `cargo test --profile release`.
