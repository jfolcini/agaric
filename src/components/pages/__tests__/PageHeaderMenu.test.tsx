import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { PageHeaderMenuProps } from '@/components/pages/PageHeaderMenu'
import { PageHeaderMenu } from '@/components/pages/PageHeaderMenu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useIsTouch'
import { t } from '@/lib/i18n'
import { resetAllShortcuts, setCustomShortcut } from '@/lib/keyboard-config'

vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: vi.fn(() => false) }))

vi.mock('lucide-react', () => ({
  BookTemplate: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="book-template-icon" {...props} />
  ),
  ChevronDown: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  ChevronLeft: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  ChevronRight: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Clock: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Copy: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="copy-icon" {...props} />,
  Download: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="download-icon" {...props} />
  ),
  Printer: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="printer-icon" {...props} />,
  ExternalLink: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="external-link-icon" {...props} />
  ),
  FileCode: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="file-code-icon" {...props} />
  ),
  FileOutput: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  FileText: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  FolderOutput: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="folder-output-icon" {...props} />
  ),
  LayoutTemplate: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="layout-template-icon" {...props} />
  ),
  Link: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="link-icon" {...props} />,
  List: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="list-icon" {...props} />,
  MoreVertical: () => <svg data-testid="more-vertical-icon" />,
  Network: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="network-icon" {...props} />,
  Redo2: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="redo2-icon" {...props} />,
  Rows3: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Settings2: (props: React.SVGProps<SVGSVGElement>) => (
    <svg data-testid="settings2-icon" {...props} />
  ),
  Smile: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="smile-icon" {...props} />,
  Tag: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="tag-icon" {...props} />,
  Trash2: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="trash2-icon" {...props} />,
  Undo2: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="undo2-icon" {...props} />,
}))

const defaultProps: PageHeaderMenuProps = {
  canRedo: false,
  kebabOpen: false,
  isTemplate: false,
  isJournalTemplate: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onOpenOutline: vi.fn(),
  onShowInGraph: vi.fn(),
  onInsertEmoji: vi.fn(),
  onKebabOpenChange: vi.fn(),
  onAddAlias: vi.fn(),
  onAddTag: vi.fn(),
  onAddProperty: vi.fn(),
  onToggleTemplate: vi.fn(),
  onToggleJournalTemplate: vi.fn(),
  onExport: vi.fn(),
  onCopyAppLink: vi.fn(),
  onEditSource: vi.fn(),
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
  it('shows only the page-actions trigger at rest', () => {
    renderMenu()

    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      t('pageHeader.pageActions'),
    ])
  })

  it('labels the page-actions trigger with a tooltip', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.hover(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(t('pageHeader.pageActions'))
  })

  it('offers undo and redo as menu items', () => {
    renderMenu({ kebabOpen: true })

    expect(screen.getByRole('menuitem', { name: /undo last page action/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /redo last page action/i })).toBeInTheDocument()
  })

  it('disables the redo item when canRedo is false', () => {
    renderMenu({ kebabOpen: true, canRedo: false })

    expect(screen.getByRole('menuitem', { name: /redo last page action/i })).toBeDisabled()
  })

  it('enables the redo item when canRedo is true', () => {
    renderMenu({ kebabOpen: true, canRedo: true })

    expect(screen.getByRole('menuitem', { name: /redo last page action/i })).not.toBeDisabled()
  })

  it('shows menu items when kebabOpen is true', () => {
    renderMenu({ kebabOpen: true })

    expect(screen.getByText(t('pageHeader.openOutline'))).toBeInTheDocument()
    expect(screen.getByText(t('pageHeader.showInGraph'))).toBeInTheDocument()
    expect(screen.getByText(t('pageHeader.insertEmoji'))).toBeInTheDocument()
    expect(screen.getByText('Add alias')).toBeInTheDocument()
    expect(screen.getByText('Add tag')).toBeInTheDocument()
    expect(screen.getByText('Add property')).toBeInTheDocument()
    expect(screen.getByText(/Save as template/i)).toBeInTheDocument()
    expect(screen.getByText(/Set as journal template/i)).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: t('pageHeader.exportMenu') })).toBeInTheDocument()
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
  it('calls onUndo when the undo item is clicked', async () => {
    const onUndo = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onUndo })

    await user.click(screen.getByRole('menuitem', { name: /undo last page action/i }))
    expect(onUndo).toHaveBeenCalledOnce()
  })

  it('calls onRedo when the redo item is clicked', async () => {
    const onRedo = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, canRedo: true, onRedo })

    await user.click(screen.getByRole('menuitem', { name: /redo last page action/i }))
    expect(onRedo).toHaveBeenCalledOnce()
  })

  it('calls onOpenOutline when "Open outline" is clicked', async () => {
    const onOpenOutline = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onOpenOutline })

    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.openOutline') }))
    expect(onOpenOutline).toHaveBeenCalledOnce()
  })

  it('calls onShowInGraph from the "Show in graph" item, reached by arrow key after Open outline', async () => {
    const onShowInGraph = vi.fn()
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true, onShowInGraph })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: t('pageHeader.openOutline') })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    const item = within(menu).getByRole('menuitem', { name: /^Show in graph/ })
    expect(item).toHaveFocus()
    expect(item).toHaveClass('coarse:min-h-(--touch-target)')
    await user.keyboard('{Enter}')

    expect(onShowInGraph).toHaveBeenCalledOnce()
  })

  it('calls onInsertEmoji when "Insert emoji" is clicked', async () => {
    const onInsertEmoji = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onInsertEmoji })

    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.insertEmoji') }))
    expect(onInsertEmoji).toHaveBeenCalledOnce()
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

    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.exportMenu') }))
    await user.click(screen.getByText(/Copy as Markdown/i))
    expect(onExport).toHaveBeenCalledOnce()
  })

  it('calls onEditSource when "Edit as Markdown" clicked', async () => {
    const onEditSource = vi.fn()
    const user = userEvent.setup()

    renderMenu({ kebabOpen: true, onEditSource })

    await user.click(screen.getByRole('menuitem', { name: t('pageSource.edit') }))
    expect(onEditSource).toHaveBeenCalledOnce()
  })

  it('hides "Edit as Markdown" without onEditSource and keeps it out of the arrow-key order', async () => {
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true, onEditSource: undefined })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    expect(within(menu).queryByRole('menuitem', { name: t('pageSource.edit') })).toBeNull()
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })
    await user.keyboard('{End}')
    await user.keyboard('{ArrowUp}')
    expect(within(menu).getByRole('menuitem', { name: t('pageHeader.exportMenu') })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(within(menu).getByRole('menuitem', { name: /undo last page action/i })).toHaveFocus()
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
    expect(addAliasButton?.className).toContain('focus-ring-visible')
  })
})

describe('PageHeaderMenu export shortcut hint', () => {
  afterEach(() => resetAllShortcuts())

  it('shows Copy as Markdown with keyboard shortcut hint', async () => {
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true })
    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.exportMenu') }))

    expect(screen.getByText(/Copy as Markdown/i)).toBeInTheDocument()
    // Compact form (no spaces around `+`) that must not wrap.
    expect(screen.getByText('Ctrl+Shift+E')).toHaveClass('whitespace-nowrap')
  })

  it('shows Show in graph with its rebindable shortcut hint', () => {
    renderMenu({ kebabOpen: true })
    expect(screen.getByText('Ctrl+Shift+G')).toBeInTheDocument()

    cleanup()
    setCustomShortcut('showPageInGraph', 'Ctrl + Alt + G')
    renderMenu({ kebabOpen: true })
    expect(screen.getByText('Ctrl+Alt+G')).toBeInTheDocument()
    expect(screen.queryByText('Ctrl+Shift+G')).not.toBeInTheDocument()
  })

  it('shows the user-rebound binding, not the default', async () => {
    const user = userEvent.setup()
    setCustomShortcut('exportPageMarkdown', 'Ctrl + Alt + X')
    renderMenu({ kebabOpen: true })
    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.exportMenu') }))

    expect(screen.getByText('Ctrl+Alt+X')).toBeInTheDocument()
    expect(screen.queryByText('Ctrl+Shift+E')).not.toBeInTheDocument()
  })
})

describe('PageHeaderMenu ARIA menu semantics (CR-A11Y #151)', () => {
  it('renders the popover content with role="menu" and the page-actions label', () => {
    renderMenu({ kebabOpen: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    expect(menu).toBeInTheDocument()
  })

  it('marks every top-level action as role="menuitem"', () => {
    renderMenu({ kebabOpen: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    const items = within(menu).getAllByRole('menuitem')
    // addAlias, addTag, addProperty, insertEmoji, openOutline, showInGraph,
    // toggleTemplate, toggleJournalTemplate, undo, redo, editSource, Export,
    // delete = 13 (no history / openInNewTab / move entry by default, and
    // Export's rows only once it opens).
    expect(items).toHaveLength(13)
    expect(within(menu).getByText('Add alias').closest('button')).toHaveAttribute(
      'role',
      'menuitem',
    )
    expect(
      within(menu)
        .getByText(/Delete page/i)
        .closest('button'),
    ).toHaveAttribute('role', 'menuitem')
  })

  it('focuses the first menuitem when the menu opens', async () => {
    renderMenu({ kebabOpen: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    const firstItem = within(menu).getByRole('menuitem', { name: 'Add alias' })
    await waitFor(() => {
      expect(firstItem).toHaveFocus()
    })
  })

  it('applies roving tabindex: only the active menuitem is tabbable', async () => {
    renderMenu({ kebabOpen: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    const firstItem = within(menu).getByRole('menuitem', { name: 'Add alias' })
    await waitFor(() => {
      expect(firstItem).toHaveFocus()
    })

    expect(firstItem).toHaveAttribute('tabindex', '0')
    const tag = within(menu).getByText('Add tag').closest('button')
    expect(tag).toHaveAttribute('tabindex', '-1')
  })

  it('ArrowDown moves focus from Undo to Redo when there is something to redo', async () => {
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true, canRedo: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })
    act(() =>
      within(menu)
        .getByRole('menuitem', { name: /undo last page action/i })
        .focus(),
    )

    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: /redo last page action/i })).toHaveFocus()
  })

  it('ArrowDown skips a disabled Redo', async () => {
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true, canRedo: false })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })
    act(() =>
      within(menu)
        .getByRole('menuitem', { name: /undo last page action/i })
        .focus(),
    )

    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: t('pageSource.edit') })).toHaveFocus()
  })

  it('ArrowUp from the first item wraps to the last (delete)', async () => {
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })

    await user.keyboard('{ArrowUp}')
    expect(
      within(menu)
        .getByText(/Delete page/i)
        .closest('button'),
    ).toHaveFocus()
  })

  it('Home and End jump to first and last menuitems', async () => {
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })

    await user.keyboard('{End}')
    expect(
      within(menu)
        .getByText(/Delete page/i)
        .closest('button'),
    ).toHaveFocus()

    await user.keyboard('{Home}')
    expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
  })

  it('ArrowUp from delete lands on Export, then on Edit as Markdown above it', async () => {
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })

    await user.keyboard('{End}')
    await user.keyboard('{ArrowUp}')
    expect(within(menu).getByRole('menuitem', { name: t('pageHeader.exportMenu') })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(within(menu).getByRole('menuitem', { name: t('pageSource.edit') })).toHaveFocus()
  })

  it('still fires the click callback after keyboard navigation', async () => {
    const onOpenOutline = vi.fn()
    const user = userEvent.setup()
    renderMenu({ kebabOpen: true, onOpenOutline })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toHaveFocus()
    })
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: t('pageHeader.openOutline') })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(onOpenOutline).toHaveBeenCalledOnce()
  })

  it('includes the open-in-new-tab menuitem when the callback is provided', () => {
    renderMenu({ kebabOpen: true, onOpenInNewTab: vi.fn() })

    const menu = screen.getByRole('menu', { name: /page actions/i })
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(14)
  })

  it('keeps the move-to-space sub-menu working without counting its items in the top-level set', async () => {
    const onMoveToSpace = vi.fn()
    const user = userEvent.setup()
    renderMenu({
      kebabOpen: true,
      onMoveToSpace,
      moveTargets: [
        { id: 'sp-1', name: 'Space One' },
        { id: 'sp-2', name: 'Space Two' },
      ],
    })

    const topMenu = screen.getByRole('menu', { name: /page actions/i })
    // 13 default + the move-to entry = 14 top-level menuitems.
    expect(within(topMenu).getAllByRole('menuitem')).toHaveLength(14)

    // Expand the sub-menu and pick a target.
    await user.click(within(topMenu).getByText(/move to/i))
    const subMenu = screen.getByRole('menu', { name: /move to/i })
    // A long space name is cut to the menu's width, as TruncatedText.
    expect(within(subMenu).getByText('Space One')).toHaveAttribute('data-slot', 'truncated-text')
    await user.click(within(subMenu).getByText('Space One'))
    expect(onMoveToSpace).toHaveBeenCalledWith('sp-1')
  })

  it('has no a11y violations with the menu open', async () => {
    const { container } = renderMenu({ kebabOpen: true })

    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

describe('PageHeaderMenu delete button danger zone', () => {
  it('wraps the delete button in a destructive-tinted container', () => {
    renderMenu({ kebabOpen: true })

    const deleteButton = screen.getByText(/Delete page/i).closest('button')
    expect(deleteButton).toBeTruthy()

    const wrapper = deleteButton?.parentElement
    expect(wrapper?.className).toContain('bg-destructive/5')
  })

  it('uses destructive hover background (not bg-accent)', () => {
    renderMenu({ kebabOpen: true })

    const deleteButton = screen.getByText(/Delete page/i).closest('button')
    expect(deleteButton?.className).toContain('hover:bg-destructive/10')
    expect(deleteButton?.className).not.toContain('hover:bg-accent')
  })

  // A half-alpha ring falls under the 3:1 non-text minimum (#5332).
  it('keeps the opaque focus ring, with no half-alpha ring colour over it', () => {
    renderMenu({ kebabOpen: true })

    const deleteButton = screen.getByText(/Delete page/i).closest('button')
    expect(deleteButton).toHaveClass('focus-ring-visible')
    expect(deleteButton?.className).not.toMatch(/ring-[a-z-]+\/\d+/)
  })
})

// #5931 — on a phone the rows open as a bottom sheet instead of a dropdown.
describe('PageHeaderMenu on a phone', () => {
  const desktopWidth = window.innerWidth
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth })
    vi.mocked(useIsTouch).mockReturnValue(false)
  })

  // A touch phone has no tab bar to show the tab on; a narrow mouse window has.
  it.each([true, false])('offers Open in new tab only without touch (touch: %s)', (touch) => {
    vi.mocked(useIsTouch).mockReturnValue(touch)
    renderMenu({ kebabOpen: true, onOpenInNewTab: vi.fn() })
    const row = screen.queryByRole('menuitem', { name: t('tabs.openInNewTab') })
    expect(row === null).toBe(touch)
  })

  it('tapping the kebab asks to open the sheet', async () => {
    const user = userEvent.setup()
    const onKebabOpenChange = vi.fn()
    renderMenu({ onKebabOpenChange })
    await user.click(screen.getByRole('button', { name: t('pageHeader.pageActions') }))
    expect(onKebabOpenChange).toHaveBeenCalledWith(true)
  })

  it('shows the rows as a menu inside a sheet, not a popover', async () => {
    renderMenu({ kebabOpen: true })
    const sheet = screen.getByRole('dialog', { name: t('pageHeader.pageActions') })
    expect(sheet).toHaveAttribute('data-slot', 'sheet-content')
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
    const menu = within(sheet).getByRole('menu', { name: t('pageHeader.pageActions') })
    expect(within(menu).getByRole('menuitem', { name: /Add alias/ })).toBeInTheDocument()
    expect(await axe(sheet)).toHaveNoViolations()
  })

  it('a row fires its action', async () => {
    const user = userEvent.setup()
    const onAddTag = vi.fn()
    renderMenu({ kebabOpen: true, onAddTag })
    await user.click(screen.getByRole('menuitem', { name: /Add tag/ }))
    expect(onAddTag).toHaveBeenCalledTimes(1)
  })

  it('Escape asks to close the sheet', async () => {
    const user = userEvent.setup()
    const onKebabOpenChange = vi.fn()
    renderMenu({ kebabOpen: true, onKebabOpenChange })
    await user.keyboard('{Escape}')
    expect(onKebabOpenChange).toHaveBeenCalledWith(false)
  })
})

// #7040 O6 (decision 21) — separators group the rows into Add, View, Template
// and Edit; an Export submenu holds copy link, Markdown, save file and print;
// Delete sits alone at the bottom.
describe('PageHeaderMenu sections', () => {
  const ALL = {
    kebabOpen: true,
    canRedo: true,
    onOpenHistory: vi.fn(),
    onOpenInNewTab: vi.fn(),
    onSaveMarkdownFile: vi.fn(),
    onPrint: vi.fn(),
    editMode: 'blocks' as const,
    onEditModeChange: vi.fn(),
    moveTargets: [{ id: 'sp-1', name: 'Space One' }],
    onMoveToSpace: vi.fn(),
  }
  const names = (scope: HTMLElement) =>
    within(scope)
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.replace(/Ctrl.*$/, '').trim())

  it('groups the rows into Add, View, Template and Edit, in that order', () => {
    renderMenu(ALL)
    const menu = screen.getByRole('menu', { name: t('pageHeader.pageActions') })
    const sections = within(menu).getAllByRole('group')
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual([
      t('pageHeader.sectionAdd'),
      t('pageHeader.sectionView'),
      t('pageHeader.sectionTemplate'),
      t('pageHeader.sectionEdit'),
    ])
    expect(sections.map(names)).toEqual([
      ['Add alias', 'Add tag', 'Add property', t('pageHeader.insertEmoji')],
      [
        t('pageHeader.openOutline'),
        t('pageHeader.pageHistory'),
        t('pageHeader.showInGraph'),
        t('tabs.openInNewTab'),
      ],
      [t('pageHeader.saveAsTemplate'), t('pageHeader.setJournalTemplate')],
      [
        t('pageHeader.undoAction'),
        t('pageHeader.redoAction'),
        t('pageMode.editAsPage'),
        t('pageSource.edit'),
        t('space.moveTo'),
      ],
    ])
  })

  it('keeps copy link, Markdown, save file and print behind a collapsed Export row', () => {
    renderMenu(ALL)
    const exportRow = screen.getByRole('menuitem', { name: t('pageHeader.exportMenu') })
    expect(exportRow).toHaveAttribute('aria-expanded', 'false')
    for (const name of [
      t('pageHeader.copyAppLink'),
      t('pageHeader.saveMarkdownFile'),
      t('pageHeader.print'),
    ]) {
      expect(screen.queryByRole('menuitem', { name })).toBeNull()
    }
    expect(screen.queryByText(/Copy as Markdown/)).toBeNull()
  })

  it('opens the Export submenu in place, and its rows run their actions', async () => {
    const user = userEvent.setup()
    const onPrint = vi.fn()
    renderMenu({ ...ALL, onPrint })
    const exportRow = screen.getByRole('menuitem', { name: t('pageHeader.exportMenu') })
    await user.click(exportRow)

    expect(exportRow).toHaveAttribute('aria-expanded', 'true')
    expect(exportRow).toHaveFocus()
    const submenu = screen.getByRole('group', { name: t('pageHeader.exportMenu') })
    expect(exportRow).toHaveAttribute('aria-controls', submenu.id)
    expect(names(submenu)).toEqual([
      t('pageHeader.copyAppLink'),
      t('pageHeader.exportMarkdown'),
      t('pageHeader.saveMarkdownFile'),
      t('pageHeader.print'),
    ])
    await user.keyboard('{ArrowDown}')
    expect(
      within(submenu).getByRole('menuitem', { name: t('pageHeader.copyAppLink') }),
    ).toHaveFocus()

    await user.click(within(submenu).getByRole('menuitem', { name: t('pageHeader.print') }))
    expect(onPrint).toHaveBeenCalledOnce()
  })

  it('puts Delete alone at the bottom, outside every section', () => {
    renderMenu(ALL)
    const menu = screen.getByRole('menu', { name: t('pageHeader.pageActions') })
    const last = within(menu).getAllByRole('menuitem').at(-1)
    expect(last).toHaveAccessibleName(t('pageHeader.deletePage'))
    expect(last?.closest('[role="group"]')).toBeNull()
  })

  it('draws every row through the menu-row variant, with its icons unsized', async () => {
    const user = userEvent.setup()
    renderMenu(ALL)
    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.exportMenu') }))
    const menu = screen.getByRole('menu', { name: t('pageHeader.pageActions') })
    for (const item of within(menu).getAllByRole('menuitem')) {
      expect(item).toHaveClass('[:where(&)_svg]:size-4', 'coarse:min-h-(--touch-target)')
      for (const icon of item.querySelectorAll('svg')) {
        expect(icon.getAttribute('class') ?? '').not.toMatch(/\b[hw]-3\.5\b/)
      }
    }
  })
})

describe('PageHeaderMenu sections on a phone', () => {
  const desktopWidth = window.innerWidth
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth })
  })

  it('drills into Export inside the sheet, and Back returns to the sections', async () => {
    const user = userEvent.setup()
    const onCopyAppLink = vi.fn()
    renderMenu({ kebabOpen: true, onPrint: vi.fn(), onCopyAppLink })
    const sheet = screen.getByRole('dialog', { name: t('pageHeader.pageActions') })
    const menu = within(sheet).getByRole('menu', { name: t('pageHeader.pageActions') })
    await user.click(within(menu).getByRole('menuitem', { name: t('pageHeader.exportMenu') }))

    expect(within(menu).queryByRole('menuitem', { name: 'Add alias' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: t('pageHeader.deletePage') })).toBeNull()
    const submenu = within(menu).getByRole('group', { name: t('pageHeader.exportMenu') })
    expect(
      within(submenu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent?.replace(/Ctrl.*$/, '')),
    ).toEqual([t('pageHeader.copyAppLink'), t('pageHeader.exportMarkdown'), t('pageHeader.print')])
    await waitFor(() => {
      expect(
        within(submenu).getByRole('menuitem', { name: t('pageHeader.copyAppLink') }),
      ).toHaveFocus()
    })
    expect(await axe(sheet)).toHaveNoViolations()

    await user.click(within(menu).getByRole('menuitem', { name: t('pageHeader.exportBack') }))
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: t('pageHeader.exportMenu') })).toHaveFocus()
    })
    expect(within(menu).getByRole('menuitem', { name: 'Add alias' })).toBeInTheDocument()

    await user.click(within(menu).getByRole('menuitem', { name: t('pageHeader.exportMenu') }))
    await user.click(within(menu).getByRole('menuitem', { name: t('pageHeader.copyAppLink') }))
    expect(onCopyAppLink).toHaveBeenCalledOnce()
  })
})
