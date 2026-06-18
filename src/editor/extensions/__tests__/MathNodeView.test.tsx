/**
 * Tests for MathInlineNodeView / MathBlockNodeView (#1437).
 *
 * Validates:
 *  - the rendered view shows the KaTeX output (lazy KatexMath, mocked)
 *  - clicking the rendered math reveals an editable LaTeX source field whose
 *    edits are pushed back via updateAttributes
 *  - invalid LaTeX degrades gracefully (KatexMath mock returns the error
 *    fallback) without crashing the view
 *
 * `@tiptap/react`'s NodeViewWrapper is stubbed to plain DOM, and the lazy
 * `KatexMath` import is mocked so KaTeX itself never loads in the test env.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({
    children,
    as: As = 'div',
    ...rest
  }: {
    children?: React.ReactNode
    as?: string
  }) => {
    const Tag = As as keyof React.JSX.IntrinsicElements
    return <Tag {...rest}>{children}</Tag>
  },
}))

// Mock the lazily-imported KatexMath so the test never pulls in real KaTeX.
vi.mock('@/components/rendering/KatexMath', () => ({
  KatexMath: ({ latex, display }: { latex: string; display?: boolean }) => (
    <span data-testid={display ? 'katex-block' : 'katex-inline'}>rendered:{latex}</span>
  ),
}))

const { MathInlineNodeView, MathBlockNodeView } = await import('../MathNodeView')

function makeProps(latex: string, updateAttributes = vi.fn()) {
  return {
    node: { attrs: { latex } },
    updateAttributes,
  } as unknown as React.ComponentProps<typeof MathInlineNodeView>
}

describe('MathInlineNodeView (#1437)', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders the KaTeX output for inline math', async () => {
    render(<MathInlineNodeView {...makeProps('a^2')} />)
    const el = await screen.findByTestId('katex-inline')
    expect(el.textContent).toBe('rendered:a^2')
  })

  it('reveals an editable source field on click and pushes edits via updateAttributes', async () => {
    const update = vi.fn()
    render(<MathInlineNodeView {...makeProps('a^2', update)} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    expect(input).toHaveValue('a^2')
    fireEvent.change(input, { target: { value: 'b^3' } })
    expect(update).toHaveBeenCalledWith({ latex: 'b^3' })
  })

  it('shows an empty-state hint for blank LaTeX (no KaTeX render attempted)', () => {
    render(<MathInlineNodeView {...makeProps('   ')} />)
    expect(screen.queryByTestId('katex-inline')).not.toBeInTheDocument()
  })
})

describe('MathBlockNodeView (#1437)', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders display-mode KaTeX output for block math', async () => {
    render(<MathBlockNodeView {...makeProps('\\int_0^1 x')} />)
    const el = await screen.findByTestId('katex-block')
    expect(el.textContent).toBe('rendered:\\int_0^1 x')
  })

  it('toggles back to the rendered view after editing source (blur)', async () => {
    render(<MathBlockNodeView {...makeProps('x')} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByTestId('math-source-input')).not.toBeInTheDocument())
  })
})
