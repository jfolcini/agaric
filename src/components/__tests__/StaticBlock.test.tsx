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

import { render, screen } from '@testing-library/react'
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

vi.mock('../../hooks/useBlockAttachments', () => ({
  useBlockAttachments: vi.fn(),
}))

vi.mock('../../editor/markdown-serializer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../editor/markdown-serializer')>()
  return { ...mod, parse: vi.fn(mod.parse) }
})

// Lazy-import after mocks are hoisted so we get the mocked version.
const { useBlockAttachments } = await import('../../hooks/useBlockAttachments')
const mockedUseBlockAttachments = vi.mocked(useBlockAttachments)

const { parse } = await import('../../editor/markdown-serializer')
const mockedParse = vi.mocked(parse)

const { invoke } = await import('@tauri-apps/api/core')
const mockedInvoke = vi.mocked(invoke)

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
    mockedUseBlockAttachments.mockReturnValue({
      attachments: [],
      loading: false,
      handleAddAttachment: vi.fn(),
      handleDeleteAttachment: vi.fn(),
    })
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('renders plain text', () => {
    render(<StaticBlock blockId="B1" content="Hello world" onFocus={vi.fn()} />)
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('renders empty block placeholder when content is empty', () => {
    render(<StaticBlock blockId="B1" content="" onFocus={vi.fn()} />)
    expect(screen.getByText('Empty block')).toBeInTheDocument()
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
    const results = await axe(container)
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
    const results = await axe(container)
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
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [makeAttachment()],
        loading: false,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

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
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [
          makeAttachment({
            id: 'att-2',
            filename: 'document.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
            fs_path: '/path/to/document.pdf',
          }),
        ],
        loading: false,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

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
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [],
        loading: true,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      expect(container.querySelector('[data-testid="attachment-section"]')).not.toBeInTheDocument()
    })

    it('handles multiple attachments (mix of images and files)', () => {
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [
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
        ],
        loading: false,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

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
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [makeAttachment()],
        loading: false,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      // Image should not render without Tauri; no attachment section if only images
      expect(container.querySelector('img')).not.toBeInTheDocument()
    })

    it('renders text chip for text/plain attachment with FileText icon', () => {
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [
          makeAttachment({
            id: 'att-txt',
            filename: 'readme.txt',
            mime_type: 'text/plain',
            size_bytes: 256,
          }),
        ],
        loading: false,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

      render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      expect(screen.getByText('readme.txt')).toBeInTheDocument()
      expect(screen.getByText('256 B')).toBeInTheDocument()
    })

    it('has no a11y violations with attachments', async () => {
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [
          makeAttachment({
            id: 'att-pdf',
            filename: 'report.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
          }),
        ],
        loading: false,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations with image attachment (Tauri available)', async () => {
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
      mockedUseBlockAttachments.mockReturnValue({
        attachments: [makeAttachment()],
        loading: false,
        handleAddAttachment: vi.fn(),
        handleDeleteAttachment: vi.fn(),
      })

      const { container } = render(<StaticBlock blockId="B1" content="Hello" onFocus={vi.fn()} />)

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
})
