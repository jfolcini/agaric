/**
 * TagList — lists all tag blocks with create capability.
 *
 * Shows existing tags and provides an inline form to create new ones.
 */

import { Plus, Tag, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BlockRow } from '../lib/tauri'
import { createBlock, deleteBlock, listBlocks } from '../lib/tauri'

export function TagList(): React.ReactElement {
  const [tags, setTags] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [newTagName, setNewTagName] = useState('')

  const loadTags = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'tag', limit: 500 })
      setTags(resp.items)
    } catch {
      // Silently fail
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  const handleCreateTag = useCallback(async () => {
    const name = newTagName.trim()
    if (!name) return
    try {
      const resp = await createBlock({ blockType: 'tag', content: name })
      const newTag: BlockRow = {
        id: resp.id,
        block_type: resp.block_type,
        content: resp.content,
        parent_id: resp.parent_id,
        position: resp.position,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
      }
      setTags((prev) => [newTag, ...prev])
      setNewTagName('')
    } catch {
      // Silently fail
    }
  }, [newTagName])

  const handleDeleteTag = useCallback(async (tagId: string) => {
    try {
      await deleteBlock(tagId)
      setTags((prev) => prev.filter((t) => t.id !== tagId))
    } catch {
      // Silently fail
    }
  }, [])

  return (
    <div className="space-y-4">
      {/* Create tag form */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleCreateTag()
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          placeholder="New tag name..."
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={!newTagName.trim()}>
          <Plus className="h-4 w-4" /> Add Tag
        </Button>
      </form>

      {loading && <div className="text-sm text-muted-foreground">Loading tags...</div>}

      {!loading && tags.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tags yet. Create one above.
        </div>
      )}

      {tags.length > 0 && (
        <div className="space-y-1">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Badge variant="secondary">{tag.content || 'Unnamed'}</Badge>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                onClick={() => handleDeleteTag(tag.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
