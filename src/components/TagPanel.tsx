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
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { BlockRow } from '../lib/tauri'
import { addTag, createBlock, listBlocks, listTagsForBlock, removeTag } from '../lib/tauri'
import { EmptyState } from './EmptyState'

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
      .catch(() => {
        toast.error('Failed to load tags')
      })
  }, [])

  useEffect(() => {
    setAppliedTagIds(new Set())
    setQuery('')
    setShowPicker(false)
    if (blockId) {
      listTagsForBlock(blockId)
        .then((tagIds) => setAppliedTagIds(new Set(tagIds)))
        .catch(() => {
          toast.error('Failed to load tags')
        })
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
        toast.error('Failed to load tags')
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
        toast.error('Failed to delete tag')
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
      setShowPicker(false)
    } catch {
      toast.error('Failed to create tag')
    }
  }, [newTagName, blockId])

  if (!blockId) {
    return <EmptyState message="Select a block to manage tags" />
  }

  const appliedTags = allTags.filter((t) => appliedTagIds.has(t.id))
  const availableTags = allTags
    .filter((t) => !appliedTagIds.has(t.id))
    .filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="tag-panel">
      <p className="text-xs text-muted-foreground mb-1">Applied tags</p>
      <div className="tag-panel-applied flex flex-wrap gap-2">
        {appliedTags.map((tag) => (
          <Badge key={tag.id} variant="secondary" className="tag-chip gap-1">
            {tag.name}
            <button
              type="button"
              className="tag-chip-remove ml-1 rounded-full hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => handleRemoveTag(tag.id)}
              aria-label={`Remove tag ${tag.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      <Popover open={showPicker} onOpenChange={setShowPicker}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="tag-panel-add-btn gap-1">
            <Plus className="h-3.5 w-3.5" />
            Add tag
          </Button>
        </PopoverTrigger>
        <PopoverContent className="tag-picker w-64 space-y-2 p-3" aria-label="Tag picker">
          <Input
            className="tag-picker-input h-8"
            placeholder="Search tags..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div
            className="tag-picker-list max-h-60 space-y-1 overflow-y-auto"
            role="listbox"
            aria-label="Available tags"
          >
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
        </PopoverContent>
      </Popover>

      {newTagName && (
        <fieldset
          aria-label="Create tag"
          className="tag-create-form mt-2 flex items-center gap-2 border-none p-0 m-0"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleCreateTag()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setNewTagName('')
            }
          }}
        >
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
          <p className="mt-1 text-[10px] text-muted-foreground">
            Press Enter to create, Escape to cancel
          </p>
        </fieldset>
      )}
    </div>
  )
}
