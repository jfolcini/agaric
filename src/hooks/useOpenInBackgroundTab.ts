/**
 * Opening a page in a background tab, the way a browser opens a middle-clicked
 * link: a new tab behind the active one, with the view left as it is. A
 * Ctrl/Cmd+click on a link chip opens its target in a new tab in front.
 */

import type React from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useIsMobile } from '@/hooks/useIsMobile'
import { announce } from '@/lib/announcer'
import type { NavigateToPageFn } from '@/lib/block-events'
import { pageLinkIdAt } from '@/lib/link-chip'
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

/** Opens a link chip's target in a new tab, behind the active one unless `inForeground`. */
export type OpenLinkInNewTab = (linkId: string, inForeground?: boolean) => void

/**
 * The opener for a link chip's target, given the editor's link navigation
 * (`useBlockNavigateToLink`), or `undefined` on mobile, as `useOpenInBackgroundTab`.
 */
export function useOpenLinkInNewTab(
  navigate: (linkId: string, openPage: NavigateToPageFn) => Promise<void>,
): OpenLinkInNewTab | undefined {
  const openInBackgroundTab = useOpenInBackgroundTab()
  const openInNewTab = useTabsStore((s) => s.openInNewTab)
  return useMemo(
    () =>
      openInBackgroundTab &&
      ((linkId, inForeground = false) =>
        void navigate(linkId, (pageId, title = '', blockId) => {
          if (inForeground) openInNewTab(pageId, title, blockId)
          else openInBackgroundTab(pageId, title)
        })),
    [navigate, openInBackgroundTab, openInNewTab],
  )
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

export interface LinkClickProps extends MiddleClickProps {
  onClickCapture: (e: React.MouseEvent) => void
}

/**
 * Mouse props for a container of link chips: a middle click on a chip opens
 * its target in a background tab, a Ctrl/Cmd+click in a new tab in front. A
 * click anywhere else is left alone, so Ctrl+click still selects a block.
 */
export function delegatedLinkClickProps(open: OpenLinkInNewTab): LinkClickProps {
  return {
    ...delegatedMiddleClickProps((e) => {
      const linkId = pageLinkIdAt(e.target)
      return linkId === undefined ? undefined : () => open(linkId)
    }),
    // Capture: a chip's own click handler stops the click and follows the link in this tab.
    onClickCapture: (e) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return
      const linkId = pageLinkIdAt(e.target)
      if (linkId === undefined) return
      e.preventDefault()
      // Stopped at this container, not at the React root this runs on, so a
      // listener between the two still sees the click: the ref peek closes on it.
      const click = e.nativeEvent
      e.currentTarget.addEventListener(
        'click',
        (native) => {
          if (native === click) native.stopPropagation()
        },
        { capture: true, once: true },
      )
      open(linkId, true)
    },
  }
}
