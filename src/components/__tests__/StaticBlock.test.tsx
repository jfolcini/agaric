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
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { StaticBlock } from '../StaticBlock'

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

describe('StaticBlock', () => {
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

  it('does not call onNavigate when onNavigate is not provided', async () => {
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
    // onNavigate is undefined — click should not throw and onFocus should NOT
    // be called because stopPropagation is called regardless
    expect(onFocus).not.toHaveBeenCalled()
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
    expect(link?.textContent).toBe('click here')
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
    expect(extLink?.textContent).toBe('docs')
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
    expect(link?.textContent).toBe('click')
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
    expect(link?.textContent).toBe('click')
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
})
