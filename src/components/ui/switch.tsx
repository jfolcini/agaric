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
      // On is the brand coral in every theme; off a neutral grey that, unlike
      // `bg-input`, still shows on a white page. The dark themes' lighter grey
      // takes a fainter tint, or the coral would not clear 3:1 against it.
      'data-[state=checked]:bg-brand data-[state=unchecked]:bg-muted-foreground/40 dark:data-[state=unchecked]:bg-muted-foreground/12',
      // Compact beside 36 px controls; the 44 px target is invisible.
      'coarse:h-6 coarse:w-11 touch-hit-area',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className={cn(
        // White in every theme and state, as on iOS and Android: only the track
        // says on or off. A theme token would turn dark with a dark theme.
        'pointer-events-none block size-4 rounded-full bg-white shadow-(--shadow-resting) ring-0 transition-transform',
        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5',
        'coarse:size-5 coarse:data-[state=checked]:translate-x-5',
      )}
    />
  </SwitchPrimitive.Root>
)

Switch.displayName = 'Switch'

export { Switch }
