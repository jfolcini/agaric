# Session 4223 — lint rules, a deleted guard and toolchain upgrades (#6841)

Built the maintainer's decision on the #6841 research as one PR: four oxlint rules and two clippy lints on with every hit burned down, the `dead-symbol-citations` guard deleted, and every toolchain and tool moved to its newest release at least seven days old.

## What shipped

- **oxlint**: `typescript/no-deprecated`, `eslint/preserve-caught-error`, `typescript/switch-exhaustiveness-check` and `typescript/no-misused-promises` at `error`, one commit each.
  - Deprecated APIs moved to their replacements (`pressSequentially`, `queryClient.query`, `toThrow`, `rolldownOptions`, `React.InputEvent` / `SubmitEvent`).
  - The TipTap Link `validate` option is deleted, not renamed. The extension reads it only when `shouldAutoLink` is falsy, and `shouldAutoLink` always has a default, so it never ran; moving it to `shouldAutoLink` would have stopped bare `example.com` autolinking.
  - Five `no-deprecated` suppressions remain, each with its reason: the keyCode 229 IME checks, which nothing else detects on Safari and Android, and WebKit's `caretRangeFromPoint` fallback.
  - Each switch names the cases its `default` absorbed. There is no `never` check: with the rule's default options a `default` does not make a union switch pass, so a new variant already fails lint at every switch.
  - Async handlers use the existing `() => void fn()` convention; `src/main.tsx` logs every unhandled rejection. Where a consumer awaits the promise (ConfirmDialog, BlockContextMenu, `useBlockFlush`), the prop is widened to `void | Promise<void>` instead.
- **clippy**: `string_slice` and `debug_assert_with_mut_call` at `deny` in every crate's `[lints.clippy]`. The `string_slice` sites, production and test code alike, now use `split_once`, `strip_prefix`, `split_at_checked`, `str::get` or a `chars` walk; `debug_assert_with_mut_call` had none. Rewrites that changed how an index is computed carry multi-byte tests.
- **Guard**: `dead-symbol-citations` and its script are gone; `HOOK_CAP` follows the count to 103.
- **Toolchains**:
  - Rust 1.99.1 everywhere it is pinned. Its new lints: `fetch_update` renamed `try_update`, redundant references in format arguments, `chunks_exact` with a constant size, two redundant imports.
  - Hand-pinned tools: prek 0.5.10, typos 1.52.0, sqruff 0.44.0, zizmor 1.32.0.
  - npm: oxlint 1.92.0, oxfmt 0.77.0, oxlint-tsgolint 7.0.2006, knip 6.44.2, Playwright 1.65.0. oxlint 1.92 no longer reports the react compiler findings in `createElement` test probes, so their directives went.
  - The `--shard` Playwright run passes `--pass-with-no-tests`.
- **AGENTS.md**: the maintainer's sentence on adopting linter rules preventively, word for word.

## Decisions and traps

- **zizmor 1.30's `self-repository` audit is disabled.** It asks for `uses: $/...`, which actionlint v1.7.12, its newest release, rejects as a ref-less action. The maintainer chose to disable that one audit until actionlint parses the form.
- **The Playwright shard flag goes on the one run that passes `--shard`** (`scheduled-deep-checks.yml`). `_validate.yml` deals files to its three legs itself and never passes `--shard`.
- **Parallel builders in one tree fill the cloud disk.** `split-debuginfo = "unpacked"` leaves `.dwo` files under `target/debug`; two rounds of deleting them and `target/debug/incremental` freed over 20 GB each time. `CARGO_INCREMENTAL=0` keeps the gates smaller.
- **A commit stashes unstaged changes** through prek, so commits waited until every builder in the shared tree had finished.

## What ran

- `npm run lint` (type-aware, 0 errors), `npm run typecheck`, vitest over every touched module's tests, the touched Playwright specs on the mock.
- `cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace` in two partitions; targeted nextest runs per rewritten module.
- `prek run --all-files` and `prek run --hook-stage manual --all-files` with the new tool versions.
- New multi-byte tests in `import.rs`, `loro/engine/apply.rs` and `fts/strip.rs`, and the AgendaView retry test, were shown red by reintroducing the bug they cover. The others were not.
