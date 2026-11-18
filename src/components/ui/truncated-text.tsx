/**
 * TruncatedText — one line of text cut with an ellipsis, whose full text shows
 * on hover when the line does not show all of it.
 *
 * The native `title` is banned in app code (`react/forbid-dom-props`, #6895): a
 * tap never shows it, and a title that repeats visible text is noise. This is
 * its sanctioned home, for the text a desktop user cannot otherwise read:
 * - the line is cut: overflow is measured when the pointer arrives;
 * - the line is shortened on purpose: it shows a namespaced page's leaf, and
 *   `text` holds the full title.
 * A line that shows its full text, uncut, carries no title.
 */

import { useState } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

type SpanProps = Omit<React.ComponentProps<'span'>, 'children' | 'title'>

export type TruncatedTextProps = SpanProps &
  (
    | {
        /** The text shown, cut to the box. */
        children: string
        /** The full text, when `children` shortens it (a namespaced page's leaf). */
        text?: string
      }
    | {
        /** Rich content (a search highlight), shown cut to the box. */
        children: React.ReactNode
        /** Its full text, for the hover. */
        text: string
      }
  )

function isCut(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth
}

function TruncatedText({
  children,
  text,
  className,
  onPointerEnter,
  ...props
}: TruncatedTextProps): React.ReactElement {
  const [cut, setCut] = useState(false)
  const full = text ?? (children as string)
  const shortened = typeof children === 'string' && full !== children
  return (
    <span
      data-slot="truncated-text"
      className={cn('min-w-0 truncate', className)}
      // oxlint-disable-next-line react/forbid-dom-props -- the sanctioned home: the full text of a line that is cut or shortened (#6895)
      title={cut || shortened ? full : undefined}
      onPointerEnter={(e) => {
        setCut(isCut(e.currentTarget))
        onPointerEnter?.(e)
      }}
      {...props}
    >
      {children}
    </span>
  )
}
TruncatedText.displayName = 'TruncatedText'

export { TruncatedText }
