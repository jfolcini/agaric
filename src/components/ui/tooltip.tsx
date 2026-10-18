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
 * What `Tooltip` shares with its `TooltipTrigger`: the trigger element, so the
 * tooltip can tell when its trigger's own Select or menu is open, and, with
 * `openOnLongPress`, the press-and-hold handlers (#1735).
 *
 * Radix hover tooltips never open on a coarse-pointer tap, so the label of an
 * icon-only control — which lives in the tooltip — is invisible to sighted
 * touch users (it survives only as `aria-label` for assistive tech). The
 * press-and-hold fallback closes that gap; it is opt-in so the other call sites
 * keep pure hover/focus semantics.
 */
const TooltipTriggerContext = React.createContext<{
  setTrigger: (node: HTMLElement | null) => void
  longPress: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerUp: () => void
    onPointerLeave: () => void
    onPointerMove: (e: React.PointerEvent) => void
  } | null
} | null>(null)

interface TooltipProps extends React.ComponentProps<typeof TooltipPrimitive.Root> {
  /**
   * Surface the tooltip on a press-and-hold (#1735). Lets icon-only controls
   * expose their label to sighted touch users, who never get the hover tooltip.
   * Defaults to off so non-touch / non-icon call sites are unaffected.
   */
  openOnLongPress?: boolean
}

/** The trigger is, or wraps, the trigger of a Select, Popover or menu that is open. */
function isTriggerMenuOpen(trigger: HTMLElement | null): boolean {
  if (trigger == null) return false
  const expanded = '[aria-expanded="true"]'
  return trigger.matches(expanded) || trigger.querySelector(expanded) != null
}

function Tooltip({ openOnLongPress = false, open, onOpenChange, ...props }: TooltipProps) {
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const [internalOpen, setInternalOpen] = React.useState(false)
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      // A tooltip that opens over its trigger's open menu is the topmost Radix
      // layer, so it takes the Escape meant for the menu and the clicks on its
      // options. Hover (Radix's delay timer outlives the click that opens the
      // menu) and focus (returned to the trigger) both reach here.
      if (next && isTriggerMenuOpen(triggerRef.current)) return
      setInternalOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  const setTrigger = React.useCallback((node: HTMLElement | null) => {
    triggerRef.current = node
  }, [])

  // A tooltip already open when its menu opens closes then: Radix leaves it
  // open when it opened in the same moment as the press that opened the menu.
  React.useEffect(() => {
    const trigger = triggerRef.current
    if (!internalOpen || trigger == null) return
    const closeIfMenuOpen = () => {
      if (isTriggerMenuOpen(trigger)) handleOpenChange(false)
    }
    // The menu can have opened before this effect ran.
    closeIfMenuOpen()
    const observer = new MutationObserver(closeIfMenuOpen)
    observer.observe(trigger, { subtree: true, attributeFilter: ['aria-expanded'] })
    return () => observer.disconnect()
  }, [internalOpen, handleOpenChange])

  const longPress = useLongPress({ onLongPress: () => setInternalOpen(true) })
  const context = React.useMemo(
    () => ({ setTrigger, longPress: openOnLongPress ? longPress : null }),
    [setTrigger, openOnLongPress, longPress],
  )

  // A call site that controls `open` itself owns it entirely.
  if (open !== undefined) {
    return (
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={open}
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
        {...props}
      />
    )
  }

  return (
    <TooltipTriggerContext.Provider value={context}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={internalOpen}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </TooltipTriggerContext.Provider>
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
  const context = React.useContext(TooltipTriggerContext)
  const longPress = context?.longPress
  const setTrigger = context?.setTrigger
  const composedRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      setTrigger?.(node)
      if (typeof ref === 'function') return ref(node)
      if (ref != null) ref.current = node
    },
    [setTrigger, ref],
  )
  return (
    <TooltipPrimitive.Trigger
      ref={composedRef}
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
}: React.ComponentProps<typeof TooltipPrimitive.Content>) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        // A dark label in light themes (inverted surface) and the lifted popover in dark
        // ones, where an inverted tooltip is a near-white glare. Children inherit the text
        // colour: dim a secondary line with `opacity-90`; a fixed token
        // (`text-muted-foreground`) or `opacity-80` falls below 4.5:1 on some themes.
        'z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md border border-transparent bg-foreground px-3 py-1.5 text-xs text-balance text-background shadow-(--shadow-floating) dark:border-border dark:bg-popover dark:text-popover-foreground fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        className,
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.Arrow className="z-50 size-2 sm:size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-sm bg-foreground fill-foreground dark:border-r dark:border-b dark:bg-popover dark:fill-popover" />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
)

TooltipContent.displayName = 'TooltipContent'

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
