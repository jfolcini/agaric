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
import { useTranslation } from 'react-i18next'
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
import { useResolveStore } from '../stores/resolve'
import { EmptyState } from './EmptyState'

interface TagListProps {
  /** Called when a tag name is clicked. */
  onTagClick?: (tagId: string, tagName: string) => void
}

export function TagList({ onTagClick }: TagListProps): React.ReactElement {
  const { t } = useTranslation()
  const [tags, setTags] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
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
    if (name.length > 100) {
      toast.error(t('tags.nameTooLong'))
      return
    }
    setIsCreating(true)
    try {
      const resp = await createBlock({ blockType: 'tag', content: name })
      const newTag: BlockRow = {
        id: resp.id,
        block_type: resp.block_type,
        content: resp.content,
        parent_id: resp.parent_id,
        position: resp.position,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      }
      setTags((prev) => [newTag, ...prev])
      setNewTagName('')
      // Update resolve cache so tag_ref nodes display the name, not ULID
      useResolveStore.getState().set(resp.id, name, false)
    } catch (error) {
      toast.error(`Failed to create tag: ${String(error)}`)
    }
    setIsCreating(false)
  }, [newTagName, t])

  const handleDeleteTag = useCallback(async (tagId: string) => {
    try {
      await deleteBlock(tagId)
      setTags((prev) => prev.filter((t) => t.id !== tagId))
      useResolveStore.getState().set(tagId, '(deleted)', true)
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
        <Button type="submit" variant="outline" disabled={!newTagName.trim() || isCreating}>
          <Plus className="h-4 w-4" /> Add Tag
        </Button>
      </form>

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      )}

      {!loading && tags.length === 0 && <EmptyState icon={Tag} message={t('tagList.empty')} />}

      {tags.length > 0 && (
        <ul className="space-y-2">
          {tags.map((tag) => (
            <li
              key={tag.id}
              className="group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0"
                onClick={() => onTagClick?.(tag.id, tag.content || 'Unnamed')}
              >
                <Badge
                  variant="secondary"
                  className="truncate max-w-[150px]"
                  title={tag.content || 'Unnamed'}
                >
                  {tag.content || 'Unnamed'}
                </Badge>
              </button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Delete tag"
                className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteTarget({ id: tag.id, name: tag.content || 'Unnamed' })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
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
              undone. {t('tags.deleteWarning')}
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
