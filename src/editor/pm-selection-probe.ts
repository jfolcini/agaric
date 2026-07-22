/**
 * pm-selection-probe — a tiny TipTap-free registry for ProseMirror's
 * `Selection.atStart` / `Selection.atEnd` boundary probes (#2939).
 *
 * `useBlockKeyboard` (called directly by `BlockTree`, on the cold-start path)
 * needs `Selection.atStart(doc).from` / `Selection.atEnd(doc).to` to detect
 * caret-at-doc-boundary in structural blocks (blockquote/list/callout). Importing
 * `Selection` from `@tiptap/pm/state` there would drag prosemirror-state onto the
 * startup bundle, defeating the lazy editor mount. Instead the editor-runtime
 * chunk — which is only loaded when a block is actually edited — registers the
 * real probe here on load.
 *
 * A live ProseMirror doc can only exist once the editor runtime has loaded (the
 * runtime is what constructs the `Editor`), so by the time any real keydown
 * reaches these probes the registration has already run. Before then,
 * `useBlockKeyboard` falls back to its legacy numeric checks (only reachable with
 * test doubles / no real doc).
 */

export interface SelectionProbe {
  /** `Selection.atStart(doc).from` for a real ProseMirror doc. */
  atStartFrom: (doc: unknown) => number
  /** `Selection.atEnd(doc).to` for a real ProseMirror doc. */
  atEndTo: (doc: unknown) => number
}

let probe: SelectionProbe | null = null

/** Registered by the editor-runtime chunk on load (or by tests using real docs). */
export function setSelectionProbe(next: SelectionProbe | null): void {
  probe = next
}

/** Null until the editor runtime has loaded. */
export function getSelectionProbe(): SelectionProbe | null {
  return probe
}
