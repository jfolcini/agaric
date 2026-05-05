import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PageAliasSection } from '../PageAliasSection'

vi.mock('lucide-react', () => ({
  X: () => <svg data-testid="x-icon" />,
}))

const defaultProps = {
  aliases: [] as string[],
  editingAliases: false,
  aliasInput: '',
  onAliasInputChange: vi.fn(),
  onAddAlias: vi.fn(),
  onRemoveAlias: vi.fn(),
  onStartEditing: vi.fn(),
  onStopEditing: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageAliasSection rendering', () => {
  it('returns null when no aliases and not editing', () => {
    const { container } = render(<PageAliasSection {...defaultProps} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders alias badges when aliases exist', () => {
    render(<PageAliasSection {...defaultProps} aliases={['daily-note', 'DN']} />)

    expect(screen.getByText('Also known as:')).toBeInTheDocument()
    expect(screen.getByText('daily-note')).toBeInTheDocument()
    expect(screen.getByText('DN')).toBeInTheDocument()
  })

  it('renders Edit button when not editing', () => {
    render(<PageAliasSection {...defaultProps} aliases={['my-alias']} />)

    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
  })

  it('renders editing form when editingAliases is true', () => {
    render(<PageAliasSection {...defaultProps} aliases={['my-alias']} editingAliases={true} />)

    expect(screen.getByLabelText('New alias input')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
  })

  it('shows remove buttons on aliases when editing', () => {
    render(
      <PageAliasSection {...defaultProps} aliases={['alias-a', 'alias-b']} editingAliases={true} />,
    )

    expect(screen.getByRole('button', { name: /remove alias alias-a/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove alias alias-b/i })).toBeInTheDocument()
  })

  it('does not show remove buttons when not editing', () => {
    render(<PageAliasSection {...defaultProps} aliases={['alias-a']} />)

    expect(screen.queryByRole('button', { name: /remove alias/i })).not.toBeInTheDocument()
  })

  it('renders editing form when no aliases but editingAliases is true', () => {
    render(<PageAliasSection {...defaultProps} editingAliases={true} />)

    expect(screen.getByLabelText('New alias input')).toBeInTheDocument()
  })
})

describe('PageAliasSection interaction', () => {
  it('calls onStartEditing when Edit button clicked', async () => {
    const onStartEditing = vi.fn()
    const user = userEvent.setup()

    render(
      <PageAliasSection {...defaultProps} aliases={['my-alias']} onStartEditing={onStartEditing} />,
    )

    await user.click(screen.getByRole('button', { name: /edit/i }))
    expect(onStartEditing).toHaveBeenCalledOnce()
  })

  it('calls onStopEditing when Done button clicked', async () => {
    const onStopEditing = vi.fn()
    const user = userEvent.setup()

    render(
      <PageAliasSection
        {...defaultProps}
        aliases={['my-alias']}
        editingAliases={true}
        onStopEditing={onStopEditing}
      />,
    )

    await user.click(screen.getByRole('button', { name: /done/i }))
    expect(onStopEditing).toHaveBeenCalledOnce()
  })

  it('calls onAliasInputChange when typing in alias input', async () => {
    const onAliasInputChange = vi.fn()
    const user = userEvent.setup()

    render(
      <PageAliasSection
        {...defaultProps}
        editingAliases={true}
        onAliasInputChange={onAliasInputChange}
      />,
    )

    const input = screen.getByLabelText('New alias input')
    await user.type(input, 'a')

    expect(onAliasInputChange).toHaveBeenCalledWith('a')
  })

  it('calls onAddAlias when form is submitted', async () => {
    const onAddAlias = vi.fn()
    const user = userEvent.setup()

    render(
      <PageAliasSection
        {...defaultProps}
        editingAliases={true}
        aliasInput="new-alias"
        onAddAlias={onAddAlias}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^add$/i }))
    expect(onAddAlias).toHaveBeenCalledOnce()
  })

  it('calls onAddAlias when Enter pressed in input', async () => {
    const onAddAlias = vi.fn()
    const user = userEvent.setup()

    render(
      <PageAliasSection
        {...defaultProps}
        editingAliases={true}
        aliasInput="new-alias"
        onAddAlias={onAddAlias}
      />,
    )

    const input = screen.getByLabelText('New alias input')
    await user.click(input)
    await user.keyboard('{Enter}')

    expect(onAddAlias).toHaveBeenCalledOnce()
  })

  it('calls onRemoveAlias with the correct alias', async () => {
    const onRemoveAlias = vi.fn()
    const user = userEvent.setup()

    render(
      <PageAliasSection
        {...defaultProps}
        aliases={['alias-a', 'alias-b']}
        editingAliases={true}
        onRemoveAlias={onRemoveAlias}
      />,
    )

    await user.click(screen.getByRole('button', { name: /remove alias alias-a/i }))
    expect(onRemoveAlias).toHaveBeenCalledWith('alias-a')
  })
})

describe('PageAliasSection UX-2 — touch target on remove button', () => {
  it('remove-alias button has 44 px coarse-pointer touch target', () => {
    render(<PageAliasSection {...defaultProps} aliases={['alias-a']} editingAliases={true} />)

    const btn = screen.getByRole('button', { name: /remove alias alias-a/i })
    expect(btn.className).toContain('[@media(pointer:coarse)]:h-11')
    expect(btn.className).toContain('[@media(pointer:coarse)]:w-11')
    expect(btn.className).toContain('[@media(pointer:coarse)]:p-2')
  })

  it('remove-alias button keeps focus-visible ring tokens', () => {
    render(<PageAliasSection {...defaultProps} aliases={['alias-a']} editingAliases={true} />)

    const btn = screen.getByRole('button', { name: /remove alias alias-a/i })
    expect(btn.className).toContain('focus-ring-visible')
  })

  // PEND-28b M5: 96 px (w-24) is too cramped on narrow desktop viewports
  //              (~360–500 px wide, mouse pointer) where the coarse-pointer
  //              `w-full` override does not apply. Add a sm: breakpoint so the
  //              field grows to 128 px before falling back to the desktop default.
  it('PEND-28b M5: alias input has sm:w-32 viewport-width breakpoint', () => {
    render(<PageAliasSection {...defaultProps} editingAliases={true} />)

    const input = screen.getByLabelText('New alias input')
    expect(input.className).toContain('sm:w-32')
  })
})

describe('PageAliasSection accessibility', () => {
  it('has no a11y violations with aliases', async () => {
    const { container } = render(
      <PageAliasSection {...defaultProps} aliases={['daily-note', 'DN']} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations in editing mode', async () => {
    const { container } = render(
      <PageAliasSection {...defaultProps} aliases={['my-alias']} editingAliases={true} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
