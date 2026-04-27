import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { TagEntry } from '../../hooks/useBlockTags'
import { PageTagSection } from '../PageTagSection'

vi.mock('lucide-react', () => ({
  Plus: () => <svg data-testid="plus-icon" />,
  X: () => <svg data-testid="x-icon" />,
}))

const TAG_1: TagEntry = { id: 'TAG_1', name: 'urgent' }
const TAG_2: TagEntry = { id: 'TAG_2', name: 'review' }
const TAG_3: TagEntry = { id: 'TAG_3', name: 'later' }

const defaultProps = {
  appliedTags: [] as TagEntry[],
  availableTags: [] as TagEntry[],
  allTags: [] as TagEntry[],
  tagQuery: '',
  showTagPicker: false,
  onTagQueryChange: vi.fn(),
  onTagPickerChange: vi.fn(),
  onAddTag: vi.fn(),
  onRemoveTag: vi.fn(),
  onCreateTag: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageTagSection rendering', () => {
  it('renders applied tag badges', () => {
    render(<PageTagSection {...defaultProps} appliedTags={[TAG_1]} allTags={[TAG_1, TAG_2]} />)

    expect(screen.getByText('urgent')).toBeInTheDocument()
    expect(screen.queryByText('review')).not.toBeInTheDocument()
  })

  it('renders remove button for each applied tag', () => {
    render(
      <PageTagSection {...defaultProps} appliedTags={[TAG_1, TAG_2]} allTags={[TAG_1, TAG_2]} />,
    )

    expect(screen.getByRole('button', { name: /remove tag urgent/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove tag review/i })).toBeInTheDocument()
  })

  it('renders add tag button', () => {
    render(<PageTagSection {...defaultProps} />)

    expect(screen.getByRole('button', { name: /add tag/i })).toBeInTheDocument()
  })

  it('shows tag picker content when showTagPicker is true', () => {
    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        availableTags={[TAG_2]}
        allTags={[TAG_1, TAG_2]}
      />,
    )

    expect(screen.getByLabelText('Tag picker')).toBeInTheDocument()
    expect(screen.getByLabelText('Search tags')).toBeInTheDocument()
    expect(screen.getByText('review')).toBeInTheDocument()
  })

  it('shows "no more tags" when no available tags and no query', () => {
    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        availableTags={[]}
        allTags={[TAG_1]}
      />,
    )

    expect(screen.getByText('No more tags')).toBeInTheDocument()
  })

  it('shows create option when query does not match any tag', () => {
    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        tagQuery="newtag"
        availableTags={[]}
        allTags={[TAG_1]}
      />,
    )

    expect(screen.getByText(/Create "newtag"/)).toBeInTheDocument()
  })

  it('does not show create option when query matches an existing tag name', () => {
    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        tagQuery="urgent"
        availableTags={[]}
        allTags={[TAG_1]}
      />,
    )

    expect(screen.queryByText(/Create "urgent"/)).not.toBeInTheDocument()
  })
})

describe('PageTagSection interaction', () => {
  it('calls onRemoveTag when remove button clicked', async () => {
    const onRemoveTag = vi.fn()
    const user = userEvent.setup()

    render(
      <PageTagSection
        {...defaultProps}
        appliedTags={[TAG_1]}
        allTags={[TAG_1]}
        onRemoveTag={onRemoveTag}
      />,
    )

    await user.click(screen.getByRole('button', { name: /remove tag urgent/i }))
    expect(onRemoveTag).toHaveBeenCalledWith('TAG_1')
  })

  it('calls onAddTag when available tag clicked in picker', async () => {
    const onAddTag = vi.fn()
    const user = userEvent.setup()

    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        availableTags={[TAG_2]}
        allTags={[TAG_1, TAG_2]}
        onAddTag={onAddTag}
      />,
    )

    await user.click(screen.getByText('review'))
    expect(onAddTag).toHaveBeenCalledWith('TAG_2')
  })

  it('calls onTagQueryChange when typing in search input', async () => {
    const onTagQueryChange = vi.fn()
    const user = userEvent.setup()

    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        availableTags={[TAG_2]}
        allTags={[TAG_1, TAG_2]}
        onTagQueryChange={onTagQueryChange}
      />,
    )

    const input = screen.getByLabelText('Search tags')
    await user.type(input, 'r')

    expect(onTagQueryChange).toHaveBeenCalled()
  })

  it('calls onCreateTag when create button clicked', async () => {
    const onCreateTag = vi.fn()
    const user = userEvent.setup()

    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        tagQuery="newtag"
        availableTags={[]}
        allTags={[TAG_1]}
        onCreateTag={onCreateTag}
      />,
    )

    await user.click(screen.getByText(/Create "newtag"/))
    expect(onCreateTag).toHaveBeenCalledOnce()
  })

  it('calls onCreateTag on Enter when no available tags and query present', async () => {
    const onCreateTag = vi.fn()
    const user = userEvent.setup()

    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        tagQuery="newtag"
        availableTags={[]}
        allTags={[TAG_1]}
        onCreateTag={onCreateTag}
      />,
    )

    const input = screen.getByLabelText('Search tags')
    await user.click(input)
    await user.keyboard('{Enter}')

    expect(onCreateTag).toHaveBeenCalledOnce()
  })

  it('calls onTagPickerChange when add tag button is clicked', async () => {
    const onTagPickerChange = vi.fn()
    const user = userEvent.setup()

    render(<PageTagSection {...defaultProps} onTagPickerChange={onTagPickerChange} />)

    await user.click(screen.getByRole('button', { name: /add tag/i }))

    await waitFor(() => {
      expect(onTagPickerChange).toHaveBeenCalled()
    })
  })
})

describe('PageTagSection UX-1 / UX-2', () => {
  it('remove-tag button has 44 px coarse-pointer touch target', () => {
    render(<PageTagSection {...defaultProps} appliedTags={[TAG_1]} allTags={[TAG_1]} />)

    const removeBtn = screen.getByRole('button', { name: /remove tag urgent/i })
    expect(removeBtn.className).toContain('[@media(pointer:coarse)]:h-11')
    expect(removeBtn.className).toContain('[@media(pointer:coarse)]:w-11')
    expect(removeBtn.className).toContain('[@media(pointer:coarse)]:p-2')
  })

  it('remove-tag button keeps focus-visible ring tokens', () => {
    render(<PageTagSection {...defaultProps} appliedTags={[TAG_1]} allTags={[TAG_1]} />)

    const removeBtn = screen.getByRole('button', { name: /remove tag urgent/i })
    expect(removeBtn.className).toContain('focus-visible:ring-[3px]')
    expect(removeBtn.className).toContain('focus-visible:ring-ring/50')
    expect(removeBtn.className).toContain('focus-visible:outline-hidden')
  })

  it('available-tag picker rows render via the Button primitive (focus ring inherited)', () => {
    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        availableTags={[TAG_2]}
        allTags={[TAG_1, TAG_2]}
      />,
    )

    // The Button primitive applies its own focus-visible ring; assert the row
    // is a real <button> with the variant ring tokens applied.
    const tagBtn = screen.getByRole('button', { name: /^review$/ })
    expect(tagBtn.className).toContain('focus-visible:ring-[3px]')
    expect(tagBtn.className).toContain('focus-visible:ring-ring/50')
  })

  it('"Create tag" row renders via the Button primitive (focus ring inherited)', () => {
    render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        tagQuery="newtag"
        availableTags={[]}
        allTags={[TAG_1]}
      />,
    )

    const createBtn = screen.getByRole('button', { name: /Create "newtag"/i })
    expect(createBtn.className).toContain('focus-visible:ring-[3px]')
    expect(createBtn.className).toContain('focus-visible:ring-ring/50')
  })
})

describe('PageTagSection accessibility', () => {
  it('has no a11y violations with tags', async () => {
    const { container } = render(
      <PageTagSection {...defaultProps} appliedTags={[TAG_1]} allTags={[TAG_1, TAG_2]} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with picker open', async () => {
    const { container } = render(
      <PageTagSection
        {...defaultProps}
        showTagPicker={true}
        availableTags={[TAG_2, TAG_3]}
        allTags={[TAG_1, TAG_2, TAG_3]}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
