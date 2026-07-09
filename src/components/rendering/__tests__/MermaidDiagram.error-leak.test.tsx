/**
 * Regression tests for the mermaid error-artifact leak (finding 43).
 *
 * Unlike `MermaidDiagram.test.tsx` (which mocks the `mermaid` module), these
 * tests run against the REAL mermaid package: the bug lives inside mermaid's
 * own `render()` error path. In mermaid 11.x a parse failure renders a
 * full-width "Syntax error" SVG into a `<div id="d<renderId>">` appended to
 * `document.body` and throws BEFORE removing it — so every failed render
 * leaked a visible, orphaned error diagram (one per keystroke while editing,
 * since the node view remounts the diagram per source change with a fresh
 * renderId). `initializeMermaid` must set `suppressErrorRendering: true` so
 * failures surface only through the component's own inline error UI.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MermaidDiagram } from '@/components/rendering/MermaidDiagram'
import { __resetThemeStoreForTests } from '@/hooks/useTheme'

/**
 * Mermaid appends its render scratch/error element to `document.body` as
 * `<div id="d<renderId>">`; the component's renderIds are `mermaid-…`, so any
 * leaked artifact matches this selector.
 */
const LEAKED_ARTIFACT_SELECTOR = 'body > [id^="dmermaid-"]'

describe('MermaidDiagram — failed renders must not leak error artifacts (finding 43)', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetThemeStoreForTests()
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    localStorage.clear()
    __resetThemeStoreForTests()
    document.documentElement.classList.remove('dark')
    // Belt-and-braces: never let one test's leak bleed into the next.
    for (const el of document.querySelectorAll(LEAKED_ARTIFACT_SELECTOR)) el.remove()
  })

  it('shows the inline error UI and leaves no error-SVG div in document.body', async () => {
    render(<MermaidDiagram code="definitely not mermaid" />)

    const errorEl = await screen.findByTestId('mermaid-error', undefined, { timeout: 15000 })
    expect(errorEl).toBeInTheDocument()
    // The raw source stays available inside the inline error state.
    expect(errorEl.querySelector('code')?.textContent).toBe('definitely not mermaid')

    expect(document.querySelectorAll(LEAKED_ARTIFACT_SELECTOR)).toHaveLength(0)
  }, 20000)

  it('does not accumulate artifacts across repeated failed renders (per-keystroke remounts)', async () => {
    // Each remount gets a fresh useId-derived renderId — exactly what happens
    // while typing in the node view (`key={source}`), so mermaid's same-id
    // cleanup can never remove a previous failure's element.
    const { unmount: unmount1 } = render(<MermaidDiagram code="graph TD; A--" />)
    await screen.findByTestId('mermaid-error', undefined, { timeout: 15000 })
    unmount1()

    const { unmount: unmount2 } = render(<MermaidDiagram code="graph TD; A-->" />)
    await screen.findByTestId('mermaid-error', undefined, { timeout: 15000 })
    unmount2()

    expect(document.querySelectorAll(LEAKED_ARTIFACT_SELECTOR)).toHaveLength(0)
  }, 30000)
})
