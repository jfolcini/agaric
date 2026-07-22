/**
 * Active-draft flush registry (#2969).
 *
 * The editor commits typed content on a short idle DEBOUNCE (see
 * `useDebouncedContentCommit`, `CONTENT_COMMIT_DEBOUNCE_MS`), in addition to
 * blur. If the user exports right after typing — most notably via the
 * `Ctrl+Shift+E` keyboard shortcut, which never blurs the editor — the
 * newest keystrokes can still be sitting in the debounce window, uncommitted
 * to the block store/backend. Reading a page's markdown at that moment (via
 * `exportPageMarkdown` / `exportGraphAsZip`) would silently miss them.
 *
 * The roving TipTap editor is a single, page-scoped instance (see
 * `use-roving-editor.ts`: "exactly ONE instance at all times"), owned deep
 * inside whichever `BlockTree` is mounted. Export entry points —
 * `PageHeader`'s copy-to-clipboard export and the "Export All" ZIP flow in
 * `export-graph.ts` — live OUTSIDE that component subtree, with no ref or
 * context path down to the focused block's editor handle. This module is the
 * minimal bridge: `useDebouncedContentCommit` registers a "flush this
 * block's pending commit right now, and await it" callback here for as long
 * as its block is focused; export call sites await `flushActiveDraft()`
 * before reading any content.
 *
 * Scope note (flagged, not silently decided): this flushes the CONTENT
 * commit path only — the same one the idle debounce uses. It intentionally
 * mirrors that debounce's own skip for a block currently containing an
 * unparsed inline `key:: value` property line (deferred to blur's
 * property-aware flush — see `useDebouncedContentCommit`'s doc comment) and
 * does not replicate the checkbox/multi-paragraph-split handling that only
 * runs on blur (`useBlockFlush` / `useEditorBlur`). Those are both rarer at
 * export time than the "typed text, hit the export shortcut without
 * blurring" race this closes, and a full cross-component flush-all covering
 * every save path would be a much larger refactor (there is no shared
 * store/context between `BlockTree` and `PageHeader` today).
 */

interface Registration {
  blockId: string
  flush: () => Promise<void>
}

let registration: Registration | null = null

/**
 * Register the currently-focused block's "flush its pending debounced
 * content commit now" callback. Returns an unregister function that clears
 * the registration ONLY if it still belongs to `blockId` — guards against a
 * stale unregister (e.g. from an unrelated block's effect cleanup running
 * out of order) clobbering a newer registration.
 */
export function registerActiveDraftFlush(blockId: string, flush: () => Promise<void>): () => void {
  registration = { blockId, flush }
  return () => {
    if (registration?.blockId === blockId) registration = null
  }
}

/**
 * Flush the currently-focused block's pending debounced content commit, if
 * any is registered. Resolves immediately (no-op) when no block is focused.
 * Export entry points MUST `await` this before reading a page's markdown so
 * a just-typed, still-debouncing edit is durably committed first (#2969).
 */
export async function flushActiveDraft(): Promise<void> {
  if (registration) await registration.flush()
}
