import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PageHeaderMenuProps } from '../PageHeaderMenu'
import { PageHeaderMenu } from '../PageHeaderMenu'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('lucide-react', () => ({
  LayoutTemplate: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="layout-template-icon" {...props} />
  ),
  MoreVertical: () => <svg data-testid="more-vertical-icon" />,
  Redo2: () => <svg data-testid="redo2-icon" />,
  Undo2: () => <svg data-testid="undo2-icon" />,
}))

const defaultProps: PageHeaderMenuProps = {
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

function renderMenu(overrides: Partial<PageHeaderMenuProps> = {}) {
  return render(
    <TooltipProvider>
      <PageHeaderMenu {...defaultProps} {...overrides} />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageHeaderMenu rendering', () => {
  it('renders undo button', () => {
    renderMenu()

    expect(screen.getByRole('button', { name: /undo last page action/i })).toBeInTheDocument()
  })

  it('renders redo button', () => {
    renderMenu()

    expect(screen.getByRole('button', { name: /redo last page action/i })).toBeInTheDocument()
  })

  it('disables redo button when canRedo is false', () => {
    renderMenu({ canRedo: false })

    expect(screen.getByRole('button', { name: /redo last page action/i })).toBeDisabled()
  })

  it('enables redo button when canRedo is true', () => {
    renderMenu({ canRedo: true })

    expect(screen.getByRole('button', { name: /redo last page action/i })).not.toBeDisabled()
  })

  it('renders page actions button', () => {
    renderMenu()

    expect(screen.getByRole('button', { name: /page actions/i })).toBeInTheDocument()
  })

  it('shows menu items when kebabOpen is true', () => {
    renderMenu({ kebabOpen: true })

    expect(screen.getByText('Add alias')).toBeInTheDocument()
    expect(screen.getByText('Add tag')).toBeInTheDocument()
    expect(screen.getByText('Add property')).toBeInTheDocument()
    expect(screen.getByText(/Save as template/i)).toBeInTheDocument()
    expect(screen.getByText(/Set as journal template/i)).toBeInTheDocument()
    expect(screen.getByText(/Export as Markdown/i)).toBeInTheDocument()
    expect(screen.getByText(/Delete page/i)).toBeInTheDocument()
  })

  it('shows "Remove template status" when isTemplate is true', () => {
    renderMenu({ kebabOpen: true, isTemplate: true })

    expect(screen.getByText(/Remove template status/i)).toBeInTheDocument()
    expect(screen.queryByText(/Save as template/i)).not.toBeInTheDocument()
  })

  it('shows "Remove journal template" when isJournalTemplate is true', () => {
    renderMenu({ kebabOpen: true, isJournalTemplate: true })

    expect(screen.getByText(/Remove journal template/i)).toBeInTheDocument()
    expect(screen.queryByText(/Set as journal template/i)).not.toBeInTheDocument()
  })
})

describe('PageHeaderMenu interaction', () => {
  it('calls onUndo when undo button clicked', async () => {
    const onUndo = vi.fn()
    const user = userEvent.setup()

    renderMenu({ onUndo })

    await user.click(screen.getByRole('button', { name: /undo last page action/i }))
    expect(onUndo).toHaveBeenCalledOnce()
  })

  it('calls onRedo when redo button clicked', async () => {
    const onRedo = vi.fn()
    const user = userEvent.setup()

    renderMenu({ canRedo: true, onRedo })

    await user.click(screen.getByRole('button', { name: /redo last page action/i }))
    expect(onRedo).toHaveBeenCalledOnce()
  })

  it('calls onAddAlias when "Add alias" clicked', async () => {
    const onAddAlias = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onAddAlias })

    await user.click(screen.getByText('Add alias'))
    expect(onAddAlias).toHaveBeenCalledOnce()
  })

  it('calls onAddTag when "Add tag" clicked', async () => {
    const onAddTag = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onAddTag })

    await user.click(screen.getByText('Add tag'))
    expect(onAddTag).toHaveBeenCalledOnce()
  })

  it('calls onAddProperty when "Add property" clicked', async () => {
    const onAddProperty = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onAddProperty })

    await user.click(screen.getByText('Add property'))
    expect(onAddProperty).toHaveBeenCalledOnce()
  })

  it('calls onToggleTemplate when template option clicked', async () => {
    const onToggleTemplate = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onToggleTemplate })

    await user.click(screen.getByText(/Save as template/i))
    expect(onToggleTemplate).toHaveBeenCalledOnce()
  })

  it('calls onToggleJournalTemplate when journal template option clicked', async () => {
    const onToggleJournalTemplate = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onToggleJournalTemplate })

    await user.click(screen.getByText(/Set as journal template/i))
    expect(onToggleJournalTemplate).toHaveBeenCalledOnce()
  })

  it('calls onExport when export option clicked', async () => {
    const onExport = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onExport })

    await user.click(screen.getByText(/Export as Markdown/i))
    expect(onExport).toHaveBeenCalledOnce()
  })

  it('calls onDeleteRequest when delete option clicked', async () => {
    const onDeleteRequest = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onDeleteRequest })

    await user.click(screen.getByText(/Delete page/i))
    expect(onDeleteRequest).toHaveBeenCalledOnce()
  })

  it('calls onKebabOpenChange when page actions button clicked', async () => {
    const onKebabOpenChange = vi.fn()
    const user = userEvent.setup()

    renderMenu({ onKebabOpenChange })

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    await waitFor(() => {
      expect(onKebabOpenChange).toHaveBeenCalled()
    })
  })
})

describe('PageHeaderMenu accessibility', () => {
  it('has no a11y violations', async () => {
    const { container } = renderMenu()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with menu open', async () => {
    const { container } = renderMenu({ kebabOpen: true })

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('menu buttons have focus-visible ring classes', () => {
    renderMenu({ kebabOpen: true })

    const addAliasButton = screen.getByText('Add alias').closest('button')
    expect(addAliasButton).toBeTruthy()
    expect(addAliasButton?.className).toContain('focus-visible:ring-2')
    expect(addAliasButton?.className).toContain('focus-visible:ring-ring')
    expect(addAliasButton?.className).toContain('focus-visible:ring-offset-1')
  })
})

describe('PageHeaderMenu template toggle button', () => {
  it('renders with correct aria-label', () => {
    renderMenu()

    const btn = screen.getByRole('button', { name: /toggle template status/i })
    expect(btn).toBeInTheDocument()
  })

  it('calls onToggleTemplate when clicked', async () => {
    const onToggleTemplate = vi.fn()
    const user = userEvent.setup()

    renderMenu({ onToggleTemplate })

    await user.click(screen.getByRole('button', { name: /toggle template status/i }))
    expect(onToggleTemplate).toHaveBeenCalledOnce()
  })

  it('shows text-primary class on icon when isTemplate is true', () => {
    renderMenu({ isTemplate: true })

    const icon = screen.getByTestId('layout-template-icon')
    expect(icon.getAttribute('class')).toContain('text-primary')
  })

  it('does not show text-primary class on icon when isTemplate is false', () => {
    renderMenu({ isTemplate: false })

    const icon = screen.getByTestId('layout-template-icon')
    expect(icon.getAttribute('class')).not.toContain('text-primary')
  })

  it('has aria-pressed matching isTemplate state', () => {
    const { rerender } = render(
      <TooltipProvider>
        <PageHeaderMenu {...defaultProps} isTemplate={false} />
      </TooltipProvider>,
    )

    const btn = screen.getByRole('button', { name: /toggle template status/i })
    expect(btn).toHaveAttribute('aria-pressed', 'false')

    rerender(
      <TooltipProvider>
        <PageHeaderMenu {...defaultProps} isTemplate={true} />
      </TooltipProvider>,
    )
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows correct tooltip text when isTemplate is false', async () => {
    const user = userEvent.setup()

    renderMenu({ isTemplate: false })

    await user.hover(screen.getByRole('button', { name: /toggle template status/i }))

    await waitFor(() => {
      const tooltipElements = screen.getAllByText(/toggle template status/i)
      expect(tooltipElements.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows correct tooltip text when isTemplate is true', async () => {
    const user = userEvent.setup()

    renderMenu({ isTemplate: true })

    await user.hover(screen.getByRole('button', { name: /toggle template status/i }))

    await waitFor(() => {
      const tooltipElements = screen.getAllByText(/page is a template/i)
      expect(tooltipElements.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('has no a11y violations', async () => {
    const { container } = renderMenu()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
