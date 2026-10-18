/**
 * useAgendaProjectedEntries — the projected occurrences of repeating tasks that
 * Agenda mode lists under its filters (#5735): `list_projected_agenda` over the
 * range `planAgendaProjection` draws from the filters, kept to the
 * occurrences that plan accepts.
 */

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useInvalidateOnCounter } from '@/hooks/useInvalidateOnCounter'
import { useToday } from '@/hooks/useToday'
import { planAgendaProjection } from '@/lib/agenda-projection'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { ActiveProjectedAgendaEntry, PageResponse } from '@/lib/bindings'
import type { AgendaFilter } from '@/lib/filter-dimension-metadata'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'
import { listProjectedAgendaLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

const AGENDA_PROJECTED_PAGE_SIZE = listProjectedAgendaLimit(100)

export interface AgendaProjectedEntries {
  entries: ActiveProjectedAgendaEntry[]
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
}

export function useAgendaProjectedEntries(filters: AgendaFilter[]): AgendaProjectedEntries {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const today = useToday()
  const plan = useMemo(
    () => planAgendaProjection(filters, new Date(`${today}T00:00:00`)),
    [filters, today],
  )

  const queryKey = useMemo(
    () => ['agendaProjected', currentSpaceId, plan?.start ?? null, plan?.end ?? null],
    [currentSpaceId, plan?.start, plan?.end],
  )
  const { invalidationKey } = useBlockPropertyEvents()
  useInvalidateOnCounter(invalidationKey, queryKey)

  const { data, isError, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage, refetch } =
    useInfiniteQuery(
      {
        queryKey,
        queryFn: async ({ pageParam }): Promise<PageResponse<ActiveProjectedAgendaEntry>> => {
          // #5415 — no active space, or filters that leave nothing to project.
          if (plan === null || currentSpaceId == null) {
            return { items: [], next_cursor: null, has_more: false, total_count: null }
          }
          try {
            return unwrap(
              await commands.listProjectedAgenda(
                plan.start,
                plan.end,
                pageParam ?? null,
                AGENDA_PROJECTED_PAGE_SIZE,
                requireActiveScope(currentSpaceId),
              ),
            )
          } catch (err) {
            logger.warn(
              'useAgendaProjectedEntries',
              'projected agenda fetch failed',
              undefined,
              err,
            )
            throw err
          }
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) =>
          last.has_more && last.next_cursor != null ? last.next_cursor : undefined,
        refetchOnMount: 'always',
        placeholderData: keepPreviousData,
        // The key carries the range, which moves with the filters and the day;
        // let a superseded range's entry go instead of keeping it all session.
        gcTime: 5 * 60 * 1000,
      },
      queryClient,
    )

  useEffect(() => {
    if (!isError) return
    notify.retry(t('agenda.loadProjectedFailed'), () => void refetch(), {
      id: 'agenda-projected-failed',
    })
  }, [isError, refetch])

  const entries = useMemo(
    () =>
      plan === null
        ? []
        : (data?.pages ?? []).flatMap((page) => page.items).filter((e) => plan.accepts(e)),
    [data, plan],
  )

  const hasMore = plan !== null && hasNextPage
  // The filters are applied here, after paging, so a page can hold no
  // occurrence they accept; read on rather than show nothing above a Load more.
  useEffect(() => {
    if (entries.length > 0 || !hasMore || isFetching || isError) return
    void fetchNextPage()
  }, [entries.length, hasMore, isFetching, isError, fetchNextPage])

  return {
    entries,
    hasMore,
    loadingMore: isFetchingNextPage,
    loadMore: () => void fetchNextPage(),
  }
}
