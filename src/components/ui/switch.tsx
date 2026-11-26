import { Switch as SwitchPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const Switch = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
      'focus-ring-visible',
      'disabled:cursor-not-allowed disabled:opacity-50',
      // `bg-input` (L 0.93) under a white thumb on a white page read as no
      // control at all; the muted-foreground tint keeps the off track visible.
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/40',
      'coarse:h-7 coarse:w-12',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className={cn(
        // Light on the off track in dark too, where the page colour read as a hole (#7040).
        'pointer-events-none block size-4 rounded-full bg-background dark:data-[state=unchecked]:bg-foreground shadow-(--shadow-resting) ring-0 transition-transform',
        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5',
        'coarse:size-6 coarse:data-[state=checked]:translate-x-5',
      )}
    />
  </SwitchPrimitive.Root>
)

Switch.displayName = 'Switch'

export { Switch }
