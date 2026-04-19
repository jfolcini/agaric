import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const popoverMenuItemVariants = cva(
  'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
  {
    variants: {
      active: {
        true: 'bg-accent font-medium',
        false: '',
      },
      disabled: {
        true: 'opacity-50 cursor-not-allowed',
        false: '',
      },
    },
    defaultVariants: {
      active: false,
      disabled: false,
    },
  },
)

interface PopoverMenuItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>,
    VariantProps<typeof popoverMenuItemVariants> {
  ref?: React.Ref<HTMLButtonElement>
}

const PopoverMenuItem = ({
  ref,
  active,
  className,
  disabled,
  children,
  ...props
}: PopoverMenuItemProps) => {
  return (
    <button
      ref={ref}
      type="button"
      data-slot="popover-menu-item"
      className={cn(popoverMenuItemVariants({ active, disabled }), className)}
      disabled={disabled === true}
      {...props}
    >
      {children}
    </button>
  )
}
PopoverMenuItem.displayName = 'PopoverMenuItem'

export { PopoverMenuItem, popoverMenuItemVariants }
