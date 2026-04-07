import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PageHeaderMenu } from '../PageHeaderMenu'

vi.mock('lucide-react', () => ({
  MoreVertical: () => <svg data-testid="more-vertical-icon" />,
  Redo2: () => <svg data-testid="redo2-icon" />,
  Undo2: () => <svg data-testid="undo2-icon" />,
}))

const defaultProps = {
  canRedo: false,
  kebabOpen: false,
  isTemplate: false,
  isJournalTemplate: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onKebabOpenChange: vi.fn(),
  onAddAlias: vi.fn(),
  onAddTag: vi.fn(),
  onAddProperty: vi.fn(),
  onToggleTemplate: vi.fn(),
  onToggleJournalTemplate: vi.fn(),
  onExport: vi.fn(),
  onDeleteRequest: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageHeaderMenu rendering', () => {
  it('renders undo button', () => {
    render(<PageHeaderMenu {...defaultProps} />)

    expect(screen.getByRole('button', { name: /undo last page action/i })).toBeInTheDocument()
  })

  it('renders redo button', () => {
    render(<PageHeaderMenu {...defaultProps} />)

    expect(screen.getByRole('button', { name: /redo last page action/i })).toBeInTheDocument()
  })

  it('disables redo button when canRedo is false', () => {
    render(<PageHeaderMenu {...defaultProps} canRedo={false} />)

    expect(screen.getByRole('button', { name: /redo last page action/i })).toBeDisabled()
  })

  it('enables redo button when canRedo is true', () => {
    render(<PageHeaderMenu {...defaultProps} canRedo={true} />)

    expect(screen.getByRole('button', { name: /redo last page action/i })).not.toBeDisabled()
  })

  it('renders page actions button', () => {
    render(<PageHeaderMenu {...defaultProps} />)

    expect(screen.getByRole('button', { name: /page actions/i })).toBeInTheDocument()
  })

  it('shows menu items when kebabOpen is true', () => {
    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} />)

    expect(screen.getByText('Add alias')).toBeInTheDocument()
    expect(screen.getByText('Add tag')).toBeInTheDocument()
    expect(screen.getByText('Add property')).toBeInTheDocument()
    expect(screen.getByText(/Save as template/i)).toBeInTheDocument()
    expect(screen.getByText(/Set as journal template/i)).toBeInTheDocument()
    expect(screen.getByText(/Export as Markdown/i)).toBeInTheDocument()
    expect(screen.getByText(/Delete page/i)).toBeInTheDocument()
  })

  it('shows "Remove template status" when isTemplate is true', () => {
    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} isTemplate={true} />)

    expect(screen.getByText(/Remove template status/i)).toBeInTheDocument()
    expect(screen.queryByText(/Save as template/i)).not.toBeInTheDocument()
  })

  it('shows "Remove journal template" when isJournalTemplate is true', () => {
    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} isJournalTemplate={true} />)

    expect(screen.getByText(/Remove journal template/i)).toBeInTheDocument()
    expect(screen.queryByText(/Set as journal template/i)).not.toBeInTheDocument()
  })
})

describe('PageHeaderMenu interaction', () => {
  it('calls onUndo when undo button clicked', async () => {
    const onUndo = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} onUndo={onUndo} />)

    await user.click(screen.getByRole('button', { name: /undo last page action/i }))
    expect(onUndo).toHaveBeenCalledOnce()
  })

  it('calls onRedo when redo button clicked', async () => {
    const onRedo = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} canRedo={true} onRedo={onRedo} />)

    await user.click(screen.getByRole('button', { name: /redo last page action/i }))
    expect(onRedo).toHaveBeenCalledOnce()
  })

  it('calls onAddAlias when "Add alias" clicked', async () => {
    const onAddAlias = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} onAddAlias={onAddAlias} />)

    await user.click(screen.getByText('Add alias'))
    expect(onAddAlias).toHaveBeenCalledOnce()
  })

  it('calls onAddTag when "Add tag" clicked', async () => {
    const onAddTag = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} onAddTag={onAddTag} />)

    await user.click(screen.getByText('Add tag'))
    expect(onAddTag).toHaveBeenCalledOnce()
  })

  it('calls onAddProperty when "Add property" clicked', async () => {
    const onAddProperty = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} onAddProperty={onAddProperty} />)

    await user.click(screen.getByText('Add property'))
    expect(onAddProperty).toHaveBeenCalledOnce()
  })

  it('calls onToggleTemplate when template option clicked', async () => {
    const onToggleTemplate = vi.fn()
    const user = userEvent.setup()

    render(
      <PageHeaderMenu {...defaultProps} kebabOpen={true} onToggleTemplate={onToggleTemplate} />,
    )

    await user.click(screen.getByText(/Save as template/i))
    expect(onToggleTemplate).toHaveBeenCalledOnce()
  })

  it('calls onToggleJournalTemplate when journal template option clicked', async () => {
    const onToggleJournalTemplate = vi.fn()
    const user = userEvent.setup()

    render(
      <PageHeaderMenu
        {...defaultProps}
        kebabOpen={true}
        onToggleJournalTemplate={onToggleJournalTemplate}
      />,
    )

    await user.click(screen.getByText(/Set as journal template/i))
    expect(onToggleJournalTemplate).toHaveBeenCalledOnce()
  })

  it('calls onExport when export option clicked', async () => {
    const onExport = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} onExport={onExport} />)

    await user.click(screen.getByText(/Export as Markdown/i))
    expect(onExport).toHaveBeenCalledOnce()
  })

  it('calls onDeleteRequest when delete option clicked', async () => {
    const onDeleteRequest = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} onDeleteRequest={onDeleteRequest} />)

    await user.click(screen.getByText(/Delete page/i))
    expect(onDeleteRequest).toHaveBeenCalledOnce()
  })

  it('calls onKebabOpenChange when page actions button clicked', async () => {
    const onKebabOpenChange = vi.fn()
    const user = userEvent.setup()

    render(<PageHeaderMenu {...defaultProps} onKebabOpenChange={onKebabOpenChange} />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    await waitFor(() => {
      expect(onKebabOpenChange).toHaveBeenCalled()
    })
  })
})

describe('PageHeaderMenu accessibility', () => {
  it('has no a11y violations', async () => {
    const { container } = render(<PageHeaderMenu {...defaultProps} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with menu open', async () => {
    const { container } = render(<PageHeaderMenu {...defaultProps} kebabOpen={true} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('menu buttons have focus-visible ring classes', () => {
    render(<PageHeaderMenu {...defaultProps} kebabOpen={true} />)

    const addAliasButton = screen.getByText('Add alias').closest('button')
    expect(addAliasButton).toBeTruthy()
    expect(addAliasButton?.className).toContain('focus-visible:ring-2')
    expect(addAliasButton?.className).toContain('focus-visible:ring-ring')
    expect(addAliasButton?.className).toContain('focus-visible:ring-offset-1')
  })
})
