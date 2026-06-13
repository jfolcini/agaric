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

// Base prop surface, sans `disabled` (its meaning depends on `asChild`).
interface PopoverMenuItemBaseProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>,
    Omit<VariantProps<typeof popoverMenuItemVariants>, 'disabled'> {
  ref?: React.Ref<HTMLButtonElement>
  active?: VariantProps<typeof popoverMenuItemVariants>['active']
}

type DisabledVariant = VariantProps<typeof popoverMenuItemVariants>['disabled']

/**
 * `disabled` is only honoured on the native `<button>`. When `asChild` is
 * true the rendered element is the caller's child (e.g. an `<a>`), which the
 * native `disabled` attribute and the visual-only CVA styling cannot make
 * non-interactive — the link stays focusable/clickable. So the prop type is a
 * discriminated union: in the `asChild` branch `disabled` is `never`, making
 * `<PopoverMenuItem asChild disabled>` a compile error. A dev-only runtime
 * warning (below) backstops `any`/spread call sites that erase the static check.
 */
type PopoverMenuItemProps = PopoverMenuItemBaseProps &
  (
    | { asChild: true; disabled?: never }
    | { asChild?: false | undefined; disabled?: DisabledVariant }
  )

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
  if (import.meta.env.DEV && asChild && disabled) {
    console.warn(
      'PopoverMenuItem: `disabled` has no effect with `asChild` — the child ' +
        'element remains focusable/clickable. Render a real <button> or gate ' +
        'interaction in the child instead.',
    )
  }
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
