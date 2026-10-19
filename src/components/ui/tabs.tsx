/**
 * Tabs — Radix Tabs for a control that swaps one panel for another (#5920).
 *
 * Variants, set once on `Tabs`:
 *  - `underline` (default): muted labels on a hairline. The selected tab is
 *    `text-foreground font-medium` over a 2 px `tab-indicator` bar that covers
 *    the hairline beneath it. The bar is the tab's only border, so its corners
 *    stay square.
 *  - `vertical`: the Settings rail. The selected tab is the neutral
 *    `sidebar-accent` pill of the app sidebar's active item; arrow keys are
 *    Up/Down.
 *
 * Radix gives each tablist one tab stop, arrow keys, Home and End. Every
 * switcher here is controlled and mounts only the selected panel, so a tab
 * that is not selected carries no `aria-controls`: it would name a panel that
 * is not in the document.
 */

import { cva } from 'class-variance-authority'
import { Tabs as TabsPrimitive } from 'radix-ui'
import type * as React from 'react'
import { createContext, useContext, useMemo } from 'react'

import { cn } from '@/lib/utils'

type TabsVariant = 'underline' | 'vertical'

const tabsListVariants = cva('flex', {
  variants: {
    variant: {
      underline: 'items-end gap-4 border-b border-border',
      vertical: 'flex-col gap-0.5',
    },
  },
  defaultVariants: { variant: 'underline' },
})

const tabsTriggerVariants = cva(
  'inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors focus-ring-visible disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [@media(pointer:coarse)]:min-h-11',
  {
    variants: {
      variant: {
        // `-mb-px` lays the bar over the list's hairline.
        underline:
          '-mb-px justify-center border-b-2 border-transparent px-1 py-2 hover:text-foreground data-[state=active]:border-tab-indicator data-[state=active]:font-medium data-[state=active]:text-foreground',
        vertical:
          'w-full justify-start rounded-md px-3 py-1.5 text-left font-medium data-[state=inactive]:hover:bg-muted/50 data-[state=inactive]:hover:text-foreground data-[state=active]:bg-sidebar-accent data-[state=active]:text-sidebar-accent-foreground',
      },
    },
    defaultVariants: { variant: 'underline' },
  },
)

const TabsContext = createContext<{ variant: TabsVariant; value: string }>({
  variant: 'underline',
  value: '',
})

type TabsProps = Omit<
  React.ComponentProps<typeof TabsPrimitive.Root>,
  'value' | 'defaultValue' | 'orientation'
> & {
  value: string
  variant?: TabsVariant
}

function Tabs({ variant = 'underline', value, ...props }: TabsProps) {
  const context = useMemo(() => ({ variant, value }), [variant, value])
  return (
    <TabsContext.Provider value={context}>
      <TabsPrimitive.Root
        data-slot="tabs"
        value={value}
        orientation={variant === 'vertical' ? 'vertical' : 'horizontal'}
        {...props}
      />
    </TabsContext.Provider>
  )
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const { variant } = useContext(TabsContext)
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const tabs = useContext(TabsContext)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      value={value}
      className={cn(tabsTriggerVariants({ variant: tabs.variant }), className)}
      {...props}
      {...(value === tabs.value ? {} : { 'aria-controls': undefined })}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('focus-ring-visible', className)}
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
