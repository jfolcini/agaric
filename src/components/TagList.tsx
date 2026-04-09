/**
 * TagList — lists all tag blocks with create, rename & delete capability.
 *
 * Shows existing tags and provides an inline form to create new ones.
 * Includes rename dialog, confirmation dialog for deletion, clickable
 * tag names, and toast error feedback.
 */

import { Pencil, Plus, Tag, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { RenameDialog } from '@/components/RenameDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ListItem } from '@/components/ui/list-item'
import type { TagCacheRow } from '../lib/tauri'
import { createBlock, deleteBlock, editBlock, listTagsByPrefix } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'
import { LoadingSkeleton } from './LoadingSkeleton'

interface TagListProps {
  /** Called when a tag name is clicked. */
  onTagClick?: (tagId: string, tagName: string) => void
}

export function TagList({ onTagClick }: TagListProps): React.ReactElement {
  const { t } = useTranslation()
  const [tags, setTags] = useState<TagCacheRow[]>([])
  const [loading, setLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)

  const loadTags = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await listTagsByPrefix({ prefix: '', limit: 500 })
      setTags(resp)
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
      const newTag: TagCacheRow = {
        tag_id: resp.id,
        name: resp.content ?? name,
        usage_count: 0,
        updated_at: new Date().toISOString(),
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
      setTags((prev) => prev.filter((t) => t.tag_id !== tagId))
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

  const handleRenameTag = useCallback(
    async (newName: string) => {
      if (!renameTarget) return
      const trimmed = newName.trim()
      if (!trimmed) return
      if (tags.some((tag) => tag.tag_id !== renameTarget.id && tag.name === trimmed)) {
        toast.error(t('tags.duplicateName'))
        return
      }
      try {
        await editBlock(renameTarget.id, trimmed)
        setTags((prev) =>
          prev.map((tag) => (tag.tag_id === renameTarget.id ? { ...tag, name: trimmed } : tag)),
        )
        useResolveStore.getState().set(renameTarget.id, trimmed, false)
        toast.success(t('tags.renameSuccess'))
      } catch (error) {
        toast.error(`${t('tags.renameFailed')}: ${String(error)}`)
      }
    },
    [renameTarget, tags, t],
  )

  return (
    <div className="space-y-4">
      {/* Create tag form */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleCreateTag()
        }}
        className="flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <Input
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          placeholder="New tag name..."
          aria-label={t('tagList.newTagLabel')}
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={!newTagName.trim() || isCreating}>
          <Plus className="h-4 w-4" /> Add Tag
        </Button>
      </form>

      <ListViewState
        loading={loading}
        items={tags}
        skeleton={
          <div aria-busy="true">
            <LoadingSkeleton count={3} height="h-10" />
          </div>
        }
        empty={<EmptyState icon={Tag} message={t('tagList.empty')} />}
      >
        {(items) => (
          <ul className="space-y-2">
            {items.map((tag) => (
              <ListItem key={tag.tag_id}>
                <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  className="cursor-pointer border-none bg-transparent p-0"
                  onClick={() => onTagClick?.(tag.tag_id, tag.name || 'Unnamed')}
                >
                  <Badge
                    variant="secondary"
                    className="truncate max-w-[150px]"
                    title={tag.name || 'Unnamed'}
                  >
                    {tag.name || 'Unnamed'}
                    <span className="ml-1.5 text-muted-foreground">{tag.usage_count}</span>
                  </Badge>
                </button>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('tagList.renameTagLabel')}
                  className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target [@media(pointer:coarse)]:min-w-[44px] focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground active:text-foreground active:scale-95"
                  onClick={() => setRenameTarget({ id: tag.tag_id, name: tag.name || 'Unnamed' })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('tagList.deleteTagLabel')}
                  className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target [@media(pointer:coarse)]:min-w-[44px] focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
                  onClick={() => setDeleteTarget({ id: tag.tag_id, name: tag.name || 'Unnamed' })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </ListItem>
            ))}
          </ul>
        )}
      </ListViewState>

      {/* Rename dialog */}
      <RenameDialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
        currentName={renameTarget?.name ?? ''}
        title={t('tags.renameTitle')}
        description={t('tags.renameDescription')}
        placeholder={t('tags.renamePlaceholder')}
        ariaLabel={t('tagList.renameInputLabel')}
        onConfirm={handleRenameTag}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="Delete tag?"
        description={`This will delete the tag \u201c${deleteTarget?.name}\u201d. This action cannot be undone. ${t('tags.deleteWarning')}`}
        cancelLabel="Cancel"
        actionLabel="Delete"
        onAction={handleConfirmDelete}
      />
    </div>
  )
}
