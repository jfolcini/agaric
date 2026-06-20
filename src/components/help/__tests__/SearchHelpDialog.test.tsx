/**
 * The Toggles help section's "Icon" column must render the
 * same lucide icons the toolbar shows (CaseSensitive / WholeWord / Regex),
 * not the old `Aa` / `Ab|` / `.*` text glyphs, so users can map the help to
 * the actual toolbar buttons.
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SearchHelpDialog } from '../SearchHelpDialog'

function getTogglesSection(baseElement: HTMLElement): HTMLElement {
  // Radix Dialog portals to document.body, which `render` exposes as
  // `baseElement`. The Toggles section is labelled by its heading id.
  const section = baseElement.querySelector('[aria-labelledby="search-help-toggles"]')
  if (!(section instanceof HTMLElement)) {
    throw new Error('Toggles help section not found')
  }
  return section
}

describe('SearchHelpDialog', () => {
  it('renders the toolbar lucide icons in the Toggles icon column (not text glyphs)', () => {
    const { baseElement } = render(<SearchHelpDialog open onOpenChange={vi.fn()} />)
    const toggles = getTogglesSection(baseElement)
    // One icon per toggle row, in the first column.
    const iconCells = toggles.querySelectorAll('tbody td:first-child svg')
    expect(iconCells).toHaveLength(3)
    // The old text glyphs are gone.
    expect(toggles.textContent).not.toContain('Aa')
    expect(toggles.textContent).not.toContain('Ab|')
  })

  it('has no a11y violations', async () => {
    const { baseElement } = render(<SearchHelpDialog open onOpenChange={vi.fn()} />)
    // Scope to the dialog content: Radix renders focus-guard <span> siblings
    // (aria-hidden + tabindex=0) in the portal that trip axe's
    // aria-hidden-focus rule — a known framework false positive, not our markup.
    const content = baseElement.querySelector('[data-testid="search-help-dialog"]')
    if (!(content instanceof HTMLElement)) {
      throw new Error('dialog content not found')
    }
    expect(await axe(content)).toHaveNoViolations()
  })
})
