/**
 * Binds the host tree's roving editor handle into the renderer an unlocked
 * embed consumes (#4550, phase 2).
 *
 * Separate module from `embed-row-editor-context.ts` on purpose: this one
 * imports `EditableBlock`, and the context module is imported by
 * `EmbeddedBlockTree`, which `EditableBlock` transitively renders. Keeping
 * the binding here is what makes the recursion unspellable rather than merely
 * absent — see that module's docblock.
 */

import { useMemo } from 'react'

import { EditableBlock } from '@/components/editor/EditableBlock'
import type {
  EmbedRowEditor,
  EmbedRowEditorProps,
} from '@/components/editor/embed/embed-row-editor-context'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'

/**
 * The value `BlockTree` publishes on `EmbedRowEditorContext`.
 *
 * Memoised on the handle alone, which `use-roving-editor` already keeps
 * reference-stable, so publishing it re-renders an embed only when the editor
 * actually goes live.
 */
export function useEmbedRowEditorValue(rovingEditor: RovingEditorHandle): EmbedRowEditor {
  return useMemo<EmbedRowEditor>(
    // `isFocused` is set here rather than passed: the only caller renders this
    // inside the branch that already established it (`editable && isFocused`),
    // so the prop could only ever be the literal `true`.
    () => (props: EmbedRowEditorProps) => (
      <EditableBlock {...props} isFocused rovingEditor={rovingEditor} />
    ),
    [rovingEditor],
  )
}
