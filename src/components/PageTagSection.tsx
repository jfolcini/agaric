import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { TagEntry } from '../hooks/useBlockTags'
import { EmptyState } from './EmptyState'

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

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {appliedTags.map((tag) => (
        <Badge key={tag.id} variant="secondary" className="gap-1">
          {tag.name}
          <button
            type="button"
            className="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 hover:bg-muted-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:p-2"
            onClick={() => onRemoveTag(tag.id)}
            aria-label={t('pageHeader.removeTag', { name: tag.name })}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      <Popover open={showTagPicker} onOpenChange={onTagPickerChange}>
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
        <PopoverContent
          className="w-64 space-y-2 p-3 max-w-[calc(100vw-2rem)]"
          aria-label={t('pageHeader.tagPicker')}
        >
          <Input
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
        </PopoverContent>
      </Popover>
    </div>
  )
}
