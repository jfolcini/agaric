/**
 * TruncatedText — one line of text cut with an ellipsis, whose full text shows
 * on hover only while it is actually cut.
 *
 * The native `title` is banned in app code (`react/forbid-dom-props`, #6895): a
 * tap never shows it, and a title that repeats visible text is noise. This is
 * its one sanctioned home, for the one case it serves: text a desktop user
 * cannot otherwise read because it was truncated. Overflow is measured when the
 * pointer or focus arrives, so a text that fits carries no title.
 */

import { useState } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

type SpanProps = Omit<React.ComponentProps<'span'>, 'children' | 'title'>

export type TruncatedTextProps = SpanProps &
  (
    | {
        /** The full text, shown cut to the box. */
        children: string
        text?: never
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
  onFocus,
  ...props
}: TruncatedTextProps): React.ReactElement {
  const [cut, setCut] = useState(false)
  return (
    <span
      data-slot="truncated-text"
      className={cn('min-w-0 truncate', className)}
      // oxlint-disable-next-line react/forbid-dom-props -- the sanctioned home: the full text of a truncated line, set only while it is cut (#6895)
      title={cut ? (text ?? (children as string)) : undefined}
      onPointerEnter={(e) => {
        setCut(isCut(e.currentTarget))
        onPointerEnter?.(e)
      }}
      onFocus={(e) => {
        setCut(isCut(e.currentTarget))
        onFocus?.(e)
      }}
      {...props}
    >
      {children}
    </span>
  )
}
TruncatedText.displayName = 'TruncatedText'

export { TruncatedText }
