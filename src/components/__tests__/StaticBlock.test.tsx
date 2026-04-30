/**
 * Tests for StaticBlock component.
 *
 * Validates:
 *  - Renders plain text content
 *  - Renders block_link tokens as clickable spans with correct classes
 *  - Renders tag_ref tokens as spans with correct classes
 *  - Applies block-link-deleted class for broken links
 *  - Applies tag-ref-deleted class for deleted tags
 *  - Click on block_link calls onNavigate (not onFocus)
 *  - Empty content shows placeholder
 *  - a11y compliance
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { AttachmentRow } from '../../lib/tauri'
import { StaticBlock } from '../StaticBlock'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('../../lib/open-url', () => ({ openUrl: vi.fn() }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}))

// MAINT-131: StaticBlock now reads attachments from the
// BatchAttachmentsProvider context instead of `useBlockAttachments`.
vi.mock('../../hooks/useBatchAttachments', () => ({
  useBatchAttachments: vi.fn(),
}))

vi.mock('../../editor/markdown-serializer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../editor/markdown-serializer')>()
  return { ...mod, parse: vi.fn(mod.parse) }
})

vi.mock('../../lib/tauri', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...mod,
    getProperties: vi.fn(() => Promise.resolve([])),
    setProperty: vi.fn(() => Promise.resolve({})),
  }
})

// Lazy-import after mocks are hoisted so we get the mocked version.
const { useBatchAttachments } = await import('../../hooks/useBatchAttachments')
const mockedUseBatchAttachments = vi.mocked(useBatchAttachments)

/**
 * Convenience: build a mock return for `useBatchAttachments` that maps
 * the test-only block id `'B1'` to the supplied attachment list. All
 * other ids return undefined (matches the "block not in cache" path).
 */
function mockBatchAttachments(attachments: AttachmentRow[], options: { loading?: boolean } = {}) {
  mockedUseBatchAttachments.mockReturnValue({
    get: (id: string) => (id === 'B1' ? attachments : undefined),
    loading: options.loading ?? false,
    invalidate: vi.fn(),
  })
}

const { parse } = await import('../../editor/markdown-serializer')
const mockedParse = vi.mocked(parse)

const { invoke } = await import('@tauri-apps/api/core')
const mockedInvoke = vi.mocked(invoke)

const { getProperties, setProperty } = await import('../../lib/tauri')
const mockedGetProperties = vi.mocked(getProperties)
const mockedSetProperty = vi.mocked(setProperty)

// Valid 26-char ULID-format test IDs (parser requires [0-9A-Z]{26}).
const BLOCK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const BLOCK_ID_2 = '01BRZ3NDEKTSV4RRFFQ69G5FAV'
const TAG_ID = '01CRZ3NDEKTSV4RRFFQ69G5FAV'
const TAG_ID_2 = '01DRZ3NDEKTSV4RRFFQ69G5FAV'
const DEL_BLOCK = '01ERZ3NDEKTSV4RRFFQ69G5FAV'
const ACT_BLOCK = '01FRZ3NDEKTSV4RRFFQ69G5FAV'
const DEL_TAG = '01GRZ3NDEKTSV4RRFFQ69G5FAV'
const ACT_TAG = '01HRZ3NDEKTSV4RRFFQ69G5FAV'
const NAV_BLOCK = '01JRZ3NDEKTSV4RRFFQ69G5FAV'
const MIX_PAGE = '01KRZ3NDEKTSV4RRFFQ69G5FAV'
const MIX_TAG = '01MRZ3NDEKTSV4RRFFQ69G5FAV'
const REF_BLOCK = '01NRZ3NDEKTSV4RRFFQ69G5FAV'
const REF_BLOCK_2 = '01PRZ3NDEKTSV4RRFFQ69G5FAV'

describe('StaticBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default behavior for mocked tauri functions
    mockedGetProperties.mockResolvedValue([])
    mockedSetProperty.mockResolvedValue({} as never)
    mockBatchAttachments([])
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
  })

  it('renders plain text', () => {
    render(<StaticBlock blockId="B1" content="Hello world" onFocus={vi.fn()} />)
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('renders empty block placeholder when content is empty', () => {
    render(<StaticBlock blockId="B1" content="" onFocus={vi.fn()} />)
    expect(screen.getByText('Type / for commands...')).toBeInTheDocument()
  })

  it('empty block has min-height class for visibility', () => {
    const { container } = render(<StaticBlock blockId="B1" content="" onFocus={vi.fn()} />)
    const button = container.querySelector('.block-static')
    expect(button).not.toBeNull()
    expect(button?.classList.contains('min-h-[1.75rem]')).toBe(true)
  })

  it('calls onFocus when the block button is clicked', async () => {
    const onFocus = vi.fn()
    const user = userEvent.setup()
    render(<StaticBlock blockId="B1" content="Click me" onFocus={onFocus} />)

    await user.click(screen.getByRole('button'))
    expect(onFocus).toHaveBeenCalledWith('B1')
  })

  // -- Block link tokens ------------------------------------------------------

  it('renders block_link token with block-link-chip class', () => {
    const content = `[[${BLOCK_ID}]]`
    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'My Page'}
      />,
    )

    const chip = screen.getByText('My Page')
    expect(chip).toBeInTheDocument()
    expect(chip.classList.contains('block-link-chip')).toBe(true)
    expect(chip.classList.contains('cursor-pointer')).toBe(true)
  })

  it('falls back to truncated ULID when resolveBlockTitle is not provided', () => {
    const content = `[[${BLOCK_ID_2}]]`
    render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)

    // Default fallback: [[01BRZ3ND...]]
    expect(screen.getByText(`[[${BLOCK_ID_2.slice(0, 8)}...]]`)).toBeInTheDocument()
  })

  it('calls onNavigate (not onFocus) when block link is clicked', async () => {
    const onFocus = vi.fn()
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    const content = `[[${NAV_BLOCK}]]`

    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={onFocus}
        onNavigate={onNavigate}
        resolveBlockTitle={() => 'Target Page'}
      />,
    )

    const chip = screen.getByText('Target Page')
    await user.click(chip)
    expect(onNavigate).toHaveBeenCalledWith(NAV_BLOCK)
    // onFocus should NOT be called because stopPropagation prevents it
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('applies block-link-deleted class for broken links', () => {
    const content = `[[${DEL_BLOCK}]]`
    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'Gone Page'}
        resolveBlockStatus={() => 'deleted'}
      />,
    )

    const chip = screen.getByText('Gone Page')
    expect(chip.classList.contains('block-link-deleted')).toBe(true)
    expect(chip.classList.contains('block-link-chip')).toBe(true)
  })

  it('does not apply block-link-deleted class for active links', () => {
    const content = `[[${ACT_BLOCK}]]`
    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'Active Page'}
        resolveBlockStatus={() => 'active'}
      />,
    )

    const chip = screen.getByText('Active Page')
    expect(chip.classList.contains('block-link-deleted')).toBe(false)
  })

  // -- Tag ref tokens ---------------------------------------------------------

  it('renders tag_ref token with tag-ref-chip class', () => {
    const content = `#[${TAG_ID}]`
    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveTagName={() => '#ProjectAlpha'}
      />,
    )

    const chip = screen.getByText('#ProjectAlpha')
    expect(chip).toBeInTheDocument()
    expect(chip.classList.contains('tag-ref-chip')).toBe(true)
  })

  it('falls back to truncated ULID when resolveTagName is not provided', () => {
    const content = `#[${TAG_ID_2}]`
    render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)

    // Default fallback: #01DRZ3ND...
    expect(screen.getByText(`#${TAG_ID_2.slice(0, 8)}...`)).toBeInTheDocument()
  })

  it('applies tag-ref-deleted class for deleted tags', () => {
    const content = `#[${DEL_TAG}]`
    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveTagName={() => '#OldTag'}
        resolveTagStatus={() => 'deleted'}
      />,
    )

    const chip = screen.getByText('#OldTag')
    expect(chip.classList.contains('tag-ref-deleted')).toBe(true)
    expect(chip.classList.contains('tag-ref-chip')).toBe(true)
  })

  it('does not apply tag-ref-deleted class for active tags', () => {
    const content = `#[${ACT_TAG}]`
    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveTagName={() => '#LiveTag'}
        resolveTagStatus={() => 'active'}
      />,
    )

    const chip = screen.getByText('#LiveTag')
    expect(chip.classList.contains('tag-ref-deleted')).toBe(false)
  })

  // -- Mixed content ----------------------------------------------------------

  it('renders text mixed with block_link and tag_ref tokens', () => {
    const content = `See [[${MIX_PAGE}]] and #[${MIX_TAG}] for details`
    const { container } = render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'Page One'}
        resolveTagName={() => '#ImportantTag'}
      />,
    )

    expect(screen.getByText('Page One')).toBeInTheDocument()
    expect(screen.getByText('#ImportantTag')).toBeInTheDocument()
    // Verify the full text content includes all parts
    const button = container.querySelector('.block-static')
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('See')
    expect(button?.textContent).toContain('Page One')
    expect(button?.textContent).toContain('and')
    expect(button?.textContent).toContain('#ImportantTag')
    expect(button?.textContent).toContain('for details')
  })

  it('renders both deleted block_link and deleted tag_ref with correct classes', () => {
    const content = `[[${DEL_BLOCK}]] and #[${DEL_TAG}]`
    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'Dead Page'}
        resolveTagName={() => '#DeadTag'}
        resolveBlockStatus={() => 'deleted'}
        resolveTagStatus={() => 'deleted'}
      />,
    )

    const linkChip = screen.getByText('Dead Page')
    expect(linkChip.classList.contains('block-link-deleted')).toBe(true)
    expect(linkChip.classList.contains('block-link-chip')).toBe(true)

    const tagChip = screen.getByText('#DeadTag')
    expect(tagChip.classList.contains('tag-ref-deleted')).toBe(true)
    expect(tagChip.classList.contains('tag-ref-chip')).toBe(true)
  })

  it('clicking block_link chip without onNavigate bubbles to parent', async () => {
    const onFocus = vi.fn()
    const user = userEvent.setup()
    const content = `[[${NAV_BLOCK}]]`

    render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={onFocus}
        resolveBlockTitle={() => 'Some Page'}
      />,
    )

    const chip = screen.getByText('Some Page')
    await user.click(chip)
    // onNavigate is undefined — click should not throw; without stopPropagation
    // the click bubbles to the parent button, triggering onFocus
    expect(onFocus).toHaveBeenCalledWith('B1')
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations with plain content', async () => {
    const { container } = render(
      <StaticBlock blockId="B1" content="Simple text" onFocus={vi.fn()} />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with token content', async () => {
    const { container } = render(
      <StaticBlock
        blockId="B1"
        content={`See [[${BLOCK_ID}]] and #[${TAG_ID}]`}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'Linked Page'}
        resolveTagName={() => '#MyTag'}
      />,
    )
    // UX-249: clickable tag/link chips (role="link", tabIndex=0) inside
    // StaticBlock's role="button" wrapper deliberately create nested-
    // interactive DOM — a pre-existing structural trade-off also flagged
    // by QueryResult nesting. Disable the rule for this audit.
    const results = await axe(container, {
      rules: { 'nested-interactive': { enabled: false } },
    })
    expect(results).toHaveNoViolations()
  })

  // -- External links ---------------------------------------------------------

  it('renders external link as <span> with correct classes and data-href', () => {
    const content = '[click here](https://example.com)'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)

    const link = container.querySelector('span.external-link')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('click here')
    expect(link?.getAttribute('data-href')).toBe('https://example.com')
    expect(link?.classList.contains('cursor-pointer')).toBe(true)
  })

  it('external link click does not trigger onFocus', async () => {
    const onFocus = vi.fn()
    const user = userEvent.setup()
    const content = '[link](https://example.com)'

    render(<StaticBlock blockId="B1" content={content} onFocus={onFocus} />)

    const link = screen.getByText('link')
    await user.click(link)
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('external link click calls openUrl with the href', async () => {
    const { openUrl } = await import('../../lib/open-url')
    const mockedOpenUrl = vi.mocked(openUrl)
    mockedOpenUrl.mockClear()
    const user = userEvent.setup()
    const content = '[click here](https://example.com)'

    render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)

    const link = screen.getByText('click here')
    await user.click(link)
    expect(mockedOpenUrl).toHaveBeenCalledWith('https://example.com')
  })

  it('renders text mixed with external link and block_link', () => {
    const content = `See [docs](https://docs.com) and [[${BLOCK_ID}]] here`
    const { container } = render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'My Page'}
      />,
    )

    const extLink = container.querySelector('span.external-link')
    expect(extLink?.textContent).toContain('docs')
    expect(extLink?.getAttribute('data-href')).toBe('https://docs.com')

    expect(screen.getByText('My Page')).toBeInTheDocument()
    const button = container.querySelector('.block-static')
    expect(button?.textContent).toContain('See')
    expect(button?.textContent).toContain('docs')
    expect(button?.textContent).toContain('My Page')
    expect(button?.textContent).toContain('here')
  })

  it('has no a11y violations with external link content', async () => {
    const { container } = render(
      <StaticBlock
        blockId="B1"
        content="Visit [example](https://example.com) for more"
        onFocus={vi.fn()}
      />,
    )
    // UX-249: external link spans are focusable inside StaticBlock's
    // role="button" wrapper (tabIndex=0 when interactive), creating
    // nested-interactive DOM — same structural trade-off as the token
    // content audit above.
    const results = await axe(container, {
      rules: { 'nested-interactive': { enabled: false } },
    })
    expect(results).toHaveNoViolations()
  })

  it('external link renders new-tab indicator and sr-only text', () => {
    const content = '[click here](https://example.com)'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)

    const link = container.querySelector('span.external-link')
    expect(link).not.toBeNull()

    // sr-only text for screen readers
    const srOnly = link?.querySelector('.sr-only')
    expect(srOnly).not.toBeNull()
    expect(srOnly?.textContent).toBe(' (opens in new tab)')

    // Visual arrow indicator
    const arrow = link?.querySelector('[aria-hidden="true"]')
    expect(arrow).not.toBeNull()
    expect(arrow?.textContent).toBe('↗')
  })

  // -- Bold / italic / code marks ---------------------------------------------

  it('renders bold text with <strong> element', () => {
    const content = '**bold text**'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    const strong = container.querySelector('strong')
    expect(strong).toBeInTheDocument()
    expect(strong?.textContent).toBe('bold text')
  })

  it('renders italic text with <em> element', () => {
    const content = '*italic text*'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    const em = container.querySelector('em')
    expect(em).toBeInTheDocument()
    expect(em?.textContent).toBe('italic text')
  })

  it('renders code text with <code> element', () => {
    const content = '`code text`'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    const code = container.querySelector('code')
    expect(code).toBeInTheDocument()
    expect(code?.textContent).toBe('code text')
  })

  it('renders bold italic text with nested <strong> and <em>', () => {
    const content = '***bold italic***'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    const strong = container.querySelector('strong')
    expect(strong).toBeInTheDocument()
    const em = strong?.querySelector('em')
    expect(em).toBeInTheDocument()
    expect(em?.textContent).toBe('bold italic')
  })

  it('renders bold external link with <strong> wrapping the link span', () => {
    const content = '**[click](https://example.com)**'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    const strong = container.querySelector('strong')
    expect(strong).toBeInTheDocument()
    const link = strong?.querySelector('.external-link')
    expect(link).toBeInTheDocument()
    expect(link?.textContent).toContain('click')
  })

  it('renders bold text adjacent to block_link chip', () => {
    const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const content = `**important** see [[${ULID}]]`
    const { container } = render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'My Page'}
      />,
    )
    expect(container.querySelector('strong')?.textContent).toBe('important')
    expect(screen.getByText('My Page')).toBeInTheDocument()
  })

  // -- Mark combinations ------------------------------------------------------

  it('renders italic external link with <em> wrapping the link span', () => {
    const content = '*[click](https://example.com)*'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    const em = container.querySelector('em')
    expect(em).toBeInTheDocument()
    const link = em?.querySelector('.external-link')
    expect(link).toBeInTheDocument()
    expect(link?.textContent).toContain('click')
  })

  it('renders mixed bold, italic, and plain text segments', () => {
    const content = '**bold** and *italic* and plain'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('em')?.textContent).toBe('italic')
    expect(container.textContent).toContain('and')
    expect(container.textContent).toContain('plain')
  })

  it('renders bold text between block_link and tag_ref nodes', () => {
    const ULID1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const ULID2 = '01BRZ3NDEKTSV4RRFFQ69G5FAV'
    const content = `[[${ULID1}]] **important** #[${ULID2}]`
    const { container } = render(
      <StaticBlock
        blockId="B1"
        content={content}
        onFocus={vi.fn()}
        resolveBlockTitle={() => 'Page'}
        resolveTagName={() => '#Tag'}
      />,
    )
    expect(screen.getByText('Page')).toBeInTheDocument()
    expect(container.querySelector('strong')?.textContent).toBe('important')
    expect(screen.getByText('#Tag')).toBeInTheDocument()
  })

  it('renders code span without processing inner marks', () => {
    const content = '`**not bold**`'
    const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
    const code = container.querySelector('code')
    expect(code).toBeInTheDocument()
    expect(code?.textContent).toBe('**not bold**')
    expect(container.querySelector('strong')).not.toBeInTheDocument()
  })

  // -- Heading rendering ------------------------------------------------------

  describe('heading rendering', () => {
    it('renders h1 heading with correct class', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content="# Main Title" onFocus={vi.fn()} />,
      )
      const h1 = container.querySelector('h1')
      expect(h1).toBeInTheDocument()
      expect(h1).toHaveTextContent('Main Title')
    })

    it('renders h2 through h6 heading levels', () => {
      for (let level = 2; level <= 6; level++) {
        const content = `${'#'.repeat(level)} Level ${level}`
        const { container, unmount } = render(
          <StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />,
        )
        const heading = container.querySelector(`h${level}`)
        expect(heading).toBeInTheDocument()
        expect(heading).toHaveTextContent(`Level ${level}`)
        unmount()
      }
    })

    it('renders heading with inline bold mark', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content="## **bold** heading" onFocus={vi.fn()} />,
      )
      const h2 = container.querySelector('h2')
      expect(h2).toBeInTheDocument()
      expect(h2?.querySelector('strong')).toHaveTextContent('bold')
    })

    it('renders heading with block_link token', () => {
      render(
        <StaticBlock
          blockId="B1"
          content="# Title [[01ARZ3NDEKTSV4RRFFQ69G5FAV]]"
          onFocus={vi.fn()}
          resolveBlockTitle={() => 'My Page'}
        />,
      )
      expect(screen.getByText('My Page')).toBeInTheDocument()
    })
  })

  // -- Code block rendering ---------------------------------------------------

  describe('code block rendering', () => {
    it('renders code block with pre and code elements', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'```\nconst x = 1\n```'} onFocus={vi.fn()} />,
      )
      const pre = container.querySelector('pre')
      expect(pre).toBeInTheDocument()
      const code = pre?.querySelector('code')
      expect(code).toHaveTextContent('const x = 1')
    })

    it('renders multi-line code block preserving content', () => {
      const content = '```\nfunction hello() {\n  return "world"\n}\n```'
      const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
      const code = container.querySelector('code')
      expect(code?.textContent).toContain('function hello()')
      expect(code?.textContent).toContain('return "world"')
    })

    it('renders mixed content: paragraph + code block + paragraph', () => {
      const content = 'Before\n```\ncode here\n```\nAfter'
      const { container } = render(<StaticBlock blockId="B1" content={content} onFocus={vi.fn()} />)
      expect(container.textContent).toContain('Before')
      expect(container.querySelector('code')).toHaveTextContent('code here')
      expect(container.textContent).toContain('After')
    })

    it('renders empty code block', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'```\n```'} onFocus={vi.fn()} />,
      )
      const pre = container.querySelector('pre')
      expect(pre).toBeInTheDocument()
    })

    it('passes a11y with heading and code block content', async () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'# Title\n```\ncode\n```'} onFocus={vi.fn()} />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  // -- ARIA attributes --------------------------------------------------------

  describe('ARIA attributes', () => {
    it('has aria-label="Edit block" on the button', () => {
      render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)
      const button = screen.getByRole('button', { name: 'Edit block' })
      expect(button).toBeInTheDocument()
    })
  })

  // -- TEST-4c: role="button" div (non-nested interactive elements) -----------
  //
  // StaticBlock's outer element is a <div role="button"> rather than a native
  // <button> so it can contain nested interactive children (QueryResult's
  // chevron toggle and edit-query pencil) without producing invalid HTML
  // ("<button> cannot be a descendant of <button>").

  describe('TEST-4c: role="button" div focus model', () => {
    it('outer focusable element is a <div>, not a <button>', () => {
      render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)
      const outer = screen.getByRole('button', { name: 'Edit block' })
      expect(outer.tagName).toBe('DIV')
      expect(outer.getAttribute('role')).toBe('button')
      expect(outer.getAttribute('tabindex')).toBe('0')
    })

    it('outer element has no nested <button> descendants for plain content', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content="Hello world" onFocus={vi.fn()} />,
      )
      const outer = screen.getByRole('button', { name: 'Edit block' })
      // The outer itself is a div — any nested <button> is a nesting violation.
      expect(outer.tagName).toBe('DIV')
      const nestedButtons = outer.querySelectorAll('button')
      expect(nestedButtons.length).toBe(0)
      // Full-container sanity check: no element is both a <button> element AND
      // a descendant of another <button> element.
      const allButtons = container.querySelectorAll('button')
      for (const btn of allButtons) {
        expect(btn.parentElement?.closest('button')).toBeNull()
      }
    })

    it('pressing Enter on the outer element calls onFocus', async () => {
      const onFocus = vi.fn()
      const user = userEvent.setup()
      render(<StaticBlock blockId="B1" content="Hello" onFocus={onFocus} />)

      const outer = screen.getByRole('button', { name: 'Edit block' })
      outer.focus()
      expect(outer).toHaveFocus()

      await user.keyboard('{Enter}')
      expect(onFocus).toHaveBeenCalledWith('B1')
      expect(onFocus).toHaveBeenCalledTimes(1)
    })

    it('pressing Space on the outer element calls onFocus and prevents default', () => {
      const onFocus = vi.fn()
      render(<StaticBlock blockId="B1" content="Hello" onFocus={onFocus} />)

      const outer = screen.getByRole('button', { name: 'Edit block' })
      const event = fireEvent.keyDown(outer, { key: ' ', code: 'Space' })
      // fireEvent.keyDown returns true if event was not canceled; we expect
      // preventDefault to have fired (page should not scroll on Space).
      expect(event).toBe(false)
      expect(onFocus).toHaveBeenCalledWith('B1')
    })

    it('Ctrl+Enter on the outer element triggers onSelect toggle (not onFocus)', async () => {
      const onFocus = vi.fn()
      const onSelect = vi.fn()
      const user = userEvent.setup()
      render(<StaticBlock blockId="B1" content="Hello" onFocus={onFocus} onSelect={onSelect} />)

      const outer = screen.getByRole('button', { name: 'Edit block' })
      outer.focus()
      await user.keyboard('{Control>}{Enter}{/Control}')
      expect(onSelect).toHaveBeenCalledWith('B1', 'toggle')
      expect(onFocus).not.toHaveBeenCalled()
    })

    it('Shift+Enter on the outer element triggers onSelect range (not onFocus)', async () => {
      const onFocus = vi.fn()
      const onSelect = vi.fn()
      const user = userEvent.setup()
      render(<StaticBlock blockId="B1" content="Hello" onFocus={onFocus} onSelect={onSelect} />)

      const outer = screen.getByRole('button', { name: 'Edit block' })
      outer.focus()
      await user.keyboard('{Shift>}{Enter}{/Shift}')
      expect(onSelect).toHaveBeenCalledWith('B1', 'range')
      expect(onFocus).not.toHaveBeenCalled()
    })

    it('keydown bubbling from a nested element does NOT trigger outer onFocus', () => {
      // Reproduce the inner-button bubble scenario: a keydown event whose
      // target is a descendant element must not call the outer's onFocus
      // handler. The guard is `e.target === e.currentTarget` in handleOuterKeyDown.
      const onFocus = vi.fn()
      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={onFocus} />)
      const outer = screen.getByRole('button', { name: 'Edit block' })

      // Simulate a keydown targeted at an inner span (the richContent node),
      // bubbling up to the outer div. This mirrors the QueryResult chevron
      // button case where Enter on the inner real <button> bubbles up here.
      const inner = outer.querySelector('span') ?? container.querySelector('span')
      expect(inner).not.toBeNull()
      fireEvent.keyDown(inner as Element, { key: 'Enter', bubbles: true })
      expect(onFocus).not.toHaveBeenCalled()
    })

    it('query-block variant is also a <div role="button"> with no nested button-in-button', () => {
      // Query blocks render QueryResult inside the outer focusable element.
      // QueryResult renders its own real <button>s (chevron toggle). Since the
      // outer is now a <div>, these inner <button>s are valid HTML.
      const { container } = render(
        <StaticBlock blockId="B1" content="{{query type:tag expr:project}}" onFocus={vi.fn()} />,
      )
      const outer = container.querySelector('[data-testid="block-static"]')
      expect(outer).not.toBeNull()
      expect(outer?.tagName).toBe('DIV')
      expect(outer?.getAttribute('role')).toBe('button')
      // Sanity: any <button> in the subtree must not have another <button>
      // ancestor (no button-in-button).
      const allButtons = container.querySelectorAll('button')
      for (const btn of allButtons) {
        expect(btn.parentElement?.closest('button')).toBeNull()
      }
    })

    it('query-block variant: clicking a non-interactive descendant calls onFocus', async () => {
      // The query block's inner subtree (QueryResult + QueryResultList) is
      // densely interactive — chevron toggle, edit pencil, result items, page
      // links — and each inner handler calls stopPropagation. Without the
      // capture-phase handler, a plain `.click()` on the block-static element
      // would land on a result item and never re-enter edit mode. This test
      // pins the capture-phase path (see handleQueryBlockClickCapture).
      const onFocus = vi.fn()
      const user = userEvent.setup()
      const { container } = render(
        <StaticBlock blockId="B1" content="{{query type:tag expr:project}}" onFocus={onFocus} />,
      )
      const outer = container.querySelector('[data-testid="block-static"]') as HTMLDivElement | null
      expect(outer).not.toBeNull()
      // Click on a non-interactive descendant (the query-result card
      // background, which renders even while results are still loading).
      const card = outer?.querySelector('[data-testid="query-result"]') as HTMLElement | null
      expect(card).not.toBeNull()
      if (card) await user.click(card)
      expect(onFocus).toHaveBeenCalledWith('B1')
    })

    it('query-block variant: clicking the chevron toggle does NOT call onFocus', async () => {
      // The capture handler must yield the click to real <button> / <a> /
      // [role="link"] targets so the chevron still toggles collapse (and so
      // the edit-pencil still opens the visual builder) without also kicking
      // the block into edit mode.
      const onFocus = vi.fn()
      const user = userEvent.setup()
      const { container } = render(
        <StaticBlock blockId="B1" content="{{query type:tag expr:project}}" onFocus={onFocus} />,
      )
      const chevron = container.querySelector(
        '[data-testid="query-result"] button',
      ) as HTMLButtonElement | null
      expect(chevron).not.toBeNull()
      if (chevron) await user.click(chevron)
      expect(onFocus).not.toHaveBeenCalled()
    })

    it('has no a11y violations with role="button" div (plain content)', async () => {
      const { container } = render(
        <StaticBlock blockId="B1" content="Plain content" onFocus={vi.fn()} />,
      )
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // -- Attachment inline rendering --------------------------------------------

  describe('attachment rendering', () => {
    function makeAttachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
      return {
        id: 'att-1',
        block_id: 'B1',
        filename: 'photo.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        fs_path: '/path/to/photo.png',
        created_at: '2024-01-01T00:00:00Z',
        ...overrides,
      }
    }

    it('renders image attachment as <img> when Tauri is available', () => {
      ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
      mockBatchAttachments([makeAttachment()])

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      const img = container.querySelector('img')
      expect(img).toBeInTheDocument()
      expect(img?.getAttribute('alt')).toBe('photo.png')
      expect(img?.getAttribute('loading')).toBe('lazy')
      expect(img?.getAttribute('src')).toContain('photo.png')
      expect(img?.style.maxWidth).toBe('100%')
      expect(img?.style.maxHeight).toBe('400px')
      expect(img?.style.objectFit).toBe('contain')
    })

    it('renders non-image attachment as file chip', () => {
      mockBatchAttachments([
        makeAttachment({
          id: 'att-2',
          filename: 'document.pdf',
          mime_type: 'application/pdf',
          size_bytes: 2048,
          fs_path: '/path/to/document.pdf',
        }),
      ])

      render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      expect(screen.getByText('document.pdf')).toBeInTheDocument()
      expect(screen.getByText('2.0 KB')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open file document.pdf' })).toBeInTheDocument()
    })

    it('shows nothing when no attachments', () => {
      // Default mock returns empty attachments
      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      expect(container.querySelector('[data-testid="attachment-section"]')).not.toBeInTheDocument()
    })

    it('shows nothing when attachments are loading', () => {
      mockBatchAttachments([], { loading: true })

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      expect(container.querySelector('[data-testid="attachment-section"]')).not.toBeInTheDocument()
    })

    it('handles multiple attachments (mix of images and files)', () => {
      ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
      mockBatchAttachments([
        makeAttachment({ id: 'att-1', filename: 'photo.png', mime_type: 'image/png' }),
        makeAttachment({
          id: 'att-2',
          filename: 'notes.txt',
          mime_type: 'text/plain',
          size_bytes: 512,
        }),
        makeAttachment({
          id: 'att-3',
          filename: 'archive.zip',
          mime_type: 'application/zip',
          size_bytes: 1048576,
        }),
      ])

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      // Image renders as <img>
      const img = container.querySelector('img')
      expect(img).toBeInTheDocument()
      expect(img?.getAttribute('alt')).toBe('photo.png')

      // Non-image files render as chips
      expect(screen.getByText('notes.txt')).toBeInTheDocument()
      expect(screen.getByText('512 B')).toBeInTheDocument()
      expect(screen.getByText('archive.zip')).toBeInTheDocument()
      expect(screen.getByText('1.0 MB')).toBeInTheDocument()
    })

    it('does not render image when Tauri is not available', () => {
      // __TAURI_INTERNALS__ is not set (cleaned up by beforeEach)
      mockBatchAttachments([makeAttachment()])

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      // Image should not render without Tauri; no attachment section if only images
      expect(container.querySelector('img')).not.toBeInTheDocument()
    })

    it('renders text chip for text/plain attachment with FileText icon', () => {
      mockBatchAttachments([
        makeAttachment({
          id: 'att-txt',
          filename: 'readme.txt',
          mime_type: 'text/plain',
          size_bytes: 256,
        }),
      ])

      render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      expect(screen.getByText('readme.txt')).toBeInTheDocument()
      expect(screen.getByText('256 B')).toBeInTheDocument()
    })

    it('has no a11y violations with attachments', async () => {
      mockBatchAttachments([
        makeAttachment({
          id: 'att-pdf',
          filename: 'report.pdf',
          mime_type: 'application/pdf',
          size_bytes: 2048,
        }),
      ])

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations with image attachment (Tauri available)', async () => {
      ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
      mockBatchAttachments([makeAttachment()])

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // -- Image resize controls (UX-85) ------------------------------------------

  describe('image resize controls', () => {
    function makeAttachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
      return {
        id: 'att-resize-1',
        block_id: 'B1',
        filename: 'photo.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        fs_path: '/path/to/photo.png',
        created_at: '2024-01-01T00:00:00Z',
        ...overrides,
      }
    }

    function renderWithImage(props: Partial<Parameters<typeof StaticBlock>[0]> = {}) {
      ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
      mockBatchAttachments([makeAttachment()])
      return render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} {...props} />)
    }

    it('shows resize toolbar on image hover', async () => {
      const user = userEvent.setup()
      const { container } = renderWithImage()

      // Toolbar should not be visible initially
      expect(screen.queryByTestId('image-resize-toolbar')).not.toBeInTheDocument()

      // Hover over the image wrapper
      const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]') as Element
      await user.hover(wrapper)

      // Toolbar should appear
      expect(screen.getByTestId('image-resize-toolbar')).toBeInTheDocument()

      // All 4 buttons should be present
      expect(screen.getByTestId('image-resize-25')).toBeInTheDocument()
      expect(screen.getByTestId('image-resize-50')).toBeInTheDocument()
      expect(screen.getByTestId('image-resize-75')).toBeInTheDocument()
      expect(screen.getByTestId('image-resize-100')).toBeInTheDocument()
    })

    it('clicking Small calls setProperty with correct value', async () => {
      const { container } = renderWithImage()

      const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]') as Element
      fireEvent.pointerEnter(wrapper)

      const btn = screen.getByTestId('image-resize-25')
      fireEvent.click(btn)

      // setProperty should have been called with image_width = '25'
      expect(mockedSetProperty).toHaveBeenCalledWith({
        blockId: 'B1',
        key: 'image_width',
        valueText: '25',
      })
    })

    it('applies stored width from properties', async () => {
      ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {}
      mockBatchAttachments([makeAttachment()])
      // getProperties returns image_width = '50'
      mockedGetProperties.mockResolvedValueOnce([
        {
          key: 'image_width',
          value_text: '50',
          value_num: null,
          value_date: null,
          value_ref: null,
        },
      ])

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      // Wait for the effect to resolve
      await vi.waitFor(() => {
        const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]')
        expect(wrapper).not.toBeNull()
        expect((wrapper as HTMLElement).style.maxWidth).toBe('50%')
      })
    })

    it('defaults to full width when no property is set', async () => {
      const { container } = renderWithImage()

      // Wait for effect
      await vi.waitFor(() => {
        const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]')
        expect(wrapper).not.toBeNull()
        expect((wrapper as HTMLElement).style.maxWidth).toBe('100%')
      })
    })

    it('has no a11y violations with image resize controls visible', async () => {
      const user = userEvent.setup()
      const { container } = renderWithImage()

      const wrapper = container.querySelector('[data-testid="image-resize-wrapper"]') as Element
      await user.hover(wrapper)

      // Toolbar visible — run axe
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // -- Block ref rendering (((ULID))) -----------------------------------------

  describe('block_ref rendering', () => {
    /** Helper: mock parse to return a doc containing a block_ref node. */
    function mockBlockRefDoc(refId: string) {
      mockedParse.mockReturnValueOnce({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'block_ref', attrs: { id: refId } }],
          },
        ],
      })
    }

    it('renders block_ref as chip with resolved content', () => {
      mockBlockRefDoc(REF_BLOCK)
      render(
        <TooltipProvider>
          <StaticBlock
            blockId="B1"
            content={`((${REF_BLOCK}))`}
            onFocus={vi.fn()}
            resolveBlockTitle={() => 'Referenced block content'}
          />
        </TooltipProvider>,
      )

      const chip = screen.getByTestId('block-ref-chip')
      expect(chip).toBeInTheDocument()
      expect(chip.textContent).toBe('Referenced block content')
      expect(chip.classList.contains('block-ref-chip')).toBe(true)
      expect(chip.classList.contains('cursor-pointer')).toBe(true)
    })

    it('renders block_ref chip with truncated first line', () => {
      const longContent =
        'This is a very long block of content that exceeds the sixty character limit for the chip label display\nSecond line here'
      mockBlockRefDoc(REF_BLOCK)
      render(
        <TooltipProvider>
          <StaticBlock
            blockId="B1"
            content={`((${REF_BLOCK}))`}
            onFocus={vi.fn()}
            resolveBlockTitle={() => longContent}
          />
        </TooltipProvider>,
      )

      const chip = screen.getByTestId('block-ref-chip')
      // First line is >60 chars, so it should be truncated to 57 + '...'
      const firstLine = longContent.split('\n')[0] as string
      const expected = `${firstLine.slice(0, 57)}...`
      expect(chip.textContent).toBe(expected)
    })

    it('renders fallback when resolveBlockTitle returns undefined', () => {
      mockBlockRefDoc(REF_BLOCK_2)
      render(
        <TooltipProvider>
          <StaticBlock blockId="B1" content={`((${REF_BLOCK_2}))`} onFocus={vi.fn()} />
        </TooltipProvider>,
      )

      const chip = screen.getByTestId('block-ref-chip')
      // Fallback: (( XXXXXXXX... ))
      expect(chip.textContent).toBe(`(( ${REF_BLOCK_2.slice(0, 8)}... ))`)
    })

    it('block_ref chip click navigates', async () => {
      const onFocus = vi.fn()
      const onNavigate = vi.fn()
      const user = userEvent.setup()
      mockBlockRefDoc(REF_BLOCK)
      render(
        <TooltipProvider>
          <StaticBlock
            blockId="B1"
            content={`((${REF_BLOCK}))`}
            onFocus={onFocus}
            onNavigate={onNavigate}
            resolveBlockTitle={() => 'Target content'}
          />
        </TooltipProvider>,
      )

      const chip = screen.getByTestId('block-ref-chip')
      await user.click(chip)
      expect(onNavigate).toHaveBeenCalledWith(REF_BLOCK)
      expect(onFocus).not.toHaveBeenCalled()
    })

    it('applies block-ref-deleted class for deleted block refs', () => {
      mockBlockRefDoc(REF_BLOCK)
      render(
        <TooltipProvider>
          <StaticBlock
            blockId="B1"
            content={`((${REF_BLOCK}))`}
            onFocus={vi.fn()}
            resolveBlockTitle={() => 'Deleted content'}
            resolveBlockStatus={() => 'deleted'}
          />
        </TooltipProvider>,
      )

      const chip = screen.getByTestId('block-ref-chip')
      expect(chip.classList.contains('block-ref-deleted')).toBe(true)
      expect(chip.classList.contains('block-ref-chip')).toBe(true)
    })
  })

  // -- Blockquote rendering ---------------------------------------------------

  describe('blockquote rendering', () => {
    /** Helper: mock parse to return a doc containing a blockquote node. */
    // biome-ignore lint/suspicious/noExplicitAny: test helper — mock data doesn't need strict typing
    function mockBlockquoteDoc(content: any[]) {
      mockedParse.mockReturnValueOnce({
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content,
          },
        ],
      } as ReturnType<typeof parse>)
    }

    it('renders blockquote with left border and muted text', () => {
      mockBlockquoteDoc([
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Quoted text' }],
        },
      ])

      const { container } = render(
        <StaticBlock blockId="B1" content="> Quoted text" onFocus={vi.fn()} />,
      )

      const bq = container.querySelector('blockquote') as HTMLElement
      expect(bq).not.toBeNull()
      expect(bq.classList.contains('border-l-[3px]')).toBe(true)
      expect(bq.classList.contains('border-border')).toBe(true)
      expect(bq.classList.contains('pl-4')).toBe(true)
      expect(bq.classList.contains('text-muted-foreground')).toBe(true)
      expect(bq.textContent).toContain('Quoted text')
    })

    it('renders nested content inside blockquote', () => {
      mockBlockquoteDoc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Normal ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' text' },
          ],
        },
      ])

      const { container } = render(
        <StaticBlock blockId="B1" content="> Normal **bold** text" onFocus={vi.fn()} />,
      )

      const bq = container.querySelector('blockquote') as HTMLElement
      expect(bq).not.toBeNull()
      expect(bq.querySelector('p')).not.toBeNull()
      expect(bq.querySelector('strong')).not.toBeNull()
      expect(bq.textContent).toContain('Normal bold text')
    })

    it('blockquote axe a11y audit', async () => {
      mockBlockquoteDoc([
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Accessible quote' }],
        },
      ])

      const { container } = render(
        <StaticBlock blockId="B1" content="> Accessible quote" onFocus={vi.fn()} />,
      )

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // -- Error paths (invoke rejection) -------------------------------------------

  describe('error paths (invoke rejection)', () => {
    it('shows error when tag query invoke rejects', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Backend unavailable'))
      render(
        <StaticBlock blockId="B1" content="{{query type:tag expr:project}}" onFocus={vi.fn()} />,
      )
      expect(await screen.findByText('Backend unavailable')).toBeInTheDocument()
      // Block wrapper still in DOM
      expect(screen.getByTestId('block-static')).toBeInTheDocument()
    })

    it('shows error when property query invoke rejects', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Property lookup failed'))
      render(
        <StaticBlock
          blockId="B1"
          content="{{query type:property key:status value:done}}"
          onFocus={vi.fn()}
        />,
      )
      expect(await screen.findByText('Property lookup failed')).toBeInTheDocument()
    })

    it('shows error when backlinks query invoke rejects', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Backlinks fetch failed'))
      render(
        <StaticBlock
          blockId="B1"
          content={`{{query type:backlinks target:${BLOCK_ID}}}`}
          onFocus={vi.fn()}
        />,
      )
      expect(await screen.findByText('Backlinks fetch failed')).toBeInTheDocument()
    })

    it('shows error when filtered query invoke rejects', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Filter query broken'))
      render(
        <StaticBlock blockId="B1" content="{{query property:todo_state=TODO}}" onFocus={vi.fn()} />,
      )
      expect(await screen.findByText('Filter query broken')).toBeInTheDocument()
    })

    it('shows error when batchResolve rejects after successful query', async () => {
      mockedInvoke
        .mockResolvedValueOnce({
          items: [
            {
              id: 'BLK_RES_1',
              parent_id: 'PARENT_1',
              page_id: 'PARENT_1',
              content: 'Result block',
              position: 0,
              block_type: 'text',
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-01T00:00:00Z',
              deleted_at: null,
              conflict_type: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
        })
        .mockRejectedValueOnce(new Error('Batch resolve failed'))
      render(
        <StaticBlock blockId="B1" content="{{query type:tag expr:project}}" onFocus={vi.fn()} />,
      )
      expect(await screen.findByText('Batch resolve failed')).toBeInTheDocument()
    })

    it('shows generic fallback for non-Error rejection in query', async () => {
      mockedInvoke.mockRejectedValueOnce('string error without Error wrapper')
      render(
        <StaticBlock blockId="B1" content="{{query type:tag expr:project}}" onFocus={vi.fn()} />,
      )
      expect(await screen.findByText('Query failed')).toBeInTheDocument()
    })

    it('query block remains clickable after invoke rejection', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Service down'))
      const onFocus = vi.fn()
      const user = userEvent.setup()
      render(<StaticBlock blockId="B1" content="{{query type:tag expr:test}}" onFocus={onFocus} />)
      await screen.findByText('Service down')
      await user.click(screen.getByTestId('block-static'))
      expect(onFocus).toHaveBeenCalledWith('B1')
    })

    it('has no a11y violations when query invoke fails', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Service unavailable'))
      const { container } = render(
        <StaticBlock blockId="B1" content="{{query type:tag expr:test}}" onFocus={vi.fn()} />,
      )
      await screen.findByText('Service unavailable')
      // Disable nested-interactive: QueryResult renders a button inside
      // StaticBlock's wrapper button — a pre-existing structural trade-off.
      const results = await axe(container, {
        rules: { 'nested-interactive': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })
  })

  describe('callout blocks', () => {
    it('renders info callout with colored border and icon', () => {
      render(<StaticBlock blockId="B1" content="> [!INFO] important info" onFocus={vi.fn()} />)
      const callout = screen.getByTestId('callout-block')
      expect(callout).toBeInTheDocument()
      expect(callout).toHaveAttribute('data-callout-type', 'info')
      expect(callout.className).toContain('border-alert-info-border')
    })

    it('renders warning callout', () => {
      render(<StaticBlock blockId="B1" content="> [!WARNING] be careful" onFocus={vi.fn()} />)
      const callout = screen.getByTestId('callout-block')
      expect(callout).toHaveAttribute('data-callout-type', 'warning')
      expect(callout.className).toContain('border-alert-warning-border')
    })

    it('renders tip callout', () => {
      render(<StaticBlock blockId="B1" content="> [!TIP] helpful hint" onFocus={vi.fn()} />)
      const callout = screen.getByTestId('callout-block')
      expect(callout).toHaveAttribute('data-callout-type', 'tip')
      expect(callout.className).toContain('border-alert-tip-border')
    })

    it('renders error callout', () => {
      render(<StaticBlock blockId="B1" content="> [!ERROR] something broke" onFocus={vi.fn()} />)
      const callout = screen.getByTestId('callout-block')
      expect(callout).toHaveAttribute('data-callout-type', 'error')
      expect(callout.className).toContain('border-alert-error-border')
    })

    it('renders note callout', () => {
      render(<StaticBlock blockId="B1" content="> [!NOTE] take note" onFocus={vi.fn()} />)
      const callout = screen.getByTestId('callout-block')
      expect(callout).toHaveAttribute('data-callout-type', 'note')
      expect(callout.className).toContain('border-alert-note-border')
    })

    it('renders type label in callout header', () => {
      render(<StaticBlock blockId="B1" content="> [!INFO] some text" onFocus={vi.fn()} />)
      expect(screen.getByText('Info')).toBeInTheDocument()
    })

    it('renders type icon with aria-hidden', () => {
      render(<StaticBlock blockId="B1" content="> [!WARNING] watch out" onFocus={vi.fn()} />)
      // The icon is rendered with aria-hidden="true"
      const callout = screen.getByTestId('callout-block')
      const icon = callout.querySelector('[aria-hidden="true"]')
      expect(icon).toBeInTheDocument()
    })

    it('renders callout content below the header', () => {
      render(<StaticBlock blockId="B1" content="> [!TIP] my tip content" onFocus={vi.fn()} />)
      expect(screen.getByText('my tip content')).toBeInTheDocument()
    })

    it('default blockquote without callout renders normally', () => {
      render(<StaticBlock blockId="B1" content="> just a quote" onFocus={vi.fn()} />)
      const blockquote = screen.getByRole('button').querySelector('blockquote')
      expect(blockquote).toBeInTheDocument()
      expect(blockquote).not.toHaveAttribute('data-callout-type')
      expect(screen.queryByTestId('callout-block')).not.toBeInTheDocument()
    })

    it('unknown callout type falls back to note styling', () => {
      render(<StaticBlock blockId="B1" content="> [!CUSTOM] custom type" onFocus={vi.fn()} />)
      const callout = screen.getByTestId('callout-block')
      expect(callout).toHaveAttribute('data-callout-type', 'custom')
      // Falls back to note config (gray border)
      expect(callout.className).toContain('border-alert-note-border')
    })

    it('has no a11y violations for callout blocks', async () => {
      const { container } = render(
        <StaticBlock blockId="B1" content="> [!INFO] accessible callout" onFocus={vi.fn()} />,
      )
      const results = await axe(container, {
        rules: { 'nested-interactive': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })
  })

  // -- Ordered list rendering -------------------------------------------------

  describe('ordered list rendering', () => {
    it('renders ordered list as <ol> with <li> children', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'1. first\n2. second'} onFocus={vi.fn()} />,
      )
      const ol = container.querySelector('ol')
      expect(ol).toBeInTheDocument()
      const items = ol?.querySelectorAll('li')
      expect(items).toHaveLength(2)
      expect(items?.[0]?.textContent).toBe('first')
      expect(items?.[1]?.textContent).toBe('second')
    })

    it('renders ordered list with marks', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'1. **bold item**\n2. *italic*'} onFocus={vi.fn()} />,
      )
      const ol = container.querySelector('ol')
      expect(ol).toBeInTheDocument()
      expect(ol?.querySelector('strong')?.textContent).toBe('bold item')
      expect(ol?.querySelector('em')?.textContent).toBe('italic')
    })

    it('renders single-item ordered list', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'1. only item'} onFocus={vi.fn()} />,
      )
      const ol = container.querySelector('ol')
      expect(ol).toBeInTheDocument()
      expect(ol?.querySelectorAll('li')).toHaveLength(1)
    })

    it('has no a11y violations for ordered list', async () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'1. first\n2. second'} onFocus={vi.fn()} />,
      )
      const results = await axe(container, {
        rules: { 'nested-interactive': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })
  })

  // -- Horizontal rule rendering ----------------------------------------------

  describe('horizontal rule rendering', () => {
    it('renders horizontal rule as <hr>', () => {
      const { container } = render(<StaticBlock blockId="B1" content={'---'} onFocus={vi.fn()} />)
      const hr = container.querySelector('hr')
      expect(hr).toBeInTheDocument()
    })

    it('renders horizontal rule with data-testid', () => {
      render(<StaticBlock blockId="B1" content={'---'} onFocus={vi.fn()} />)
      expect(screen.getByTestId('horizontal-rule')).toBeInTheDocument()
    })

    it('renders horizontal rule between text blocks', () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'Before\n---\nAfter'} onFocus={vi.fn()} />,
      )
      expect(container.querySelector('hr')).toBeInTheDocument()
      expect(container.textContent).toContain('Before')
      expect(container.textContent).toContain('After')
    })

    it('has no a11y violations for horizontal rule', async () => {
      const { container } = render(
        <StaticBlock blockId="B1" content={'Before\n---\nAfter'} onFocus={vi.fn()} />,
      )
      const results = await axe(container, {
        rules: { 'nested-interactive': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })
  })

  // -- Mermaid code block rendering -------------------------------------------

  describe('mermaid code block rendering', () => {
    /** Helper: mock parse to return a codeBlock with language 'mermaid'. */
    function mockMermaidCodeBlock(code: string) {
      mockedParse.mockReturnValueOnce({
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'mermaid' },
            content: [{ type: 'text', text: code }],
          },
        ],
      } as ReturnType<typeof parse>)
    }

    it('renders MermaidDiagram (lazy placeholder) for mermaid code blocks', () => {
      const mermaidCode = 'graph TD; A-->B;'
      mockMermaidCodeBlock(mermaidCode)

      const { container } = render(
        <StaticBlock
          blockId="B1"
          content={`\`\`\`mermaid\n${mermaidCode}\n\`\`\``}
          onFocus={vi.fn()}
        />,
      )

      // Should not render syntax-highlighted code block
      expect(container.querySelector('code.language-mermaid')).not.toBeInTheDocument()
      // Should render the Suspense fallback (loading state) or the MermaidDiagram
      const loadingOrDiagram =
        container.querySelector('[data-testid="mermaid-loading"]') ??
        container.querySelector('[data-testid="mermaid-diagram"]') ??
        container.querySelector('[role="status"]')
      expect(loadingOrDiagram).toBeInTheDocument()
    })

    it('renders normal syntax highlighting for non-mermaid code blocks', () => {
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

      const { container } = render(
        <StaticBlock blockId="B1" content={'```javascript\nconst x = 1\n```'} onFocus={vi.fn()} />,
      )

      const code = container.querySelector('code.language-javascript')
      expect(code).toBeInTheDocument()
      expect(code?.textContent).toContain('const')
    })

    it('has no a11y violations for mermaid code block', async () => {
      mockMermaidCodeBlock('graph TD; A-->B;')

      const { container } = render(
        <StaticBlock
          blockId="B1"
          content={'```mermaid\ngraph TD; A-->B;\n```'}
          onFocus={vi.fn()}
        />,
      )

      const results = await axe(container, {
        rules: { 'nested-interactive': { enabled: false } },
      })
      expect(results).toHaveNoViolations()
    })
  })
})
