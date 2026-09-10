# Session 1675 — the hand-written wrapper layer is gone

#2927, the last step. `src/lib/tauri.ts` and `src/lib/tauri/` had four
survivors (`blocks`, `search`, `import`, `logging`) and thirteen production
importers. Each survivor carried logic the generated binding does not
express, which is exactly what `src/lib/ipc-helpers.ts` exists for, so they
moved there: `createBlock` (positional `?? null` coercion), `searchBlocks`
and `searchBlocksPartitioned` (the `requireActiveScope` default that is the
opposite of the wire's, #4412), `logFrontend`, and the private
`marshalDateFilter`. `BibliographyFormat` went to its only consumer,
`vault-import.ts`. Every importer now takes types from `@/lib/bindings` and
runtime helpers from `@/lib/ipc-helpers` or `@/lib/safe-limit`.

The `tauri-import-baseline` ratchet, its baseline and sanctioned-symbols
files, the knip entry, the two raw-invoke allowlist entries and the
`pr-merge-result-check.sh` guard slot went with it; that script now runs
five whole-tree guards and its up-front `node` check is justified by the
typecheck stage's own probe instead.

## What deleting an import-time side effect costs

`src/lib/tauri/logging.ts` called `setLogBackendSink(logFrontend)` when
first imported, and the wrapper barrel was imported by enough of the app
that the sink was always wired. With the barrel gone nothing imports it, so
`main()` in `src/main.tsx` now makes the call itself, first thing, and
`main-boot-error.test.ts` asserts the sink after `bootstrap`. Removing the
call reddens that case (`expected null to be [AsyncFunction logFrontend]`),
verified by the builder and again by me on a copy, restored and `cmp`-clean.

`scripts/check-ipc-error-path.mjs` already had the `@/lib/ipc-helpers` and
`commands`-from-bindings arms; the dead `@/lib/tauri` arm is gone and the
guard still selects the same components (61 before and after, the
`ipc-helpers` arm alone accounts for the difference when disabled).

Two tests were deleted rather than moved: `wrapper-type-drift.test.ts`
guarded against a wrapper module redeclaring a generated type, and there is
no wrapper module left; the `platform.test.ts` case asserting the absence of
the `tauri.ts:1871` doc anchor named a file that no longer exists. That
anchor was the only entry in `check-doc-code-paths.mjs`'s acknowledgment
list, so the list is empty and the self-test battery built around it reports
itself skipped by name instead of pretending to run.

Rust `///` comments that cited the deleted file were edited in lockstep with
`src/lib/bindings.ts`, checked line by line; the local
`ts_bindings_up_to_date` run was OOM-killed on the in-use laptop, so
CI's cargo-tests lane is the arbiter for that file.

Six inert `vi.mock('@/lib/tauri')` factories were deleted (every symbol they
stubbed had already left the barrel); the other ten retarget
`@/lib/ipc-helpers` with `importOriginal`. `hand-stub-ratchet`'s backlog
lost its `tauri.test.ts` entry, 45 → 44.

Root `AGENTS.md` changed one clause (the sentence that described the
ratchet) and `src-tauri/src/commands/AGENTS.md` one sentence (step 5 pointed
at the deleted files); both are flagged in the PR for the maintainer.

## Verified

- `npm run typecheck` exit 0, by the builder and by me.
- vitest over every touched or moved test file: 103 files, 2826 passed (mine);
  the builder's narrower run, 34 files, 990 passed.
- Guards: `check-ipc-error-path`, `check-raw-invoke`, `check-doc-code-paths`
  (and its `--self-test`), `check-hook-budget`, lib-layering, import-cycles,
  tauri-mock-parity, dead-symbol-citations, architecture-citations,
  json-parse-cast, strict-invoke-optout, md-link-targets, persist-hooks, knip:
  all exit 0.
- Not run locally: `ts_bindings_up_to_date` (see above), the full Rust and
  vitest suites, Playwright (CI carries them; the laptop is in use).
