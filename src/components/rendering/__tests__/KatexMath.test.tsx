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
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('katex', () => ({
  default: {
    renderToString: vi.fn(),
  },
}))

const katex = (await import('katex')).default
const mockedRender = vi.mocked(katex.renderToString)

const { KatexMath } = await import('../KatexMath')

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
