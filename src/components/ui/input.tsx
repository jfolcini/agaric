import type * as React from 'react'

import { cn } from '@/lib/utils'

export const SHARED_INPUT_CLASSES = [
  'focus-visible:border-ring focus-ring-visible',
  'aria-invalid:border-destructive',
] as const

const Input = ({ ref, className, type, ...props }: React.ComponentProps<'input'>) => (
  // `coarse:text-base` keeps 16 px text on touch: iOS Safari zooms the
  // viewport into a focused field whose text is smaller (#216).
  // 36 px on every pointer, a button's height, so a field lines up with the
  // buttons beside it. An input cannot carry a pseudo-element hit area, so on
  // touch it trades 8 px of tap height for that alignment.
  <input
    ref={ref}
    type={type}
    data-slot="input"
    className={cn(
      'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm coarse:text-base shadow-xs transition-[color,box-shadow] outline-hidden file:inline-flex file:h-7 file:border-0 file:bg-accent file:text-accent-foreground file:cursor-pointer file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 contrast-more:dark:bg-transparent',
      SHARED_INPUT_CLASSES,
      className,
    )}
    {...props}
  />
)

Input.displayName = 'Input'

export { Input }
