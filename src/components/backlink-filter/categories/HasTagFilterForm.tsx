/**
 * HasTagFilterForm — searchable tag picker for the `has-tag` filter
 * category.  Owns the tag-search popover state and the debounced
 * `listTagsByPrefix` IPC (B-72).
 */

import type React from 'react'
import { useEffect, useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { logger } from '@/lib/logger'
import { listTagsByPrefix } from '../../../lib/tauri'
import { SearchablePopover } from '../../SearchablePopover'
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
    listTagsByPrefix({ prefix: query, limit: 50 })
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

  return (
    <SearchablePopover
      open={tagSearchOpen}
      onOpenChange={setTagSearchOpen}
      items={tagSearchResults.length > 0 ? tagSearchResults : tags}
      isLoading={tagSearchLoading}
      onSelect={(tag) => {
        setTagValue(tag.id)
        setTagSearchOpen(false)
      }}
      renderItem={(tag) => tag.name}
      keyExtractor={(tag) => tag.id}
      searchValue={tagSearchQuery}
      onSearchChange={setTagSearchQuery}
      searchPlaceholder={t('backlink.searchTagPlaceholder')}
      emptyMessage={t('backlink.noTagsFound')}
      triggerLabel={
        tagValue
          ? (tags.find((tg) => tg.id === tagValue)?.name ??
            tagSearchResults.find((tg) => tg.id === tagValue)?.name ??
            tagValue)
          : t('backlink.selectTag')
      }
    />
  )
}
