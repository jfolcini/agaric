/**
 * TabBar — horizontal tab bar above the page editor.
 *
 * Renders one button per open tab. Hidden when only a single tab is open.
 * Each tab shows the page title (label) and a close area (X icon).
 *
 * Implements ARIA tablist pattern with ArrowLeft/ArrowRight + Home/End
 * keyboard navigation using automatic activation (focus follows selection).
 *
 * The close area is a `<span>` (not a `<button>`) to avoid nested-interactive
 * a11y violations inside `role="tab"`. Close also available via Ctrl+W.
 */

import { X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { useNavigationStore } from '../stores/navigation'

export function TabBar(): React.ReactElement | null {
  const { t } = useTranslation()
  const tabs = useNavigationStore((s) => s.tabs)
  const activeTabIndex = useNavigationStore((s) => s.activeTabIndex)
  const switchTab = useNavigationStore((s) => s.switchTab)
  const closeTab = useNavigationStore((s) => s.closeTab)

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const keyNavRef = useRef(false)

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

  // Hide bar when only a single tab is open
  if (tabs.length <= 1) return null

  function handleTabClick(i: number, e: React.MouseEvent) {
    // Check if the click was on the close icon (data-close attribute)
    const target = e.target as HTMLElement
    if (target.closest('[data-tab-close]')) {
      e.stopPropagation()
      closeTab(i)
      return
    }
    switchTab(i)
  }

  function handleTabKeyDown(i: number, e: React.KeyboardEvent) {
    // Delete / Backspace on a tab closes it
    if (e.key === 'Delete' || e.key === 'Backspace') {
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

  return (
    <div
      className="flex items-center gap-1 border-b border-border px-2 py-1 bg-muted/30 overflow-x-auto"
      role="tablist"
      aria-label={t('tabs.tabList')}
    >
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            tabRefs.current[i] = el
          }}
          type="button"
          role="tab"
          tabIndex={i === activeTabIndex ? 0 : -1}
          aria-selected={i === activeTabIndex}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-sm rounded-t-md truncate max-w-[200px] cursor-pointer select-none',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-hidden',
            i === activeTabIndex
              ? 'bg-background border border-b-0 border-border font-medium'
              : 'text-muted-foreground hover:bg-accent/50',
          )}
          onClick={(e) => handleTabClick(i, e)}
          onKeyDown={(e) => handleTabKeyDown(i, e)}
        >
          <span className="truncate">{tab.label || t('tabs.untitled')}</span>
          <span
            data-tab-close=""
            className="ml-1 rounded-sm hover:bg-destructive/20 p-0.5 inline-flex"
            aria-hidden="true"
          >
            <X className="size-3" />
          </span>
        </button>
      ))}
    </div>
  )
}
