/**
 * Canonical keyboard-chip primitive (#1005).
 *
 * Before this component the same "keyboard shortcut" concept was styled
 * four different ways across nine-plus call sites (slash menu, command
 * palette, action menu, mode chip, search-help, journal tooltips) and a
 * competing `renderKeys` helper added a fifth. This is the single
 * implementation; `lib/render-keyboard-shortcut.tsx#renderKeys` now
 * delegates here so there is exactly one chip look.
 *
 * Two exports:
 *  - `<Kbd>`        — a single key/token chip (e.g. `↵`, `Esc`, `Alt+T`).
 *  - `<KbdChord keys="Ctrl + K" />` — a chord string: splits `+` combos
 *    and `/` alternatives, substitutes the platform mod key (⌘ / Ctrl)
 *    for a literal `Ctrl` token, and renders one `<Kbd>` per token with
 *    `+` / `/` separators.
 *
 * Visual tokens (#1004): the chip carries its **own** background and
 * foreground (`bg-background text-foreground border-border`, the Logseq
 * inert-badge model) so it stays legible on a selected row whose own
 * colour is `bg-accent text-accent-foreground`. Deriving the chip fill
 * from a row-relative token (the old `bg-muted/40`) made the chip nearly
 * invisible once the row was selected; an absolute token fixes that and
 * meets WCAG AA (4.5:1) in both themes on selected and unselected rows.
 *
 * `size`:
 *  - `sm` — compact slash-menu / palette chip (`text-[11px]`).
 *  - `md` — prominent settings / help chip (`text-xs font-semibold`,
 *    a subtle shadow), matching the old `renderKeys` look.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { Fragment } from 'react'

import { modKey } from '@/lib/platform'
import { cn } from '@/lib/utils'

const kbdVariants = cva(
  // Absolute (not row-relative) colour tokens so the chip contrasts
  // regardless of the surrounding row's selection state (#1004).
  'inline-flex items-center justify-center rounded border border-border bg-background font-mono leading-none text-foreground',
  {
    variants: {
      size: {
        sm: 'px-1.5 py-0.5 text-[11px]',
        md: 'px-1.5 py-0.5 text-xs font-semibold shadow-sm',
      },
    },
    defaultVariants: { size: 'sm' },
  },
)

export type KbdProps = React.ComponentProps<'kbd'> & VariantProps<typeof kbdVariants>

/** A single keyboard-key chip. */
export function Kbd({ size, className, children, ...props }: KbdProps): React.ReactElement {
  return (
    <kbd className={cn(kbdVariants({ size }), className)} {...props}>
      {children}
    </kbd>
  )
}
Kbd.displayName = 'Kbd'

export interface KbdChordProps extends VariantProps<typeof kbdVariants> {
  /**
   * Chord string. `+`-separated tokens form one combo; ` / `-separated
   * groups are alternatives. The literal `Ctrl` token is replaced with
   * the platform mod glyph (⌘ on macOS, Ctrl elsewhere).
   */
  keys: string
  /** Forwarded to the wrapping element (spacing, `aria-hidden`, etc.). */
  className?: string
}

/**
 * Render a chord string as styled `<Kbd>` chips joined by `+` / `/`
 * separators. Folds the former `renderKeys` logic in (#1005).
 */
export function KbdChord({ keys, size, className }: KbdChordProps): React.ReactElement {
  const mod = modKey()
  const alternatives = keys.split(' / ')
  return (
    <span className={cn('inline-flex flex-wrap items-center', className)}>
      {alternatives.map((alt, i) => {
        const parts = alt.split(' + ').map((part) => (part === 'Ctrl' ? mod : part))
        return (
          // Tokens are positional and never reordered, so an index-based key is
          // correct. It also avoids duplicate-key collisions when a chord
          // repeats a token (e.g. `G + G`) or an alternative — keying by the
          // token text alone produced duplicate React keys (#1562). The token
          // text is appended only to keep keys human-readable.
          // oxlint-disable-next-line react/no-array-index-key -- tokens are positional and never reordered, so the index uniquely + stably identifies each Fragment; keying by token text alone produced duplicate keys for repeated tokens (#1562)
          <Fragment key={`${i}-${alt}`}>
            {i > 0 && <span className="mx-1 font-normal text-muted-foreground">/</span>}
            {parts.map((part, j) => (
              // oxlint-disable-next-line react/no-array-index-key -- tokens are positional and never reordered, so the index uniquely + stably identifies each Fragment; keying by token text alone produced duplicate keys for repeated tokens (#1562)
              <Fragment key={`${i}-${j}-${part}`}>
                {j > 0 && <span className="mx-0.5 font-normal text-muted-foreground">+</span>}
                <Kbd size={size}>{part}</Kbd>
              </Fragment>
            ))}
          </Fragment>
        )
      })}
    </span>
  )
}
KbdChord.displayName = 'KbdChord'
