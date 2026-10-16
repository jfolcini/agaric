/**
 * Tests for the KatexMath component (#1437).
 *
 * Validates:
 *  - renders KaTeX HTML output for valid LaTeX (inline + display mode)
 *  - degrades gracefully when KaTeX throws (defensive try/catch → raw source,
 *    editor not crashed) — `katex` is mocked exactly as the mermaid tests mock
 *    `mermaid`.
 *  - passes `throwOnError:false` so invalid LaTeX never throws at runtime.
 *
 * `katex/dist/katex.min.css` is a side-effect CSS import; vitest resolves CSS
 * imports to a no-op module, so it needs no special handling here.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('katex', () => ({
  default: {
    renderToString: vi.fn(),
  },
}))

const katex = (await import('katex')).default
const mockedRender = vi.mocked(katex.renderToString)

const { KatexMath } = await import('@/components/rendering/KatexMath')

describe('KatexMath (#1437)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders KaTeX output inline for valid LaTeX', () => {
    mockedRender.mockReturnValue('<span class="katex">a^2</span>')
    render(<KatexMath latex="a^2" />)
    const el = screen.getByTestId('katex-inline')
    expect(el.tagName).toBe('SPAN')
    expect(el.innerHTML).toBe('<span class="katex">a^2</span>')
  })

  it('renders in display mode as a block element', () => {
    mockedRender.mockReturnValue('<span class="katex katex-display">x</span>')
    render(<KatexMath latex={'\\int x'} display />)
    const el = screen.getByTestId('katex-block')
    expect(el.tagName).toBe('DIV')
  })

  // #5638 — KaTeX keeps a display equation on one line, so the wrapper must
  // scroll horizontally or a wide equation is clipped on a phone.
  it('puts display math inside a horizontal ScrollArea viewport', () => {
    mockedRender.mockReturnValue('<span class="katex katex-display">x</span>')
    const { container } = render(<KatexMath latex={'\\int x'} display />)
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).toContainElement(screen.getByTestId('katex-block'))
  })

  it('leaves inline math outside any ScrollArea', () => {
    mockedRender.mockReturnValue('<span class="katex">x</span>')
    const { container } = render(<KatexMath latex="x" />)
    expect(container.querySelector('[data-slot="scroll-area"]')).toBeNull()
  })

  it('takes the KaTeX error colour from the error token', () => {
    mockedRender.mockReturnValue('<span class="katex"></span>')
    render(<KatexMath latex={'\\frac{'} />)
    expect(mockedRender).toHaveBeenCalledWith(
      '\\frac{',
      expect.objectContaining({ errorColor: 'var(--alert-error-foreground)' }),
    )
  })

  it('has no a11y violations in display mode', async () => {
    mockedRender.mockReturnValue('<span class="katex katex-display">x</span>')
    const { container } = render(<KatexMath latex="x" display />)
    expect(await axe(container)).toHaveNoViolations()
  })

  // #5638 — the viewer is opt-in: the editor node view renders math inside a
  // button, where a nested Expand button would be invalid.
  it('offers Expand only for expandable display math', () => {
    mockedRender.mockReturnValue('<span class="katex">x</span>')
    const { rerender } = render(<KatexMath latex="x" display />)
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull()
    rerender(<KatexMath latex="x" expandable />)
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull()
    rerender(<KatexMath latex="x" display expandable />)
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument()
  })

  it('opens display math in the viewer with Copy LaTeX', async () => {
    mockedRender.mockReturnValue('<span class="katex">x</span>')
    const user = userEvent.setup()
    render(<KatexMath latex="x" display expandable />)
    await user.click(screen.getByRole('button', { name: 'Expand' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('.katex')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Copy LaTeX' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download SVG' })).toBeNull()
    expect(await axe(dialog)).toHaveNoViolations()
  })

  it('calls KaTeX with throwOnError:false so invalid LaTeX never throws', () => {
    mockedRender.mockReturnValue('<span class="katex"></span>')
    render(<KatexMath latex={'\\frac{'} />)
    expect(mockedRender).toHaveBeenCalledWith(
      '\\frac{',
      expect.objectContaining({ throwOnError: false }),
    )
  })

  it('degrades gracefully (raw source, no crash) if KaTeX unexpectedly throws', () => {
    mockedRender.mockImplementation(() => {
      throw new Error('boom')
    })
    render(<KatexMath latex={'\\bad{'} />)
    const fallback = screen.getByTestId('katex-error')
    expect(fallback.textContent).toBe('\\bad{')
  })
})
