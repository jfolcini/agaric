/**
 * Tags-mode body (PEND-67 Phase 3 — `#` prefix → block_type=tag
 * search). Extracted from CommandPalette.tsx (#751).
 */

import { Hash } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import type { useTranslation } from 'react-i18next'

import { CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { useFailedOnce } from '@/hooks/useFailedOnce'
import { useGenerationGuard } from '@/hooks/useGenerationGuard'
import { isCancellation } from '@/lib/app-error'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { SearchBlockRow } from '@/lib/tauri'
import { searchBlocks, searchBlocksLimit } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

import { PALETTE_DEBOUNCE_MS, TAGS_QUERY_LIMIT } from './constants'

/**
 * Tags-mode body — debounced `searchBlocks({ blockTypeFilter: 'tag' })`
 * with on-select escalation to the search view seeded by
 * `tag:#<name>` (PEND-54 inline filter syntax). The escalation keeps
 * the palette out of the navigation business and reuses the existing
 * find-in-files surface for tag filtering.
 */
export function TagsModeBody({
  onEscalate,
  t,
}: {
  onEscalate: (q: string) => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)
  const query = useCommandPaletteStore((s) => s.query)
  const filter = query.trim()

  const [tags, setTags] = useState<SearchBlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  // PEND-73 Phase 4.M3 — shared race-discard hook.
  const tagsGen = useGenerationGuard()
  // PEND-73 Phase 3.U1 — once-per-session failure surface.
  const surfaceTagsFailureOnce = useFailedOnce()
  const debounced = useDebouncedCallback((value: string) => {
    setDebouncedQuery(value)
  }, PALETTE_DEBOUNCE_MS)

  useEffect(() => {
    debounced.cancel()
    debounced.schedule(filter)
  }, [filter, debounced])

  useEffect(() => {
    if (!spaceIsReady) return
    const gen = tagsGen.next()
    setLoading(true)
    searchBlocks({
      query: debouncedQuery,
      blockTypeFilter: 'tag',
      limit: searchBlocksLimit(TAGS_QUERY_LIMIT),
      spaceId: currentSpaceId ?? '',
    })
      .then((resp) => {
        if (!tagsGen.isCurrent(gen)) return
        setTags(resp.items)
        setLoading(false)
      })
      .catch((err) => {
        if (!tagsGen.isCurrent(gen)) return
        // PEND-73 Phase 2 — see sibling catch site rationale.
        if (isCancellation(err)) return
        logger.warn('CommandPalette', 'tags search failed', { query: debouncedQuery }, err)
        // PEND-73 Phase 3.U1 — once-per-session toast for real failures.
        surfaceTagsFailureOnce('palette:tags', () => notify.error(t('search.failed')))
        setTags([])
        setLoading(false)
      })
  }, [debouncedQuery, currentSpaceId, spaceIsReady, tagsGen, surfaceTagsFailureOnce, t])

  if (!loading && tags.length === 0) {
    return (
      <CommandEmpty data-testid="palette-tags-empty">
        {filter.length === 0 ? t('palette.tagsWelcomeEmpty') : t('palette.tagsNoResults')}
      </CommandEmpty>
    )
  }

  return (
    <CommandGroup heading={t('palette.tagsTitle')} data-testid="palette-tags-group">
      {tags.map((tag) => {
        const name = tag.content ?? ''
        return (
          <CommandItem
            key={tag.id}
            value={`tag:${tag.id}`}
            onSelect={() => onEscalate(`tag:#${name}`)}
            data-testid={`palette-tag-${tag.id}`}
            className="gap-2"
          >
            <Hash className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{name.length > 0 ? name : t('palette.tagsUnnamed')}</span>
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
