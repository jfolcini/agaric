/**
 * TagPageLink — on a page titled `Tag/<tag>`, the link to the tag whose notes
 * it holds (#6755). The pairing is the title alone, so the tag is looked up by
 * name among the space's tags; a page under `Tag/` whose tag does not exist is
 * an ordinary page and shows nothing.
 */

import { useQuery } from '@tanstack/react-query'
import { Tag } from 'lucide-react'
import type React from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { unwrap } from '@/lib/app-error'
import type { TagCacheRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { nameKey, tagOfPageTitle } from '@/lib/name-tokens'
import { queryClient } from '@/lib/query-client'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

export interface TagPageLinkProps {
  pageTitle: string
}

export function TagPageLink({ pageTitle }: TagPageLinkProps): React.ReactElement | null {
  const { t } = useTranslation()
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const tagName = tagOfPageTitle(pageTitle)
  // The tag list is a cache the backend rebuilds after a rename commits.
  useEffect(
    () =>
      subscribeToNameChanges((change) => {
        if (change.kind === 'invalidated') {
          void queryClient.invalidateQueries({ queryKey: ['tagOfPage'] })
        }
      }),
    [],
  )
  const { data: tag } = useQuery(
    {
      queryKey: ['tagOfPage', spaceId, tagName],
      enabled: spaceId !== null && tagName !== null,
      staleTime: 0,
      queryFn: async (): Promise<TagCacheRow | null> => {
        try {
          const tags = unwrap(await commands.listAllTagsInSpace(requireActiveScope(spaceId ?? '')))
          const key = nameKey(tagName ?? '')
          return tags.find((row) => nameKey(row.name) === key) ?? null
        } catch (err) {
          // The page reads whole without the link, so no toast.
          logger.warn('TagPageLink', 'Failed to look up the tag of a page', { pageTitle }, err)
          return null
        }
      },
    },
    queryClient,
  )
  if (tag == null) return null
  return (
    <Button
      variant="link"
      size="sm"
      className="self-start px-0"
      onClick={() => navigateToPage(tag.tag_id, tag.name)}
    >
      <Tag aria-hidden="true" />
      {t('tagNotes.openTag', { name: tag.name })}
    </Button>
  )
}
