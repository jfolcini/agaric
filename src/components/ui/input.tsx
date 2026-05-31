import type * as React from 'react'

import { cn } from '@/lib/utils'

export const SHARED_INPUT_CLASSES = [
  'focus-visible:border-ring focus-ring-visible',
  'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
] as const

const Input = ({ ref, className, type, ...props }: React.ComponentProps<'input'>) => {
  // #216 C3 — the `[@media(pointer:coarse)]:text-base` (16px) in the class list
  // below is load-bearing for mobile: iOS Safari auto-zooms the viewport when a
  // focused input's font-size is < 16px. Do NOT drop the coarse-pointer
  // `text-base` override or lower it below 16px, or touch users get a jarring
  // zoom on every field focus.
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        'h-9 [@media(pointer:coarse)]:h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm [@media(pointer:coarse)]:text-base shadow-xs transition-[color,box-shadow] outline-hidden selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-accent file:text-accent-foreground file:cursor-pointer file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
        SHARED_INPUT_CLASSES,
        className,
      )}
      {...props}
    />
  )
}
Input.displayName = 'Input'

export { Input }
