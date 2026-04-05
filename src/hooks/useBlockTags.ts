import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import type { BlockRow } from '../lib/tauri'
import { addTag, createBlock, listBlocks, listTagsForBlock, removeTag } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { useResolveStore } from '../stores/resolve'
import { useUndoStore } from '../stores/undo'

export interface TagEntry {
  id: string
  name: string
}

export interface UseBlockTagsReturn {
  /** All available tags in the system */
  allTags: TagEntry[]
  /** Set of tag IDs applied to the current block */
  appliedTagIds: Set<string>
  /** Loading state for initial tag fetch */
  loading: boolean
  /** Add an existing tag to the block */
  handleAddTag: (tagId: string) => Promise<void>
  /** Remove a tag from the block */
  handleRemoveTag: (tagId: string) => Promise<void>
  /** Create a new tag and optionally apply it to the block */
  handleCreateTag: (name: string) => Promise<void>
}

export function useBlockTags(blockId: string | null): UseBlockTagsReturn {
  const [allTags, setAllTags] = useState<TagEntry[]>([])
  const [appliedTagIds, setAppliedTagIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  // Load all available tags on mount
  useEffect(() => {
    listBlocks({ blockType: 'tag' })
      .then((resp) => {
        setAllTags(resp.items.map((t: BlockRow) => ({ id: t.id, name: t.content ?? '' })))
      })
      .catch(() => {
        toast.error(i18n.t('tags.loadFailed'))
      })
  }, [])

  // Load applied tags when blockId changes
  useEffect(() => {
    setAppliedTagIds(new Set())
    setLoading(true)
    if (blockId) {
      listTagsForBlock(blockId)
        .then((tagIds) => {
          setAppliedTagIds(new Set(tagIds))
          setLoading(false)
        })
        .catch(() => {
          toast.error(i18n.t('tags.loadFailed'))
          setLoading(false)
        })
    } else {
      setLoading(false)
    }
  }, [blockId])

  const handleAddTag = useCallback(
    async (tagId: string) => {
      if (!blockId) return
      try {
        await addTag(blockId, tagId)
        const { rootParentId } = useBlockStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAppliedTagIds((prev) => new Set([...prev, tagId]))
      } catch {
        toast.error(i18n.t('tags.addFailed'))
      }
    },
    [blockId],
  )

  const handleRemoveTag = useCallback(
    async (tagId: string) => {
      if (!blockId) return
      try {
        await removeTag(blockId, tagId)
        const { rootParentId } = useBlockStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAppliedTagIds((prev) => {
          const next = new Set(prev)
          next.delete(tagId)
          return next
        })
      } catch {
        toast.error(i18n.t('tags.deleteFailed'))
      }
    },
    [blockId],
  )

  const handleCreateTag = useCallback(
    async (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      try {
        const resp = await createBlock({ blockType: 'tag', content: trimmed })
        const entry = { id: resp.id, name: trimmed }
        setAllTags((prev) => [...prev, entry])
        useResolveStore.getState().set(resp.id, trimmed, false)
        if (blockId) {
          await addTag(blockId, resp.id)
          const { rootParentId } = useBlockStore.getState()
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          setAppliedTagIds((prev) => new Set([...prev, resp.id]))
        }
      } catch {
        toast.error(i18n.t('tags.createFailed'))
      }
    },
    [blockId],
  )

  return { allTags, appliedTagIds, loading, handleAddTag, handleRemoveTag, handleCreateTag }
}
