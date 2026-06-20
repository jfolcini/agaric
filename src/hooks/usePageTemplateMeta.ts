/**
 * usePageTemplateMeta — page-level template + space metadata for
 * `PageHeader`.
 *
 * Loads the four property-derived booleans/refs the kebab menu and
 * `t('space.moveTo')` sub-menu need (`isTemplate`, `isJournalTemplate`,
 * `isSpaceBlock`, `pageSpaceId`), and exposes the toggle handlers for
 * the two template flags. The factory pattern (`createTemplateToggle`)
 * collapses the previously-duplicated template/journal-template
 * handlers into a single closure so adding a third template kind
 * costs one extra `useMemo` derivation rather than another copy-paste.
 *
 * Extracted from `PageHeader.tsx` (Phase 3b of the design-system
 * maintainability pass) so the orchestrator stays under the LOC budget
 * without forcing each handler into its own micro-component.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { deleteProperty, getProperties, setProperty } from '@/lib/tauri'

export interface UsePageTemplateMetaReturn {
  isTemplate: boolean
  isJournalTemplate: boolean
  isSpaceBlock: boolean
  /** The space id currently owning this page (or `null` for orphans). */
  pageSpaceId: string | null
  /** Setter used by the `t('space.moveTo')` flow once the move resolves. */
  setPageSpaceId: (id: string | null) => void
  /** Toggle `template=true`; flips the local flag + persists. */
  handleToggleTemplate: () => Promise<void>
  /** Toggle `journal-template=true`; flips the local flag + persists. */
  handleToggleJournalTemplate: () => Promise<void>
}

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
  const [isTemplate, setIsTemplate] = useState(false)
  const [isJournalTemplate, setIsJournalTemplate] = useState(false)
  // Phase 2 — `t('space.moveTo')` needs two bits of metadata that
  // aren't derivable from props: whether the current page is itself a
  // space block (moving spaces into spaces is nonsensical), and which
  // space currently owns it (so the destination list can exclude it).
  // Both come from the page's property set, loaded once and refreshed
  // when the page changes.
  const [isSpaceBlock, setIsSpaceBlock] = useState(false)
  const [pageSpaceId, setPageSpaceId] = useState<string | null>(null)

  useEffect(() => {
    if (!pageId) return
    getProperties(pageId)
      .then((props) => {
        setIsTemplate(props.some((p) => p.key === 'template' && p.value_text === 'true'))
        setIsJournalTemplate(
          props.some((p) => p.key === 'journal-template' && p.value_text === 'true'),
        )
        setIsSpaceBlock(props.some((p) => p.key === 'is_space' && p.value_text === 'true'))
        const spaceProp = props.find((p) => p.key === 'space')
        setPageSpaceId(spaceProp?.value_ref ?? null)
      })
      .catch((err: unknown) => {
        logger.warn(
          'PageHeader',
          'Failed to load template properties',
          {
            pageId,
          },
          err,
        )
      })
  }, [pageId])

  // The factory was previously a plain function expression inside the
  // component body. Moving it under `useMemo` keyed on `pageId/t` keeps
  // the two derived handlers stable across renders, matching the
  // original `useCallback` semantics of the rest of the file.
  const createTemplateToggle = useMemo(
    () =>
      (
        key: string,
        currentState: boolean,
        setState: (v: boolean) => void,
        removedKey: string,
        savedKey: string,
        failedKey: string,
      ) =>
      async () => {
        try {
          if (currentState) {
            await deleteProperty(pageId, key)
            setState(false)
            notify.success(t(removedKey))
          } else {
            await setProperty({ blockId: pageId, key, valueText: 'true' })
            setState(true)
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
        setIsTemplate,
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
        setIsJournalTemplate,
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
    pageSpaceId,
    setPageSpaceId,
    handleToggleTemplate,
    handleToggleJournalTemplate,
  }
}
