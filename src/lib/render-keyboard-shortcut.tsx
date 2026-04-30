/**
 * renderKeys — render a keyboard shortcut string as styled `<kbd>` elements.
 *
 * Shared between `KeyboardSettingsTab` and `KeyboardShortcuts`. Handles
 * `+` combos and `/` alternatives, and substitutes the platform mod key
 * (Cmd / Ctrl) for the literal `Ctrl` token.
 */

import React from 'react'
import { modKey } from './platform'

/** Render a keys string as styled <kbd> elements. Handles `+` combos and `/` alternatives. */
export function renderKeys(keys: string): React.ReactNode {
  const alternatives = keys.split(' / ')
  const mod = modKey()
  return alternatives.map((alt, i) => {
    const parts = alt.split(' + ').map((part) => (part === 'Ctrl' ? mod : part))
    return (
      <React.Fragment key={alt}>
        {i > 0 && <span className="text-muted-foreground font-normal mx-1">/</span>}
        {parts.map((part, j) => (
          <React.Fragment key={part}>
            {j > 0 && <span className="text-muted-foreground font-normal mx-0.5">+</span>}
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold shadow-sm">
              {part}
            </kbd>
          </React.Fragment>
        ))}
      </React.Fragment>
    )
  })
}
