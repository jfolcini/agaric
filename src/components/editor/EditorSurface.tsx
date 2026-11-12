/**
 * EditorSurface — the TipTap-dependent editing UI for the focused block.
 *
 * This is the inner render of `EditableBlock`'s editor `<section>`: the
 * selection bubble menu, the `EditorContent` portal that hosts the roving
 * ProseMirror view, and the drag-drop hint. The formatting toolbar it hands to
 * the view (`useViewToolbar`), which shows one for the whole view (#6562). It is imported ONLY
 * by the lazily-loaded editor-runtime chunk (`RovingEditorHost`), so none of its
 * `@tiptap/*` imports reach the cold-start path (#2939).
 *
 * `EditableBlock` renders this via `EditorSurfaceContext`; it never imports this
 * module directly.
 */

import { EditorContent } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { useBlockActions } from '@/components/block-tree/use-block-actions'
import { ImageBubbleMenu } from '@/components/editor-toolbar/ImageBubbleMenu'
import { SelectionBubbleMenu } from '@/components/editor-toolbar/SelectionBubbleMenu'
import type { EditorSurfaceProps } from '@/components/editor/editor-surface-context'
import { useListMarker } from '@/components/editor/ListMarkerContext'
import { FormattingToolbar } from '@/components/FormattingToolbar'
import { useViewToolbar } from '@/components/FormattingToolbar/view-toolbar'

export function EditorSurface({
  editor,
  blockId,
  currentPriority,
  isDragOver,
  onToolbarBlur,
}: EditorSurfaceProps): React.ReactElement {
  const { t } = useTranslation()
  const { onIndent, onDedent } = useBlockActions()
  // The context types `editor` loosely (`unknown`) to stay TipTap-free; here it
  // is always the live TipTap `Editor` for the focused block.
  const ed = editor as Editor
  // The bar renders outside this tree, where no `ListMarkerProvider` gives the block's list style.
  const listStyle = useListMarker(blockId).style
  useViewToolbar(
    <FormattingToolbar
      editor={ed}
      blockId={blockId}
      currentPriority={currentPriority}
      listStyle={listStyle}
      className="mx-auto h-full max-w-reading rounded-none border-b-0 bg-transparent px-0"
      indent={
        onIndent && onDedent
          ? { onIndent: () => onIndent(blockId), onOutdent: () => onDedent(blockId) }
          : undefined
      }
    />,
    onToolbarBlur,
  )
  return (
    <>
      <SelectionBubbleMenu editor={ed} blockId={blockId} />
      <ImageBubbleMenu editor={ed} />
      <EditorContent editor={ed} />
      {isDragOver && (
        <p className="px-3 pb-1 text-xs text-muted-foreground select-none" aria-live="polite">
          {t('block.attachDropZoneCaption')}
        </p>
      )}
    </>
  )
}
