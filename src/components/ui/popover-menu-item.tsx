import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const popoverMenuItemVariants = cva(
  'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11 focus-ring-visible',
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
  asChild?: boolean
}

const PopoverMenuItem = ({
  ref,
  active,
  className,
  disabled,
  asChild = false,
  children,
  ...props
}: PopoverMenuItemProps) => {
  const Comp = asChild ? Slot.Root : 'button'
  // `type="button"` and the native `disabled` attribute are only valid on
  // the native button; when rendering via Slot the caller's element
  // (e.g. `<a>`) owns its own semantics. Keep the visual `disabled`
  // styling via the CVA variant either way.
  const buttonOnlyProps = asChild ? {} : { type: 'button' as const, disabled: disabled === true }

  return (
    <Comp
      ref={ref}
      data-slot="popover-menu-item"
      className={cn(popoverMenuItemVariants({ active, disabled }), className)}
      {...buttonOnlyProps}
      {...props}
    >
      {children}
    </Comp>
  )
}
PopoverMenuItem.displayName = 'PopoverMenuItem'

export { PopoverMenuItem, popoverMenuItemVariants }
