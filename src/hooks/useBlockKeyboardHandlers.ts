import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
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
  /** Discard any persisted draft for the given block (called on Escape). */
  discardDraft: (blockId: string) => void
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
  discardDraft,
  t,
}: UseBlockKeyboardHandlersParams): UseBlockKeyboardHandlersReturn {
  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  // Tracks the post-merge setTextSelection setTimeout so we can cancel it on
  // unmount. Without this, a late-firing callback could call
  // `setTextSelection` on a stale editor instance and move the user's cursor
  // on the NEXT mounted block (#MAINT-15).
  const pendingMergeSelectionRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (pendingMergeSelectionRef.current !== null) {
        window.clearTimeout(pendingMergeSelectionRef.current)
        pendingMergeSelectionRef.current = null
      }
    },
    [],
  )

  const handleFocusPrev = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, prevBlock.content ?? '')
      const preview = prevBlock.content?.slice(0, 50) ?? ''
      announce(t('announce.editingBlock', { preview: preview || t('announce.emptyBlock') }))
    }
  }, [collapsedVisible, focusedBlockId, setFocused, t])

  const handleFocusNext = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0 && idx < collapsedVisible.length - 1) {
      const nextBlock = collapsedVisible[idx + 1] as (typeof collapsedVisible)[number]
      setFocused(nextBlock.id)
      rovingEditorRef.current.mount(nextBlock.id, nextBlock.content ?? '')
      const preview = nextBlock.content?.slice(0, 50) ?? ''
      announce(t('announce.editingBlock', { preview: preview || t('announce.emptyBlock') }))
    }
  }, [collapsedVisible, focusedBlockId, setFocused, t])

  const handleDeleteBlock = useCallback(() => {
    if (!focusedBlockId) return
    if (deleteInProgress.current) return
    if (collapsedVisible.length <= 1) {
      toast.error(t('blockTree.cannotDeleteLastBlock'))
      return
    }
    deleteInProgress.current = true
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    rovingEditorRef.current.unmount()
    remove(focusedBlockId).finally(() => {
      deleteInProgress.current = false
    })
    announce(t('announce.blockDeleted'))
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, prevBlock.content ?? '')
    } else if (idx + 1 < collapsedVisible.length) {
      const nextBlock = collapsedVisible[idx + 1] as (typeof collapsedVisible)[number]
      setFocused(nextBlock.id)
      rovingEditorRef.current.mount(nextBlock.id, nextBlock.content ?? '')
    } else {
      setFocused(null)
    }
  }, [focusedBlockId, collapsedVisible, remove, setFocused, t])

  const handleIndent = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    indent(focusedBlockId)
    rovingEditorRef.current.mount(focusedBlockId, content)
    announce(t('announce.blockIndented'))
  }, [focusedBlockId, handleFlush, indent, t])

  const handleDedent = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    dedent(focusedBlockId)
    rovingEditorRef.current.mount(focusedBlockId, content)
    announce(t('announce.blockDedented'))
  }, [focusedBlockId, handleFlush, dedent, t])

  const handleMoveUp = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    moveUp(focusedBlockId)
    rovingEditorRef.current.mount(focusedBlockId, content)
    announce(t('announce.blockMovedUp'))
  }, [focusedBlockId, handleFlush, moveUp, t])

  const handleMoveDown = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    moveDown(focusedBlockId)
    rovingEditorRef.current.mount(focusedBlockId, content)
    announce(t('announce.blockMovedDown'))
  }, [focusedBlockId, handleFlush, moveDown, t])

  const handleMoveUpById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      moveUp(id)
      if (content !== null) {
        rovingEditorRef.current.mount(id, content)
      }
    },
    [focusedBlockId, handleFlush, moveUp],
  )

  const handleMoveDownById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      moveDown(id)
      if (content !== null) {
        rovingEditorRef.current.mount(id, content)
      }
    },
    [focusedBlockId, handleFlush, moveDown],
  )

  const handleMergeWithPrev = useCallback(async () => {
    if (!focusedBlockId) return
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx <= 0) return

    const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]

    const currentContent = rovingEditorRef.current.unmount() ?? collapsedVisible[idx]?.content ?? ''
    const prevContent = prevBlock.content ?? ''

    const mergedContent = prevContent + currentContent
    const prevDoc = parse(prevContent)
    const joinPoint = pmEndOfFirstBlock(prevDoc)

    try {
      await edit(prevBlock.id, mergedContent)
    } catch (err) {
      logger.error(
        'useBlockKeyboardHandlers',
        'Failed to merge blocks (edit step)',
        {
          blockId: prevBlock.id,
        },
        err,
      )
      rovingEditorRef.current.mount(focusedBlockId, currentContent)
      toast.error(t('blockTree.mergeBlocksFailed'))
      return
    }
    try {
      await remove(focusedBlockId)
    } catch (err) {
      logger.error(
        'useBlockKeyboardHandlers',
        'Failed to merge blocks (remove step)',
        {
          blockId: focusedBlockId,
        },
        err,
      )
      // Revert the edit to avoid partial state (merged content in prev + original in current)
      await edit(prevBlock.id, prevContent).catch((revertErr: unknown) => {
        logger.warn(
          'useBlockKeyboardHandlers',
          'Failed to revert edit after merge failure',
          {
            blockId: prevBlock.id,
          },
          revertErr,
        )
      })
      rovingEditorRef.current.mount(focusedBlockId, currentContent)
      toast.error(t('blockTree.mergeBlocksFailed'))
      return
    }

    setFocused(prevBlock.id)
    rovingEditorRef.current.mount(prevBlock.id, mergedContent)

    if (pendingMergeSelectionRef.current !== null) {
      window.clearTimeout(pendingMergeSelectionRef.current)
    }
    pendingMergeSelectionRef.current = window.setTimeout(() => {
      pendingMergeSelectionRef.current = null
      const editor = rovingEditorRef.current.editor
      if (editor) {
        const pmPos = Math.min(joinPoint, editor.state.doc.content.size - 1)
        editor.commands.setTextSelection(pmPos)
      }
    }, 0)
  }, [focusedBlockId, collapsedVisible, edit, remove, setFocused, t])

  const handleMergeById = useCallback(
    async (blockId: string) => {
      const idx = collapsedVisible.findIndex((b) => b.id === blockId)
      if (idx <= 0) return

      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]

      const editorContent = focusedBlockId === blockId ? rovingEditorRef.current.unmount() : null
      const currentContent = editorContent ?? collapsedVisible[idx]?.content ?? ''
      const prevContent = prevBlock.content ?? ''

      const mergedContent = prevContent + currentContent

      try {
        await edit(prevBlock.id, mergedContent)
      } catch (err) {
        logger.error(
          'useBlockKeyboardHandlers',
          'Failed to merge blocks by ID (edit step)',
          {
            blockId,
          },
          err,
        )
        if (editorContent !== null) {
          rovingEditorRef.current.mount(blockId, currentContent)
        }
        toast.error(t('blockTree.mergeBlocksFailed'))
        return
      }
      try {
        await remove(blockId)
      } catch (err) {
        logger.error(
          'useBlockKeyboardHandlers',
          'Failed to merge blocks by ID (remove step)',
          {
            blockId,
          },
          err,
        )
        // Revert the edit to avoid partial state (merged content in prev + original in current)
        await edit(prevBlock.id, prevContent).catch((revertErr: unknown) => {
          logger.warn(
            'useBlockKeyboardHandlers',
            'Failed to revert edit after merge failure',
            {
              blockId: prevBlock.id,
            },
            revertErr,
          )
        })
        if (editorContent !== null) {
          rovingEditorRef.current.mount(blockId, currentContent)
        }
        toast.error(t('blockTree.mergeBlocksFailed'))
        return
      }

      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, mergedContent)
    },
    [collapsedVisible, focusedBlockId, edit, remove, setFocused, t],
  )

  // Re-entrancy guard: prevents rapid Backspace presses from duplicating deletes.
  const deleteInProgress = useRef(false)

  // Re-entrancy guard: prevents rapid Enter presses from creating duplicate blocks.
  const enterSaveInProgress = useRef(false)

  const handleEnterSave = useCallback(async () => {
    if (!focusedBlockId) return
    if (enterSaveInProgress.current) {
      logger.warn(
        'useBlockKeyboardHandlers',
        'Enter press dropped — previous save still in progress',
        {
          blockId: focusedBlockId,
        },
      )
      return
    }
    enterSaveInProgress.current = true
    try {
      // Capture content before flush so we can re-mount on failure
      const savedContent = rovingEditorRef.current.getMarkdown?.() ?? ''
      handleFlush()
      const newBlockId = await createBelow(focusedBlockId)
      if (newBlockId) {
        justCreatedBlockIds.current.add(newBlockId)
        setFocused(newBlockId)
        announce(t('announce.blockCreated'))
      } else {
        // createBelow returned null (e.g. backend error) — re-mount editor
        // so the user isn't stuck with an unmounted block.
        rovingEditorRef.current.mount(focusedBlockId, savedContent)
      }
    } finally {
      enterSaveInProgress.current = false
    }
  }, [focusedBlockId, handleFlush, createBelow, setFocused, justCreatedBlockIds, t])

  const handleEscapeCancel = useCallback(() => {
    if (!focusedBlockId) return
    // Discard any persisted draft BEFORE unmounting so the autosave
    // cleanup cannot flush stale content to the database.
    discardDraft(focusedBlockId)
    const changed = rovingEditorRef.current.unmount()
    if (changed !== null) {
      toast('Changes discarded', { duration: 2000 })
    }
    // If the block was just created and the user made no edits (changed === null),
    // delete the empty block instead of leaving it around.
    if (justCreatedBlockIds.current.has(focusedBlockId) && changed === null) {
      justCreatedBlockIds.current.delete(focusedBlockId)
      remove(focusedBlockId).catch((err: unknown) => {
        logger.warn(
          'useBlockKeyboardHandlers',
          'Failed to remove empty just-created block on Escape',
          { blockId: focusedBlockId },
          err,
        )
      })
    }
    setFocused(null)
  }, [focusedBlockId, setFocused, justCreatedBlockIds, remove, discardDraft])

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
