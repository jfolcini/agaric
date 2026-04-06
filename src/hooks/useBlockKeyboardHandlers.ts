import type { MutableRefObject } from 'react'
import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { parse } from '../editor/markdown-serializer'
import { pmEndOfFirstBlock } from '../editor/types'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { announce } from '../lib/announcer'
import type { FlatBlock } from '../lib/tree-utils'

export interface UseBlockKeyboardHandlersParams {
  focusedBlockId: string | null
  collapsedVisible: FlatBlock[]
  rovingEditor: Pick<RovingEditorHandle, 'editor' | 'mount' | 'unmount' | 'getMarkdown'>
  setFocused: (id: string | null) => void
  handleFlush: () => string | null
  remove: (id: string) => Promise<void>
  edit: (id: string, content: string) => Promise<void>
  indent: (id: string) => Promise<void>
  dedent: (id: string) => Promise<void>
  moveUp: (id: string) => Promise<void>
  moveDown: (id: string) => Promise<void>
  createBelow: (afterBlockId: string) => Promise<string | null>
  justCreatedBlockIds: MutableRefObject<Set<string>>
  // biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
  t: (...args: any[]) => any
}

export interface UseBlockKeyboardHandlersReturn {
  handleFocusPrev: () => void
  handleFocusNext: () => void
  handleDeleteBlock: () => void
  handleIndent: () => void
  handleDedent: () => void
  handleMoveUp: () => void
  handleMoveDown: () => void
  handleMoveUpById: (id: string) => void
  handleMoveDownById: (id: string) => void
  handleMergeWithPrev: () => Promise<void>
  handleMergeById: (blockId: string) => Promise<void>
  handleEnterSave: () => Promise<void>
  handleEscapeCancel: () => void
}

export function useBlockKeyboardHandlers({
  focusedBlockId,
  collapsedVisible,
  rovingEditor,
  setFocused,
  handleFlush,
  remove,
  edit,
  indent,
  dedent,
  moveUp,
  moveDown,
  createBelow,
  justCreatedBlockIds,
  t,
}: UseBlockKeyboardHandlersParams): UseBlockKeyboardHandlersReturn {
  const handleFocusPrev = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
      const preview = prevBlock.content?.slice(0, 50) ?? ''
      announce(`Editing block: ${preview || 'empty block'}`)
    }
  }, [collapsedVisible, focusedBlockId, setFocused, rovingEditor])

  const handleFocusNext = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0 && idx < collapsedVisible.length - 1) {
      const nextBlock = collapsedVisible[idx + 1] as (typeof collapsedVisible)[number]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
      const preview = nextBlock.content?.slice(0, 50) ?? ''
      announce(`Editing block: ${preview || 'empty block'}`)
    }
  }, [collapsedVisible, focusedBlockId, setFocused, rovingEditor])

  const handleDeleteBlock = useCallback(() => {
    if (!focusedBlockId) return
    if (deleteInProgress.current) return
    if (collapsedVisible.length <= 1) {
      toast.error(t('blockTree.cannotDeleteLastBlock'))
      return
    }
    deleteInProgress.current = true
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    rovingEditor.unmount()
    remove(focusedBlockId).finally(() => {
      deleteInProgress.current = false
    })
    announce('Block deleted')
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
      setFocused(prevBlock.id)
      rovingEditor.mount(prevBlock.id, prevBlock.content ?? '')
    } else if (idx + 1 < collapsedVisible.length) {
      const nextBlock = collapsedVisible[idx + 1] as (typeof collapsedVisible)[number]
      setFocused(nextBlock.id)
      rovingEditor.mount(nextBlock.id, nextBlock.content ?? '')
    } else {
      setFocused(null)
    }
  }, [focusedBlockId, collapsedVisible, rovingEditor, remove, setFocused, t])

  const handleIndent = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    indent(focusedBlockId)
    announce('Block indented')
  }, [focusedBlockId, handleFlush, indent])

  const handleDedent = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    dedent(focusedBlockId)
    announce('Block outdented')
  }, [focusedBlockId, handleFlush, dedent])

  const handleMoveUp = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    moveUp(focusedBlockId)
    announce('Block moved up')
  }, [focusedBlockId, handleFlush, moveUp])

  const handleMoveDown = useCallback(() => {
    if (!focusedBlockId) return
    handleFlush()
    moveDown(focusedBlockId)
    announce('Block moved down')
  }, [focusedBlockId, handleFlush, moveDown])

  const handleMoveUpById = useCallback(
    (id: string) => {
      handleFlush()
      moveUp(id)
    },
    [handleFlush, moveUp],
  )

  const handleMoveDownById = useCallback(
    (id: string) => {
      handleFlush()
      moveDown(id)
    },
    [handleFlush, moveDown],
  )

  const handleMergeWithPrev = useCallback(async () => {
    if (!focusedBlockId) return
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx <= 0) return

    const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]

    const currentContent = rovingEditor.unmount() ?? collapsedVisible[idx]?.content ?? ''
    const prevContent = prevBlock.content ?? ''

    const mergedContent = prevContent + currentContent
    const prevDoc = parse(prevContent)
    const joinPoint = pmEndOfFirstBlock(prevDoc)

    try {
      await edit(prevBlock.id, mergedContent)
      await remove(focusedBlockId)
    } catch {
      rovingEditor.mount(focusedBlockId, currentContent)
      toast.error(t('blockTree.mergeBlocksFailed'))
      return
    }

    setFocused(prevBlock.id)
    rovingEditor.mount(prevBlock.id, mergedContent)

    setTimeout(() => {
      if (rovingEditor.editor) {
        const pmPos = Math.min(joinPoint, rovingEditor.editor.state.doc.content.size - 1)
        rovingEditor.editor.commands.setTextSelection(pmPos)
      }
    }, 0)
  }, [focusedBlockId, collapsedVisible, rovingEditor, edit, remove, setFocused, t])

  const handleMergeById = useCallback(
    async (blockId: string) => {
      const idx = collapsedVisible.findIndex((b) => b.id === blockId)
      if (idx <= 0) return

      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]

      const editorContent = focusedBlockId === blockId ? rovingEditor.unmount() : null
      const currentContent = editorContent ?? collapsedVisible[idx]?.content ?? ''
      const prevContent = prevBlock.content ?? ''

      const mergedContent = prevContent + currentContent

      try {
        await edit(prevBlock.id, mergedContent)
        await remove(blockId)
      } catch {
        if (editorContent !== null) {
          rovingEditor.mount(blockId, currentContent)
        }
        toast.error(t('blockTree.mergeBlocksFailed'))
        return
      }

      setFocused(prevBlock.id)
    },
    [collapsedVisible, focusedBlockId, rovingEditor, edit, remove, setFocused, t],
  )

  // Re-entrancy guard: prevents rapid Backspace presses from duplicating deletes.
  const deleteInProgress = useRef(false)

  // Re-entrancy guard: prevents rapid Enter presses from creating duplicate blocks.
  const enterSaveInProgress = useRef(false)

  const handleEnterSave = useCallback(async () => {
    if (!focusedBlockId || enterSaveInProgress.current) return
    enterSaveInProgress.current = true
    try {
      // Capture content before flush so we can re-mount on failure
      const savedContent = rovingEditor.getMarkdown?.() ?? ''
      handleFlush()
      const newBlockId = await createBelow(focusedBlockId)
      if (newBlockId) {
        justCreatedBlockIds.current.add(newBlockId)
        setFocused(newBlockId)
      } else {
        // createBelow returned null (e.g. backend error) — re-mount editor
        // so the user isn't stuck with an unmounted block.
        rovingEditor.mount(focusedBlockId, savedContent)
      }
    } finally {
      enterSaveInProgress.current = false
    }
  }, [focusedBlockId, handleFlush, createBelow, setFocused, justCreatedBlockIds, rovingEditor])

  const handleEscapeCancel = useCallback(() => {
    if (!focusedBlockId) return
    const changed = rovingEditor.unmount()
    if (changed !== null) {
      toast('Changes discarded', { duration: 2000 })
    }
    // If the block was just created and the user made no edits (changed === null),
    // delete the empty block instead of leaving it around.
    if (justCreatedBlockIds.current.has(focusedBlockId) && changed === null) {
      justCreatedBlockIds.current.delete(focusedBlockId)
      remove(focusedBlockId).catch(() => {
        // Best-effort cleanup — block reappears on next reload if this fails
      })
    }
    setFocused(null)
  }, [focusedBlockId, rovingEditor, setFocused, justCreatedBlockIds, remove])

  return {
    handleFocusPrev,
    handleFocusNext,
    handleDeleteBlock,
    handleIndent,
    handleDedent,
    handleMoveUp,
    handleMoveDown,
    handleMoveUpById,
    handleMoveDownById,
    handleMergeWithPrev,
    handleMergeById,
    handleEnterSave,
    handleEscapeCancel,
  }
}
