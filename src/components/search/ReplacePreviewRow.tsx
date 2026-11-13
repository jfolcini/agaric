/**
 * ReplacePreviewRow — one block of the replace-across-pages preview (#6608):
 * what the replace would change in it, and whether it is ticked.
 *
 * The row is the `role="option"` of a multi-select listbox, so the tick is
 * `aria-selected` and the box is drawn, not a checkbox inside the option
 * (axe's nested-interactive rule). Space or a click toggles it, through the
 * listbox's roving focus.
 */

import { Check } from 'lucide-react'
import type React from 'react'

import type { RowMatches } from '@/components/SearchPanel/useSearchReplace'
import { listRowVariants } from '@/components/ui/list-item'
import { cn } from '@/lib/utils'

/** Text shown before the first change, so the change is in the row's two lines. */
const LEAD_CHARS = 40

export interface ReplacePreviewRowProps {
  blockId: string
  matches: RowMatches
  replacement: string
  ticked: boolean
  isFocused: boolean
  onToggle: () => void
  id: string
  style?: React.CSSProperties
  measureRef?: (el: HTMLElement | null) => void
  dataIndex?: number
}

function changeNodes({ text, ranges }: RowMatches, replacement: string): React.ReactNode[] {
  const first = ranges[0]?.start ?? 0
  // The cut lands on a character, never inside a surrogate pair.
  const lead = Array.from(text.slice(0, first)).slice(-LEAD_CHARS).join('')
  const out: React.ReactNode[] = [lead.length < first ? `…${lead}` : lead]
  ranges.forEach(({ start, end }, i) => {
    out.push(
      <del
        key={`d${start}`}
        className="bg-destructive/15 text-destructive line-through before:mr-0.5 before:font-semibold before:content-['−']"
      >
        {text.slice(start, end)}
      </del>,
    )
    if (replacement !== '') {
      out.push(
        <ins
          key={`i${start}`}
          className="bg-status-done text-status-done-foreground no-underline before:mr-0.5 before:font-semibold before:content-['+']"
        >
          {replacement}
        </ins>,
      )
    }
    out.push(text.slice(end, ranges[i + 1]?.start))
  })
  return out
}

export function ReplacePreviewRow({
  blockId,
  matches,
  replacement,
  ticked,
  isFocused,
  onToggle,
  id,
  style,
  measureRef,
  dataIndex,
}: ReplacePreviewRowProps): React.ReactElement {
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the row is out of the focus path; Space and Enter reach it through the listbox's aria-activedescendant, as in SearchResultBlockRow
    <li
      id={id}
      ref={measureRef}
      data-index={dataIndex}
      style={style}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/prefer-tag-over-role -- `<li role="option">` inside `<ul role="listbox">`, as SearchResultBlockRow; a native <option> cannot hold the change markup
      role="option"
      aria-selected={ticked}
      tabIndex={-1}
      onClick={onToggle}
      className={cn(
        listRowVariants({
          density: 'compact',
          className: 'list-none gap-2 text-sm cursor-pointer',
        }),
        'active:bg-accent/70',
        isFocused && 'bg-accent',
      )}
      data-testid={`search-replace-row-${blockId}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-muted-foreground/80 bg-background [@media(pointer:coarse)]:size-5',
          ticked && 'border-primary bg-primary text-primary-foreground',
        )}
      >
        {ticked && <Check className="size-3.5" strokeWidth={3} />}
      </span>
      <span className={cn('flex-1 line-clamp-2', !ticked && 'text-muted-foreground')}>
        {changeNodes(matches, replacement)}
      </span>
    </li>
  )
}
