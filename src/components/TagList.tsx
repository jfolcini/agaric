/**
 * TagList — lists all tag blocks with create capability.
 *
 * Shows existing tags and provides an inline form to create new ones.
 * Includes confirmation dialog for deletion, clickable tag names,
 * and toast error feedback.
 */

import { Plus, Tag, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { BlockRow } from '../lib/tauri'
import { createBlock, deleteBlock, listBlocks } from '../lib/tauri'

interface TagListProps {
  /** Called when a tag name is clicked. */
  onTagClick?: (tagId: string, tagName: string) => void
}

export function TagList({ onTagClick }: TagListProps): React.ReactElement {
  const [tags, setTags] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  const loadTags = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await listBlocks({ blockType: 'tag', limit: 500 })
      setTags(resp.items)
    } catch (error) {
      toast.error(`Failed to load tags: ${String(error)}`)
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
    } catch (error) {
      toast.error(`Failed to create tag: ${String(error)}`)
    }
  }, [newTagName])

  const handleDeleteTag = useCallback(async (tagId: string) => {
    try {
      await deleteBlock(tagId)
      setTags((prev) => prev.filter((t) => t.id !== tagId))
    } catch (error) {
      toast.error(`Failed to delete tag: ${String(error)}`)
    }
  }, [])

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      handleDeleteTag(deleteTarget.id)
      setDeleteTarget(null)
    }
  }, [deleteTarget, handleDeleteTag])

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

      {loading && (
        <div className="space-y-1">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      )}

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
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0"
                onClick={() => onTagClick?.(tag.id, tag.content || 'Unnamed')}
              >
                <Badge variant="secondary">{tag.content || 'Unnamed'}</Badge>
              </button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Delete tag"
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteTarget({ id: tag.id, name: tag.content || 'Unnamed' })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tag?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the tag &ldquo;{deleteTarget?.name}&rdquo;. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
