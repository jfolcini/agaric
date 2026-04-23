/**
 * TabBar — horizontal tab bar mounted at the app-shell level (FEAT-7).
 *
 * Renders one button per open tab. Hidden when only a single tab is open, or
 * when the viewport is below the mobile breakpoint (FEAT-7 makes tabs a
 * desktop-only affordance — mobile users navigate via sidebar + breadcrumbs).
 * Each tab shows the page title (label) and a close area (X icon).
 *
 * Active-tab styling depends on the current view (FEAT-7 item 2):
 * - In `page-editor`: filled/focused look (`bg-background` + bordered bottom
 *   attachment) signalling the user is editing the tab's page.
 * - In any other view: muted/outlined look (`sidebar-accent` background +
 *   `sidebar-accent-foreground` text) mirroring `SidebarMenuButton`'s
 *   active-state tokens — reads as "these are your tabs; click to return".
 *
 * Clicking the active tab's label opens a dropdown switcher listing every
 * open tab (FEAT-8). The dropdown reuses the `Popover` primitive because the
 * repo does not (yet) ship a `DropdownMenu` primitive — the behaviour is
 * equivalent: one anchor, one portaled content region, Escape closes,
 * outside-click closes.
 *
 * Implements ARIA tablist pattern with ArrowLeft/ArrowRight + Home/End
 * keyboard navigation using automatic activation (focus follows selection).
 *
 * The close area is a `<span>` (not a `<button>`) to avoid nested-interactive
 * a11y violations inside `role="tab"`. Close also available via Ctrl+W.
 */

import { Check, ChevronDown, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { getShortcutKeys } from '../lib/keyboard-config'
import { useNavigationStore } from '../stores/navigation'

export function TabBar(): React.ReactElement | null {
  const { t } = useTranslation()
  const tabs = useNavigationStore((s) => s.tabs)
  const activeTabIndex = useNavigationStore((s) => s.activeTabIndex)
  const currentView = useNavigationStore((s) => s.currentView)
  const switchTab = useNavigationStore((s) => s.switchTab)
  const closeTab = useNavigationStore((s) => s.closeTab)

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const keyNavRef = useRef(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const isMobile = useIsMobile()

  const { handleKeyDown: handleListKeyDown } = useListKeyboardNavigation({
    itemCount: tabs.length,
    horizontal: true,
    homeEnd: true,
    wrap: true,
  })

  // Focus the active tab button after a keyboard-triggered tab switch
  useEffect(() => {
    if (keyNavRef.current) {
      tabRefs.current[activeTabIndex]?.focus()
      keyNavRef.current = false
    }
  }, [activeTabIndex])

  // FEAT-7 scope item 6: TabBar is desktop-only. Mobile users navigate via
  // sidebar + breadcrumbs; the `openInNewTab` IPC surface collapses to a
  // plain `navigateToPage` on mobile (handled at the call site).
  if (isMobile) return null

  // Per FEAT-7 decision: autohide guard preserved by explicit user direction
  // in session 461.
  if (tabs.length <= 1) return null

  function handleTabClick(i: number, e: React.MouseEvent) {
    // Check if the click was on the close icon (data-close attribute)
    const target = e.target as HTMLElement
    if (target.closest('[data-tab-close]')) {
      e.stopPropagation()
      closeTab(i)
      return
    }
    // FEAT-8: clicking the active tab's label opens the dropdown switcher
    // (desktop-only by virtue of the earlier `isMobile` early-return).
    if (i === activeTabIndex && currentView === 'page-editor') {
      setDropdownOpen((prev) => !prev)
      return
    }
    switchTab(i)
  }

  function handleTabKeyDown(i: number, e: React.KeyboardEvent) {
    // Delete / Backspace on a tab closes it
    const closeKeys = getShortcutKeys('closeTabOnFocus')
      .split('/')
      .map((k) => k.trim().toLowerCase())
    if (closeKeys.includes(e.key.toLowerCase())) {
      e.preventDefault()
      closeTab(i)
      return
    }

    // Arrow key navigation with automatic activation
    if (handleListKeyDown(e)) {
      e.preventDefault()
      // Compute the new index manually (useState is async)
      let newIndex = i
      if (e.key === 'ArrowRight') newIndex = i >= tabs.length - 1 ? 0 : i + 1
      else if (e.key === 'ArrowLeft') newIndex = i <= 0 ? tabs.length - 1 : i - 1
      else if (e.key === 'Home') newIndex = 0
      else if (e.key === 'End') newIndex = tabs.length - 1
      keyNavRef.current = true
      switchTab(newIndex)
    }
  }

  // FEAT-7 item 2: the active-tab look depends on whether the user is in the
  // page-editor view. In any other view we fall back to muted/outlined tokens
  // borrowed from `SidebarMenuButton`'s active state so the visual reads as
  // "you can click these to return to the editor".
  const activeInEditorClass = 'bg-background border border-b-0 border-border font-medium'
  const activeOutsideEditorClass =
    'bg-sidebar-accent text-sidebar-accent-foreground border border-b-0 border-sidebar-border'
  const inactiveClass = 'text-muted-foreground hover:bg-accent/50'

  function tabClassName(i: number): string {
    if (i !== activeTabIndex) return inactiveClass
    return currentView === 'page-editor' ? activeInEditorClass : activeOutsideEditorClass
  }

  return (
    <ScrollArea orientation="horizontal" className="border-b border-border bg-muted/30">
      <div
        role="tablist"
        aria-label={t('tabs.tabList')}
        // Left edge matches `<header>` (px-4) and the Recent / ViewHeaderOutletSlot
        // rows below (px-4 md:px-6) so the full chrome stack aligns vertically.
        className="flex items-center gap-1 px-4 md:px-6 py-1 min-w-0"
      >
        <Popover open={dropdownOpen} onOpenChange={setDropdownOpen}>
          {tabs.map((tab, i) => {
            const isActive = i === activeTabIndex
            const showDropdownHint = isActive && currentView === 'page-editor'
            const button = (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[i] = el
                }}
                type="button"
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                aria-haspopup={showDropdownHint ? 'menu' : undefined}
                aria-expanded={showDropdownHint ? dropdownOpen : undefined}
                className={cn(
                  'flex items-center gap-1 px-3 py-1 text-sm rounded-t-md truncate max-w-[120px] md:max-w-[200px] cursor-pointer select-none',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-hidden',
                  tabClassName(i),
                )}
                onClick={(e) => handleTabClick(i, e)}
                onKeyDown={(e) => handleTabKeyDown(i, e)}
              >
                <span className="truncate">{tab.label || t('tabs.untitled')}</span>
                {showDropdownHint && (
                  <ChevronDown className="size-3 opacity-50 ml-1" aria-hidden="true" />
                )}
                <span
                  data-tab-close=""
                  className="ml-1 rounded-sm hover:bg-destructive/20 p-0.5 inline-flex"
                  aria-hidden="true"
                >
                  <X className="size-3" />
                </span>
              </button>
            )

            // Only the active tab anchors the dropdown; inactive tabs render
            // as bare buttons so their clicks switch tabs.
            return isActive ? (
              <PopoverAnchor key={tab.id} asChild>
                {button}
              </PopoverAnchor>
            ) : (
              button
            )
          })}
          <PopoverContent
            align="start"
            sideOffset={4}
            className="w-64 p-1 max-w-[calc(100vw-2rem)]"
            role="menu"
            aria-label={t('tabs.tabList')}
          >
            {tabs.map((tab, i) => {
              const isActive = i === activeTabIndex
              return (
                <div
                  key={tab.id}
                  role="menuitemradio"
                  aria-checked={isActive}
                  data-state={isActive ? 'checked' : 'unchecked'}
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent cursor-pointer data-[state=checked]:bg-accent/60 touch-target focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
                  onClick={() => {
                    switchTab(i)
                    setDropdownOpen(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      switchTab(i)
                      setDropdownOpen(false)
                    }
                  }}
                >
                  <span
                    className="inline-flex size-4 shrink-0 items-center justify-center"
                    aria-hidden="true"
                  >
                    {isActive ? <Check className="size-3" /> : null}
                  </span>
                  <span className="flex-1 truncate">{tab.label || t('tabs.untitled')}</span>
                  <button
                    type="button"
                    data-tab-dropdown-close=""
                    className="ml-auto inline-flex rounded-sm p-0.5 hover:bg-destructive/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
                    aria-label={t('tabs.closeTab', { label: tab.label || t('tabs.untitled') })}
                    onClick={(e) => {
                      // Keep the dropdown open when the close button fires —
                      // the user likely wants to prune several tabs in a row.
                      e.stopPropagation()
                      e.preventDefault()
                      closeTab(i)
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
          </PopoverContent>
        </Popover>
      </div>
    </ScrollArea>
  )
}
