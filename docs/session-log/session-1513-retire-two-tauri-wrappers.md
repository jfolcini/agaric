# Session 1513 — retire the attachments and links tauri wrappers

Issue #4411, one slice. `src/lib/bindings.ts` is generated from the Rust command
surface; the legacy `@/lib/tauri` wrappers are frozen by the
`check-tauri-import-baseline.mjs` ratchet and only shrink. Each surviving wrapper is a
second declaration of a type the generator already owns, which is where drift hides.

The slice took the four smallest wrapper modules, on the issue's rule that a module only
graduates when its *entire* consumer set does — a half-migrated module leaves the wrapper
alive and achieves nothing. Two graduated, two did not.

## Retired

`attachments.ts` (`addAttachmentWithBytes`) was PURE: `unwrap(await commands.X(...))`
around an `Array.from(bytes)` that is unavoidable wire-shape marshalling, and that the
already-migrated call sites (`useSlashCommandProperty.ts`, `PdfViewerDialog.tsx`) do
inline anyway.

`links.ts` (`listPageLinks`) was SCOPE — its only added logic was `toSpaceScope`, which
phase 8 extracted into the tauri-free `@/lib/space-scope`. Its "legacy bare-string"
overload and its empty-array-to-null defaulting were dead: the sole production caller,
`GraphView.helpers.ts`, already computed `tagIds: string[] | null` itself.

Both modules are deleted, along with their `export *` lines in `src/lib/tauri.ts`.

## Not retired, and why

`search.ts` (`searchBlocks`, `searchBlocksPartitioned`) is DEFAULTS/RESHAPE — it supplies
`?? []` / `?? null` / `?? false` defaults and marshals `DateFilterValueInput` into the
wire `DateFilter`. That is the #3127 hazard the issue splits out explicitly, not
mechanical work.

`logging.ts` (`logFrontend`) is PURE by body shape but has no ordinary call site to
graduate to. Its only consumer is the import-time `setLogBackendSink(logFrontend)`
registration that keeps `logger.ts` decoupled from the Tauri bindings, breaking a prior
import cycle. Relocating that wiring is an architecture decision, and the sibling pattern
in `observability/transport.ts` deliberately keeps such registration out of the leaf
transport module.

`import.ts` and `_shared.ts` export nothing directly but are not dead: `import.ts` still
serves `vault-import.ts`, `useImportRunner.ts` and `wrapper-type-drift.test.ts`, and
`_shared.ts` still serves five wrapper modules. Both untouched.

## The AttachmentRow guard

`wrapper-type-drift.test.ts` carried a compile-time `Expect<IsEqual<…>>` pinning the
wrapper's `AttachmentRow` against the generated one — that type is the file's own worked
example of silent drift (it was missing `content_hash?: string | null`). With the wrapper
gone there is no second declaration left to diverge, so the entry was removed the same
way `SyncSessionInfo`'s was when `sync.ts` retired. The guard still covers `OpRef`,
`UndoResult`, `ImportResult` and `PropertyRow`.

## Verified

`npm run typecheck` clean. `npx vitest run` over the touched and adjacent files: 10 files,
426 tests, all passing. `node scripts/check-tauri-import-baseline.mjs`: **46 → 45**
baseline importers, no new importers, no stale entries.

One caution recorded for the next session: a `git push` in flight holds the working tree
in a prek stash, so a verification run started during it silently tests the *unmodified*
tree. A typecheck run that way looked clean and proved nothing; the numbers above are
from a re-run after the push released the tree.
