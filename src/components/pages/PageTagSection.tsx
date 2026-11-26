import { CornerDownRight, Plus, Smile, X } from 'lucide-react'
import { Fragment, useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { EmojiPickerDialog } from '@/components/EmojiPicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InfoPopover } from '@/components/ui/info-popover'
import { Input } from '@/components/ui/input'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { TagEntry } from '@/hooks/useBlockTags'
import { useEmojiRecents } from '@/hooks/useEmojiRecents'
import { useTagColorStyle } from '@/hooks/useTagColorStyle'
import { insertEmojiIntoInput, spliceEmojiIntoText } from '@/lib/insert-emoji-at-caret'
import { keepFocusThatMovedOn } from '@/lib/keep-focus-that-moved-on'
import { dashedTagName } from '@/lib/name-tokens'

/** A tag set on the page itself: the tag chip, in the tag's colour, with its remove button. */
function AppliedTag({ tag, onRemoveTag }: { tag: TagEntry; onRemoveTag: (tagId: string) => void }) {
  const { t } = useTranslation()
  return (
    <Badge tone="tag" className="gap-1" style={useTagColorStyle(tag.id)}>
      {tag.name}
      <button
        type="button"
        className="-mr-0.5 inline-flex items-center justify-center rounded-sm p-0.5 hover:bg-muted-foreground/20 focus-ring-visible touch-hit-area"
        onClick={() => onRemoveTag(tag.id)}
        aria-label={t('pageHeader.removeTag', { name: tag.name })}
      >
        <X className="h-3 w-3 coarse:size-3.5" />
      </button>
    </Badge>
  )
}

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
  const firstInheritedId = appliedTags.find((tag) => tag.inherited)?.id

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
      {appliedTags.map((tag) =>
        tag.inherited ? (
          // #1423 — inherited (derived) tag chip. Distinguished from a
          // direct chip by an outlined (not solid) tone, reduced opacity,
          // italic name, and a propagation icon — not color alone. The
          // chip is NOT directly removable (the tag lives on an ancestor);
          // its screen-reader text names it as inherited. The first one
          // carries the ⓘ that explains inherited tags.
          <Fragment key={tag.id}>
            <Badge
              tone="outline"
              data-inherited="true"
              className="gap-1 border-dashed italic opacity-70"
            >
              <CornerDownRight aria-hidden="true" className="h-3 w-3" />
              <span aria-hidden="true">{tag.name}</span>
              <span className="sr-only">{t('pageHeader.inheritedTag', { name: tag.name })}</span>
            </Badge>
            {tag.id === firstInheritedId && (
              <InfoPopover
                variant="icon"
                ariaLabel={t('pageHeader.inheritedTagInfo')}
                content={t('pageHeader.inheritedTagHint')}
              />
            )}
          </Fragment>
        ) : (
          <AppliedTag key={tag.id} tag={tag} onRemoveTag={onRemoveTag} />
        ),
      )}

      <Popover
        open={showTagPicker}
        sheetTitle={t('pageHeader.addTag')}
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
            <Plus />
          </Button>
        </PopoverTrigger>
        <MenuPopoverContent
          className="space-y-2 p-3"
          aria-label={t('pageHeader.tagPicker')}
          onCloseAutoFocus={keepFocusThatMovedOn}
        >
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
              <Smile />
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
                {/* #6278 I4 — the name `onCreateTag` creates: a new tag name holds no whitespace. */}
                {t('pageHeader.createTag', { name: dashedTagName(tagQuery) })}
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
