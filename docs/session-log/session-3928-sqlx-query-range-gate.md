# Session 3928 — pre-push Phase E runs only when the range can change a query

The last step of #6560's `.sqlx` checkbox, rule (a) of the approved design comment on that issue: pre-push Phase E (`cargo sqlx prepare --workspace --check`, a whole-workspace recompile) ran on every push with a `.rs` file; it now runs only when the pushed range can have changed what the cache records.

## What changed

- `scripts/lib/sqlx-query-range.mjs <base> <head>` prints `skip` or `run: <reason>`. Order: path triggers (`src-tauri/.sqlx/`, `src-tauri/**/*.sql`, any `Cargo.toml` / `Cargo.lock` under `src-tauri/`, `sqlx.toml`), then any `macro_rules!` at `<head>` whose body holds a query macro, then each `.rs` hunk of `git diff -U0 -M` against the query-macro spans of the pre-image and the post-image. Spans come from `stripRustComments` text (comments and literals blanked, so a `)` inside SQL cannot end a span) plus delimiter counting; an unterminated macro spans to end of file. Any git failure, unparseable patch line or `.rs` path listed without a diff section throws: exit 1.
- `scripts/verify-ci-equivalent.sh`: `sqlx_gate_verdict <forced> <changed_ok> <helper…>` decides; only exit 0 with exactly `skip` skips. `PRE_PUSH_SQLX_CHECK=1` or `CHANGED_OK=0` force the run. The Phase E command text is unchanged (the ratchets grep it). The PASS banner gains a "sqlx cache check skipped" line. `scripts/push.sh` inherits the environment, so the override reaches the verifier.
- Tests: `scripts/lib/sqlx-query-range.test.mjs` (12 cases from the design, registered in `_validate.yml`'s node:test step; no local runner lists these files) and five `--self-test` checks of `sqlx_gate_verdict` (the three asked for, plus "uncomputable change set runs" and "exact skip skips", without which an always-run gate passes the rest).

## Traps

- `git diff` defaults `diff.renames=true`, so deleting `-M` from the patch command is not a broken variant; the pure-rename case was shown red with `--no-renames`.
- A zero-count side of a `-U0` hunk (`-a,0` or `+c,0`) names an insertion point, not a line; it is skipped, because the other side carries the content lines. Counting it would run Phase E for a line inserted just after a macro's closing line.
- A user `textconv` driver on `*.rs` shifts the patch's line numbers away from the `git show` text the spans come from, and an in-macro edit then skipped; the patch command passes `--no-textconv`.
- `git grep -l` exits 1 on no match; that alone is "no wrapper", any other failure throws.
- Over the last 150 `origin/main` commits touching `.rs`, the helper said `run` on 46 and `skip` on 104; all 38 that changed `src-tauri/.sqlx` said `run`, and still did with every path trigger disabled (the span rule alone). That agrees with the design's "at most 47 of 149".

## Checks run

`node --test scripts/lib/sqlx-query-range.test.mjs` (12 pass), `bash scripts/verify-ci-equivalent.sh --self-test` (passed), shellcheck at hook severity, oxlint and oxfmt on the new files, each test case shown red against its named broken variant. No cargo was run, so Phase E itself and the full verifier were not exercised end to end; CI's `verify-ci-equivalent-selftest` hook covers the gate function.
