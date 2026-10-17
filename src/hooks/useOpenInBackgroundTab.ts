/**
 * Opening a page in a background tab, the way a browser opens a middle-clicked
 * link: a new tab behind the active one, with the view left as it is.
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { useIsMobile } from '@/hooks/useIsMobile'
import { announce } from '@/lib/announcer'
import { useTabsStore } from '@/stores/tabs'

export type OpenInBackgroundTab = (pageId: string, title: string) => void

/**
 * The opener, or `undefined` on mobile, where `TabBar` is hidden and a
 * background tab could never be reached.
 */
export function useOpenInBackgroundTab(): OpenInBackgroundTab | undefined {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const openInBackgroundTab = useTabsStore((s) => s.openInBackgroundTab)
  const open = useCallback<OpenInBackgroundTab>(
    (pageId, title) => {
      openInBackgroundTab(pageId, title)
      // Nothing on screen moves, so a screen reader would hear nothing.
      announce(t('tabs.openedInBackground', { title }))
    },
    [openInBackgroundTab, t],
  )
  return isMobile ? undefined : open
}

export interface MiddleClickProps {
  onMouseDown?: (e: React.MouseEvent) => void
  onMouseUp?: (e: React.MouseEvent) => void
  onAuxClick?: (e: React.MouseEvent) => void
}

/**
 * Mouse props that hand a middle click to the opener `openFor` returns for the
 * event's target; `undefined` means the target opens nothing and leaves the
 * click to the browser. A middle click fires no `click`, so the element's own
 * navigation never runs; the browser's own middle-button actions, autoscroll
 * on `mousedown` and the X11 primary-selection paste on `mouseup`, are
 * cancelled.
 */
export function delegatedMiddleClickProps(
  openFor: (e: React.MouseEvent) => (() => void) | undefined,
): MiddleClickProps {
  const cancel = (e: React.MouseEvent) => {
    if (e.button === 1 && openFor(e) !== undefined) e.preventDefault()
  }
  return {
    onMouseDown: cancel,
    onMouseUp: cancel,
    onAuxClick: (e) => {
      if (e.button !== 1) return
      const open = openFor(e)
      if (open === undefined) return
      e.preventDefault()
      // The innermost target wins: an enclosing row must not open its page too.
      e.stopPropagation()
      open()
    },
  }
}
