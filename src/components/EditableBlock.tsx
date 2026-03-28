/**
 * EditableBlock — wrapper that switches between static div and TipTap editor.
 *
 * When focused: mounts the roving TipTap instance.
 * When not focused: renders StaticBlock (plain div).
 * On blur: serializes, compares, flushes if dirty, auto-splits on \n.
 */

import { EditorContent } from '@tiptap/react'
import type React from 'react'
import { useCallback } from 'react'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { useBlockStore } from '../stores/blocks'
import { StaticBlock } from './StaticBlock'

interface EditableBlockProps {
  blockId: string
  content: string
  isFocused: boolean
  rovingEditor: RovingEditorHandle
}

export function EditableBlock({
  blockId,
  content,
  isFocused,
  rovingEditor,
}: EditableBlockProps): React.ReactElement {
  const { setFocused, edit, splitBlock } = useBlockStore()

  const handleFocus = useCallback(
    (id: string) => {
      // Unmount from previous block if any
      if (rovingEditor.activeBlockId && rovingEditor.activeBlockId !== id) {
        const changed = rovingEditor.unmount()
        if (changed !== null) {
          const prevId = rovingEditor.activeBlockId
          // Auto-split if content contains newlines
          if (changed.includes('\n')) {
            splitBlock(prevId, changed)
          } else {
            edit(prevId, changed)
          }
        }
      }
      // Mount into the new block
      setFocused(id)
      rovingEditor.mount(id, content)
    },
    [rovingEditor, content, setFocused, edit, splitBlock],
  )

  const handleBlur = useCallback(() => {
    if (!rovingEditor.activeBlockId) return
    const changed = rovingEditor.unmount()
    if (changed !== null) {
      if (changed.includes('\n')) {
        splitBlock(blockId, changed)
      } else {
        edit(blockId, changed)
      }
    }
    setFocused(null)
  }, [rovingEditor, blockId, edit, splitBlock, setFocused])

  if (!isFocused) {
    return <StaticBlock blockId={blockId} content={content} onFocus={handleFocus} />
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper div catches blur from TipTap contenteditable
    <div className="block-editor" data-block-id={blockId} onBlur={handleBlur}>
      <EditorContent editor={rovingEditor.editor} />
    </div>
  )
}
