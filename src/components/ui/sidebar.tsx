import { cva, type VariantProps } from 'class-variance-authority'
import { PanelLeftIcon } from 'lucide-react'
import { Slot } from 'radix-ui'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

const SIDEBAR_COOKIE_NAME = 'sidebar_state'
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH_DEFAULT = 150
const SIDEBAR_WIDTH_MIN = 120
const SIDEBAR_WIDTH_MOBILE = 'min(18rem, 85vw)'
const SIDEBAR_WIDTH_ICON = '3rem'
const SIDEBAR_WIDTH_ICON_PX = 48 // 3rem at 16px base
const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar_width'
const SIDEBAR_KEYBOARD_SHORTCUT = 'b'
const SWIPE_EDGE_ZONE = 20 // px from left edge to start tracking
const SWIPE_MIN_DISTANCE = 50 // px horizontal distance to trigger open

type SidebarContextProps = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  isResizing: boolean
  setIsResizing: (resizing: boolean) => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }

  return context
}

const SidebarProvider = ({
  ref,
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  ref?: React.Ref<HTMLDivElement>
}) => {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // Sidebar width state — persisted in localStorage
  const [sidebarWidth, _setSidebarWidth] = React.useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
      if (stored) {
        const parsed = Number(stored)
        if (parsed >= SIDEBAR_WIDTH_MIN) return Math.min(parsed, window.innerWidth * 0.5)
      }
    } catch {
      // localStorage unavailable
    }
    return SIDEBAR_WIDTH_DEFAULT
  })
  const setSidebarWidth = React.useCallback((width: number) => {
    const maxWidth = Math.floor(window.innerWidth * 0.5)
    const clamped = Math.max(SIDEBAR_WIDTH_MIN, Math.min(maxWidth, width))
    _setSidebarWidth(clamped)
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped))
    } catch {
      // localStorage unavailable
    }
  }, [])

  const [isResizing, setIsResizing] = React.useState(false)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      // This sets the cookie to keep the sidebar state.
      // biome-ignore lint/suspicious/noDocumentCookie: shadcn/ui sidebar state persistence
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open],
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen])

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        // Skip when user is editing — Ctrl+B is Bold in TipTap
        const target = event.target as HTMLElement | null
        if (target) {
          const tag = target.tagName?.toLowerCase()
          if (tag === 'input' || tag === 'textarea') return
          if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true')
            return
        }
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])

  // Swipe-from-left-edge gesture to open mobile sidebar (navigation drawer pattern).
  React.useEffect(() => {
    if (!isMobile || openMobile) return

    let startX = 0
    let startY = 0
    let tracking = false

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) return
      const touch = e.touches[0]
      if (!touch) return
      if (touch.clientX < SWIPE_EDGE_ZONE) {
        startX = touch.clientX
        startY = touch.clientY
        tracking = true
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return
      const touch = e.touches[0]
      if (!touch) return
      const dx = touch.clientX - startX
      const dy = Math.abs(touch.clientY - startY)

      // Cancel if swipe becomes more vertical than horizontal
      if (dy > Math.abs(dx)) {
        tracking = false
        return
      }

      if (dx >= SWIPE_MIN_DISTANCE) {
        tracking = false
        setOpenMobile(true)
      }
    }

    const onTouchEnd = () => {
      tracking = false
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })

    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [isMobile, openMobile])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed'

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      sidebarWidth,
      setSidebarWidth,
      isResizing,
      setIsResizing,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      toggleSidebar,
      sidebarWidth,
      setSidebarWidth,
      isResizing,
    ],
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          ref={ref}
          data-slot="sidebar-wrapper"
          data-resizing={isResizing || undefined}
          style={
            {
              '--sidebar-width': `${sidebarWidth}px`,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper flex h-svh w-full has-data-[variant=inset]:bg-sidebar',
            className,
          )}
          {...props}
        >
          {/*
            UX-260 sub-fix 1: 3px coarse-pointer-only edge gradient hint that
            tells touch users a sidebar lives behind the left edge.
            `pointer:coarse` only — desktop layout unaffected. Hidden when
            the sidebar is already open on mobile.
          */}
          {isMobile && !openMobile && (
            <div
              aria-hidden="true"
              data-testid="sidebar-swipe-hint"
              className="pointer-events-none fixed left-0 inset-y-0 z-40 hidden w-[3px] bg-foreground/10 [@media(pointer:coarse)]:block"
            />
          )}
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}
SidebarProvider.displayName = 'SidebarProvider'

const Sidebar = ({
  ref,
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right'
  variant?: 'sidebar' | 'floating' | 'inset'
  collapsible?: 'offcanvas' | 'icon' | 'none'
  ref?: React.Ref<HTMLDivElement>
}) => {
  const { isMobile, state, openMobile, setOpenMobile, isResizing } = useSidebar()
  const { t } = useTranslation()

  if (collapsible === 'none') {
    return (
      <div
        ref={ref}
        data-slot="sidebar"
        className={cn(
          'flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    // The expanded-state Sheet — opened via hamburger trigger, left-edge
    // swipe, or Ctrl+B. Rendered for every `collapsible` variant on mobile.
    const sheet = (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t('sidebar.label')}</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )

    // UX-231: `collapsible="offcanvas"` keeps the original Sheet-only
    // behaviour so other consumers of this shadcn primitive are unaffected.
    if (collapsible === 'offcanvas') {
      return sheet
    }

    // UX-231: `collapsible="icon"` on mobile renders a persistent 48-px
    // icon rail AND the Sheet. The rail is always visible; the Sheet slides
    // in on top when `openMobile` becomes true. The rail's ancestor carries
    // `data-collapsible="icon"` so `SidebarMenuButton` (and every other
    // descendant that reacts to `group-data-[collapsible=icon]`) renders as
    // icon-only inside the rail.
    return (
      <>
        <nav
          ref={ref as React.Ref<HTMLElement>}
          className="group peer text-sidebar-foreground"
          data-state="collapsed"
          data-collapsible="icon"
          data-variant={variant}
          data-side={side}
          data-slot="sidebar"
          data-mobile-rail="true"
          aria-label={t('sidebar.label')}
        >
          {/* Spacer — reserves layout space so SidebarInset starts after the rail. */}
          <div
            data-slot="sidebar-gap"
            className={cn(
              'relative h-svh w-(--sidebar-width-icon) bg-transparent',
              'group-data-[side=right]:rotate-180',
            )}
          />
          {/* Fixed rail container, anchored to the viewport edge. */}
          <div
            data-slot="sidebar-container"
            className={cn(
              'fixed inset-y-0 z-10 flex h-svh w-(--sidebar-width-icon)',
              side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
              className,
            )}
          >
            <div
              data-sidebar="sidebar"
              data-slot="sidebar-inner"
              className="flex h-full w-full flex-col bg-sidebar"
            >
              {children}
            </div>
          </div>
        </nav>
        {sheet}
      </>
    )
  }

  return (
    <div
      ref={ref}
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
          isResizing && '!transition-none',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex',
          isResizing && '!transition-none',
          side === 'left'
            ? 'left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]'
            : 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
          // Adjust the padding for floating and inset variants.
          variant === 'floating' || variant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
        >
          {children}
        </div>
      </div>
    </div>
  )
}
Sidebar.displayName = 'Sidebar'

const SidebarTrigger = ({
  ref,
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) => {
  const { toggleSidebar } = useSidebar()
  const { t } = useTranslation()

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn('size-7 [@media(pointer:coarse)]:size-11', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon />
      <span className="sr-only">{t('sidebar.toggleSidebar')}</span>
    </Button>
  )
}
SidebarTrigger.displayName = 'SidebarTrigger'

const SidebarRail = ({ ref, className, ...props }: React.ComponentProps<'button'>) => {
  const { t } = useTranslation()
  const { toggleSidebar, setSidebarWidth, sidebarWidth, setIsResizing, setOpen, open } =
    useSidebar()
  const dragState = React.useRef({
    dragging: false,
    startX: 0,
    startWidth: 0,
    moved: false,
    wasCollapsed: false,
  })

  const onDoubleClick = React.useCallback(() => {
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
    setOpen(true)
  }, [setSidebarWidth, setOpen])

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const state = dragState.current
      state.dragging = true
      state.startX = e.clientX
      state.wasCollapsed = !open
      // When collapsed, start from 0 so dragging right opens smoothly
      state.startWidth = open ? sidebarWidth : 0
      state.moved = false

      const onPointerMove = (ev: PointerEvent) => {
        if (!state.dragging) return
        const delta = ev.clientX - state.startX
        if (Math.abs(delta) > 2 && !state.moved) {
          state.moved = true
          setIsResizing(true)
          // When dragging from collapsed state, open the sidebar
          if (state.wasCollapsed) {
            setOpen(true)
          }
        }
        if (state.moved) {
          const newWidth = state.startWidth + delta
          if (newWidth < SIDEBAR_WIDTH_ICON_PX) {
            // Dragged below icon width — collapse
            state.dragging = false
            document.removeEventListener('pointermove', onPointerMove)
            document.removeEventListener('pointerup', onPointerUp)
            document.documentElement.style.cursor = ''
            document.body.style.userSelect = ''
            setIsResizing(false)
            setOpen(false)
            return
          }
          setSidebarWidth(newWidth)
        }
      }

      const onPointerUp = () => {
        state.dragging = false
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', onPointerUp)
        document.documentElement.style.cursor = ''
        document.body.style.userSelect = ''
        if (state.moved) {
          setIsResizing(false)
        } else {
          // If we didn't drag, treat as a click → toggle
          toggleSidebar()
        }
      }

      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp)
      document.documentElement.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [open, sidebarWidth, setSidebarWidth, toggleSidebar, setIsResizing, setOpen],
  )

  return (
    <button
      ref={ref}
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label={t('sidebar.toggleSidebar')}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title={t('sidebar.toggleSidebar')}
      className={cn(
        'absolute inset-y-0 z-20 hidden w-4 [@media(pointer:coarse)]:w-8 -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex',
        'in-data-[side=left]:cursor-col-resize in-data-[side=right]:cursor-col-resize',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        className,
      )}
      {...props}
    />
  )
}
SidebarRail.displayName = 'SidebarRail'

const SidebarInset = ({ ref, className, ...props }: React.ComponentProps<'main'>) => {
  return (
    <main
      ref={ref}
      data-slot="sidebar-inset"
      className={cn(
        // UX-231 belt-and-braces: `overflow-x-hidden` stops any lateral
        // overflow from a SidebarInset descendant (e.g., a long tab row)
        // from bleeding to the document and pushing the app shell off the
        // viewport. Vertical overflow is unaffected.
        'relative flex min-w-0 w-full flex-1 flex-col overflow-x-hidden bg-background',
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className,
      )}
      {...props}
    />
  )
}
SidebarInset.displayName = 'SidebarInset'

const SidebarInput = ({ ref, className, ...props }: React.ComponentProps<typeof Input>) => {
  return (
    <Input
      ref={ref}
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn('h-8 w-full bg-background shadow-none', className)}
      {...props}
    />
  )
}
SidebarInput.displayName = 'SidebarInput'

const SidebarHeader = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}
SidebarHeader.displayName = 'SidebarHeader'

const SidebarFooter = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}
SidebarFooter.displayName = 'SidebarFooter'

const SidebarSeparator = ({ ref, className, ...props }: React.ComponentProps<typeof Separator>) => {
  return (
    <Separator
      ref={ref}
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('mx-2 w-auto bg-sidebar-border', className)}
      {...props}
    />
  )
}
SidebarSeparator.displayName = 'SidebarSeparator'

// Agaric override (UX-208): use ScrollArea per AGENTS.md mandate.
// The original shadcn primitive uses bare `overflow-auto`; AGENTS.md §
// "Mandatory patterns" requires `ScrollArea` for every scrollable container.
// Keep this comment in place so future shadcn pulls don't silently revert.
//
// We omit `dir` from the forwarded div props because Radix's ScrollArea.Root
// requires `Direction` ('ltr' | 'rtl'), not the loose `string | undefined`
// from HTMLAttributes. Callers that actually need dir can set it on children.
const SidebarContent = ({
  ref,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'dir'>) => {
  return (
    <ScrollArea
      ref={ref}
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'flex min-h-0 flex-1 flex-col group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      viewportClassName="flex flex-col gap-2"
      {...props}
    >
      {children}
    </ScrollArea>
  )
}
SidebarContent.displayName = 'SidebarContent'

const SidebarGroup = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn(
        'relative flex w-full min-w-0 flex-col p-2',
        // UX-231: inside the mobile icon rail the 48-px rail width is
        // reserved for 44-px touch targets, so strip horizontal padding via
        // the ancestor `data-mobile-rail="true"` attribute (set on the
        // unnamed-`group` rail wrapper). Vertical padding is preserved.
        'group-data-[mobile-rail=true]:px-0',
        className,
      )}
      {...props}
    />
  )
}
SidebarGroup.displayName = 'SidebarGroup'

const SidebarGroupLabel = ({
  ref,
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean; ref?: React.Ref<HTMLDivElement> }) => {
  const Comp = asChild ? Slot.Root : 'div'

  return (
    <Comp
      ref={ref}
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-muted-foreground outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  )
}
SidebarGroupLabel.displayName = 'SidebarGroupLabel'

const SidebarGroupAction = ({
  ref,
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean; ref?: React.Ref<HTMLButtonElement> }) => {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      ref={ref}
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        'absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}
SidebarGroupAction.displayName = 'SidebarGroupAction'

const SidebarGroupContent = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn('w-full text-sm', className)}
      {...props}
    />
  )
}
SidebarGroupContent.displayName = 'SidebarGroupContent'

const SidebarMenu = ({ ref, className, ...props }: React.ComponentProps<'ul'>) => {
  return (
    <ul
      ref={ref}
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}
SidebarMenu.displayName = 'SidebarMenu'

const SidebarMenuItem = ({ ref, className, ...props }: React.ComponentProps<'li'>) => {
  return (
    <li
      ref={ref}
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  )
}
SidebarMenuItem.displayName = 'SidebarMenuItem'

const sidebarMenuButtonVariants = cva(
  // UX-231: on touch / coarse-pointer devices, enforce the 44-px WCAG
  // Target Size minimum when the sidebar is collapsed to icon-only mode via
  // `[@media(pointer:coarse)]:group-data-[collapsible=icon]:size-11!`. The
  // desktop default stays at `size-8` (32 px) because pointer precision is
  // higher. Works in tandem with `SidebarGroup` stripping horizontal padding
  // inside the mobile rail (`group-data-[mobile-rail=true]:px-0`) so the
  // 44-px button fits fully inside the 48-px rail without any overflow /
  // paint-vs-hit-area trade-off.
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [@media(pointer:coarse)]:group-data-[collapsible=icon]:size-11! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[active=true]:rounded-l-none data-[active=true]:border-l-[3px] data-[active=true]:border-l-primary data-[active=true]:dark:border-l-4 data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-[1.2em] [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline:
          'bg-background border border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

const SidebarMenuButton = ({
  ref,
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
  ref?: React.Ref<HTMLButtonElement>
} & VariantProps<typeof sidebarMenuButtonVariants>) => {
  const Comp = asChild ? Slot.Root : 'button'
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp
      ref={ref}
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  if (typeof tooltip === 'string') {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== 'collapsed' || isMobile}
        {...tooltip}
      />
    </Tooltip>
  )
}
SidebarMenuButton.displayName = 'SidebarMenuButton'

const SidebarMenuAction = ({
  ref,
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  showOnHover?: boolean
  ref?: React.Ref<HTMLButtonElement>
}) => {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      ref={ref}
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        'absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden transition-transform peer-hover/menu-button:text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4 [&>svg]:shrink-0',
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        showOnHover &&
          'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground data-[state=open]:opacity-100 md:opacity-0',
        className,
      )}
      {...props}
    />
  )
}
SidebarMenuAction.displayName = 'SidebarMenuAction'

const SidebarMenuBadge = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}
SidebarMenuBadge.displayName = 'SidebarMenuBadge'

const SidebarMenuSkeleton = ({
  ref,
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & { showIcon?: boolean; ref?: React.Ref<HTMLDivElement> }) => {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`
  }, [])

  return (
    <div
      ref={ref}
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  )
}
SidebarMenuSkeleton.displayName = 'SidebarMenuSkeleton'

const SidebarMenuSub = ({ ref, className, ...props }: React.ComponentProps<'ul'>) => {
  return (
    <ul
      ref={ref}
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}
SidebarMenuSub.displayName = 'SidebarMenuSub'

const SidebarMenuSubItem = ({ ref, className, ...props }: React.ComponentProps<'li'>) => {
  return (
    <li
      ref={ref}
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn('group/menu-sub-item relative', className)}
      {...props}
    />
  )
}
SidebarMenuSubItem.displayName = 'SidebarMenuSubItem'

const SidebarMenuSubButton = ({
  ref,
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean
  size?: 'sm' | 'md'
  isActive?: boolean
  ref?: React.Ref<HTMLAnchorElement>
}) => {
  const Comp = asChild ? Slot.Root : 'a'

  return (
    <Comp
      ref={ref}
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-sm',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}
SidebarMenuSubButton.displayName = 'SidebarMenuSubButton'

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}
