import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { Children } from 'react'

import { cn } from '@/lib/utils'

// Icon sizes sit at zero specificity, so a `size-*`, `h-*` or `w-*` on the icon wins.
// A leading icon's box carries whitespace beside its glyph, so it is pulled into
// the start padding (`data-leading-icon`); a margin, not padding, so a caller's
// own `px-*` still holds.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,transform,scale] active:scale-[0.97] focus-ring-visible disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [:where(&)_svg]:size-4 data-leading-icon:[&>svg:first-child]:-ms-0.5',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground active:bg-accent/80 dark:border-input dark:bg-input/30 dark:hover:bg-input/50 dark:active:bg-input/70',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70',
        ghost:
          'hover:bg-accent hover:text-accent-foreground active:bg-accent/80 dark:hover:bg-accent/50 dark:active:bg-accent/70',
        link: 'text-primary underline underline-offset-4 decoration-muted-foreground/60 hover:decoration-current',
        // An action inside a tinted alert: label and edge take the alert's own
        // text colour (its `text-alert-*-foreground`), which already clears the
        // alert's fill; an outline's translucent dark fill sank into the red.
        alert:
          'border border-current bg-transparent text-current hover:bg-current/10 active:bg-current/15',
      },
      size: {
        // Three heights on a fine pointer (28, 32, 36 px) and one on a coarse
        // pointer: every text size paints 36 px with a 14 px label, and takes
        // the rest of its 44 px target invisibly (`touch-hit-area`), so a row
        // of buttons reads as one height however long each label is.
        default: 'h-9 gap-1.5 px-4 py-2 touch-hit-area',
        sm: 'h-8 gap-1.5 rounded-md px-3 coarse:h-9 coarse:text-sm touch-hit-area',
        xs: 'h-7 gap-1 rounded-md px-2.5 text-xs [:where(&)_svg]:size-3 coarse:h-9 coarse:px-3 coarse:text-sm coarse:[:where(&)_svg]:size-4 touch-hit-area',
        // On a coarse pointer an icon button is 36 px like the rest, with a
        // 20 px glyph and its 44 px target invisible (`touch-hit-area`).
        icon: 'size-9 coarse:[:where(&)_svg]:size-5 touch-hit-area',
        'icon-xs': 'size-6 rounded-md coarse:size-9 coarse:[:where(&)_svg]:size-5 touch-hit-area',
        'icon-sm': 'size-8 coarse:size-9 coarse:[:where(&)_svg]:size-5 touch-hit-area',
      },
    },
    compoundVariants: [
      // A frameless icon paints nothing at rest, so its 44 px box shows only as
      // the hover fill, and the phone's header and toolbars are laid out on it.
      {
        variant: ['ghost', 'link'],
        size: ['icon', 'icon-xs', 'icon-sm'],
        class: 'coarse:size-(--touch-target)',
      },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

/** Ghost and outline icons take the theme's icon color (#5368); a `text-*` on the icon wins. */
const paletteIcons = "[&_svg:not([class*='text-'])]:text-icon"

const Button = ({
  ref,
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /**
     * Button contents — text, icons, or fragments. Explicit (rather than
     * relying on the implicit `children` from `ComponentProps<'button'>`) so
     * the signature documents intent. For icon-only buttons use `IconButton`,
     * which enforces a tooltip + accessible name.
     */
    children?: React.ReactNode
  }) => {
  const Comp = asChild ? Slot.Root : 'button'
  // A text color the caller sets on the button reaches its icons too, so a
  // row action's red delete hover is not stopped at the glyph. tailwind-merge
  // drops `text-icon` only for a color, so `text-xs` or `text-left` keep the tint.
  const tintsIcons =
    (variant === 'ghost' || variant === 'outline') &&
    cn('text-icon', className).split(' ').includes('text-icon')

  // CSS cannot see text nodes, so only here does an icon before a bare label
  // differ from an icon alone, one beside a visually hidden name, or a chevron
  // after one.
  const [first, ...rest] = Children.toArray(children)
  const leadingIcon =
    typeof first === 'object' && rest.some((c) => typeof c === 'string' || typeof c === 'number')

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-leading-icon={leadingIcon || undefined}
      className={cn(buttonVariants({ variant, size }), tintsIcons && paletteIcons, className)}
      {...props}
    >
      {children}
    </Comp>
  )
}
Button.displayName = 'Button'

export { Button, buttonVariants }
