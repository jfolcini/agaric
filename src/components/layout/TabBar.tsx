/**
 * TabBar — horizontal tab bar mounted at the app-shell level.
 *
 * Renders one button per open tab. Hidden when only a single tab is open, or
 * When the viewport is below the mobile breakpoint (makes tabs a
 * desktop-only affordance — mobile users navigate via sidebar + breadcrumbs).
 * Each tab shows the page title (label) and a close area (X icon).
 *
 * The strip is a recessed band that ends in a hairline. The active tab is
 * attached to the content below it: it takes the page background, covers the
 * hairline beneath itself, and carries a 2 px `tab-indicator` bar along its
 * square top edge, with no other border. In `page-editor` its label is
 * `text-foreground font-medium`; in any other view the same shape keeps
 * `text-muted-foreground`, because the tab is selected but its page is not
 * the one on screen. Inactive tabs are plain muted text on the strip.
 *
 * A caret button left of the strip opens `TabSwitcher`: every open tab under
 * a filter input, as Chrome's tab search. Clicking a tab only activates it.
 *
 * Implements ARIA tablist pattern with ArrowLeft/ArrowRight + Home/End
 * keyboard navigation using automatic activation (focus follows selection).
 *
 * The close area is a `<span>` (not a `<button>`) to avoid nested-interactive
 * a11y violations inside `role="tab"` (and `role="option"` in the switcher).
 * Close also available via Ctrl+W and Delete / Backspace on a focused tab.
 */

import { cva } from 'class-variance-authority'
import { Check, ChevronDown, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useJournalDateFormat } from '@/hooks/useJournalDateFormat'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { formatJournalTitle, isDateFormattedPage } from '@/lib/date-utils'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { getPageDisplayName } from '@/lib/page-display'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import {
  selectActiveTabIndexForSpace,
  selectTabsForSpace,
  type Tab,
  useTabsStore,
} from '@/stores/tabs'

// Every tab overlaps the strip's hairline (`-mb-px`) so the active one's
// background opens into the content. The strip's scroll viewport clips below
// that line, so the focus ring is drawn inside the tab.
const tabVariants = cva(
  'flex items-center gap-1 px-3 py-1 -mb-px border-t-2 text-sm truncate max-w-[120px] md:max-w-[200px] cursor-pointer select-none focus-ring-visible focus-visible:ring-inset',
  {
    variants: {
      state: {
        inactive: 'rounded-t-md border-t-transparent text-muted-foreground hover:bg-accent/50',
        editing: 'border-t-tab-indicator bg-background font-medium text-foreground',
        elsewhere: 'border-t-tab-indicator bg-background text-muted-foreground',
      },
    },
  },
)

interface TabSwitcherProps {
  tabs: Tab[]
  activeTabIndex: number
  displayLabel: (fullPath: string) => string
  onActivate: (index: number) => void
  onClose: (index: number) => void
}

/**
 * Lists every open tab under a filter input. The filter is a case-insensitive
 * substring over the shown label and the full path; the list is in memory, so
 * there is no debounce. cmdk supplies the combobox: focus starts in the input,
 * ArrowUp / ArrowDown move through the matches, Enter activates.
 */
function TabSwitcher({
  tabs,
  activeTabIndex,
  displayLabel,
  onActivate,
  onClose,
}: TabSwitcherProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const rows = tabs.flatMap((tab, index) => {
    const fullPath = tab.label || t('tabs.untitled')
    const title = displayLabel(fullPath)
    const matches = title.toLowerCase().includes(needle) || fullPath.toLowerCase().includes(needle)
    return matches ? [{ tab, index, fullPath, title }] : []
  })

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <IconButton
          variant="ghost"
          size="icon-xs"
          ariaLabel={t('tabs.switcher')}
          tooltip={t('tabs.switcher')}
          className="mr-1 shrink-0 self-center"
        >
          <ChevronDown />
        </IconButton>
      </PopoverTrigger>
      <MenuPopoverContent align="start" className="w-72 p-0" aria-label={t('tabs.switcher')}>
        <Command shouldFilter={false} loop label={t('tabs.switcher')}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('tabs.switcherFilter')}
          />
          <CommandList>
            <CommandEmpty>{t('tabs.switcherNoMatch')}</CommandEmpty>
            {rows.map(({ tab, index, fullPath, title }) => (
              <CommandItem
                key={tab.id}
                value={tab.id}
                title={fullPath}
                className="gap-2"
                onSelect={() => {
                  onActivate(index)
                  setOpen(false)
                  setQuery('')
                }}
              >
                <span className="inline-flex size-4 shrink-0 items-center justify-center">
                  {index === activeTabIndex ? (
                    <>
                      <Check className="size-3" aria-hidden="true" />
                      <span className="sr-only">{t('tabs.activeTab')}</span>
                    </>
                  ) : null}
                </span>
                <span className="flex-1 truncate">{title}</span>
                {/* Mouse close, as on the strip: a widget inside an option is a
                    nested-interactive violation. The menu stays open so several
                    tabs can be pruned in a row; at one tab the bar unmounts. */}
                <span
                  data-tab-switcher-close=""
                  aria-hidden="true"
                  className="inline-flex shrink-0 items-center justify-center rounded-sm p-1 hover:bg-destructive/20 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(index)
                  }}
                >
                  <X className="size-3" />
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </MenuPopoverContent>
    </Popover>
  )
}

export function TabBar(): React.ReactElement | null {
  const { t } = useTranslation()
  // #1448 — DISPLAY-ONLY journal-tab title formatting. `fullPath`/`tab.label`
  // remain the canonical ISO identity (used for the `title=` tooltip, switching,
  // and close announcements); only the visible leaf label is reformatted.
  const { journalDateFormat } = useJournalDateFormat()
  const displayLabel = (fullPath: string): string => {
    const leaf = getPageDisplayName(fullPath, 'leaf').label
    return isDateFormattedPage(fullPath) ? formatJournalTitle(fullPath, journalDateFormat) : leaf
  }
  // Phase 3 — read tabs through the per-space selector so tabs
  // opened in space-A never bleed into space-B's bar.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const tabs = useTabsStore((s) => selectTabsForSpace(s, currentSpaceId))
  const activeTabIndex = useTabsStore((s) => selectActiveTabIndexForSpace(s, currentSpaceId))
  const currentView = useNavigationStore((s) => s.currentView)
  const switchTab = useTabsStore((s) => s.switchTab)
  const closeTab = useTabsStore((s) => s.closeTab)

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const keyNavRef = useRef(false)
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

  // Scope item 6: TabBar is desktop-only. Mobile users navigate via
  // sidebar + breadcrumbs; the `openInNewTab` IPC surface collapses to a
  // plain `navigateToPage` on mobile (handled at the call site).
  if (isMobile) return null

  // Per decision: autohide guard preserved by explicit user direction
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

  function tabState(i: number): 'inactive' | 'editing' | 'elsewhere' {
    if (i !== activeTabIndex) return 'inactive'
    return currentView === 'page-editor' ? 'editing' : 'elsewhere'
  }

  return (
    // Left edge matches the Recent / ViewHeaderOutletSlot rows below so the
    // chrome stack aligns vertically. The hairline is drawn twice, under the
    // caret and on the tablist, because each tab overlaps the tablist's own.
    <div className="flex min-w-0 bg-muted/30">
      <div className="flex shrink-0 border-b border-border pl-4 md:pl-6 md:pointer-fine:pl-16 pt-1">
        <TabSwitcher
          tabs={tabs}
          activeTabIndex={activeTabIndex}
          displayLabel={displayLabel}
          onActivate={switchTab}
          onClose={closeTab}
        />
      </div>
      <ScrollArea orientation="horizontal" className="min-w-0 flex-1">
        <div
          role="tablist"
          aria-label={t('tabs.tabList')}
          className="flex items-end gap-1 border-b border-border pr-4 md:pr-6 pt-1 min-w-0"
        >
          {tabs.map((tab, i) => {
            const isActive = i === activeTabIndex
            // Bug 1: tabs are space-constrained (`max-w-[120px]
            // md:max-w-[200px]` + `truncate`) — full namespaced paths
            // overflow fast. Display the LEAF only and surface the full
            // path via `title=""` for hover. The empty-label fallback to
            // "Untitled" is preserved verbatim so the existing label test
            // keeps passing.
            const fullPath = tab.label || t('tabs.untitled')
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[i] = el
                }}
                type="button"
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                title={fullPath}
                className={tabVariants({ state: tabState(i) })}
                onClick={(e) => handleTabClick(i, e)}
                onKeyDown={(e) => handleTabKeyDown(i, e)}
              >
                <span className="truncate">{displayLabel(fullPath)}</span>
                <span
                  data-tab-close=""
                  className="ml-1 rounded-sm hover:bg-destructive/20 p-0.5 inline-flex"
                  aria-hidden="true"
                >
                  <X className="size-3" />
                </span>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
