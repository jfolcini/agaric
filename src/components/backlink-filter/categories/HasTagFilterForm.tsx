/**
 * HasTagFilterForm — searchable tag picker for the `has-tag` filter
 * category. Owns the tag-search popover state and the debounced
 * `listTagsByPrefix` IPC. Renders a Radix Popover shell around the
 * cmdk-based `<Command>` wrapper with `shouldFilter={false}` — the
 * backend prefix query is the source of truth, not client rescoring.
 */

import type React from 'react'
import { useEffect, useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'

import { listTagsByPrefix } from '../../../lib/tauri'
import type { FilterFormHandle } from './types'

export interface HasTagFilterFormProps {
  tags: Array<{ id: string; name: string }>
  ref?: React.Ref<FilterFormHandle>
}

export function HasTagFilterForm({ tags, ref }: HasTagFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [tagValue, setTagValue] = useState(tags[0]?.id ?? '')
  const [tagSearchOpen, setTagSearchOpen] = useState(false)
  const [tagSearchQuery, setTagSearchQuery] = useState('')
  const [tagSearchResults, setTagSearchResults] = useState<Array<{ id: string; name: string }>>([])
  const [tagSearchLoading, setTagSearchLoading] = useState(false)

  useImperativeHandle(ref, () => ({ getState: () => ({ tagValue }) }), [tagValue])

  const debouncedTagSearch = useDebouncedCallback((query: string) => {
    setTagSearchLoading(true)
    listTagsByPrefix({ prefix: query, limit: PAGINATION_LIMIT })
      .then((rows) => {
        setTagSearchResults(rows.map((r) => ({ id: r.tag_id, name: r.name })))
      })
      .catch((err) => {
        logger.warn('Tag search failed', err)
      })
      .finally(() => {
        setTagSearchLoading(false)
      })
  }, 150)

  useEffect(() => {
    if (tagSearchOpen) {
      debouncedTagSearch.schedule(tagSearchQuery)
    } else {
      debouncedTagSearch.cancel()
    }
  }, [tagSearchQuery, tagSearchOpen, debouncedTagSearch])

  const items = tagSearchResults.length > 0 ? tagSearchResults : tags
  const triggerLabel = tagValue
    ? (tags.find((tg) => tg.id === tagValue)?.name ??
      tagSearchResults.find((tg) => tg.id === tagValue)?.name ??
      tagValue)
    : t('backlink.selectTag')

  function handleSelect(tagId: string) {
    setTagValue(tagId)
    setTagSearchOpen(false)
  }

  return (
    <Popover open={tagSearchOpen} onOpenChange={setTagSearchOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={triggerLabel}
          data-testid="tag-search-popover"
        >
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <MenuPopoverContent className="p-0" align="start">
        <Command shouldFilter={false} label={t('backlink.searchTagPlaceholder')}>
          <CommandInput
            value={tagSearchQuery}
            onValueChange={setTagSearchQuery}
            placeholder={t('backlink.searchTagPlaceholder')}
            aria-label={t('backlink.searchTagPlaceholder')}
          />
          <CommandList>
            {tagSearchLoading && (
              <div className="p-2">
                <Spinner className="mx-auto text-muted-foreground" />
              </div>
            )}
            {!tagSearchLoading && items.length === 0 && (
              <CommandEmpty>{t('backlink.noTagsFound')}</CommandEmpty>
            )}
            {!tagSearchLoading &&
              items.map((tag) => (
                <CommandItem key={tag.id} value={tag.id} onSelect={() => handleSelect(tag.id)}>
                  {tag.name}
                </CommandItem>
              ))}
          </CommandList>
        </Command>
      </MenuPopoverContent>
    </Popover>
  )
}
