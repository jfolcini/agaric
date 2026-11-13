/**
 * usePageCreation — the create handler behind the New page dialog.
 *
 * `createPage(name)` creates a page in the active space and returns it, or
 * the page that already carries `name` in any case or normal form
 * (`create_page_in_space` resolves an existing title to that page, #6278),
 * under its own title. A blank name takes the first free `Untitled N`. The
 * backend answers both (`resolve_page_title`, #6527). A failure is mapped to
 * a message in `createError` (a duplicate-name conflict is user-actionable,
 * anything else is not) and `createPage` returns `null`, so the caller can
 * keep its form open.
 *
 * The Pages list is not patched here: every local write marks it stale
 * (`watchLocalWrites` → `invalidatePageBrowserData`), and the caller opens the
 * new page, which unmounts the list anyway.
 */

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { announce } from '@/lib/announcer'
import { isConflict, unwrap, validationCode } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notifyPageAdded } from '@/lib/name-change-bus'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { requireActiveScope } from '@/lib/space-scope'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

export interface CreatedPage {
  id: string
  title: string
}

interface UsePageCreationResult {
  isCreating: boolean
  /** Why the last `createPage` failed, or `null`. */
  createError: string | null
  clearCreateError: () => void
  createPage: (name: string) => Promise<CreatedPage | null>
}

export function usePageCreation(): UsePageCreationResult {
  const { t } = useTranslation()
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // A double Enter must not create twice.
  const inFlightRef = useRef(false)

  const clearCreateError = useCallback(() => setCreateError(null), [])

  const createPage = useCallback(
    async (rawName: string): Promise<CreatedPage | null> => {
      if (inFlightRef.current) return null
      const activeSpaceId = useSpaceStore.getState().currentSpaceId
      if (activeSpaceId == null) {
        setCreateError(t('pageBrowser.spaceNotReady'))
        return null
      }
      inFlightRef.current = true
      setIsCreating(true)
      setCreateError(null)
      try {
        // #4723 — `create_page_in_space` RESOLVES an existing title to that
        // page instead of creating one, so ask first: a taken title is
        // opened under its own title, and a blank name gets a free `Untitled N`.
        const resolved = unwrap(
          await commands.resolvePageTitle(rawName.trim(), requireActiveScope(activeSpaceId)),
        )
        if (resolved.page_id !== null) return { id: resolved.page_id, title: resolved.title }
        const name = resolved.title
        const id = unwrap(await commands.createPageInSpace(null, name, activeSpaceId))
        // #4338 — publish so a warm `[[` picker cache offers the page at once.
        notifyPageAdded(id, name, activeSpaceId)
        useResolveStore.getState().set(id, name, false)
        announce(t('announce.newPageCreated'))
        return { id, title: name }
      } catch (error) {
        logger.warn('usePageCreation', 'create page failed', { name: rawName }, error)
        // #6278 — another page's alias refuses the create.
        const duplicate =
          isConflict(error) || validationCode(error) === ValidationCode.DuplicatePageTitle
        setCreateError(
          duplicate
            ? t('pageBrowser.duplicateName')
            : t('pageBrowser.createFailed', { error: String(error) }),
        )
        return null
      } finally {
        inFlightRef.current = false
        setIsCreating(false)
      }
    },
    [t],
  )

  return { isCreating, createError, clearCreateError, createPage }
}
