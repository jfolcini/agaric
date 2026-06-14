/**
 * Tests for the code-block renderer's highlight size cap (#747 item 3).
 *
 * `highlightAuto` scans the full source across every registered grammar with
 * backtracking regexes — O(grammars × length) work on the render thread — so a
 * pasted multi-hundred-KB log stalls the render. We cap highlighting at
 * `HIGHLIGHT_MAX_LENGTH` (30 KB) and fall back to plain text above it.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import type { CodeBlockNode } from '../../../../editor/types'
import { HIGHLIGHT_MAX_LENGTH, renderCodeBlock } from '../code'

function codeBlock(text: string, language: string | null = null): CodeBlockNode {
  return {
    type: 'codeBlock',
    attrs: { language },
    content: [{ type: 'text', text }],
  }
}

describe('renderCodeBlock — highlight size cap (#747 item 3)', () => {
  it('highlights small code blocks (hljs spans present below the cap)', () => {
    const block = codeBlock('const x: number = 1', 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    const spans = container.querySelectorAll('span[class*="hljs-"]')
    expect(spans.length).toBeGreaterThan(0)
    // Source text is preserved.
    expect(container.querySelector('code')?.textContent).toContain('const x')
  })

  it('highlights small code blocks via highlightAuto when no language is set', () => {
    const block = codeBlock('def greet():\n    return "hi"\n', null)
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    const spans = container.querySelectorAll('span[class*="hljs-"]')
    expect(spans.length).toBeGreaterThan(0)
  })

  it('falls back to PLAIN TEXT above the cap — no highlight spans (auto path)', () => {
    // A >cap input that WOULD otherwise produce highlight spans if processed.
    const huge = 'const value = 42;\n'.repeat(Math.ceil(HIGHLIGHT_MAX_LENGTH / 18) + 100)
    expect(huge.length).toBeGreaterThan(HIGHLIGHT_MAX_LENGTH)

    const block = codeBlock(huge, null)
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    // No highlighting applied — code rendered as plain text.
    expect(container.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0)
    // ...but the full source is still rendered (readable, just uncolored).
    expect(container.querySelector('code')?.textContent).toContain('const value = 42;')
  })

  it('falls back to plain text above the cap on the explicit-language path too', () => {
    const huge = 'fn main() {}\n'.repeat(Math.ceil(HIGHLIGHT_MAX_LENGTH / 13) + 100)
    expect(huge.length).toBeGreaterThan(HIGHLIGHT_MAX_LENGTH)

    const block = codeBlock(huge, 'rust')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)

    expect(container.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0)
    expect(container.querySelector('code')?.textContent).toContain('fn main()')
  })

  it('still highlights a block right at the cap boundary', () => {
    // Exactly the cap length (not over) → highlighting still runs.
    const filler = '// x\n'
    const base = 'const x = 1;\n'
    let body = base
    while (body.length + filler.length <= HIGHLIGHT_MAX_LENGTH) body += filler
    expect(body.length).toBeLessThanOrEqual(HIGHLIGHT_MAX_LENGTH)

    const block = codeBlock(body, 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)
    expect(container.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0)
  })

  it('has no axe violations (small highlighted block)', async () => {
    const block = codeBlock('const x = 1', 'typescript')
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations (plain-text fallback above the cap)', async () => {
    const huge = 'log line here\n'.repeat(Math.ceil(HIGHLIGHT_MAX_LENGTH / 14) + 100)
    const block = codeBlock(huge, null)
    const { container } = render(<>{renderCodeBlock(block, 'k')}</>)
    expect(await axe(container)).toHaveNoViolations()
  })
})
