# Session 1589 — type the `invoke` stub seam, and the 39 lies it found (#4668)

## What

`mockInvokeCommands` is now typed against the **generated** command return
types. A handler must produce what that command actually resolves with, and an
unknown command name is a type error.

The map is derived from `src/lib/bindings.ts`, so it cannot drift from the Rust
surface: `commands.foo()` returns `typedError<T, AppError>(__TAURI_INVOKE(…))`,
so the value `invoke` resolves is the `T`, and a `CamelToSnake` template-literal
type converts the generated camelCase key to the snake_case IPC name.

## What it found on the day it landed

**39 errors across 14 files** — every one a stub asserting against a response
the backend never produces. Three worth naming:

- **A command that does not exist.** `record_page_visit` was stubbed in
  `strict-invoke.test.ts` *and* used as the example in `mockInvokeCommands`'
  own doc comment. It is in neither `bindings.ts` nor the Rust source. Nothing
  checked the name, so the test passed against a phantom.
- **An invented field name.** `EmbedContainer.test.tsx` returned
  `{ ...toRow(b), ops: [] }`. The envelope is `WithOps<T> = { op_refs } & T`;
  `ops` never existed.
- **A pre-migration shape frozen in a stub.** `DaySection.test.tsx` returned
  `deleted_at: '2026-01-01T00:00:00Z'`. `DeleteResponse.deleted_at` has been
  epoch-ms `number` since migration 0080.

The rest were missing required fields — `PageResponse.total_count`,
`BlockRow`'s four TODO/date columns, `GroupedBacklinkResponse.truncated` — and
`list_pages_with_metadata` stubs returning snake_case `BlockRow`s where the
command returns camelCase `PageWithMetadataRow` with four metadata columns.

## Typed row factories

The drift generator was every suite hand-building its own row literal with the
subset of fields that suite happened to read. `src/__tests__/helpers/rows.ts`
adds `makeBlockRow`, `makePageWithMetadataRow`, `makePageHeading`, `withOps`
and `asPageWithMetadataRow`, all keyed to the generated types — complete by
construction, and a field added to a Rust struct now fails typecheck in one
place instead of silently in every stub that omitted it.

## The ratchet

`hand-stub-ratchet.test.ts` counts **85** test files that hand the invoke mock a
literal. Equality, not `<=`, for the same reason as #4667's — a stale baseline
would hide a migration and let the count drift back up.

**The first version of this counted the wrong thing and could not ratchet.** It
counted files containing `vi.mocked(invoke)` — but `mockInvokeCommands` returns
an implementation you still have to install, so a fully migrated file KEEPS that
string. 25 of the 149 it counted already used the typed seam, including files
this very change migrated. Migrating a directory would not have moved the number
at all; the only way to lower it would have been to delete a test file, and a
count that falls only when tests are deleted is worse than no count.
Reviewer-caught.

It now counts what actually changes on migration: `.mockResolvedValue(…)` /
`.mockRejectedValue(…)` (and the `Once` variants) called on `vi.mocked(invoke)`
or a local alias bound to it — the literal nothing checks against the Rust
surface. Verified by simulating a migration: removing one file's literals takes
the count 87 → 86, which the old metric could not do.

It also counted **itself** at first, because the file names the patterns in its
own prose — the same self-match that makes a `pgrep -f` waiter never exit.
Excluded explicitly, with the reason in a comment.

Hand stubs are not banned. #4668 says error injection, malformed payloads and
rejection paths legitimately need an arbitrary response, and should end as a
documented minority rather than zero.

## Falsification

Against a copy, restored and `cmp`-verified. Both red:

- drop a required field (`total_count`) from a stub → `tsc` fails;
- stub a command name that does not exist → `tsc` fails.

Restored tree: 0 errors. Those two are the whole claim — that the seam rejects a
wrong SHAPE and a wrong NAME — so a vacuous version of this type would have
passed both silently.

## Not done here

`mockInvokeCommands` is typed; the 85 remaining hand-stub files are not
migrated. That is #4668's step 2 ("migrate by directory"), and the ratchet is
what makes it visible.

## Second review round: the metric reads prose

The reviewer's second pass found the match unanchored against an 80-character
window, so a `.mockResolvedValue(` on an unrelated mock could be attributed to
invoke, and called the file's self-exclusion dead. Anchoring it at the alias
(`/^\s*\.mock(?:Resolved|Rejected)Value(?:Once)?\s*\(/` against everything
after the alias) removes the window and the magic 80, and changed no count.

The self-exclusion was a different story. Deleting it and writing one sentence
explaining the deletion put the number back up 85 -> 86, because the sentence
spells the expression the metric greps for. The match is textual, so prose
counts: `src/__tests__/helpers/invoke.ts` (an error message) and
`src/test-setup.ts` (a comment) were both members no migration could ever
remove. Restricting the walk to `*.test.ts(x)` drops those two by a positive
rule about the population, taking the baseline 87 -> 85; the self-exclusion
stays for this file, and is now load-bearing rather than dead — removing it
reddens at 86.

## Third round: one canonical row factory, not two

The reviewer caught that this PR's own `src/__tests__/helpers/rows.ts` was a
SECOND canonical location: `src/__tests__/fixtures/index.ts` already had
`makePage`, a `BlockRow` factory keyed to the same generated type. The stated
payoff — "a field added to the Rust struct fails typecheck in one place" — was
therefore not what shipped; it would have failed in three, across two files.

`rows.ts` is gone and its factories live in `fixtures/index.ts` beside their
siblings, with `makePage` and `makeDailyPage` rebuilt on top of `makeBlockRow`
so the `BlockRow` field list is written once. `withOps`' `opRefs` parameter had
no caller and `makePageWithMetadataRow` had exactly one, in its own file — the
first is deleted, the second is module-local.

## Fourth round: three files were opting out, and the drift was still there

`stubInvoke` in `usePageDeleteAction.test.tsx`, `PageBrowser.crud.test.tsx` and
`PageEditor.test.tsx` was annotated `Readonly<Record<string, InvokeHandler>>`,
whose `unknown` return makes every handler passed through it unchecked — an
unknown command name and a wrong shape both compile. Retyping them to
`Readonly<TypedInvokeHandlers>` reddened 22 sites, all of them real:
`delete_block` answering `deleted_at: '2026-01-01T00:00:00Z'` when
`DeleteResponse.deleted_at` is epoch ms, every mutating stub missing its
`op_refs` envelope, and five `list_pages_with_metadata` stubs returning
snake_case `BlockRow`s. That is the same drift this PR's description names as
its headline find, sitting unfixed behind an opt-out — and invisible to the
ratchet too, since these files use `mockImplementation` rather than a stub
literal.

## The ratchet stops reading prose

The count was textual over raw source, so it saw comments and error messages.
That cost two hand-exclusions and a population fence, and the file still had to
exclude itself — with the exclusion's liveness depending on how its own doc
comment happened to be worded.

`scripts/lib/js-scanner.mjs`'s `stripComments` is the repo's sanctioned answer,
already used by two other vitest guards, and its header says not to hand-roll a
rival. Running the source through it first deletes the self-exclusion outright.
Proven both ways: adding a sentence to this file that names the stub expression
on purpose no longer moves the number, and a simulated migration still reddens
at 84 vs 85. The `*.test.ts(x)` fence stays, because `stripComments`
deliberately leaves strings alone and `helpers/invoke.ts` names the expression
inside an error message.
