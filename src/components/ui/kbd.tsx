/**
 * Kbd — the one way a keyboard shortcut is drawn (#1005, #7040).
 *
 * Takes a shortcut in the catalog's format (`keyboard-config/catalog.ts`):
 * tokens joined by ` + ` (`Ctrl + Shift + Arrow Up`), alternatives by ` / `.
 * Each alternative is one keycap. On macOS the modifiers are glyphs and touch
 * (`⌘⇧↑`, the catalog's `Ctrl` being the platform's mod key); elsewhere they
 * are words joined by `+` (`Ctrl+Shift+↑`). Arrow keys are glyphs everywhere.
 *
 * The keycap carries its own background and foreground (`bg-background
 * text-foreground border-border`, #1004) so it stays legible on a selected
 * row whose own colour is `bg-accent text-accent-foreground`.
 *
 * `size`: `sm` for rows (pickers, the palette), `md` for the help and
 * settings tables. `tone="muted"` drops the keycap for a menu's hint, which is
 * secondary text beside the row's label.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { Fragment } from 'react'

import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'

const kbdVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded border border-border bg-background font-mono leading-none text-foreground',
  {
    variants: {
      size: {
        sm: 'px-1.5 py-0.5 text-xs',
        md: 'px-1.5 py-0.5 text-xs font-semibold shadow-(--shadow-resting)',
      },
      tone: {
        chip: '',
        muted: 'border-transparent bg-transparent px-0 font-sans text-muted-foreground',
      },
    },
    defaultVariants: { size: 'sm', tone: 'chip' },
  },
)

const ARROW_GLYPHS: Record<string, string> = {
  'Arrow Up': '↑',
  'Arrow Down': '↓',
  'Arrow Left': '←',
  'Arrow Right': '→',
}

// `Ctrl` is the catalog's mod key; `Control` is the Control key itself.
const MAC_MODIFIER_GLYPHS: Record<string, string> = {
  Ctrl: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
}

/** One alternative (`Ctrl + Shift + Arrow Up`) as this platform writes it. */
function formatChord(chord: string): string {
  const mac = isMac()
  return chord
    .split(' + ')
    .map((token) => ARROW_GLYPHS[token] ?? (mac ? MAC_MODIFIER_GLYPHS[token] : undefined) ?? token)
    .join(mac ? '' : '+')
}

export type KbdProps = Omit<React.ComponentProps<'kbd'>, 'children' | 'ref'> &
  VariantProps<typeof kbdVariants> & {
    /** The shortcut, in the catalog's `Ctrl + K` / `A / B` format. */
    keys: string
  }

export function Kbd({ keys, size, tone, className, ...props }: KbdProps): React.ReactElement {
  const alternatives = keys.split(' / ').map(formatChord)
  if (alternatives.length === 1) {
    return (
      <kbd className={cn(kbdVariants({ size, tone }), className)} {...props}>
        {alternatives[0]}
      </kbd>
    )
  }
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)} {...props}>
      {alternatives.map((alternative, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- alternatives are positional and never reordered, and one can repeat (#1562)
        <Fragment key={i}>
          {i > 0 && <span className="font-normal text-muted-foreground">/</span>}
          <kbd className={cn(kbdVariants({ size, tone }))}>{alternative}</kbd>
        </Fragment>
      ))}
    </span>
  )
}
Kbd.displayName = 'Kbd'
