/**
 * ProjectedEntries -- the projected future occurrences of repeating tasks
 * (`list_projected_agenda`), shared by the Due panel and Agenda mode so a
 * projection looks the same wherever it shows: a dashed row, its text, then a
 * "Projected" label, its priority and the date chip of the date it falls on,
 * listed after the host's committed tasks. A projected row is not a block of
 * its own; its only action is opening its source task.
 */

import { Repeat } from 'lucide-react'
import type React from 'react'
import { memo, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { DateChip } from '@/components/common/DateChip'
import { renderRichContent } from '@/components/RichContentRenderer'
import { Badge } from '@/components/ui/badge'
import { ListItem } from '@/components/ui/list-item'
import { useRovingRowFocus } from '@/hooks/useListKeyboardNavigation'
import {
  type RichContentCallbacks,
  useRichContentCallbacks,
  useTagClickHandler,
} from '@/hooks/useRichContentCallbacks'
import type { ActiveProjectedAgendaEntry } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { cn } from '@/lib/utils'
import { useResolveStore } from '@/stores/resolve'

interface ProjectedEntryContentProps {
  content: string
  onTagClick: (id: string) => void
  callbacks: RichContentCallbacks
}

/**
 * Rich-content body of a projected agenda entry. Memoized (#2193) so the
 * `renderRichContent` → `parse(content)` cost isn't paid for every projected
 * row each time the host list re-renders (arrow-key roving focus flips
 * `focusedIndex` on the host on every keypress).
 *
 * The parse is wrapped in a `useMemo` keyed on `content` plus the resolve
 * `version`; the `onTagClick` / resolve callbacks are threaded via refs read
 * at call-time so a fresh parent closure doesn't bust the memo. Any change to
 * what the resolve callbacks return bumps `version`, which forces a recompute.
 */
function ProjectedEntryContentInner({
  content,
  onTagClick,
  callbacks,
}: ProjectedEntryContentProps): React.ReactElement {
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const resolveVersion = useResolveStore((s) => s.version)
  const rendered = useMemo(
    () =>
      renderRichContent(content, {
        // The row's tag chips ARE meant to be clickable: `ProjectedEntriesSection`
        // wires `useTagClickHandler()` down to this component explicitly, and the
        // chips `stopPropagation` so a tag click navigates to the tag rather
        // than to the entry's page. (Block-link chips stay inert regardless —
        // `renderBlockLink` needs `onNavigate` too, and none is passed.)
        interactive: true,
        // #4719 — the output lands in the row's text span below, a single
        // clamped line. Without `inline` a projected entry whose content
        // starts `# ` or `- ` puts an <h1> / <ul> block box inside that span
        // and breaks the row layout (#1533).
        inline: true,
        onTagClick: (id) => onTagClickRef.current(id),
        resolveBlockTitle: (id) => callbacksRef.current.resolveBlockTitle(id),
        resolveBlockStatus: (id) => callbacksRef.current.resolveBlockStatus(id),
        resolveTagName: (id) => callbacksRef.current.resolveTagName(id),
        resolveTagStatus: (id) => callbacksRef.current.resolveTagStatus(id),
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- onTagClick/resolve callbacks captured via refs (intentional perf optimization — see comment above); resolveVersion drives recomputation on cache updates
    [content, resolveVersion],
  )

  return <>{rendered}</>
}

const ProjectedEntryContent = memo(ProjectedEntryContentInner)
ProjectedEntryContent.displayName = 'ProjectedEntryContent'

interface ProjectedEntryRowProps {
  entry: ActiveProjectedAgendaEntry
  /**
   * Parent page title resolved by the caller from `pageTitles`. Passing the
   * resolved string (not the whole map) keeps the memo shallow-compare precise:
   * the row only re-renders when *its own* title changes, and reads it at click
   * time from a stable prop instead of a per-render map lookup.
   */
  pageTitle: string
  isFocused: boolean
  onNavigateToPage: NavigateToPageFn | undefined
  onTagClick: (id: string) => void
  projectedBadgeLabel: string
  emptyContentLabel: string
}

/**
 * One projected-agenda `<li>`. Memoized (#2200) so host re-renders driven
 * by arrow-key roving focus (which flips `focusedIndex` on the host every
 * keypress) only re-render the two rows whose `isFocused` actually changed,
 * instead of rebuilding every projected row's `cn()` / `Badge` / `ListItem`
 * subtree each keystroke. This mirrors how the grouped-blocks list keeps focus
 * cheap: the memoized `BlockListItem` takes `isFocused` as a prop so the
 * structural markup is skipped on unrelated re-renders. The expensive
 * rich-content parse already lives behind its own memo (`ProjectedEntryContent`,
 * #2193); this memo covers the surrounding structural markup.
 */
function ProjectedEntryRowInner({
  entry,
  pageTitle,
  isFocused,
  onNavigateToPage,
  onTagClick,
  projectedBadgeLabel,
  emptyContentLabel,
}: ProjectedEntryRowProps): React.ReactElement {
  // #2200 — source the rich-content callbacks INSIDE the memoized row (the
  // `BlockListItem` pattern) rather than taking them as a prop.
  // `useRichContentCallbacks()` returns a fresh object literal each render, so
  // threading it through a prop would fail this row's `memo` shallow-compare on
  // every roving-focus re-render and re-render all projected rows per keystroke;
  // consuming it internally keeps the row's prop surface reference-stable so
  // only the two rows whose `isFocused` flips actually re-render.
  const callbacks = useRichContentCallbacks()
  const rowRef = useRovingRowFocus<HTMLLIElement>(isFocused)
  const navigate = (): void => {
    if (!entry.block.page_id || !onNavigateToPage) return
    onNavigateToPage(entry.block.page_id, pageTitle, entry.block.id)
  }
  return (
    <ListItem
      ref={rowRef}
      data-block-list-item
      data-testid="projected-entry"
      // #1520 — roving tabindex, mirroring the host's `BlockListItem` rows: only
      // the keyboard-focused projected entry is a tab stop so the list keeps a
      // single roving tab stop instead of one per row.
      tabIndex={isFocused ? 0 : -1}
      className={cn(
        // Override ListItem's `gap-3 rounded-lg px-3 py-2 hover:bg-accent/50` chrome
        // with the muted dashed-border "projected" shape via tailwind-merge.
        'gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2 py-1.5 text-block-sm text-muted-foreground cursor-pointer hover:bg-muted/50 active:bg-muted/70',
        isFocused && 'list-cursor',
      )}
      onClick={navigate}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        navigate()
      }}
    >
      {/* `truncate` would clip the chips' touch area (`tag-chip-row`) to the
          line; clipped sideways only, the text still ends in an ellipsis. */}
      <span className="tag-chip-row min-w-0 flex-1 overflow-x-clip text-ellipsis whitespace-nowrap bidi-plaintext">
        {entry.block.content ? (
          <ProjectedEntryContent
            content={entry.block.content}
            onTagClick={onTagClick}
            callbacks={callbacks}
          />
        ) : (
          emptyContentLabel
        )}
      </span>
      <Badge tone="metadata">
        <Repeat />
        {projectedBadgeLabel}
      </Badge>
      {entry.block.priority && (
        <Badge tone="priority" size="sm" priorityLevel={entry.block.priority}>
          P{entry.block.priority}
        </Badge>
      )}
      <DateChip
        kind={entry.source === 'due_date' ? 'due' : 'scheduled'}
        date={entry.projected_date}
      />
    </ListItem>
  )
}

const ProjectedEntryRow = memo(ProjectedEntryRowInner)
ProjectedEntryRow.displayName = 'ProjectedEntryRow'

interface ProjectedEntriesSectionProps {
  entries: ActiveProjectedAgendaEntry[]
  pageTitles: Map<string, string>
  /** Where the first entry sits in the host list's keyboard-navigation order. */
  firstFlatIndex: number
  focusedIndex: number
  onNavigateToPage: NavigateToPageFn | undefined
}

export function ProjectedEntriesSection({
  entries,
  pageTitles,
  firstFlatIndex,
  focusedIndex,
  onNavigateToPage,
}: ProjectedEntriesSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  const onTagClick = useTagClickHandler()
  if (entries.length === 0) return null
  return (
    <div className="mt-3 border-t border-dashed border-muted-foreground/30 pt-3">
      <h2 className="text-xs coarse:text-sm font-medium text-muted-foreground mb-2">
        {t('due.projected')}
      </h2>
      <ul className="space-y-1" aria-label={t('duePanel.projectedListLabel')}>
        {entries.map((entry, i) => (
          <ProjectedEntryRow
            key={`projected-${entry.block.id}-${entry.source}-${entry.projected_date}`}
            entry={entry}
            pageTitle={
              entry.block.page_id
                ? (pageTitles.get(entry.block.page_id) ?? t('duePanel.untitled'))
                : ''
            }
            isFocused={focusedIndex === firstFlatIndex + i}
            onNavigateToPage={onNavigateToPage}
            onTagClick={onTagClick}
            projectedBadgeLabel={t('duePanel.projectedBadge')}
            emptyContentLabel={t('duePanel.emptyContent')}
          />
        ))}
      </ul>
    </div>
  )
}
