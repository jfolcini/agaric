import * as React from 'react'

import { cn } from '@/lib/utils'

interface PopoverMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
}

const PopoverMenuItem = React.forwardRef<HTMLButtonElement, PopoverMenuItemProps>(
  ({ active, className, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          active && 'bg-accent font-medium',
          disabled && 'opacity-50 cursor-not-allowed',
          className,
        )}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    )
  },
)
PopoverMenuItem.displayName = 'PopoverMenuItem'

export { PopoverMenuItem }
