import { Channel } from '@tauri-apps/api/core'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { ImportProgressUpdate, VaultFile } from '@/lib/bindings'

export interface ImportResult {
  page_title: string
  blocks_created: number
  properties_set: number
  warnings: string[]
}

/**
 * Import a Logseq/Markdown file. Creates a page from the filename and
 * blocks from content.
 *
 * `spaceId` — required. The created page is stamped
 * with `space = ?spaceId` inside the same backend transaction as the
 * `CreateBlock` op, so an imported page can never exist without its
 * space property. Callers must pass the active space's ULID; the
 * import button must stay disabled while the space store is not
 * bootstrapped (no active space) so this never receives an empty
 * string.
 *
 * `onProgress` (#128) — optional. When
 * supplied, the backend streams per-block progress over a
 * `Channel<ImportProgressUpdate>`: one `started` event, one `progress`
 * per block, then one `complete` after the import transaction commits.
 * A failed import emits `started` (+ any `progress`) but no `complete`,
 * so a consumer that never sees `complete` should treat it as failed.
 * The channel is always created (mirroring `startSync`) even when no
 * callback is passed; events are simply discarded.
 */
export async function importMarkdown(
  content: string,
  filename: string | undefined,
  spaceId: string,
  onProgress?: (update: ImportProgressUpdate) => void,
  vaultFiles?: VaultFile[] | null,
): Promise<ImportResult> {
  const channel = new Channel<ImportProgressUpdate>()
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri `Channel` is an IPC primitive, not a DOM EventTarget; it only exposes an `onmessage` setter (no `addEventListener`)
  if (onProgress) channel.onmessage = onProgress
  // #1925 — `vaultFiles` carries the referenced attachment bytes the backend
  // ingests and rewrites to `attachment:<id>`. Only the `webkitdirectory`
  // vault picker can supply siblings (see DataSettingsTab); a single-file
  // import has no siblings and omits it. Defaults to `null` ⇒ exactly the
  // pre-#1925 behaviour for every caller that does not pass it.
  return unwrap(
    await commands.importMarkdown(content, filename ?? null, spaceId, vaultFiles ?? null, channel),
  )
}

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

/**
 * Import a BibTeX (`.bib`) or CSL-JSON (`.json`) bibliography (#1454).
 * Creates one reference page per entry in the target space.
 *
 * `format` — `'bibtex' | 'csl-json'`, or `null` for backend content
 * auto-detection. The Settings → Data importer always infers it from the
 * picked file's extension, so `null` is only for callers with no filename.
 *
 * `spaceId` — required; like `importMarkdown`, the backend rejects empty /
 * unknown ULIDs with `AppError::Validation`, so the UI affordance must stay
 * disabled until the space store is bootstrapped.
 */
export async function importBibliography(
  content: string,
  format: BibliographyFormat | null,
  spaceId: string,
): Promise<import('@/lib/bindings').ImportBibliographyResult> {
  return unwrap(await commands.importBibliography(content, format, spaceId))
}

// ---------------------------------------------------------------------------
// Draft autosave commands (F-17)
// ---------------------------------------------------------------------------
