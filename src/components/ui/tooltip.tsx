import { Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'

import { useLongPress } from '@/hooks/useLongPress'
import { cn } from '@/lib/utils'

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}
TooltipProvider.displayName = 'TooltipProvider'

/**
 * Long-press fallback context (#1735).
 *
 * Radix hover tooltips never open on a coarse-pointer tap, so the label of an
 * icon-only control — which lives in the tooltip — is invisible to sighted
 * touch users (it survives only as `aria-label` for assistive tech). To close
 * that discoverability gap at the primitive level, `Tooltip` can opt into a
 * press-and-hold fallback: holding the trigger surfaces the tooltip on touch.
 *
 * The behaviour is opt-in (default off) so the 24 other Tooltip call sites keep
 * their pure hover/focus semantics. When enabled, `Tooltip` lifts `open` into
 * controlled state (hover/focus still drive it via Radix's `onOpenChange`) and
 * publishes long-press handlers for `TooltipTrigger` to spread onto the trigger.
 */
const TooltipLongPressContext = React.createContext<{
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerMove: (e: React.PointerEvent) => void
} | null>(null)

interface TooltipProps extends React.ComponentProps<typeof TooltipPrimitive.Root> {
  /**
   * Surface the tooltip on a press-and-hold (#1735). Lets icon-only controls
   * expose their label to sighted touch users, who never get the hover tooltip.
   * Defaults to off so non-touch / non-icon call sites are unaffected.
   */
  openOnLongPress?: boolean
}

function Tooltip({ openOnLongPress = false, open, onOpenChange, ...props }: TooltipProps) {
  // Only lift open state when the fallback is requested AND the call site has
  // not already taken control of `open` itself — otherwise defer entirely to
  // Radix's own uncontrolled hover/focus handling.
  const isControlled = openOnLongPress && open === undefined

  const [internalOpen, setInternalOpen] = React.useState(false)
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setInternalOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  const longPress = useLongPress({ onLongPress: () => setInternalOpen(true) })

  if (!isControlled) {
    return (
      <TooltipPrimitive.Root
        data-slot="tooltip"
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
        {...props}
      />
    )
  }

  return (
    <TooltipLongPressContext.Provider value={longPress}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={internalOpen}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </TooltipLongPressContext.Provider>
  )
}
Tooltip.displayName = 'Tooltip'

const TooltipTrigger = ({
  ref,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerMove,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) => {
  const longPress = React.useContext(TooltipLongPressContext)
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      data-slot="tooltip-trigger"
      // Compose the consumer's handlers with the long-press fallback (#1735) so
      // a press-and-hold opens the tooltip without clobbering drag / focus
      // handlers the trigger already carries. No-op when long-press is off.
      onPointerDown={(e) => {
        onPointerDown?.(e)
        longPress?.onPointerDown(e)
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e)
        longPress?.onPointerUp()
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e)
        longPress?.onPointerLeave()
      }}
      onPointerMove={(e) => {
        onPointerMove?.(e)
        longPress?.onPointerMove(e)
      }}
      {...props}
    />
  )
}
TooltipTrigger.displayName = 'TooltipTrigger'

const TooltipContent = ({
  ref,
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) => {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md border bg-popover px-3 py-1.5 text-xs text-balance text-popover-foreground shadow-(--shadow-floating) fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2 sm:size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-sm border-r border-b bg-popover fill-popover" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}
TooltipContent.displayName = 'TooltipContent'

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
