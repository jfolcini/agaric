/**
 * TagPanel — apply/remove tags from a block (p15-t18).
 *
 * Displays tags currently applied to the focused block.
 * Provides a picker to add tags and buttons to remove them.
 * Also allows creating new tag blocks inline (p15-t19).
 */

import { Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BlockRow } from '../lib/tauri'
import { addTag, createBlock, listBlocks, listTagsForBlock, removeTag } from '../lib/tauri'

interface TagPanelProps {
  /** The block to manage tags for. */
  blockId: string | null
}

interface TagEntry {
  id: string
  name: string
}

export function TagPanel({ blockId }: TagPanelProps): React.ReactElement | null {
  const [allTags, setAllTags] = useState<TagEntry[]>([])
  const [appliedTagIds, setAppliedTagIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [newTagName, setNewTagName] = useState('')

  // Load all available tags
  useEffect(() => {
    listBlocks({ blockType: 'tag' })
      .then((resp) => {
        setAllTags(resp.items.map((t: BlockRow) => ({ id: t.id, name: t.content ?? '' })))
      })
      .catch(() => {})
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset state when focused block changes (blockId is a prop)
  useEffect(() => {
    setAppliedTagIds(new Set())
    setQuery('')
    setShowPicker(false)
    if (blockId) {
      listTagsForBlock(blockId)
        .then((tagIds) => setAppliedTagIds(new Set(tagIds)))
        .catch(() => {})
    }
  }, [blockId])

  const handleAddTag = useCallback(
    async (tagId: string) => {
      if (!blockId) return
      try {
        await addTag(blockId, tagId)
        setAppliedTagIds((prev) => new Set([...prev, tagId]))
        setQuery('')
        setShowPicker(false)
      } catch {
        // Silently fail (e.g., already applied)
      }
    },
    [blockId],
  )

  const handleRemoveTag = useCallback(
    async (tagId: string) => {
      if (!blockId) return
      try {
        await removeTag(blockId, tagId)
        setAppliedTagIds((prev) => {
          const next = new Set(prev)
          next.delete(tagId)
          return next
        })
      } catch {
        // Silently fail
      }
    },
    [blockId],
  )

  const handleCreateTag = useCallback(async () => {
    const name = newTagName.trim()
    if (!name) return
    try {
      const resp = await createBlock({ blockType: 'tag', content: name })
      const entry = { id: resp.id, name }
      setAllTags((prev) => [...prev, entry])
      setNewTagName('')
      // Auto-apply to current block if one is focused
      if (blockId) {
        await addTag(blockId, resp.id)
        setAppliedTagIds((prev) => new Set([...prev, resp.id]))
      }
    } catch {
      // Silently fail
    }
  }, [newTagName, blockId])

  if (!blockId) {
    return (
      <div className="tag-panel rounded-lg border border-dashed p-6 text-center">
        <div className="tag-panel-empty text-sm text-muted-foreground">
          Select a block to manage tags
        </div>
      </div>
    )
  }

  const appliedTags = allTags.filter((t) => appliedTagIds.has(t.id))
  const availableTags = allTags
    .filter((t) => !appliedTagIds.has(t.id))
    .filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="tag-panel">
      <div className="tag-panel-applied flex flex-wrap gap-2">
        {appliedTags.map((tag) => (
          <Badge key={tag.id} variant="secondary" className="tag-chip gap-1">
            {tag.name}
            <button
              type="button"
              className="tag-chip-remove ml-1 rounded-full hover:bg-muted"
              onClick={() => handleRemoveTag(tag.id)}
              aria-label={`Remove tag ${tag.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      <Button
        variant="outline"
        size="sm"
        className="tag-panel-add-btn gap-1"
        onClick={() => setShowPicker(!showPicker)}
      >
        <Plus className="h-3.5 w-3.5" />
        Add tag
      </Button>

      {showPicker && (
        <div className="tag-picker mt-2 space-y-2 rounded-lg border bg-popover p-3 shadow-md">
          <Input
            className="tag-picker-input h-8"
            placeholder="Search tags..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="tag-picker-list max-h-40 space-y-1 overflow-y-auto" role="listbox">
            {availableTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="tag-picker-item flex w-full items-center rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                role="option"
                aria-selected={false}
                onClick={() => handleAddTag(tag.id)}
              >
                {tag.name}
              </button>
            ))}
            {availableTags.length === 0 && query && (
              <div className="tag-picker-empty text-sm text-muted-foreground">
                No matching tags.{' '}
                <button
                  type="button"
                  className="tag-create-inline text-primary underline-offset-4 hover:underline"
                  onClick={() => {
                    setNewTagName(query)
                    setShowPicker(false)
                  }}
                >
                  Create &quot;{query}&quot;
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {newTagName && (
        <div className="tag-create-form mt-2 flex items-center gap-2">
          <Input
            className="tag-create-input h-8 flex-1"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            placeholder="Tag name"
          />
          <Button size="sm" className="tag-create-btn" onClick={handleCreateTag}>
            Create tag
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="tag-create-cancel"
            onClick={() => setNewTagName('')}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
