/**
 * Tests for `renderTextInline` / `applyTextMarks` (text mark rendering).
 *
 * Perf (#2201) — `applyTextMarks` was rewritten from ~7 independent
 * `find`/`some` array scans to a single pass over `node.marks`. These tests
 * pin the observable output so the rewrite is provably behaviour-preserving:
 *   - fixed innermost-out nesting (code, s, mark, em, strong, u) regardless of
 *     the marks' array order;
 *   - the external-link element wrapping the marked label (link outermost);
 *   - first-link-match semantics; and
 *   - disallowed-scheme hrefs falling back to plain marked text.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'

const mockOpenAttachmentLink = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const mockOpenUrl = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('@/lib/attachment-utils', () => ({ openAttachmentLink: mockOpenAttachmentLink }))
vi.mock('@/lib/open-url', () => ({ openUrl: mockOpenUrl }))

import type { RenderContext } from '@/components/RichContentRenderer/context'
import { renderTextInline } from '@/components/RichContentRenderer/marks/text'
import type { PMMark, TextNode } from '@/editor/types'

const ctx: RenderContext = { interactive: true }

function textNode(text: string, marks?: PMMark[]): TextNode {
  return marks ? { type: 'text', text, marks } : { type: 'text', text }
}

function html(node: TextNode): string {
  const { container } = render(<>{renderTextInline(node, 'k', ctx)}</>)
  return container.innerHTML
}

describe('applyTextMarks — single-pass equivalence (#2201)', () => {
  it('renders unmarked text as a bare span', () => {
    const { container } = render(<>{renderTextInline(textNode('hi'), 'k', ctx)}</>)
    const span = container.querySelector('span')
    expect(span?.textContent).toBe('hi')
    expect(container.querySelector('code, s, mark, em, strong, u')).toBeNull()
  })

  it('wraps each individual mark in its element', () => {
    expect(html(textNode('x', [{ type: 'code' }]))).toContain('<code')
    expect(html(textNode('x', [{ type: 'strike' }]))).toContain('<s>')
    const hl = html(textNode('x', [{ type: 'highlight' }]))
    expect(hl).toContain('<mark')
    expect(hl).toContain('bg-highlight')
    expect(html(textNode('x', [{ type: 'italic' }]))).toContain('<em>')
    expect(html(textNode('x', [{ type: 'bold' }]))).toContain('<strong>')
    expect(html(textNode('x', [{ type: 'underline' }]))).toContain('<u>')
  })

  it('applies the fixed innermost-out nesting (code, s, mark, em, strong, u)', () => {
    const all: PMMark[] = [
      { type: 'code' },
      { type: 'strike' },
      { type: 'highlight' },
      { type: 'italic' },
      { type: 'bold' },
      { type: 'underline' },
    ]
    const { container } = render(<>{renderTextInline(textNode('x', all), 'k', ctx)}</>)
    // u > strong > em > mark > s > code > text
    expect(container.querySelector('u > strong > em > mark > s > code')?.textContent).toBe('x')
  })

  it('is independent of the marks array order', () => {
    const a = html(textNode('x', [{ type: 'italic' }, { type: 'bold' }]))
    const b = html(textNode('x', [{ type: 'bold' }, { type: 'italic' }]))
    expect(a).toBe(b)
    // bold is outer, italic inner regardless of array order.
    expect(a).toContain('<strong><em>x</em></strong>')
  })

  it('wraps the marked label in an external-link element (link outermost)', () => {
    const { container } = render(
      <>
        {renderTextInline(
          textNode('go', [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://ok.test' } }]),
          'k',
          ctx,
        )}
      </>,
    )
    const link = container.querySelector('[data-testid="external-link"]')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('data-href')).toBe('https://ok.test')
    // The mark wraps the label; the link element is outside it.
    expect(link?.querySelector('strong')?.textContent).toBe('go')
  })

  it('keeps only the first link mark (find semantics)', () => {
    const { container } = render(
      <>
        {renderTextInline(
          textNode('go', [
            { type: 'link', attrs: { href: 'https://first.test' } },
            { type: 'link', attrs: { href: 'https://second.test' } },
          ]),
          'k',
          ctx,
        )}
      </>,
    )
    const link = container.querySelector('[data-testid="external-link"]')
    expect(link?.getAttribute('data-href')).toBe('https://first.test')
  })

  it('renders a disallowed-scheme href as plain marked text (no link element)', () => {
    const { container } = render(
      <>
        {renderTextInline(
          textNode('x', [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'javascript:alert(1)' } },
          ]),
          'k',
          ctx,
        )}
      </>,
    )
    expect(container.querySelector('[data-testid="external-link"]')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('x')
  })
})

describe('attachment links (#6032)', () => {
  it('renders `[label](attachment:<id>)` as a file link that downloads the attachment', async () => {
    const { container } = render(
      <p>
        {renderTextInline(
          textNode('paper', [
            { type: 'link', attrs: { href: 'attachment:01ATT0000000000000000AT01' } },
          ]),
          'k',
          ctx,
        )}
      </p>,
    )
    const link = screen.getByRole('link', { name: 'paper' })
    expect(link).toHaveAttribute('data-testid', 'attachment-link')
    expect(container.querySelector('[data-testid="external-link"]')).toBeNull()

    fireEvent.click(link)
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(mockOpenAttachmentLink.mock.calls).toEqual([
      ['01ATT0000000000000000AT01'],
      ['01ATT0000000000000000AT01'],
    ])
    expect(mockOpenUrl).not.toHaveBeenCalled()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('renders an `attachment:` href naming no id as plain text', () => {
    render(
      <>
        {renderTextInline(
          textNode('bad', [{ type: 'link', attrs: { href: 'attachment:../etc' } }]),
          'k',
          ctx,
        )}
      </>,
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('bad')).toBeInTheDocument()
  })
})
