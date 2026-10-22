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
 * Dragging a tab, or Space, arrows, Space, moves it, as the sidebar's
 * bookmarks move (`reorder-dnd.ts`).
 *
 * The close area is a `<span>` (not a `<button>`) to avoid nested-interactive
 * a11y violations inside `role="tab"` (and `role="option"` in the switcher).
 * Close also available via a middle click, Ctrl+W and Delete / Backspace on a
 * focused tab.
 */

import { closestCenter, DndContext, type DragEndEvent, type UniqueIdentifier } from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cva } from 'class-variance-authority'
import { ChevronDown, X } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { reorderAccessibility, useReorderSensors } from '@/components/layout/reorder-dnd'
import type { TabSwitcherListProps } from '@/components/layout/TabSwitcherList'
import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useJournalDateFormat } from '@/hooks/useJournalDateFormat'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { delegatedMiddleClickProps } from '@/hooks/useOpenInBackgroundTab'
import { formatJournalTitle, isDateFormattedPage } from '@/lib/date-utils'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { getPageDisplayName } from '@/lib/page-display'
import { cn } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { selectActiveTabIndexForSpace, selectTabsForSpace, useTabsStore } from '@/stores/tabs'

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

// #5441 — lazy: cmdk loads when the switcher first opens.
const TabSwitcherList = lazy(() =>
  import('@/components/layout/TabSwitcherList').then((m) => ({ default: m.TabSwitcherList })),
)

function TabSwitcher({ onActivate, ...listProps }: TabSwitcherListProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <Suspense fallback={null}>
          <TabSwitcherList
            {...listProps}
            onActivate={(index) => {
              onActivate(index)
              setOpen(false)
            }}
          />
        </Suspense>
      </MenuPopoverContent>
    </Popover>
  )
}

interface SortableTabProps {
  id: string
  isActive: boolean
  state: 'inactive' | 'editing' | 'elsewhere'
  fullPath: string
  label: string
  buttonRef: (el: HTMLButtonElement | null) => void
  onClick: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onClose: () => void
}

/**
 * One tab. The whole tab is the drag handle; while it is up, the arrows move it
 * instead of switching tabs.
 */
function SortableTab({
  id,
  isActive,
  state,
  fullPath,
  label,
  buttonRef,
  onClick,
  onKeyDown,
  onClose,
}: SortableTabProps): React.ReactElement {
  // The `tab` role keeps dnd-kit from marking the dragged tab `aria-pressed`,
  // which a tab does not take.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    attributes: { role: 'tab' },
  })
  return (
    <button
      ref={(el) => {
        setNodeRef(el)
        buttonRef(el)
      }}
      type="button"
      {...attributes}
      role="tab"
      tabIndex={isActive ? 0 : -1}
      // A tab announces itself as a tab, not as dnd-kit's "sortable".
      aria-roledescription={undefined}
      aria-selected={isActive}
      title={fullPath}
      // Along the strip only: it clips anything above or below it.
      style={{ transform: CSS.Translate.toString(transform && { ...transform, y: 0 }), transition }}
      className={cn(tabVariants({ state }), isDragging && 'z-10')}
      {...listeners}
      {...delegatedMiddleClickProps(() => onClose)}
      onClick={onClick}
      onKeyDown={(e) => {
        listeners?.['onKeyDown']?.(e)
        if (!isDragging && !e.defaultPrevented) onKeyDown(e)
      }}
    >
      <span className="truncate">{label}</span>
      <span
        data-tab-close=""
        className="ml-1 rounded-sm hover:bg-destructive/20 p-0.5 inline-flex"
        aria-hidden="true"
      >
        <X className="size-3" />
      </span>
    </button>
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
  const moveTab = useTabsStore((s) => s.moveTab)
  const sensors = useReorderSensors()

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

  const indexOf = (id: UniqueIdentifier) => tabs.findIndex((tab) => tab.id === id)
  const dndAccessibility = reorderAccessibility(
    t,
    (id) => displayLabel(tabs[indexOf(id)]?.label || t('tabs.untitled')),
    t('tabs.reorderInstructions'),
  )
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) moveTab(indexOf(active.id), indexOf(over.id))
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          accessibility={dndAccessibility}
        >
          <SortableContext
            items={tabs.map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div
              role="tablist"
              aria-label={t('tabs.tabList')}
              className="flex items-end gap-1 border-b border-border pr-4 md:pr-6 pt-1 min-w-0"
            >
              {tabs.map((tab, i) => {
                // Bug 1: tabs are space-constrained (`max-w-[120px]
                // md:max-w-[200px]` + `truncate`) — full namespaced paths
                // overflow fast. Display the LEAF only and surface the full
                // path via `title=""` for hover. The empty-label fallback to
                // "Untitled" is preserved verbatim so the existing label test
                // keeps passing.
                const fullPath = tab.label || t('tabs.untitled')
                return (
                  <SortableTab
                    key={tab.id}
                    id={tab.id}
                    isActive={i === activeTabIndex}
                    state={tabState(i)}
                    fullPath={fullPath}
                    label={displayLabel(fullPath)}
                    buttonRef={(el) => {
                      tabRefs.current[i] = el
                    }}
                    onClick={(e) => handleTabClick(i, e)}
                    onKeyDown={(e) => handleTabKeyDown(i, e)}
                    onClose={() => closeTab(i)}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      </ScrollArea>
    </div>
  )
}
