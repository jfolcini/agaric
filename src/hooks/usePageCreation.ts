/**
 * usePageCreation — the create-page flow for the Pages view.
 *
 * Owns the new-page name input state, the in-flight `isCreating` flag,
 * the form/input refs (incl. primary-focus registration and the
 * unmount-cancelled focus timer), and the two creation handlers:
 *
 *  - `handleCreatePage`: creates a page in the active space, then either
 *    optimistically prepends a `BlockRow` + bumps the count chip (the
 *    common unfiltered case) or `reload()`s when chips are active
 *and finally selects the new page. Distinguishes
 *    duplicate-name conflicts from generic failures for the toast.
 *  - `handleCreateUnder`: seeds the input with a namespace prefix and
 * Focuses it after a 0ms timer (cancelled on unmount, #).
 *
 * Extracted verbatim from `PageBrowser.tsx` (#1263). Pure move — same
 * effects, same deps, same timing, same optimistic-update behaviour.
 */

import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { notify } from '@/lib/notify'

import { isConflict } from '../lib/app-error'
import type { BlockRow, FilterPrimitive, PageWithMetadataRow } from '../lib/tauri'
import { createPageInSpace } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { useRegisterPrimaryFocus } from './usePrimaryFocus'

interface UsePageCreationParams {
  wireFilters: FilterPrimitive[]
  reload: () => void
  setPages: Dispatch<SetStateAction<(BlockRow | PageWithMetadataRow)[]>>
  setDisplayTotalCount: Dispatch<SetStateAction<number | undefined>>
  onPageSelect?: ((pageId: string, title?: string) => void) | undefined
}

interface UsePageCreationResult {
  newPageName: string
  setNewPageName: Dispatch<SetStateAction<string>>
  isCreating: boolean
  handleCreatePage: () => Promise<void>
  handleCreateUnder: (namespacePath: string) => void
  formRef: RefObject<HTMLFormElement | null>
  newPageInputRef: RefObject<HTMLInputElement | null>
}

export function usePageCreation({
  wireFilters,
  reload,
  setPages,
  setDisplayTotalCount,
  onPageSelect,
}: UsePageCreationParams): UsePageCreationResult {
  const { t } = useTranslation()

  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const newPageInputRef = useRef<HTMLInputElement>(null)
  // Register the "new page" input as the primary-focus target for this view
  // so switching to Pages via sidebar lands the cursor in the create form
  // Instead of the generic #main-content container.
  useRegisterPrimaryFocus(newPageInputRef)
  // Tracks the handleCreateUnder focus setTimeout so we can cancel it on
  // Unmount and avoid focusing a stale DOM node (#).
  const pendingFocusRef = useRef<number | null>(null)

  // Clear any pending focus timer on unmount.
  useEffect(
    () => () => {
      if (pendingFocusRef.current !== null) {
        window.clearTimeout(pendingFocusRef.current)
        pendingFocusRef.current = null
      }
    },
    [],
  )

  const handleCreatePage = useCallback(async () => {
    const name = newPageName.trim() || t('pageBrowser.untitled')
    // Phase 2 — a page must belong to a space. On the rare
    // first-boot path where `SpaceStore` has not yet hydrated we
    // refuse to create and surface a toast rather than silently
    // creating an unscoped page. The `isReady` gate above normally
    // prevents this branch from firing.
    const activeSpaceId = useSpaceStore.getState().currentSpaceId
    if (activeSpaceId == null) {
      notify.error(t('pageBrowser.spaceNotReady'))
      return
    }
    setIsCreating(true)
    try {
      const newId = await createPageInSpace({ content: name, spaceId: activeSpaceId })
      setNewPageName('')
      // The optimistic prepend assumes the new page belongs
      // at the top of the *current* result set. That only holds when no
      // compound-filter chips are active: with chips the server decides
      // membership (the new page may or may not match), and the prepended
      // row also lacks the metadata the density rows read. When chips are
      // active we refetch from page 1 instead, so the new page surfaces
      // only if it actually matches — and with full metadata. The fast
      // optimistic path is kept for the unfiltered case (the common one).
      if (wireFilters.length > 0) {
        reload()
      } else {
        const newPage: BlockRow = {
          id: newId,
          block_type: 'page',
          content: name,
          parent_id: null,
          position: null,
          deleted_at: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: newId,
        }
        setPages((prev) => [newPage, ...prev])
        // Keep the count chip in step with the optimistic prepend (mirror
        // of the D20 delete decrement). The chip-active branch above
        // refetches, which re-runs the backend COUNT, so no manual bump
        // is needed there.
        setDisplayTotalCount((cur) => (typeof cur === 'number' ? cur + 1 : cur))
      }
      onPageSelect?.(newId, name)
    } catch (error) {
      // Issue #106 — distinguish duplicate-name conflicts from generic
      // DB failures. A conflict is user-actionable ("pick a different
      // name"), not a system error worth a Retry button.
      if (isConflict(error)) {
        notify.error(t('pageBrowser.duplicateName'))
      } else {
        notify.error(t('pageBrowser.createFailed', { error: String(error) }), {
          action: { label: t('pageBrowser.retry'), onClick: () => handleCreatePage() },
        })
      }
    }
    setIsCreating(false)
  }, [newPageName, setPages, setDisplayTotalCount, t, onPageSelect, wireFilters, reload])

  const handleCreateUnder = useCallback((namespacePath: string) => {
    setNewPageName(`${namespacePath}/`)
    if (pendingFocusRef.current !== null) {
      window.clearTimeout(pendingFocusRef.current)
    }
    pendingFocusRef.current = window.setTimeout(() => {
      pendingFocusRef.current = null
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    }, 0)
  }, [])

  return {
    newPageName,
    setNewPageName,
    isCreating,
    handleCreatePage,
    handleCreateUnder,
    formRef,
    newPageInputRef,
  }
}
