/**
 * PageHeader — editable page title + tag badge row.
 *
 * Rendered at the top of PageEditor. Contains the contentEditable title
 * and a tag badge row with an inline tag picker popover.
 */

import { ArrowLeft, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useBlockTags } from '../hooks/useBlockTags'
import { editBlock, getPageAliases, setPageAliases } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { useResolveStore } from '../stores/resolve'
import { useUndoStore } from '../stores/undo'
import { PagePropertyTable } from './PagePropertyTable'

export interface PageHeaderProps {
  pageId: string
  title: string
  onBack?: () => void
}

export function PageHeader({ pageId, title, onBack }: PageHeaderProps) {
  // --- Title editing ---
  const titleRef = useRef<HTMLDivElement>(null)
  const [editableTitle, setEditableTitle] = useState(title)
  const [tagQuery, setTagQuery] = useState('')
  const [showTagPicker, setShowTagPicker] = useState(false)

  // --- Alias state ---
  const [aliases, setAliases] = useState<string[]>([])
  const [editingAliases, setEditingAliases] = useState(false)
  const [aliasInput, setAliasInput] = useState('')

  // Fetch aliases on mount / page change
  useEffect(() => {
    if (!pageId) return
    getPageAliases(pageId)
      .then(setAliases)
      .catch(() => {})
  }, [pageId])

  // Sync editableTitle when prop changes (e.g., navigating to a different page)
  useEffect(() => {
    setEditableTitle(title)
    if (titleRef.current && titleRef.current.textContent !== title) {
      titleRef.current.textContent = title
    }
  }, [title])

  const handleTitleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    setEditableTitle(e.currentTarget.textContent ?? '')
  }, [])

  const handleTitleBlur = useCallback(async () => {
    const newTitle = editableTitle.trim()
    if (!newTitle) {
      setEditableTitle(title)
      if (titleRef.current) titleRef.current.textContent = title
      return
    }
    if (newTitle !== title) {
      try {
        await editBlock(pageId, newTitle)
        useUndoStore.getState().onNewAction(pageId)
        useNavigationStore.getState().replacePage(pageId, newTitle)
        useResolveStore.getState().set(pageId, newTitle, false)
      } catch {
        toast.error('Failed to rename page')
        setEditableTitle(title)
        if (titleRef.current) titleRef.current.textContent = title
      }
    }
  }, [editableTitle, title, pageId])

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    }
  }, [])

  // --- Tag badges ---
  const { allTags, appliedTagIds, handleAddTag, handleRemoveTag, handleCreateTag } =
    useBlockTags(pageId)

  const appliedTags = allTags.filter((t) => appliedTagIds.has(t.id))
  const availableTags = allTags
    .filter((t) => !appliedTagIds.has(t.id))
    .filter((t) => !tagQuery || t.name.toLowerCase().includes(tagQuery.toLowerCase()))

  const handleTagAdd = useCallback(
    async (tagId: string) => {
      await handleAddTag(tagId)
      setTagQuery('')
      setShowTagPicker(false)
    },
    [handleAddTag],
  )

  const handleTagCreate = useCallback(async () => {
    const name = tagQuery.trim()
    if (!name) return
    await handleCreateTag(name)
    setTagQuery('')
    setShowTagPicker(false)
  }, [tagQuery, handleCreateTag])

  return (
    <div className="page-header space-y-2">
      {/* Title row */}
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Go back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: contentEditable div is intentional for inline title editing */}
        <div
          ref={titleRef}
          role="textbox"
          tabIndex={0}
          aria-label="Page title"
          contentEditable
          suppressContentEditableWarning
          className={[
            'flex-1 text-xl font-semibold outline-none rounded-md px-1',
            'focus:ring-2 focus:ring-ring/50',
            'hover:bg-accent/5 focus-within:bg-accent/5 transition-colors',
          ].join(' ')}
          onInput={handleTitleInput}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
        >
          {title}
        </div>
      </div>

      {/* Aliases */}
      {(aliases.length > 0 || editingAliases) && (
        <div className="flex flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground">
          <span className="font-medium">Also known as:</span>
          {aliases.map((alias) => (
            <span key={alias} className="rounded-md bg-muted px-1.5 py-0.5">
              {alias}
              {editingAliases && (
                <button
                  type="button"
                  className="ml-1 text-destructive hover:text-destructive/80"
                  onClick={() => {
                    const next = aliases.filter((a) => a !== alias)
                    setAliases(next)
                    setPageAliases(pageId, next).catch(() =>
                      toast.error('Failed to update aliases'),
                    )
                  }}
                  aria-label={`Remove alias ${alias}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {editingAliases ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                if (aliasInput.trim()) {
                  const next = [...aliases, aliasInput.trim()]
                  setAliases(next)
                  setPageAliases(pageId, next).catch(() => toast.error('Failed to update aliases'))
                  setAliasInput('')
                }
              }}
            >
              <input
                type="text"
                className="w-24 rounded border px-1 py-0.5 text-xs"
                placeholder="New alias..."
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                aria-label="New alias input"
              />
              <button type="submit" className="text-xs text-primary">
                Add
              </button>
              <button type="button" className="text-xs" onClick={() => setEditingAliases(false)}>
                Done
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => setEditingAliases(true)}
            >
              {aliases.length > 0 ? 'Edit' : '+ Add alias'}
            </button>
          )}
        </div>
      )}
      {aliases.length === 0 && !editingAliases && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-primary px-1"
          onClick={() => setEditingAliases(true)}
        >
          + Add alias
        </button>
      )}

      {/* Tag badges row */}
      <div className="flex flex-wrap items-center gap-1.5">
        {appliedTags.map((tag) => (
          <Badge key={tag.id} variant="secondary" className="gap-1">
            {tag.name}
            <button
              type="button"
              className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
              onClick={() => handleRemoveTag(tag.id)}
              aria-label={`Remove tag ${tag.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}

        <Popover open={showTagPicker} onOpenChange={setShowTagPicker}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="gap-1 text-muted-foreground"
              aria-label="Add tag"
            >
              <Plus className="h-3.5 w-3.5" />
              {appliedTags.length === 0 ? 'Add tag' : ''}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 space-y-2 p-3" aria-label="Tag picker">
            <Input
              placeholder="Search or create tag..."
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && availableTags.length === 0 && tagQuery.trim()) {
                  e.preventDefault()
                  handleTagCreate()
                }
              }}
              aria-label="Search tags"
            />
            <div className="max-h-40 overflow-y-auto">
              {availableTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                  onClick={() => handleTagAdd(tag.id)}
                >
                  {tag.name}
                </button>
              ))}
              {tagQuery.trim() && !allTags.some((t) => t.name === tagQuery.trim()) && (
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent"
                  onClick={handleTagCreate}
                >
                  Create &quot;{tagQuery.trim()}&quot;
                </button>
              )}
              {availableTags.length === 0 && !tagQuery.trim() && (
                <p className="px-2 py-1 text-sm text-muted-foreground">No more tags</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <PagePropertyTable pageId={pageId} />
    </div>
  )
}
