import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, type RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PageTitleEditor } from '../PageTitleEditor'

vi.mock('lucide-react', () => ({
  AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  Info: () => <svg data-testid="info-icon" />,
  Lightbulb: () => <svg data-testid="lightbulb-icon" />,
  MoreVertical: () => <svg data-testid="more-vertical-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
  Redo2: () => <svg data-testid="redo2-icon" />,
  StickyNote: () => <svg data-testid="sticky-note-icon" />,
  Undo2: () => <svg data-testid="undo2-icon" />,
  X: () => <svg data-testid="x-icon" />,
  XCircle: () => <svg data-testid="x-circle-icon" />,
}))

const defaultProps = {
  title: 'My Page',
  editableTitle: 'My Page',
  titleRef: createRef<HTMLDivElement>() as RefObject<HTMLDivElement | null>,
  onInput: vi.fn(),
  onBlur: vi.fn(),
  onKeyDown: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageTitleEditor rendering', () => {
  it('renders the title in a textbox', () => {
    render(<PageTitleEditor {...defaultProps} />)

    const el = screen.getByRole('textbox', { name: /page title/i })
    expect(el).toBeInTheDocument()
    expect(el).toHaveTextContent('My Page')
  })

  it('is contentEditable', () => {
    render(<PageTitleEditor {...defaultProps} />)

    const el = screen.getByRole('textbox', { name: /page title/i })
    expect(el).toHaveAttribute('contenteditable', 'true')
  })

  it('sets the ref on the div element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<PageTitleEditor {...defaultProps} titleRef={ref as RefObject<HTMLDivElement | null>} />)

    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.textContent).toBe('My Page')
  })
})

describe('PageTitleEditor interaction', () => {
  it('calls onInput when user types', async () => {
    const onInput = vi.fn()
    const user = userEvent.setup()

    render(<PageTitleEditor {...defaultProps} onInput={onInput} />)

    const el = screen.getByRole('textbox', { name: /page title/i })
    await user.click(el)
    await user.type(el, 'x')

    expect(onInput).toHaveBeenCalled()
  })

  it('calls onBlur when the element loses focus', async () => {
    const onBlur = vi.fn()
    const user = userEvent.setup()

    render(<PageTitleEditor {...defaultProps} onBlur={onBlur} />)

    const el = screen.getByRole('textbox', { name: /page title/i })
    await user.click(el)
    await user.tab()

    expect(onBlur).toHaveBeenCalled()
  })

  it('calls onKeyDown when Enter is pressed', async () => {
    const onKeyDown = vi.fn()
    const user = userEvent.setup()

    render(<PageTitleEditor {...defaultProps} onKeyDown={onKeyDown} />)

    const el = screen.getByRole('textbox', { name: /page title/i })
    await user.click(el)
    await user.keyboard('{Enter}')

    expect(onKeyDown).toHaveBeenCalled()
  })
})

describe('PageTitleEditor accessibility', () => {
  it('has no a11y violations', async () => {
    const { container } = render(<PageTitleEditor {...defaultProps} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has tabIndex for keyboard accessibility', () => {
    render(<PageTitleEditor {...defaultProps} />)

    const el = screen.getByRole('textbox', { name: /page title/i })
    expect(el).toHaveAttribute('tabindex', '0')
  })
})
