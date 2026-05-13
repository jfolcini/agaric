import type * as React from 'react'

import { cn } from '@/lib/utils'
import { SHARED_INPUT_CLASSES } from './input'

const Textarea = ({ ref, className, ...props }: React.ComponentProps<'textarea'>) => {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        'flex min-h-[80px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm [@media(pointer:coarse)]:text-base shadow-xs transition-[color,box-shadow] outline-hidden selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
        SHARED_INPUT_CLASSES,
        '[@media(pointer:coarse)]:min-h-[120px]',
        className,
      )}
      {...props}
    />
  )
}
Textarea.displayName = 'Textarea'

export { Textarea }
