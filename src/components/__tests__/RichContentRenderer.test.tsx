import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../../lib/open-url', () => ({ openUrl: vi.fn() }))

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
    const { container } = render(<>{renderRichContent('Hello world', {})}</>)
    expect(container.textContent).toBe('Hello world')
  })

  // -- Marks: bold, italic, code ----------------------------------------------

  it('renders bold text with <strong>', () => {
    const { container } = render(<>{renderRichContent('**bold text**', {})}</>)
    const strong = container.querySelector('strong')
    expect(strong).toBeInTheDocument()
    expect(strong?.textContent).toBe('bold text')
  })

  it('renders italic text with <em>', () => {
    const { container } = render(<>{renderRichContent('*italic text*', {})}</>)
    const em = container.querySelector('em')
    expect(em).toBeInTheDocument()
    expect(em?.textContent).toBe('italic text')
  })

  it('renders code text with <code>', () => {
    const { container } = render(<>{renderRichContent('`code text`', {})}</>)
    const code = container.querySelector('code')
    expect(code).toBeInTheDocument()
    expect(code?.textContent).toBe('code text')
  })

  // -- Headings ---------------------------------------------------------------

  it('renders h1 heading', () => {
    const { container } = render(<>{renderRichContent('# Main Title', {})}</>)
    const h1 = container.querySelector('h1')
    expect(h1).toBeInTheDocument()
    expect(h1?.textContent).toBe('Main Title')
  })

  it('renders h2 through h6 heading levels', () => {
    for (let level = 2; level <= 6; level++) {
      const content = `${'#'.repeat(level)} Level ${level}`
      const { container, unmount } = render(<>{renderRichContent(content, {})}</>)
      const heading = container.querySelector(`h${level}`)
      expect(heading).toBeInTheDocument()
      expect(heading?.textContent).toBe(`Level ${level}`)
      unmount()
    }
  })

  // -- Code blocks with syntax highlighting -----------------------------------

  it('renders code block with pre and code elements', () => {
    const { container } = render(<>{renderRichContent('```\nconst x = 1\n```', {})}</>)
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

    const { container } = render(<>{renderRichContent('```javascript\nconst x = 1\n```', {})}</>)
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

    const { container } = render(<>{renderRichContent('```mermaid\ngraph TD; A-->B;\n```', {})}</>)
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

    const { container } = render(<>{renderRichContent('> Quoted text', {})}</>)
    const bq = container.querySelector('blockquote')
    expect(bq).toBeInTheDocument()
    expect(bq?.textContent).toContain('Quoted text')
  })

  it('renders info callout with correct styling', () => {
    render(<>{renderRichContent('> [!INFO] important info', {})}</>)
    const callout = screen.getByTestId('callout-block')
    expect(callout).toBeInTheDocument()
    expect(callout).toHaveAttribute('data-callout-type', 'info')
    expect(callout.className).toContain('border-alert-info-border')
  })

  it('renders warning callout', () => {
    render(<>{renderRichContent('> [!WARNING] be careful', {})}</>)
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'warning')
  })

  it('renders tip callout', () => {
    render(<>{renderRichContent('> [!TIP] helpful hint', {})}</>)
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'tip')
  })

  it('renders error callout', () => {
    render(<>{renderRichContent('> [!ERROR] something broke', {})}</>)
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'error')
  })

  it('renders note callout', () => {
    render(<>{renderRichContent('> [!NOTE] take note', {})}</>)
    const callout = screen.getByTestId('callout-block')
    expect(callout).toHaveAttribute('data-callout-type', 'note')
  })

  it('exports CALLOUT_CONFIG with 5 types', () => {
    expect(Object.keys(CALLOUT_CONFIG)).toEqual(['info', 'warning', 'tip', 'error', 'note'])
  })

  // -- Ordered lists ----------------------------------------------------------

  it('renders ordered list', () => {
    const { container } = render(<>{renderRichContent('1. first\n2. second', {})}</>)
    const ol = container.querySelector('ol')
    expect(ol).toBeInTheDocument()
    const items = ol?.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items?.[0]?.textContent).toBe('first')
    expect(items?.[1]?.textContent).toBe('second')
  })

  // -- Horizontal rules -------------------------------------------------------

  it('renders horizontal rule', () => {
    const { container } = render(<>{renderRichContent('---', {})}</>)
    const hr = container.querySelector('hr')
    expect(hr).toBeInTheDocument()
    expect(screen.getByTestId('horizontal-rule')).toBeInTheDocument()
  })

  // -- Inline tokens: tag_ref -------------------------------------------------

  it('renders tag_ref as chip', () => {
    const content = `#[${TAG_ID}]`
    render(
      <>
        {renderRichContent(content, {
          resolveTagName: () => '#MyTag',
        })}
      </>,
    )
    const chip = screen.getByTestId('tag-ref-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toBe('#MyTag')
  })

  it('renders deleted tag with tag-ref-deleted class', () => {
    const content = `#[${TAG_ID}]`
    render(
      <>
        {renderRichContent(content, {
          resolveTagName: () => '#Dead',
          resolveTagStatus: () => 'deleted',
        })}
      </>,
    )
    const chip = screen.getByTestId('tag-ref-chip')
    expect(chip.classList.contains('tag-ref-deleted')).toBe(true)
    expect(chip).toHaveAttribute('aria-label', '#Dead (deleted)')
  })

  // -- Inline tokens: block_link ----------------------------------------------

  it('renders block_link as chip', () => {
    const content = `[[${BLOCK_ID}]]`
    render(
      <>
        {renderRichContent(content, {
          resolveBlockTitle: () => 'My Page',
        })}
      </>,
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
      <>
        {renderRichContent(content, {
          onNavigate,
          resolveBlockTitle: () => 'My Page',
        })}
      </>,
    )
    await user.click(screen.getByTestId('block-link-chip'))
    expect(onNavigate).toHaveBeenCalledWith(BLOCK_ID)
  })

  it('renders deleted block_link with block-link-deleted class', () => {
    const content = `[[${BLOCK_ID}]]`
    render(
      <>
        {renderRichContent(content, {
          resolveBlockTitle: () => 'Dead Page',
          resolveBlockStatus: () => 'deleted',
        })}
      </>,
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
        <>
          {renderRichContent(`((${REF_BLOCK}))`, {
            resolveBlockTitle: () => 'Referenced content',
          })}
        </>
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
        <>
          {renderRichContent(`((${REF_BLOCK}))`, {
            resolveBlockTitle: () => 'Deleted ref',
            resolveBlockStatus: () => 'deleted',
          })}
        </>
      </TooltipProvider>,
    )
    const chip = screen.getByTestId('block-ref-chip')
    expect(chip.classList.contains('block-ref-deleted')).toBe(true)
  })

  // -- Inline tokens: external_link -------------------------------------------

  it('renders external link with data-href', () => {
    const { container } = render(<>{renderRichContent('[click here](https://example.com)', {})}</>)
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
    const { container } = render(<>{renderRichContent('before\nafter', {})}</>)
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
  })

  // -- Interactive mode -------------------------------------------------------

  it('adds tabIndex and role to elements in interactive mode', () => {
    const content = `[[${BLOCK_ID}]]`
    render(
      <>
        {renderRichContent(content, {
          interactive: true,
          resolveBlockTitle: () => 'Page',
        })}
      </>,
    )
    const chip = screen.getByTestId('block-link-chip')
    expect(chip).toHaveAttribute('tabindex', '0')
    expect(chip).toHaveAttribute('role', 'link')
  })

  it('tag_ref gets tabIndex in interactive mode', () => {
    const content = `#[${TAG_ID}]`
    render(
      <>
        {renderRichContent(content, {
          interactive: true,
          resolveTagName: () => '#Tag',
        })}
      </>,
    )
    const chip = screen.getByTestId('tag-ref-chip')
    expect(chip).toHaveAttribute('tabindex', '0')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations with plain content', async () => {
    const { container } = render(<>{renderRichContent('Simple text', {})}</>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with mixed content', async () => {
    const { container } = render(
      <>
        {renderRichContent(`See [[${BLOCK_ID}]] and #[${TAG_ID}]`, {
          resolveBlockTitle: () => 'Page',
          resolveTagName: () => '#Tag',
        })}
      </>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with heading and code block', async () => {
    const { container } = render(<>{renderRichContent('# Title\n```\ncode\n```', {})}</>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
