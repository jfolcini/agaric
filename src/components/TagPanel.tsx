/**
 * TagPanel — apply/remove tags from a block (p15-t18).
 *
 * Displays tags currently applied to the focused block.
 * Provides a picker to add tags and buttons to remove them.
 * Also allows creating new tag blocks inline (p15-t19).
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { BlockRow } from '../lib/tauri'
import { addTag, createBlock, listBlocks, removeTag } from '../lib/tauri'

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
      <div className="tag-panel">
        <div className="tag-panel-empty">Select a block to manage tags</div>
      </div>
    )
  }

  const appliedTags = allTags.filter((t) => appliedTagIds.has(t.id))
  const availableTags = allTags
    .filter((t) => !appliedTagIds.has(t.id))
    .filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="tag-panel">
      <div className="tag-panel-applied">
        {appliedTags.map((tag) => (
          <span key={tag.id} className="tag-chip">
            {tag.name}
            <button
              type="button"
              className="tag-chip-remove"
              onClick={() => handleRemoveTag(tag.id)}
              aria-label={`Remove tag ${tag.name}`}
            >
              x
            </button>
          </span>
        ))}
      </div>

      <button
        type="button"
        className="tag-panel-add-btn"
        onClick={() => setShowPicker(!showPicker)}
      >
        + Add tag
      </button>

      {showPicker && (
        <div className="tag-picker">
          <input
            type="text"
            className="tag-picker-input"
            placeholder="Search tags..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="tag-picker-list" role="listbox">
            {availableTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="tag-picker-item"
                role="option"
                aria-selected={false}
                onClick={() => handleAddTag(tag.id)}
              >
                {tag.name}
              </button>
            ))}
            {availableTags.length === 0 && query && (
              <div className="tag-picker-empty">
                No matching tags.{' '}
                <button
                  type="button"
                  className="tag-create-inline"
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
        <div className="tag-create-form">
          <input
            type="text"
            className="tag-create-input"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            placeholder="Tag name"
          />
          <button type="button" className="tag-create-btn" onClick={handleCreateTag}>
            Create tag
          </button>
          <button type="button" className="tag-create-cancel" onClick={() => setNewTagName('')}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
