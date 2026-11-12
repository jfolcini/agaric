/**
 * Shared render-context type + heading-class lookup + callout config for
 * RichContentRenderer sub-modules. Lives in its own file so per-mark
 * renderers (under `./marks/`) can import it without depending on the
 * dispatcher (which would create a cycle).
 */
import { AlertTriangle, Info, Lightbulb, StickyNote, XCircle } from 'lucide-react'
import type React from 'react'

import type { FootnoteNumbering } from '@/editor/footnotes'
import type { BlockLinkNode } from '@/editor/types'

/** Render-time context shared across block and inline sub-renderers. */
export interface RenderContext {
  readonly onNavigate?: ((id: string) => void) | undefined
  readonly onTagClick?: ((id: string) => void) | undefined
  readonly resolveBlockTitle?: ((id: string) => string | undefined) | undefined
  readonly resolveTagName?: ((id: string) => string | undefined) | undefined
  readonly resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  readonly resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  readonly interactive?: boolean | undefined
  /** Set where the rendered content can be edited: a broken `[[link]]` chip then removes itself. */
  readonly removeBrokenLink?: ((link: BlockLinkNode) => void) | undefined
  /**
   * #4551 — the block this content is being rendered *about*. A `[[ULID]]` or
   * `((ULID))` chip naming it is the one that earned the row its place in a
   * linked-references list, so it gets an anchor highlight
   * (`.ref-chip-anchor`) to pick it out of the row's other chips.
   */
  readonly anchorRefId?: string | undefined
  /** Preview mode (#1533): nothing that breaks a clamped one-line row. */
  readonly inline?: boolean | undefined
  /** The numbering of the page the content is on (#6033); unset, a footnote shows its label. */
  readonly footnotes?: FootnoteNumbering | undefined
}

export const HEADING_CLASSES: Record<number, string> = {
  1: 'text-heading-1 font-bold',
  2: 'text-heading-2 font-bold',
  3: 'text-heading-3 font-semibold',
  4: 'text-heading-4 font-semibold',
  5: 'text-heading-5 font-semibold',
  6: 'text-heading-6 font-semibold uppercase tracking-wide',
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

/** Every callout variant, in menu order: the toolbar picker and the block menu list these. */
export const CALLOUT_TYPES: readonly string[] = Object.keys(CALLOUT_CONFIG)
