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

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

export interface UsePageTemplateMetaReturn {
  isTemplate: boolean
  isJournalTemplate: boolean
  isSpaceBlock: boolean
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
  // `t('space.moveTo')` is hidden on a space block: spaces cannot be
  // moved into other spaces. Refreshed when the page or (#5287: sync, MCP,
  // undo) its properties change.
  const [isSpaceBlock, setIsSpaceBlock] = useState(false)
  const { invalidationKey } = useBlockPropertyEvents()

  useEffect(() => {
    if (!pageId) return
    // A property event can start this load just before a page switch; the
    // older page's answer must not set the new page's flags.
    let active = true
    commands
      .getProperties(pageId)
      .then(unwrap)
      .then((props) => {
        if (!active) return
        setIsTemplate(props.some((p) => p.key === 'template' && p.value_text === 'true'))
        setIsJournalTemplate(
          props.some((p) => p.key === 'journal-template' && p.value_text === 'true'),
        )
        setIsSpaceBlock(props.some((p) => p.key === 'is_space' && p.value_text === 'true'))
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
    return () => {
      active = false
    }
  }, [pageId, invalidationKey])

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
            unwrap(await commands.deleteProperty(pageId, key))
            setState(false)
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
    handleToggleTemplate,
    handleToggleJournalTemplate,
  }
}
