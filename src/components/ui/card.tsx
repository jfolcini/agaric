import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const cardVariants = cva(
  'flex flex-col gap-6 rounded-lg border bg-card py-6 text-card-foreground shadow-(--shadow-resting)',
  {
    variants: {
      variant: {
        // A card that only groups settings drops its box on a phone: inside the
        // view's 16 px gutter a second inset leaves its text on its own edge.
        section:
          'max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:py-0 max-sm:shadow-none max-sm:*:px-0',
        // A card that is one item of a list keeps its box at every width.
        item: '',
      },
    },
    defaultVariants: { variant: 'section' },
  },
)

const Card = ({
  ref,
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof cardVariants>) => (
  <div ref={ref} data-slot="card" className={cn(cardVariants({ variant }), className)} {...props} />
)

Card.displayName = 'Card'

const CardHeader = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div
    ref={ref}
    data-slot="card-header"
    className={cn(
      '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6',
      className,
    )}
    {...props}
  />
)

CardHeader.displayName = 'CardHeader'

const CardTitle = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div
    ref={ref}
    data-slot="card-title"
    className={cn('text-base leading-none font-semibold tracking-tight', className)}
    {...props}
  />
)

CardTitle.displayName = 'CardTitle'

const CardDescription = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div
    ref={ref}
    data-slot="card-description"
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
)

CardDescription.displayName = 'CardDescription'

const CardAction = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div
    ref={ref}
    data-slot="card-action"
    className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
    {...props}
  />
)

CardAction.displayName = 'CardAction'

const CardContent = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div ref={ref} data-slot="card-content" className={cn('px-6', className)} {...props} />
)

CardContent.displayName = 'CardContent'

const CardFooter = ({ ref, className, ...props }: React.ComponentProps<'div'>) => (
  <div
    ref={ref}
    data-slot="card-footer"
    className={cn('flex items-center px-6 [.border-t]:pt-6', className)}
    {...props}
  />
)

CardFooter.displayName = 'CardFooter'

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle }
