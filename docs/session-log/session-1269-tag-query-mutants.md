# Session 1269 — four tag_query mutants, and a suggested test that could not have failed

Follow-on to session 1268 and #3452. `tag_query/**` sits outside the mutants lane's `examine_globs`, so these four survivors would not surface in CI even with #3393's budget fixed. They were found by widening the globs locally, and all four are user-visible.

## The four

| site | mutation | consequence |
|---|---|---|
| `query.rs:241` | `>` → `>=` in `run_projection` | a result that exactly fills the limit advertises a next page that returns nothing |
| `query.rs:317` | match guard → `true` | `list_tags_by_prefix` accepts out-of-range limits instead of `AppError::Validation` |
| `query.rs:269` | `exact_match_nocase` → `Ok(None)` | case-insensitive exact-tag hoisting silently stops |
| `query.rs:370` | `<` → `<=` | exact-match insertion index shifts by one on a name tie |

All four now caught, verified by re-running rather than by the tests passing:

```
before (pristine origin/main, globs widened):  4 MISSED
after:                                          4 mutants tested in 4m: 4 caught
```

Every *other* mutant at those sites was swept too — 6 caught / 0 missed at the three original sites, 5 caught / 0 missed in the extracted helper. The refactor introduced no new survivors.

## The finding worth keeping: my suggested test could not have failed

#3454 proposed, for the `exact_match_nocase` gap: *"insert `Urgent`, query prefix `urgent`, assert the exact match is returned and hoisted."*

That test passes with the function stubbed to `Ok(None)`.

With the fast path disabled the code falls through to `exact_match_normalized`, which matches the same ASCII case-variant. `tag_norm`'s own `ascii_fold_matches_sqlite_nocase` drift guard proves the two agree on ASCII, and NOCASE's match set is a strict subset of the normalized one. So the obvious black-box assertion observes no difference at all.

The only observable difference is **which row wins when several match**: NOCASE takes the BINARY-smallest name, the fallback takes the smallest `tag_id`. The real test seeds two case-variants (`wip` with the smaller id, `wiP` with the smaller name) plus `WIP-1..3` fillers so both exacts fall off a limit-3 page, then asserts the hoisted row is `wiP`. That pins the documented contract — the fallback is reached only when the fast path missed — using the transient mid-rebuild duplicate that `exact_match_normalized`'s own doc comment acknowledges.

Worth stating plainly, because this work stream is entirely about checks that cannot fail: **the issue proposing the fix specified a test that cannot fail.** Writing "assert the behaviour is correct" is not the same as finding an input where correct and broken diverge. Only running the mutant catches the difference.

## Gap 4 was unreachable through the public API

`tags_cache.name` is `UNIQUE` (migration 0061), and the caller only splices when `exact.tag_id` is absent from `rows`. So no database state can place a row whose name *equals* `exact.name` into `rows` — and that tie is the sole input separating `<` from `<=`. No black-box test could have killed this mutant.

The splice block was extracted verbatim into a private `splice_exact_match(rows, exact, effective_limit)` and the tie tested directly. Pure move, behaviour unchanged; the doc comment records why the extraction exists so it is not later inlined again. (The mutant consequently reports at `:396` in the helper rather than `:370`.)

This is a case where the honest options were "extract to make it testable" or "declare it an equivalent-in-practice mutant and document it". Extraction was chosen because the comparison encodes a real ordering invariant, not an accident.

## Verification

- `cargo nextest run -p agaric-store` → 1248 passed (was 1243; +5)
- `cargo clippy -p agaric-store --all-targets` clean, `cargo fmt` applied
- `git diff origin/main -- src-tauri/.cargo/mutants.toml` → **0 lines**; the temporary glob widening used to reproduce was restored before committing
