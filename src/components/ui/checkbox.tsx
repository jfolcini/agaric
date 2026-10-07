import { Check } from 'lucide-react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const Checkbox = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) => (
  <div
    className="inline-flex items-center justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    data-slot="checkbox-hitbox"
  >
    <CheckboxPrimitive.Root
      ref={ref}
      data-slot="checkbox"
      className={cn(
        // `--input` was ≈1.2:1 against the page; a checkbox's boundary needs 3:1 (WCAG
        // 1.4.11): muted-foreground/80 is ≈3.3:1 in light, ≈5.2:1 in dark.
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-muted-foreground/80 bg-background shadow-xs transition-colors',
        'focus-ring-visible',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground',
        '[@media(pointer:coarse)]:size-5',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <Check className="size-3.5 [@media(pointer:coarse)]:size-4" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  </div>
)

Checkbox.displayName = 'Checkbox'

export { Checkbox }
