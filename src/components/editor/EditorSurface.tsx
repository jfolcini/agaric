/**
 * EditorSurface — the TipTap-dependent editing UI for the focused block.
 *
 * This is the inner render of `EditableBlock`'s editor `<section>`: the
 * formatting toolbar, the selection bubble menu, the `EditorContent` portal that
 * hosts the roving ProseMirror view, and the drag-drop hint. It is imported ONLY
 * by the lazily-loaded editor-runtime chunk (`RovingEditorHost`), so none of its
 * `@tiptap/*` imports reach the cold-start path (#2939).
 *
 * `EditableBlock` renders this via `EditorSurfaceContext`; it never imports this
 * module directly. Behaviour is byte-for-byte the same as the previous inline
 * render — the toolbars and `EditorContent` receive the identical props.
 */

import { EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { SelectionBubbleMenu } from '@/components/editor-toolbar/SelectionBubbleMenu'
import type { EditorSurfaceProps } from '@/components/editor/editor-surface-context'
import { FormattingToolbar } from '@/components/FormattingToolbar'

export function EditorSurface({
  editor,
  blockId,
  currentPriority,
  isDragOver,
}: EditorSurfaceProps): React.ReactElement {
  const { t } = useTranslation()
  // The context types `editor` loosely (`unknown`) to stay TipTap-free; here it
  // is always the live TipTap `Editor` for the focused block.
  const ed = editor as Editor
  return (
    <>
      <FormattingToolbar editor={ed} blockId={blockId} currentPriority={currentPriority} />
      <SelectionBubbleMenu editor={ed} blockId={blockId} />
      <EditorContent editor={ed} />
      {isDragOver && (
        <p className="px-3 pb-1 text-xs text-primary/70 select-none" aria-live="polite">
          {t('block.attachDropZoneCaption')}
        </p>
      )}
    </>
  )
}
