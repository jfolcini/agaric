# Session 1631 — the stringly and awaited-nothing type-aware rules

`oxlint --type-aware` has never run against this tree; the flag is passed by no
script, hook or lane. Turning it on is being done one rule at a time, each
cleared to zero in its own PR. This one takes `no-base-to-string` (22 sites),
`restrict-template-expressions` (18) and `await-thenable` (10). No disable
comment was left anywhere: every site is a code change.

## What the three rules found

`no-base-to-string` flags a value whose only `toString` is `Object`'s, so it
renders as the literal text `[object Object]`. `restrict-template-expressions`
flags the same class inside a template, plus `unknown` and `any`.
`await-thenable` flags awaiting something that is not a promise.

Two of the fifty were live defects a person could see. The rest split between
type models that were wrong about their own data and cosmetics.

## The fatal boot screen said "[object Object]"

`renderFatalBootError` in `src/main.tsx` is the last line of defence for a
crash before React mounts — the user gets one static screen and no console.
Its message was `String(error ?? 'An unexpected error occurred')`, and the `??`
only substitutes for null. A rejection carrying a bare IPC `AppError`
(`{ kind, message }` is exactly what the backend serialises) therefore rendered
as `[object Object]`, which is the whole of what that user is told.

It now mirrors `ErrorBoundary`: an `Error`'s `message`, a thrown string
verbatim, and the generic copy for everything else. A thrown *number* now gets
the generic copy rather than its digits, which is the one regression in the
change and not a shape anything throws.

## An object cause logged as "[object Object]" too

`extractSingleCause` in `src/lib/logger.ts` handles an `Error`, then an object
with a `message`, then fell through to `String(cause)`. An object with neither
— the shape the cause chain exists to reveal — reached the console line and the
IPC context JSON written to the daily rolling log as `[object Object]`. It is
now `JSON.stringify`d through the module's existing `safeStringify`, whose
parameter widened from `Record<string, unknown>` to `unknown` to take it.

The primitive arms are spelled out with six `typeof` tests rather than an else.
That is not decoration: TypeScript cannot subtract `object` from `unknown`, so
the negative branch is still `{}` and still flagged, and a symbol must go
through `String` because `${sym}` throws.

## Two type models that were inverted

`scripts/check-mutants-scope.mjs` builds its upload and download records as
`{ name: undefined, path: undefined }`, which pins each property's type to
`undefined`. Every `!== undefined` guard downstream therefore narrowed to
`never`, and the three template sites reporting the artifact name and path were
printing a value the compiler believed could not exist. `scripts/generate-vex.mjs`
has the same shape in `parseArgs` (`{ output: null, version: null }`). JSDoc
typedefs restore the real types; nothing about the runtime changes, and the
`--output` guard still throws on a missing path argument.

This matters less than it sounds, because `scripts/**/*.mjs` is in no `tsc -b`
project — `tsconfig.scripts.json` includes `.ts` only. So the annotations added
here are read by `oxlint --type-aware` and by nothing else, and the standing
check on those files is each guard's own `--self-test`.

## The e2e-tauri awaits

Eight of the ten `await-thenable` sites are `await $(…)` / `await $$(…)` in the
wdio lane. WebdriverIO 9.31 declares `ChainablePromiseElement` and
`ChainablePromiseArray` with no `then`, so the compiler sees the awaits as
no-ops — but at runtime the chainable is a proxy over a real promise
(`@wdio/utils` forwards `then`, `catch` and `finally` to the target), so they
resolved and nothing was broken. This is a type-versus-runtime divergence, not
a live bug, and the two `[…] probe` log lines that read `.length` off the
result were printing real counts, not `[object Promise]`.

They now use the form the rest of the lane already settled on:
`$(…)` unawaited for a single element, `await $$(…).getElements()` for a list.
`e2e-tauri/helpers.ts` states the second one's independent reason — reading
`.length` off a live chainable re-queries the DOM, so a count and a subsequent
index can disagree.

The ninth is `await expect(blockId).toBeTruthy()` in
`reserved-property-roundtrip.e2e.ts`: a genuinely dead await on a synchronous
matcher. The assertion always ran; only the `await` went.

**None of these four files were executed.** The `e2e-tauri` lane is `schedule`
plus `workflow_dispatch` only and needs the real Tauri binary under
tauri-driver, so no per-PR run exists to give a signal. They are compiled —
`tsconfig.wdio.json` is a referenced project, so `tsc -b` covers
`wdio.conf.ts` and `e2e-tauri/**` — and the change is the pattern the rest of
the lane already uses, but that is the extent of the evidence.

## The tenth await, and what it hid

`export-graph.test.ts` did `Promise.all(names.map((f) => zip.file(f)?.async(…)))`.
A missing entry folded to `undefined` and surfaced below as a content mismatch
— on the one test whose subject is "none of the three colliding pages was
silently dropped". It now throws naming the entry.

## Mock messages that did not change

Six sites are in `src/lib/tauri-mock/handlers/`, which is a hand-maintained
second implementation of the backend pinned by conformance fixtures, and three
of them build validation messages asserted verbatim by tests. All six are
byte-identical after the change: `blocks.ts` and `pages.ts` print the same
value from the number-typed local instead of the `unknown` one; `search.ts`
drops a `String()` that was wrapping a `u8` the guard above it had already
proved; `shared.ts` keeps its `String()` and adds only the cast, so a
non-string in a TEXT column still coerces exactly as it did. `history.ts`'s
`historicalCreatedAt` is typed to the ISO-8601 string its own comment
documents, which does change the comparison for a numeric argument — a shape
the wire contract does not have.

`conformance-query.ts`'s `attrValue` mirrors a Rust twin whose arms are string,
number and bool. Its fallback rendered anything else through `String()`, which
would collapse every distinct object onto one `[object Object]` token — an
expectation that cannot disagree. Objects now serialise; nothing in the mock's
rows can reach that arm today.

## Verification

The listing reports zero diagnostics for the three rules. The total across all
eight type-aware rules went 339 → 337 with no other rule's count rising, so
nothing was traded away. `npm run typecheck` is clean.

Every touched test file passes, plus `src/lib/tauri-mock/__tests__/` (43 files,
1105 tests) for the handler and conformance edits. The five touched guards were
run through their own self-tests, and `generate-vex.mjs` through both argument
branches.

The two production fixes were falsified against `cp` backups and restored with
`cmp`. Reverting `main.tsx` reddens the new boot-error test on the
`[object Object]` assertion itself, with `Something went wrong[object
Object]Reload` as the received text; reverting `logger.ts` reddens the new
cause test with `[object Object]` against the expected JSON.
