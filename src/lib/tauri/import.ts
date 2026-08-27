/** The generated wire shape (#4414) — re-exported, not redeclared. */
export type { ImportResult } from '@/lib/bindings'

/**
 * `importMarkdown` is channel-based (`Channel<ImportProgressUpdate>` progress
 * plumbing), so it is part of the migration floor and its single definition
 * lives in `@/lib/ipc-helpers` (#4413) — see that module's doc comment.
 *
 * This is a re-export shim, NOT a second copy: the wrapper layer must not
 * hand-declare a duplicate of a function that already has a home, for exactly
 * the reason #4414 gives for the duplicated *types* — nothing detects when
 * one of two declarations drifts. `useImportRunner` still imports it from the
 * `@/lib/tauri` barrel; that import graduates to `@/lib/ipc-helpers` with the
 * rest of the file, and this line goes away with `src/lib/tauri/`.
 */
export { importMarkdown } from '@/lib/ipc-helpers'

// ---------------------------------------------------------------------------
// Bibliography import (#1454)
// ---------------------------------------------------------------------------

/**
 * Source format accepted by the `import_bibliography` command (#1454).
 * `'bibtex'` for `.bib` files, `'csl-json'` for CSL-JSON `.json` files.
 * Passing `null` as the wrapper's `format` asks the backend to auto-detect
 * from the content.
 */
export type BibliographyFormat = 'bibtex' | 'csl-json'

/** Result of a bibliography import (#1454) — the generated wire shape. */
export type { ImportBibliographyResult } from '@/lib/bindings'

// ---------------------------------------------------------------------------
// Draft autosave commands (F-17)
// ---------------------------------------------------------------------------
