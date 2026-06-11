import { Plus, Smile, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { EmojiPickerDialog } from '@/components/EmojiPicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { TagEntry } from '@/hooks/useBlockTags'
import { useEmojiRecents } from '@/hooks/useEmojiRecents'
import { insertEmojiIntoInput, spliceEmojiIntoText } from '@/lib/insert-emoji-at-caret'

export interface PageTagSectionProps {
  appliedTags: TagEntry[]
  availableTags: TagEntry[]
  allTags: TagEntry[]
  tagQuery: string
  showTagPicker: boolean
  onTagQueryChange: (query: string) => void
  onTagPickerChange: (open: boolean) => void
  onAddTag: (tagId: string) => void
  onRemoveTag: (tagId: string) => void
  onCreateTag: () => void
}

export function PageTagSection({
  appliedTags,
  availableTags,
  allTags,
  tagQuery,
  showTagPicker,
  onTagQueryChange,
  onTagPickerChange,
  onAddTag,
  onRemoveTag,
  onCreateTag,
}: PageTagSectionProps) {
  const { t } = useTranslation()
  const tagInputRef = useRef<HTMLInputElement>(null)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const { push: pushEmojiRecent } = useEmojiRecents()

  // Insert a picked emoji into the tag-name input at the caret (or append).
  // The input may have lost focus to the picker dialog, so fall back to a
  // pure string splice on the controlled `tagQuery` when the live element
  // selection is unavailable. Either way we sync the controlled value and
  // refocus the input so typing can continue.
  const handleTagEmojiSelect = useCallback(
    (char: string) => {
      pushEmojiRecent(char)
      const el = tagInputRef.current
      if (el && el.isConnected) {
        const next = insertEmojiIntoInput(el, char)
        onTagQueryChange(next)
        requestAnimationFrame(() => el.focus())
      } else {
        onTagQueryChange(spliceEmojiIntoText(tagQuery, char).value)
      }
    },
    [onTagQueryChange, pushEmojiRecent, tagQuery],
  )

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {appliedTags.map((tag) => (
        <Badge key={tag.id} tone="secondary" className="gap-1">
          {tag.name}
          <button
            type="button"
            className="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 hover:bg-muted-foreground/20 focus-ring-visible [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:p-2"
            onClick={() => onRemoveTag(tag.id)}
            aria-label={t('pageHeader.removeTag', { name: tag.name })}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      <Popover
        open={showTagPicker}
        onOpenChange={(open) => {
          // Keep the tag picker open while the emoji dialog has focus — the
          // dialog is a logical child of this picker even though it portals
          // out, so an outside-interaction close would be jarring (#286).
          if (!open && emojiPickerOpen) return
          onTagPickerChange(open)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="gap-1 text-muted-foreground"
            aria-label={t('pageHeader.addTag')}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <MenuPopoverContent className="space-y-2 p-3" aria-label={t('pageHeader.tagPicker')}>
          <div className="flex items-center gap-1">
            <Input
              ref={tagInputRef}
              placeholder={t('pageHeader.searchTags')}
              value={tagQuery}
              onChange={(e) => onTagQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && availableTags.length === 0 && tagQuery.trim()) {
                  e.preventDefault()
                  onCreateTag()
                }
              }}
              aria-label={t('pageHeader.searchTagsLabel')}
            />
            {/* #286 — insert an emoji into the tag name at the caret. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              onClick={() => setEmojiPickerOpen(true)}
              aria-label={t('pageHeader.insertEmoji')}
            >
              <Smile className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ScrollArea className="max-h-40">
            {availableTags.map((tag) => (
              <Button
                key={tag.id}
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => onAddTag(tag.id)}
              >
                {tag.name}
              </Button>
            ))}
            {tagQuery.trim() && !allTags.some((t_) => t_.name === tagQuery.trim()) && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={onCreateTag}
              >
                {t('pageHeader.createTag', { name: tagQuery.trim() })}
              </Button>
            )}
            {availableTags.length === 0 && !tagQuery.trim() && (
              <EmptyState compact message={t('pages.tags.empty')} />
            )}
          </ScrollArea>
        </MenuPopoverContent>
      </Popover>

      {/* #286 — tag-name emoji picker. Splices the chosen emoji into the
          tag-name input at the caret. Shared dialog primitive (#319). */}
      <EmojiPickerDialog
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onSelect={handleTagEmojiSelect}
      />
    </div>
  )
}
