/**
 * TagList — lists all tag blocks with create, rename & delete capability.
 *
 * Shows existing tags and provides an inline form to create new ones.
 * Includes rename dialog, confirmation dialog for deletion, clickable
 * tag names, color picker popover, and toast error feedback.
 */

import { Paintbrush, Pencil, Plus, Tag, Trash2, X } from 'lucide-react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  clearTagColor,
  getTagColors,
  setTagColor as setTagColorLocal,
  TAG_COLOR_PRESETS,
} from '@/lib/tag-colors'
import { cn } from '@/lib/utils'
import { logger } from '../lib/logger'
import type { TagCacheRow } from '../lib/tauri'
import {
  createBlock,
  deleteProperty,
  editBlock,
  listTagsByPrefix,
  purgeBlock,
  setProperty,
} from '../lib/tauri'
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
  const [tagColors, setTagColors] = useState<Record<string, string>>(getTagColors)
  const [colorPickerOpen, setColorPickerOpen] = useState<string | null>(null)

  const loadTags = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await listTagsByPrefix({ prefix: '', limit: 500 })
      setTags(resp)
    } catch (error) {
      logger.error('TagList', 'failed to load tags', undefined, error)
      toast.error(t('tags.loadFailed'))
    }
    setLoading(false)
  }, [t])

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
      logger.error('TagList', 'failed to create tag', { name }, error)
      toast.error(t('tags.createFailed'))
    }
    setIsCreating(false)
  }, [newTagName, t])

  const handleDeleteTag = useCallback(
    async (tagId: string) => {
      try {
        await purgeBlock(tagId)
        setTags((prev) => prev.filter((t) => t.tag_id !== tagId))
        useResolveStore.getState().set(tagId, '(deleted)', true)
      } catch (error) {
        logger.error('TagList', 'failed to delete tag', { tagId }, error)
        toast.error(t('tags.deleteFailed'))
      }
    },
    [t],
  )

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
        logger.warn(
          'TagList',
          'failed to rename tag',
          { tagId: renameTarget.id, newName: trimmed },
          error,
        )
        toast.error(`${t('tags.renameFailed')}: ${String(error)}`)
      }
    },
    [renameTarget, tags, t],
  )

  const handleSetColor = useCallback(async (tagId: string, color: string) => {
    setTagColorLocal(tagId, color)
    setTagColors((prev) => ({ ...prev, [tagId]: color }))
    setColorPickerOpen(null)
    try {
      await setProperty({ blockId: tagId, key: 'color', valueText: color })
    } catch (err) {
      // localStorage already persisted — property sync is best-effort
      logger.warn('TagList', 'failed to persist tag color via setProperty', { tagId, color }, err)
    }
  }, [])

  const handleClearColor = useCallback(async (tagId: string) => {
    clearTagColor(tagId)
    setTagColors((prev) => {
      const next = { ...prev }
      delete next[tagId]
      return next
    })
    setColorPickerOpen(null)
    try {
      await deleteProperty(tagId, 'color')
    } catch (err) {
      // localStorage already updated — property sync is best-effort
      logger.warn('TagList', 'failed to clear tag color via deleteProperty', { tagId }, err)
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
        className="flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <Input
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          placeholder={t('tagList.newTagPlaceholder')}
          aria-label={t('tagList.newTagLabel')}
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={!newTagName.trim() || isCreating}>
          <Plus className="h-4 w-4" /> {t('tag.addTag')}
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
            {items.map((tag) => {
              const color = tagColors[tag.tag_id]
              return (
                <ListItem key={tag.tag_id}>
                  <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    className="cursor-pointer border-none bg-transparent p-0"
                    onClick={() => onTagClick?.(tag.tag_id, tag.name || 'Unnamed')}
                    data-testid={`tag-item-${tag.name || 'Unnamed'}`}
                  >
                    <Badge
                      variant={color ? undefined : 'secondary'}
                      className={cn('truncate max-w-[150px]', color && 'border-transparent')}
                      style={color ? { backgroundColor: color, color: '#fff' } : undefined}
                      title={tag.name || 'Unnamed'}
                    >
                      {tag.name || 'Unnamed'}
                      <span
                        className={cn('ml-1.5', color ? 'text-white/70' : 'text-muted-foreground')}
                      >
                        {tag.usage_count}
                      </span>
                    </Badge>
                  </button>
                  <div className="flex-1" />
                  <Popover
                    open={colorPickerOpen === tag.tag_id}
                    onOpenChange={(open) => setColorPickerOpen(open ? tag.tag_id : null)}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('tagList.colorTagLabel')}
                        className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground active:text-foreground active:scale-95"
                      >
                        {color ? (
                          <span
                            className="inline-block h-3.5 w-3.5 rounded-full border border-white/30"
                            style={{ backgroundColor: color }}
                          />
                        ) : (
                          <Paintbrush className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-3" align="start">
                      <fieldset
                        className="grid grid-cols-4 gap-2 border-0 p-0 m-0"
                        aria-label={t('tagList.colorPaletteLabel')}
                      >
                        {TAG_COLOR_PRESETS.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            className={cn(
                              'h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                              color === preset.value
                                ? 'border-foreground scale-110'
                                : 'border-transparent',
                            )}
                            style={{ backgroundColor: preset.value }}
                            aria-label={preset.name}
                            aria-pressed={color === preset.value}
                            onClick={() => handleSetColor(tag.tag_id, preset.value)}
                          />
                        ))}
                      </fieldset>
                      {color && (
                        <button
                          type="button"
                          className="mt-2 flex w-full items-center justify-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                          onClick={() => handleClearColor(tag.tag_id)}
                        >
                          <X className="h-3 w-3" />
                          {t('tagList.clearColor')}
                        </button>
                      )}
                    </PopoverContent>
                  </Popover>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('tagList.renameTagLabel')}
                    className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground active:text-foreground active:scale-95"
                    onClick={() => setRenameTarget({ id: tag.tag_id, name: tag.name || 'Unnamed' })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('tagList.deleteTagLabel')}
                    className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
                    onClick={() => setDeleteTarget({ id: tag.tag_id, name: tag.name || 'Unnamed' })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </ListItem>
              )
            })}
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
