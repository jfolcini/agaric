/**
 * TipTap extension stub for the in-page find feature (PEND-52).
 *
 * ## Why this is a thin stub
 *
 * The original PEND-52 design assumed a single ProseMirror document
 * spanning the whole page and prescribed a `Plugin` + `DecorationSet`
 * matcher driven by an `apply()` hook on `tr.docChanged` /
 * `tr.getMeta(findPluginKey)`. Agaric uses a **roving editor** pattern
 * (`src/editor/use-roving-editor.ts`): only the currently-focused
 * block holds a ProseMirror instance — every other block renders as
 * static DOM via `StaticBlock.tsx`. A `DecorationSet` therefore
 * covers at most ONE block, not the whole page.
 *
 * To honour the spirit of the constraint ("non-destructive
 * highlighting, no `dangerouslySetInnerHTML`") uniformly across both
 * static blocks AND the active editor, the find feature lives in
 * `src/lib/in-page-find/` (matcher + highlighter via `CSS.highlights`)
 * with a Zustand store + React component driving it. The TipTap
 * extension below is intentionally a no-op — it exists so future
 * editor-specific affordances (a `find.setQuery` command, e.g., or
 * a per-block decoration overlay for the focused block) have a slot
 * to land in without breaking the public extension surface.
 *
 * See `pending/PEND-52-in-page-find.md` and the implementation report
 * for the full rationale.
 */

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'

/** Plugin key reserved for future editor-internal find affordances. */
export const inPageFindPluginKey = new PluginKey('inPageFind')

export const InPageFindExtension = Extension.create({
  name: 'inPageFind',
  // No ProseMirror plugin attached yet — the cross-block matcher lives
  // outside the editor. Adding addProseMirrorPlugins here later (for
  // focused-block decorations, say) is the natural extension point.
})
