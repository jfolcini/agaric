/**
 * Shared render-context type + heading-class lookup + callout config for
 * RichContentRenderer sub-modules. Lives in its own file so per-mark
 * renderers (under `./marks/`) can import it without depending on the
 * dispatcher (which would create a cycle).
 */
import { AlertTriangle, Info, Lightbulb, StickyNote, XCircle } from 'lucide-react'
import type React from 'react'

/** Render-time context shared across block and inline sub-renderers. */
export interface RenderContext {
  readonly onNavigate?: ((id: string) => void) | undefined
  readonly onTagClick?: ((id: string) => void) | undefined
  readonly resolveBlockTitle?: ((id: string) => string | undefined) | undefined
  readonly resolveTagName?: ((id: string) => string | undefined) | undefined
  readonly resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  readonly resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  readonly interactive?: boolean | undefined
}

export const HEADING_CLASSES: Record<number, string> = {
  1: 'text-xl sm:text-2xl font-bold',
  2: 'text-lg sm:text-xl font-bold',
  3: 'text-base sm:text-lg font-semibold',
  4: 'text-sm sm:text-base font-semibold',
  5: 'text-sm font-semibold',
  6: 'text-xs font-semibold uppercase tracking-wide',
}

/** Callout type configuration: border color, icon, and label. */
export const CALLOUT_CONFIG: Record<
  string,
  {
    borderClass: string
    bgClass: string
    textClass: string
    icon: React.ComponentType<{ className?: string | undefined }>
    label: string
  }
> = {
  info: {
    borderClass: 'border-alert-info-border',
    bgClass: 'bg-alert-info',
    textClass: 'text-alert-info-foreground',
    icon: Info,
    label: 'Info',
  },
  warning: {
    borderClass: 'border-alert-warning-border',
    bgClass: 'bg-alert-warning',
    textClass: 'text-alert-warning-foreground',
    icon: AlertTriangle,
    label: 'Warning',
  },
  tip: {
    borderClass: 'border-alert-tip-border',
    bgClass: 'bg-alert-tip',
    textClass: 'text-alert-tip-foreground',
    icon: Lightbulb,
    label: 'Tip',
  },
  error: {
    borderClass: 'border-alert-error-border',
    bgClass: 'bg-alert-error',
    textClass: 'text-alert-error-foreground',
    icon: XCircle,
    label: 'Error',
  },
  note: {
    borderClass: 'border-alert-note-border',
    bgClass: 'bg-alert-note',
    textClass: 'text-alert-note-foreground',
    icon: StickyNote,
    label: 'Note',
  },
}
