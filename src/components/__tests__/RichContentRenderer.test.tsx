import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../../lib/open-url', () => ({ openUrl: vi.fn() }))

const { openUrl } = await import('../../lib/open-url')
const mockedOpenUrl = vi.mocked(openUrl)

vi.mock('../../editor/markdown-serializer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../editor/markdown-serializer')>()
  return { ...mod, parse: vi.fn(mod.parse) }
})

const { parse } = await import('../../editor/markdown-serializer')
const mockedParse = vi.mocked(parse)

import { CALLOUT_CONFIG, renderRichContent } from '../RichContentRenderer'
import { TooltipProvider } from '../ui/tooltip'

const BLOCK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TAG_ID = '01CRZ3NDEKTSV4RRFFQ69G5FAV'
const REF_BLOCK = '01NRZ3NDEKTSV4RRFFQ69G5FAV'

describe('RichContentRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -- Plain text / paragraphs ------------------------------------------------

  it('returns null for empty string', () => {
    const result = renderRichContent('', {})
    expect(result).toBeNull()
  })

  it('renders plain text paragraph', () => {
    const { container } = render(renderRichContent('Hello world', {}))
    expect(container.textContent).toBe('Hello world')
  })

  // -- Marks: bold, italic, code ----------------------------------------------

  it('renders bold text with <strong>', () => {
    const { container } = render(renderRichContent('**bold text**', {}))
    const strong = container.querySelector('strong')
    expect(strong).toBeInTheDocument()
    expect(strong?.textContent).toBe('bold text')
  })

  it('renders italic text with <em>', () => {
    const { container } = render(renderRichContent('*italic text*', {}))
    const em = container.querySelector('em')
    expect(em).toBeInTheDocument()
    expect(em?.textContent).toBe('italic text')
  })

  it('renders code text with <code>', () => {
    const { container } = render(renderRichContent('`code text`', {}))
    const code = container.querySelector('code')
    expect(code).toBeInTheDocument()
    expect(code?.textContent).toBe('code text')
  })

  // -- Headings ---------------------------------------------------------------

  it('renders h1 heading', () => {
    const { container } = render(renderRichContent('# Main Title', {}))
    const h1 = container.querySelector('h1')
    expect(h1).toBeInTheDocument()
    expect(h1?.textContent).toBe('Main Title')
  })

  it('renders h2 through h6 heading levels', () => {
    for (let level = 2; level <= 6; level++) {
      const content = `${'#'.repeat(level)} Level ${level}`
      const { container, unmount } = render(renderRichContent(content, {}))
      const heading = container.querySelector(`h${level}`)
      expect(heading).toBeInTheDocument()
      expect(heading?.textContent).toBe(`Level ${level}`)
      unmount()
    }
  })

  // -- Code blocks with syntax highlighting -----------------------------------

  it('renders code block with pre and code elements', () => {
    const { container } = render(renderRichContent('```\nconst x = 1\n```', {}))
    const pre = container.querySelector('pre')
    expect(pre).toBeInTheDocument()
    const code = pre?.querySelector('code')
    expect(code?.textContent).toContain('const x = 1')
  })

  it('renders code block with language class', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'javascript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    } as ReturnType<typeof parse>)

    const { container } = render(renderRichContent('```javascript\nconst x = 1\n```', {}))
    const code = container.querySelector('code.language-javascript')
    expect(code).toBeInTheDocument()
  })

  // -- Mermaid code blocks (lazy load) ----------------------------------------

  it('renders mermaid code block with Suspense fallback', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'mermaid' },
          content: [{ type: 'text', text: 'graph TD; A-->B;' }],
        },
      ],
    } as ReturnType<typeof parse>)

    const { container } = render(renderRichContent('```mermaid\ngraph TD; A-->B;\n```', {}))
    // Should render Suspense fallback (loading state) or the MermaidDiagram
    const loadingOrDiagram =
      container.querySelector('[role="status"]') ??
      container.querySelector('[data-testid="mermaid-diagram"]')
    expect(loadingOrDiagram).toBeInTheDocument()
  })

  // -- Blockquotes and callouts -----------------------------------------------

  it('renders plain blockquote', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted text' }] }],
        },
      ],
    } as ReturnType<typeof parse>)

    const { container } = render(renderRichContent('> Quoted text', {}))
    const bq = container.querySelector('blockquote')
    expect(bq).toBeInTheDocument()
    expect(bq?.textContent).toContain('Quoted text')
  })

  it('renders info callout with correct styling', () => {
    render(renderRichContent('> [!INFO] important info', {}))
    const callout = screen.getByTestId('callout-block')
    expect(callout).toBeInTheDocument()
    expect(callout).toHaveAttribute('data-callout-type', 'info')
    expect(callout.className).toContain('border-alert-info-border')
  })

  it('renders warning callout', () => {
    render(renderRichContent('> [!WARNING] be careful', {}))
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'warning')
  })

  it('renders tip callout', () => {
    render(renderRichContent('> [!TIP] helpful hint', {}))
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'tip')
  })

  it('renders error callout', () => {
    render(renderRichContent('> [!ERROR] something broke', {}))
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'error')
  })

  it('renders note callout', () => {
    render(renderRichContent('> [!NOTE] take note', {}))
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'note')
  })

  it('exports CALLOUT_CONFIG with 5 types', () => {
    expect(Object.keys(CALLOUT_CONFIG)).toEqual(['info', 'warning', 'tip', 'error', 'note'])
  })

  // -- Ordered lists ----------------------------------------------------------

  it('renders ordered list', () => {
    const { container } = render(renderRichContent('1. first\n2. second', {}))
    const ol = container.querySelector('ol')
    expect(ol).toBeInTheDocument()
    const items = ol?.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items?.[0]?.textContent).toBe('first')
    expect(items?.[1]?.textContent).toBe('second')
  })

  // -- Horizontal rules -------------------------------------------------------

  it('renders horizontal rule', () => {
    const { container } = render(renderRichContent('---', {}))
    const hr = container.querySelector('hr')
    expect(hr).toBeInTheDocument()
    expect(screen.getByTestId('horizontal-rule')).toBeInTheDocument()
  })

  // -- Inline tokens: tag_ref -------------------------------------------------

  it('renders tag_ref as chip', () => {
    const content = `#[${TAG_ID}]`
    render(
      renderRichContent(content, {
        resolveTagName: () => '#MyTag',
      }),
    )
    const chip = screen.getByTestId('tag-ref-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toBe('#MyTag')
  })

  it('renders deleted tag with tag-ref-deleted class', () => {
    const content = `#[${TAG_ID}]`
    render(
      renderRichContent(content, {
        resolveTagName: () => '#Dead',
        resolveTagStatus: () => 'deleted',
      }),
    )
    const chip = screen.getByTestId('tag-ref-chip')
    expect(chip.classList.contains('tag-ref-deleted')).toBe(true)
    expect(chip).toHaveAttribute('aria-label', '#Dead (deleted)')
  })

  // -- Inline tokens: block_link ----------------------------------------------

  it('renders block_link as chip', () => {
    const content = `[[${BLOCK_ID}]]`
    render(
      renderRichContent(content, {
        resolveBlockTitle: () => 'My Page',
      }),
    )
    const chip = screen.getByTestId('block-link-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toBe('My Page')
  })

  it('block_link click calls onNavigate', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    const content = `[[${BLOCK_ID}]]`
    render(
      renderRichContent(content, {
        onNavigate,
        resolveBlockTitle: () => 'My Page',
      }),
    )
    await user.click(screen.getByTestId('block-link-chip'))
    expect(onNavigate).toHaveBeenCalledWith(BLOCK_ID)
  })

  it('renders deleted block_link with block-link-deleted class', () => {
    const content = `[[${BLOCK_ID}]]`
    render(
      renderRichContent(content, {
        resolveBlockTitle: () => 'Dead Page',
        resolveBlockStatus: () => 'deleted',
      }),
    )
    const chip = screen.getByTestId('block-link-chip')
    expect(chip.classList.contains('block-link-deleted')).toBe(true)
    expect(chip).toHaveAttribute('aria-label', 'Dead Page (deleted)')
  })

  // -- Inline tokens: block_ref -----------------------------------------------

  it('renders block_ref as chip with tooltip', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    render(
      <TooltipProvider>
        {renderRichContent(`((${REF_BLOCK}))`, {
          resolveBlockTitle: () => 'Referenced content',
        })}
      </TooltipProvider>,
    )
    const chip = screen.getByTestId('block-ref-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toBe('Referenced content')
  })

  it('renders deleted block_ref with block-ref-deleted class', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    render(
      <TooltipProvider>
        {renderRichContent(`((${REF_BLOCK}))`, {
          resolveBlockTitle: () => 'Deleted ref',
          resolveBlockStatus: () => 'deleted',
        })}
      </TooltipProvider>,
    )
    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.classList.contains('block-ref-deleted')).toBe(true)
  })

  // -- Inline tokens: external_link -------------------------------------------

  it('renders external link with data-href', () => {
    const { container } = render(renderRichContent('[click here](https://example.com)', {}))
    const link = container.querySelector('span.external-link')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('data-href')).toBe('https://example.com')
    expect(link?.textContent).toContain('click here')
  })

  // -- Inline tokens: hardBreak -----------------------------------------------

  it('renders hardBreak as space span', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before' },
            { type: 'hardBreak' },
            { type: 'text', text: 'after' },
          ],
        },
      ],
    })
    const { container } = render(renderRichContent('before\nafter', {}))
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
  })

  // -- Interactive mode -------------------------------------------------------

  it('adds tabIndex and role to elements in interactive mode', () => {
    const content = `[[${BLOCK_ID}]]`
    render(
      renderRichContent(content, {
        interactive: true,
        resolveBlockTitle: () => 'Page',
      }),
    )
    const chip = screen.getByTestId('block-link-chip')
    expect(chip).toHaveAttribute('tabindex', '0')
    expect(chip).toHaveAttribute('role', 'link')
  })

  it('tag_ref gets tabIndex in interactive mode', () => {
    const content = `#[${TAG_ID}]`
    render(
      renderRichContent(content, {
        interactive: true,
        resolveTagName: () => '#Tag',
      }),
    )
    const chip = screen.getByTestId('tag-ref-chip')
    expect(chip).toHaveAttribute('tabindex', '0')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations with plain content', async () => {
    const { container } = render(renderRichContent('Simple text', {}))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with mixed content', async () => {
    const { container } = render(
      renderRichContent(`See [[${BLOCK_ID}]] and #[${TAG_ID}]`, {
        resolveBlockTitle: () => 'Page',
        resolveTagName: () => '#Tag',
      }),
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with heading and code block', async () => {
    const { container } = render(renderRichContent('# Title\n```\ncode\n```', {}))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -- External link behaviour ------------------------------------------------

  it('external link click calls openUrl and stops propagation', async () => {
    const user = userEvent.setup()
    const { container } = render(renderRichContent('[click](https://example.com)', {}))
    const link = container.querySelector('span.external-link')
    expect(link).not.toBeNull()
    if (link) await user.click(link)
    expect(mockedOpenUrl).toHaveBeenCalledTimes(1)
    expect(mockedOpenUrl).toHaveBeenCalledWith('https://example.com')
  })

  it('external link Enter key triggers openUrl (interactive mode)', async () => {
    const user = userEvent.setup()
    render(renderRichContent('[click](https://example.com)', { interactive: true }))
    const link = screen.getByTestId('external-link')
    link.focus()
    await user.keyboard('{Enter}')
    expect(mockedOpenUrl).toHaveBeenCalledTimes(1)
    expect(mockedOpenUrl).toHaveBeenCalledWith('https://example.com')
  })

  it('external link Space key triggers openUrl (interactive mode)', async () => {
    const user = userEvent.setup()
    render(renderRichContent('[click](https://example.com)', { interactive: true }))
    const link = screen.getByTestId('external-link')
    link.focus()
    await user.keyboard(' ')
    expect(mockedOpenUrl).toHaveBeenCalledTimes(1)
  })

  it('external link other keys do not trigger openUrl', async () => {
    const user = userEvent.setup()
    render(renderRichContent('[click](https://example.com)', { interactive: true }))
    const link = screen.getByTestId('external-link')
    link.focus()
    await user.keyboard('a')
    expect(mockedOpenUrl).not.toHaveBeenCalled()
  })

  it('external link has role=link for screen readers', () => {
    render(renderRichContent('[click](https://example.com)', {}))
    const link = screen.getByTestId('external-link')
    expect(link).toHaveAttribute('role', 'link')
  })

  it('interactive external link gets tabIndex=0', () => {
    render(renderRichContent('[click](https://example.com)', { interactive: true }))
    const link = screen.getByTestId('external-link')
    expect(link).toHaveAttribute('tabindex', '0')
  })

  it('non-interactive external link has no tabIndex', () => {
    render(renderRichContent('[click](https://example.com)', {}))
    const link = screen.getByTestId('external-link')
    expect(link).not.toHaveAttribute('tabindex')
  })

  // -- Block link keyboard interactions ---------------------------------------

  it('block_link Enter key triggers onNavigate', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(
      renderRichContent(`[[${BLOCK_ID}]]`, {
        onNavigate,
        interactive: true,
        resolveBlockTitle: () => 'Page',
      }),
    )
    const chip = screen.getByTestId('block-link-chip')
    chip.focus()
    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(BLOCK_ID)
  })

  it('block_link Space key triggers onNavigate', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(
      renderRichContent(`[[${BLOCK_ID}]]`, {
        onNavigate,
        interactive: true,
        resolveBlockTitle: () => 'Page',
      }),
    )
    const chip = screen.getByTestId('block-link-chip')
    chip.focus()
    await user.keyboard(' ')
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('block_link click without onNavigate is inert (no crash)', async () => {
    const user = userEvent.setup()
    render(renderRichContent(`[[${BLOCK_ID}]]`, { resolveBlockTitle: () => 'Page' }))
    await user.click(screen.getByTestId('block-link-chip'))
    // No-op: just verify nothing throws
    expect(screen.getByTestId('block-link-chip')).toBeInTheDocument()
  })

  // -- Block ref interactions -------------------------------------------------

  it('block_ref click calls onNavigate', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    render(
      <TooltipProvider>
        {renderRichContent(`((${REF_BLOCK}))`, {
          onNavigate,
          resolveBlockTitle: () => 'Referenced',
        })}
      </TooltipProvider>,
    )
    await user.click(screen.getByTestId('block-ref-chip'))
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(REF_BLOCK)
  })

  it('block_ref Enter key triggers onNavigate', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    render(
      <TooltipProvider>
        {renderRichContent(`((${REF_BLOCK}))`, {
          onNavigate,
          resolveBlockTitle: () => 'Referenced',
        })}
      </TooltipProvider>,
    )
    const chip = screen.getByTestId('block-ref-chip')
    chip.focus()
    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('block_ref role is button when non-interactive', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    render(
      <TooltipProvider>
        {renderRichContent(`((${REF_BLOCK}))`, {
          resolveBlockTitle: () => 'Referenced',
        })}
      </TooltipProvider>,
    )
    expect(screen.getByTestId('block-ref-chip')).toHaveAttribute('role', 'button')
  })

  it('block_ref role is link in interactive mode', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    render(
      <TooltipProvider>
        {renderRichContent(`((${REF_BLOCK}))`, {
          resolveBlockTitle: () => 'Referenced',
          interactive: true,
        })}
      </TooltipProvider>,
    )
    expect(screen.getByTestId('block-ref-chip')).toHaveAttribute('role', 'link')
  })

  it('block_ref long content is truncated in chip label', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    const longTitle = 'x'.repeat(200)
    render(
      <TooltipProvider>
        {renderRichContent(`((${REF_BLOCK}))`, {
          resolveBlockTitle: () => longTitle,
        })}
      </TooltipProvider>,
    )
    const chip = screen.getByTestId('block-ref-chip')
    // First-line truncated at 57 chars + ellipsis
    expect(chip.textContent?.length).toBe(60)
    expect(chip.textContent?.endsWith('...')).toBe(true)
  })

  it('block_ref falls back to id-slice when resolver returns undefined', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'block_ref', attrs: { id: REF_BLOCK } }],
        },
      ],
    })
    render(<TooltipProvider>{renderRichContent(`((${REF_BLOCK}))`, {})}</TooltipProvider>)
    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.textContent).toContain(REF_BLOCK.slice(0, 8))
  })

  // -- Inline mark fall-through (strike / highlight) --------------------------

  it('strike mark text passes through as plain text (no wrapper)', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'crossed', marks: [{ type: 'strike' }] }],
        },
      ],
    })
    const { container } = render(renderRichContent('~~crossed~~', {}))
    expect(container.textContent).toBe('crossed')
  })

  it('highlight mark text passes through as plain text (no wrapper)', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hl', marks: [{ type: 'highlight' }] }],
        },
      ],
    })
    const { container } = render(renderRichContent('==hl==', {}))
    expect(container.textContent).toBe('hl')
  })

  // -- Combined marks ---------------------------------------------------------

  it('bold and italic combine into nested strong+em', () => {
    const { container } = render(renderRichContent('***both***', {}))
    const strong = container.querySelector('strong')
    const em = strong?.querySelector('em')
    expect(strong).not.toBeNull()
    expect(em).not.toBeNull()
    expect(em?.textContent).toBe('both')
  })

  it('code + bold nests code inside bold', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'both',
              marks: [{ type: 'bold' }, { type: 'code' }],
            },
          ],
        },
      ],
    })
    const { container } = render(renderRichContent('ignored', {}))
    const strong = container.querySelector('strong')
    expect(strong?.querySelector('code')).not.toBeNull()
  })

  // -- Ordered list with multiple paragraphs per item -------------------------

  it('ordered list item with two paragraphs flattens inline content', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
              ],
            },
          ],
        },
      ],
    } as ReturnType<typeof parse>)
    const { container } = render(renderRichContent('1. stuff', {}))
    const items = container.querySelectorAll('li')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('a')
    expect(items[0]?.textContent).toContain('b')
  })

  // -- Separator between blocks -----------------------------------------------

  it('inserts a space separator between consecutive blocks', () => {
    const { container } = render(renderRichContent('# One\n# Two', {}))
    const h1s = container.querySelectorAll('h1')
    expect(h1s).toHaveLength(2)
  })

  // -- a11y per block type ----------------------------------------------------

  it('has no a11y violations for ordered list', async () => {
    const { container } = render(renderRichContent('1. first\n2. second', {}))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations for blockquote', async () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
        },
      ],
    } as ReturnType<typeof parse>)
    const { container } = render(renderRichContent('> quoted', {}))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations for info callout', async () => {
    const { container } = render(renderRichContent('> [!INFO] hello', {}))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations for horizontal rule', async () => {
    const { container } = render(renderRichContent('---', {}))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations for code block with language', async () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'javascript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    } as ReturnType<typeof parse>)
    const { container } = render(renderRichContent('```javascript\nconst x = 1\n```', {}))
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations for interactive block_link', async () => {
    const { container } = render(
      renderRichContent(`[[${BLOCK_ID}]]`, {
        interactive: true,
        onNavigate: () => {},
        resolveBlockTitle: () => 'Target',
      }),
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations for external link', async () => {
    const { container } = render(
      renderRichContent('[example](https://example.com)', { interactive: true }),
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -- Edge cases -------------------------------------------------------------

  it('returns null for markdown parsing to an empty doc', () => {
    mockedParse.mockReturnValueOnce({ type: 'doc' } as ReturnType<typeof parse>)
    const result = renderRichContent('whatever', {})
    expect(result).toBeNull()
  })

  it('tag_ref falls back to id-slice when resolver returns undefined', () => {
    render(renderRichContent(`#[${TAG_ID}]`, {}))
    const chip = screen.getByTestId('tag-ref-chip')
    expect(chip.textContent).toContain(TAG_ID.slice(0, 8))
  })

  it('block_link falls back to id-slice when resolver returns undefined', () => {
    render(renderRichContent(`[[${BLOCK_ID}]]`, {}))
    const chip = screen.getByTestId('block-link-chip')
    expect(chip.textContent).toContain(BLOCK_ID.slice(0, 8))
  })

  it('unknown callout type falls back to note config', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { calloutType: 'mystery' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        },
      ],
    } as ReturnType<typeof parse>)
    const { container } = render(renderRichContent('ignored', {}))
    const callout = container.querySelector('[data-testid="callout-block"]')
    expect(callout).not.toBeNull()
    expect(callout?.getAttribute('data-callout-type')).toBe('mystery')
  })

  it('empty paragraph renders nothing for that block but separator still applies', () => {
    mockedParse.mockReturnValueOnce({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph' },
      ],
    } as ReturnType<typeof parse>)
    const { container } = render(renderRichContent('first\n', {}))
    expect(container.textContent).toContain('first')
  })
})
