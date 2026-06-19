/**
 * Calendar — a shadcn-style wrapper around react-day-picker v10.
 *
 * Provides Tailwind styling consistent with the app's design system.
 * Supports week numbers (clickable) and Monday-start weeks.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
import type * as React from 'react'
import { useMemo } from 'react'
import {
  type CustomComponents,
  DayPicker,
  type DayPickerProps,
  useDayPicker,
} from 'react-day-picker'

import { buttonVariants } from '@/components/ui/button'
import { i18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export type CalendarProps = DayPickerProps & {
  /** Called when a week number is clicked with the week number and the dates in that week. */
  onWeekNumberClick?: (weekNumber: number, dates: Date[]) => void
  /** Called when the month caption label is clicked with the month's Date. */
  onMonthClick?: (month: Date) => void
  ref?: React.Ref<HTMLDivElement>
}

// Hoisted to module scope: `buttonVariants` arguments are literal, so the
// resulting class strings never change between renders. Computing once at
// module load avoids redundant work on every render of <Calendar>.
const NAV_BUTTON_CLASS = cn(
  buttonVariants({ variant: 'outline' }),
  'size-7 bg-transparent p-0 opacity-50 hover:opacity-100 [@media(pointer:coarse)]:size-10',
)
const DAY_BUTTON_CLASS = cn(
  buttonVariants({ variant: 'ghost' }),
  'size-8 p-0 font-normal aria-selected:opacity-100 [@media(pointer:coarse)]:size-11',
)

// Hoisted to module scope: the entire `classNames` skeleton is composed of
// literal strings (no closure / prop / state dependencies), so it can be
// shared across every render. The render body spreads caller-supplied
// `classNames` on top of this base.
const BASE_CLASS_NAMES = {
  root: 'rdp',
  months: 'flex flex-col sm:flex-row gap-2 relative',
  month: 'flex flex-col gap-4',
  month_caption: 'flex items-center justify-center pt-1 pb-2 text-sm font-medium h-10',
  caption_label: 'text-sm font-medium',
  nav: 'absolute top-0 inset-x-0 flex items-center justify-between h-10 pt-1 px-1',
  button_previous: NAV_BUTTON_CLASS,
  button_next: NAV_BUTTON_CLASS,
  month_grid: 'w-full border-collapse space-y-1',
  weekdays: 'flex',
  weekday:
    'text-muted-foreground rounded-md w-8 font-normal text-[0.8rem] [@media(pointer:coarse)]:w-11',
  week: 'flex w-full mt-2',
  // In react-day-picker v10 the `Day` component renders the `<td>` cell and
  // sets `aria-selected` on that SAME `<td>` (verified against node_modules:
  // components/Day.js renders a bare `<td>`; DayPicker.js line 368 sets
  // `aria-selected: modifiers.selected || undefined` on it — NOT on the inner
  // DayButton). A descendant `:has([aria-selected])` therefore never matches
  // (the attribute lives on `&`, not a child), so the accent state was dead
  // (#1793). Key the accent off the cell's OWN attribute `&[aria-selected]`,
  // consistent with how #1563 fixed the `today` gate.
  day: cn(
    'relative p-0 text-center text-sm focus-within:relative focus-within:z-20 [&[aria-selected]]:bg-accent [&[aria-selected].outside]:bg-accent/50 first:[&[aria-selected]]:rounded-l-md last:[&[aria-selected]]:rounded-r-md',
    'h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
  ),
  day_button: DAY_BUTTON_CLASS,
  range_end: 'day-range-end',
  selected:
    'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground rounded-md',
  // When a day is BOTH today and selected, react-day-picker applies the `today`
  // and `selected` class sets to the SAME day cell. `today`'s accent fill and
  // `selected`'s primary fill are equal-specificity, so the winner used to
  // depend on Tailwind's generated source order (non-deterministic, #1563).
  // Make the outcome explicit: the accent fill applies ONLY when the cell is not
  // selected, so a selected-today cell always keeps the primary fill, and the
  // always-on ring carries the "today" cue without competing for the
  // background. In react-day-picker v10 the `Day` component renders the `<td>`
  // cell and puts `aria-selected` on that SAME `<td>` (verified against
  // node_modules: components/Day.js renders a bare `<td>`, and DayPicker.js sets
  // `aria-selected` on it — NOT on the inner button). So the gate must key off
  // the cell's OWN attribute with `[&:not([aria-selected])]:`; a descendant
  // `:has([aria-selected])` check would never match (the attribute is on `&`,
  // not a child) and would fail to gate the accent on a selected-today cell.
  today:
    'rounded-md ring-2 ring-primary/50 [&:not([aria-selected])]:bg-accent [&:not([aria-selected])]:text-accent-foreground',
  outside: 'outside text-muted-foreground aria-selected:text-muted-foreground opacity-50',
  disabled: 'text-muted-foreground opacity-50',
  range_middle: 'aria-selected:bg-accent aria-selected:text-accent-foreground',
  hidden: 'invisible',
  week_number: 'text-[0.7rem] text-muted-foreground w-8 text-center',
  week_number_header: 'text-[0.7rem] text-muted-foreground w-8',
} as const

// Hoisted to module scope (no closure deps) so its identity is stable across
// every <Calendar> render — react-day-picker's `components` map otherwise sees
// a brand-new component each render and remounts the chevrons.
const CalendarChevron = ({
  orientation,
  ...chevronProps
}: {
  orientation?: 'left' | 'right' | 'up' | 'down'
} & React.HTMLAttributes<SVGElement>) => {
  const Icon = orientation === 'left' ? ChevronLeft : ChevronRight
  return <Icon className="size-4" {...chevronProps} />
}

// Custom WeekNumber component to make week numbers clickable.
//
// react-day-picker v10 removed the `onWeekNumberClick` prop; the sanctioned
// replacement is to supply a custom `WeekNumber` component (`week: CalendarWeek`
// + th attrs).
//
// IMPORTANT: the default WeekNumber renders a <th>, and the parent Week renders
// a <tr>. If we returned a bare <button> here, the DOM would become
// <tr><button>...</button></tr> — which triggers React 19's "In HTML, <button>
// cannot be a child of <tr>" hydration warning. Wrap the interactive element in
// a <th> so the <tr><th>... nesting stays valid and forward the week-number
// cell's ARIA / styling attributes onto the <th> (not the <button>).
//
// Defined at module scope (factory closed over the click handler) so the
// component identity is stable across renders once memoized by the caller.
const makeWeekNumber = (
  onWeekNumberClick: (weekNumber: number, dates: Date[]) => void,
): CustomComponents['WeekNumber'] => {
  const WeekNumber: CustomComponents['WeekNumber'] = ({ week, children, ...thProps }) => {
    const dates = week.days.map((d) => d.date)
    const weekNum = week.weekNumber
    return (
      <th {...thProps}>
        <button
          type="button"
          className="text-[0.7rem] text-muted-foreground w-8 text-center cursor-pointer hover:text-foreground hover:bg-accent rounded-md transition-colors focus-ring-visible"
          onClick={() => onWeekNumberClick(weekNum, dates)}
          aria-label={i18n.t('journal.goToWeek', { weekNum })}
        >
          {children}
        </button>
      </th>
    )
  }
  return WeekNumber
}

// Read the CURRENTLY displayed month from the DayPicker context rather than
// `props.defaultMonth`. `defaultMonth` is only the month the picker OPENED on;
// once the user pages with the chevrons the displayed month diverges from it.
// The context's `months[0].date` is the first day of the active month, so the
// caption "go to monthly view" click targets what's on screen (#745).
// `useDayPicker()` is valid here because CaptionLabel renders inside the
// DayPicker provider.
//
// Defined at module scope (factory closed over the click handler) so the
// component identity is stable across renders once memoized by the caller.
const makeCaptionLabel = (
  onMonthClick: (month: Date) => void,
): CustomComponents['CaptionLabel'] => {
  const CaptionLabel: CustomComponents['CaptionLabel'] = ({ children }) => {
    const { months } = useDayPicker()
    const displayedMonth = months[0]?.date ?? new Date()
    return (
      <button
        type="button"
        className="text-sm font-medium cursor-pointer rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground transition-colors focus-ring-visible"
        onClick={() => onMonthClick(displayedMonth)}
        aria-label={i18n.t('journal.monthlyViewButtonLabel')}
      >
        {children}
      </button>
    )
  }
  return CaptionLabel
}

const Calendar = ({
  ref,
  className,
  classNames,
  showOutsideDays = true,
  onWeekNumberClick,
  onMonthClick,
  components: componentsProp,
  ...props
}: CalendarProps) => {
  // Build the custom-components map once per dependency change so each custom
  // component keeps a stable identity across renders (react-day-picker remounts
  // any component whose reference changes). The interactive WeekNumber /
  // CaptionLabel are only added when their click handler is supplied.
  const components = useMemo<Partial<CustomComponents>>(
    () => ({
      Chevron: CalendarChevron,
      ...(onWeekNumberClick ? { WeekNumber: makeWeekNumber(onWeekNumberClick) } : {}),
      ...(onMonthClick ? { CaptionLabel: makeCaptionLabel(onMonthClick) } : {}),
      ...componentsProp,
    }),
    [onWeekNumberClick, onMonthClick, componentsProp],
  )
  return (
    <div ref={ref} data-slot="calendar" data-editor-portal="">
      <DayPicker
        showOutsideDays={showOutsideDays}
        className={cn('p-3', className)}
        classNames={{
          ...BASE_CLASS_NAMES,
          ...classNames,
        }}
        components={components}
        {...props}
      />
    </div>
  )
}
Calendar.displayName = 'Calendar'

export { Calendar }
