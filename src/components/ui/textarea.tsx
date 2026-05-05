import type * as React from 'react'

import { cn } from '@/lib/utils'

const Textarea = ({ ref, className, ...props }: React.ComponentProps<'textarea'>) => {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm [@media(pointer:coarse)]:text-base shadow-xs transition-[color,box-shadow] outline-hidden selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
        'focus-visible:border-ring focus-ring-visible',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        '[@media(pointer:coarse)]:min-h-[120px]',
        className,
      )}
      {...props}
    />
  )
}
Textarea.displayName = 'Textarea'

export { Textarea }
