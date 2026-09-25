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
 * mirrors that debounce's own skip, so a draft the blur would classify (an
 * inline `key:: value` line, a block or a leading GFM task marker the edit
 * INTRODUCED — `classifyUnmountFlush`, #5160 D2) flushes NOTHING and exports
 * at its previously committed text; the same shapes a block was loaded with
 * are plain text and flush normally. The classifying branches strip, fold or
 * split the store's content, which would desync it from the still-mounted
 * editor's document, so they stay blur-only (`useBlockFlush`, `useEditorBlur`,
 * and `persistUnmount` in EditableBlock share that decision chain — see
 * `unmount-flush.ts`, #3278; the skips are `commitNow`'s, #4976). Accepted
 * trade, same class as #2675: such drafts are rarer at export time than the
 * "typed text, hit the export shortcut without blurring" race this closes.
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
