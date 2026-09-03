# Session 1485 — #4411: the `links` domain graduates off the `@/lib/tauri` wrapper layer

## What this set out to do

#4411 is the mechanical half of the `tauri.ts` retirement: 27 PURE wrappers (body is exactly
`unwrap(await commands.X(args))`) and 13 SCOPE wrappers (which additionally build a `SpaceScope`).
The issue pins the slicing rule — pick a domain module whose **entire** consumer set graduates in
one step, because a half-migrated domain leaves the wrapper alive and the slice achieves nothing.

## Which domain, and why not the smaller two

Measured against `origin/main` at `9c7a15269`: eleven files under `src/lib/tauri/`, 52 exports.
Two modules are smaller than `links.ts` and neither graduates:

- **`logging.ts` (1 export).** `logFrontend` is PURE, but the module's real payload is the
  import-time side effect `setLogBackendSink(logFrontend)` — the seam that decouples `logger.ts`
  from the IPC layer (#761), reached only because the barrel does `export * from './logging'`.
  Retiring the wrapper means relocating that registration to an entry point, which changes *when*
  the sink is installed. That is a behavioural move with an ordering hazard the lazy-sink note in
  `logger-transport.ts` already warns about, not a mechanical one. It belongs with the floor
  wrappers that "get their own home", not in this sweep.
- **`attachments.ts` (1 export).** `addAttachmentWithBytes` reshapes a params object into
  positional args and converts `Uint8Array` → `number[]`. That is #4412's DEFAULTS/RESHAPE class,
  named explicitly in the issue's out-of-scope list.

So the slice is **`links.ts`**: five exports, four of them in this issue's classes, and their four
production consumers import *nothing else* from `@/lib/tauri` — so the whole set graduates and the
ratchet moves.

## What shipped

Retired, with call sites repointed at `commands.*`:

- `fetchLinkMetadata`, `getLinkMetadata` (PURE) — `src/hooks/useLinkMetadata.ts`,
  `src/hooks/useLinkPreview.ts`
- `listBacklinksGrouped`, `listUnlinkedReferences` (SCOPE) — `src/hooks/useBacklinkGroups.ts`,
  `src/hooks/useUnlinkedReferences.ts`

The two SCOPE wrappers now build their scope with `toSpaceScope` from the tauri-free
`@/lib/space-scope` (the `useBatchCounts.ts` precedent), and `useUnlinkedReferences` takes
`paginationLimit` from `@/lib/safe-limit` rather than through the barrel — otherwise the file would
still import `@/lib/tauri` and the ratchet would not move.

The hand-declared `LinkMetadata` interface went with them. `@/lib/bindings` generates the same
shape from Rust, so the duplicate could only drift; the three test files that imported the type now
take the generated one. Same reasoning as the `AttachmentRow` de-duplication in `attachments.ts`.

`listPageLinks` stays. It is DEFAULTS/RESHAPE — it normalises a legacy positional `spaceId` string
into an object and collapses an empty `tagIds` array to `null` — so it is #4412's, and mislabelling
it PURE is exactly the hazard that issue exists for. Its one consumer, `GraphView.helpers.ts`,
therefore stays in the baseline.

**Ratchet: `scripts/tauri-import-baseline.json` 50 → 46.** The four hook files are gone from it;
`node scripts/check-tauri-import-baseline.mjs` reports no new importers and no stale entries.

## What the tests showed

This is a pure refactor, so the evidence is the *existing* tests passing unchanged rather than a new
one shown red. Two things make that evidence real rather than nominal:

- `useBacklinkGroups.test.ts` and `useUnlinkedReferences.test.ts` drive the strict `invoke` mock by
  **command name** (`list_backlinks_grouped`, `list_unlinked_references`), not by wrapper identity.
  They passed with zero edits, which is a wire-level assertion that the positional argument order,
  the `?? null` coalescing and the scope encoding all survived the move. Same for
  `useLinkMetadata.test.tsx`, which asserts `invoke('fetch_link_metadata', { url })`.
- The component tests did *not* pass unchanged, and the way they failed is worth recording. Seven
  tests in `UnlinkedReferences.test.tsx` / `.countIntegrity.test.tsx` went red because their mock
  implementations branched on `args.cursor` / `args.limit` — properties of the wrapper's params
  object, which after the migration is a bare `pageId` string. `tsc` was silent: `vi.fn()` types its
  parameters as `any`. The suite caught what the compiler could not, which is the argument for
  keeping those assertions rather than loosening them.

Those assertions were rewritten to the positional call, not deleted — a mock that no longer pins the
argument order would have gone green while pinning nothing.

Both rewritten shapes were falsified against a copy, then restored and `cmp`'d:
`filters.length > 0 ? filters : null` → `null` in `useUnlinkedReferences` reddens
`UnlinkedReferences.test.tsx` (1 of 50), and `pageParam ?? null` → `null` in `useBacklinkGroups`
reddens `useBacklinkGroups.test.ts` (1 of 5). Neither mutation is visible to `tsc` — both arguments
are legitimately nullable — so without those assertions the argument order would be unpinned.

Deleted from `src/lib/__tests__/tauri.test.ts`: the four wrapper `describe` blocks and the two
entries in the cross-cutting snake_case list, each replaced by a one-line pointer to where the
coverage now lives.

**Verified** (frontend only; no `.rs` touched, no cargo lock taken):

- `npm run typecheck` — clean.
- `npx vitest run src/lib src/stores src/editor src/__tests__` — 291 files, 7,556 passed, 1 expected
  fail.
- `npx vitest run src/components src/hooks` — green.
- Targeted re-run of the affected files (`src/components/backlinks`, `src/components/editor-toolbar`,
  `src/hooks/__tests__`, `src/editor/__tests__/external-link.test.ts`,
  `src/lib/__tests__/tauri.test.ts`, `src/components/__tests__/LinkPreviewTooltip.test.tsx`) —
  148 files, 2,388 passed.
- `node scripts/check-tauri-import-baseline.mjs` — 46 importers, no new, no stale.

One flake worth naming so the next reader does not chase it: `src/components/__tests__/App.test.tsx`
failed at file level in one large parallel chunk and passed (130 tests) on its own immediately
after. It touches nothing in this diff.

## What is left on #4411

Not closed. `blocks`, `history`, `pages`, `properties`, `queries` and `search` still carry
PURE/SCOPE wrappers, plus the two exclusions the 2026-08-27 inventory comment justifies by code
(`undoPageOp`, whose `.not.toHaveBeenCalled()` guards in `stores/__tests__/undo.test.ts` must be
rewritten first, and `createBlock`, which carries the H-3a invariant and the #2849 client-ULID
contract). `pages.ts` is the next clean one — all seven of its exports are in scope, so the module
can be deleted outright — but its thirteen production consumers make it a bigger slice than this.
