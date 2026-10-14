/**
 * usePageTemplateMeta — page-level template metadata for `PageHeader`.
 *
 * Loads the three property-derived booleans the kebab menu and
 * `t('space.moveTo')` sub-menu need (`isTemplate`, `isJournalTemplate`,
 * `isSpaceBlock`), and exposes the toggle handlers for
 * the two template flags. The factory pattern (`createTemplateToggle`)
 * collapses the previously-duplicated template/journal-template
 * handlers into a single closure so adding a third template kind
 * costs one extra `useMemo` derivation rather than another copy-paste.
 *
 * Extracted from `PageHeader.tsx` (Phase 3b of the design-system
 * maintainability pass) so the orchestrator stays under the LOC budget
 * without forcing each handler into its own micro-component.
 */

import { useCallback, useEffect, useMemo } from 'react'

import { usePageProperties } from '@/hooks/usePageProperties'
import { unwrap } from '@/lib/app-error'
import type { PropertyRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { pagePropertiesQueryKey } from '@/lib/property-caches'
import { queryClient } from '@/lib/query-client'

export interface UsePageTemplateMetaReturn {
  isTemplate: boolean
  isJournalTemplate: boolean
  isSpaceBlock: boolean
  /** Toggle `template=true`; flips the local flag + persists. */
  handleToggleTemplate: () => Promise<void>
  /** Toggle `journal-template=true`; flips the local flag + persists. */
  handleToggleJournalTemplate: () => Promise<void>
}

const isTrue = (props: PropertyRow[] | undefined, key: string): boolean =>
  props?.some((p) => p.key === key && p.value_text === 'true') ?? false

/**
 * `onAfterToggle` runs after every successful (or failed) template
 * toggle. The previous inline implementation closed the kebab menu in
 * exactly this slot, so we expose it as a callback rather than coupling
 * the hook to the kebab state itself.
 */
export function usePageTemplateMeta(
  pageId: string,
  t: (key: string) => string,
  onAfterToggle: () => void,
): UsePageTemplateMetaReturn {
  const { data: props, error } = usePageProperties(pageId)
  const isTemplate = isTrue(props, 'template')
  const isJournalTemplate = isTrue(props, 'journal-template')
  // `t('space.moveTo')` is hidden on a space block: spaces cannot be
  // moved into other spaces.
  const isSpaceBlock = isTrue(props, 'is_space')

  useEffect(() => {
    if (error) logger.warn('PageHeader', 'Failed to load template properties', { pageId }, error)
  }, [error, pageId])

  // The factory was previously a plain function expression inside the
  // component body. Moving it under `useMemo` keyed on `pageId/t` keeps
  // the two derived handlers stable across renders, matching the
  // original `useCallback` semantics of the rest of the file.
  const createTemplateToggle = useMemo(
    () =>
      (
        key: string,
        currentState: boolean,
        removedKey: string,
        savedKey: string,
        failedKey: string,
      ) =>
      async () => {
        try {
          if (currentState) {
            unwrap(await commands.deleteProperty(pageId, key))
            setStoredFlag(pageId, key, false)
            notify.success(t(removedKey))
          } else {
            unwrap(
              await commands.setProperty(pageId, key, {
                value_text: 'true',
                value_num: null,
                value_date: null,
                value_ref: null,
                value_bool: null,
              }),
            )
            setStoredFlag(pageId, key, true)
            notify.success(t(savedKey))
          }
        } catch (err) {
          logger.error(
            'PageHeader',
            'Failed to toggle template property',
            {
              pageId,
              key,
            },
            err,
          )
          notify.error(t(failedKey))
        }
        onAfterToggle()
      },
    [pageId, t, onAfterToggle],
  )

  const handleToggleTemplate = useCallback(
    () =>
      createTemplateToggle(
        'template',
        isTemplate,
        'pageHeader.templateRemoved',
        'pageHeader.templateSaved',
        'pageHeader.templateFailed',
      )(),
    [createTemplateToggle, isTemplate],
  )

  const handleToggleJournalTemplate = useCallback(
    () =>
      createTemplateToggle(
        'journal-template',
        isJournalTemplate,
        'pageHeader.journalTemplateRemoved',
        'pageHeader.journalTemplateSaved',
        'pageHeader.journalTemplateFailed',
      )(),
    [createTemplateToggle, isJournalTemplate],
  )

  return {
    isTemplate,
    isJournalTemplate,
    isSpaceBlock,
    handleToggleTemplate,
    handleToggleJournalTemplate,
  }
}

/** Mirror a confirmed flag write into the shared page-properties cache. */
function setStoredFlag(pageId: string, key: string, on: boolean): void {
  queryClient.setQueryData<PropertyRow[]>(pagePropertiesQueryKey(pageId), (rows = []) => {
    const others = rows.filter((p) => p.key !== key)
    if (!on) return others
    return [
      ...others,
      {
        key,
        value_text: 'true',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    ]
  })
}
