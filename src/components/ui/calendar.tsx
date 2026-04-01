/**
 * Calendar — a shadcn-style wrapper around react-day-picker v9.
 *
 * Provides Tailwind styling consistent with the app's design system.
 * Supports week numbers (clickable) and Monday-start weeks.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker, type DayPickerProps } from 'react-day-picker'

import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type CalendarProps = DayPickerProps & {
  /** Called when a week number is clicked with the week number and the dates in that week. */
  onWeekNumberClick?: (weekNumber: number, dates: Date[]) => void
  /** Called when the month caption label is clicked with the month's Date. */
  onMonthClick?: (month: Date) => void
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  onWeekNumberClick,
  onMonthClick,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        root: 'rdp',
        months: 'flex flex-col sm:flex-row gap-2',
        month: 'flex flex-col gap-4',
        month_caption:
          'flex justify-center pt-1 pb-2 relative items-center text-sm font-medium h-10',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1',
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'size-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute left-0 [@media(pointer:coarse)]:size-10',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'size-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute right-0 [@media(pointer:coarse)]:size-10',
        ),
        month_grid: 'w-full border-collapse space-y-1',
        weekdays: 'flex',
        weekday:
          'text-muted-foreground rounded-md w-8 font-normal text-[0.8rem] [@media(pointer:coarse)]:w-11',
        week: 'flex w-full mt-2',
        day: cn(
          'relative p-0 text-center text-sm focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-accent [&:has([aria-selected].outside)]:bg-accent/50 first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md',
          'h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
        ),
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-8 p-0 font-normal aria-selected:opacity-100 [@media(pointer:coarse)]:size-11',
        ),
        range_end: 'day-range-end',
        selected:
          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground rounded-md',
        today: 'bg-accent text-accent-foreground rounded-md ring-2 ring-primary/50',
        outside: 'outside text-muted-foreground aria-selected:text-muted-foreground opacity-50',
        disabled: 'text-muted-foreground opacity-50',
        range_middle: 'aria-selected:bg-accent aria-selected:text-accent-foreground',
        hidden: 'invisible',
        week_number: 'text-[0.7rem] text-muted-foreground w-8 text-center',
        week_number_header: 'text-[0.7rem] text-muted-foreground w-8',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...chevronProps }) => {
          const Icon = orientation === 'left' ? ChevronLeft : ChevronRight
          return <Icon className="size-4" {...chevronProps} />
        },
        // Custom WeekNumber component to make week numbers clickable
        ...(onWeekNumberClick
          ? {
              WeekNumber: ({ children, week }) => {
                const dates = week?.days?.map((d: { date: Date }) => d.date) ?? []
                const weekNum = typeof children === 'number' ? children : Number(children)
                return (
                  <button
                    type="button"
                    className="text-[0.7rem] text-muted-foreground w-8 text-center cursor-pointer hover:text-foreground hover:bg-accent rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => onWeekNumberClick(weekNum, dates)}
                    aria-label={`Go to week ${weekNum}`}
                  >
                    {children}
                  </button>
                )
              },
            }
          : {}),
        ...(onMonthClick
          ? {
              CaptionLabel: ({ children }: React.HTMLAttributes<HTMLSpanElement>) => {
                return (
                  <button
                    type="button"
                    className="text-sm font-medium cursor-pointer rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => onMonthClick(props.defaultMonth ?? new Date())}
                    aria-label="Go to monthly view"
                  >
                    {children}
                  </button>
                )
              },
            }
          : {}),
      }}
      {...props}
    />
  )
}

export { Calendar }
