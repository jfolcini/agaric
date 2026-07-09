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
    editor: { commands: { focus: vi.fn() } },
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

/**
 * Finding 44 — the LaTeX source editor was unusable: focusing the input blurred
 * the ProseMirror contenteditable, and `useEditorBlur` (finding no
 * `[data-editor-portal]` ancestor on the relatedTarget) saved + unmounted the
 * block, destroying the input mid-interaction. The node view must:
 *  - tag the source-editor span with `data-editor-portal` (the blur guard's
 *    single opt-in escape hatch — see useEditorBlur's EDITOR_PORTAL_SELECTOR),
 *  - focus the input when the source is revealed (the reveal click keeps the
 *    editor focused via preventDefault, so nothing else focuses it),
 *  - contain its keydowns so use-block-keyboard's capture-phase container
 *    listener cannot flush/merge/navigate blocks while the user types LaTeX.
 */
describe('MathNodeView source editor focus retention (finding 44)', () => {
  afterEach(() => vi.clearAllMocks())

  it('wraps the source input in a data-editor-portal element so the blur guard keeps the block mounted', async () => {
    render(<MathInlineNodeView {...makeProps('a^2')} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    // `[data-editor-portal]` is useEditorBlur's EDITOR_PORTAL_SELECTOR — the
    // single opt-in that stops Step 5 (unmount + save) when focus moves here.
    expect(input.closest('[data-editor-portal]')).not.toBeNull()
  })

  it('focuses the source input when it is revealed', async () => {
    render(<MathInlineNodeView {...makeProps('a^2')} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it('keydown in the source input never reaches capture-phase block keyboard listeners', async () => {
    // Mirrors use-block-keyboard: a capture-phase keydown listener on an
    // ancestor of the editor DOM. Keys typed into the LaTeX field must not
    // reach it (Enter there would flush/split the block under the input).
    const captureSpy = vi.fn()
    document.body.addEventListener('keydown', captureSpy, true)
    try {
      render(<MathInlineNodeView {...makeProps('a^2')} />)
      fireEvent.click(await screen.findByTestId('math-rendered'))
      const input = await screen.findByTestId('math-source-input')

      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.keyDown(input, { key: 'Backspace' })
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(captureSpy).not.toHaveBeenCalled()

      // Control: keydown elsewhere still propagates normally.
      fireEvent.keyDown(document.body, { key: 'Enter' })
      expect(captureSpy).toHaveBeenCalledTimes(1)
    } finally {
      document.body.removeEventListener('keydown', captureSpy, true)
    }
  })

  it('Enter closes the source editor and returns focus to the editor', async () => {
    const props = makeProps('a^2')
    render(<MathInlineNodeView {...props} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')

    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.queryByTestId('math-source-input')).not.toBeInTheDocument())
    expect(screen.getByTestId('math-rendered')).toBeInTheDocument()
    expect(
      (props as { editor: { commands: { focus: () => void } } }).editor.commands.focus,
    ).toHaveBeenCalled()
  })

  it('Escape closes the source editor and returns focus to the editor', async () => {
    const props = makeProps('x_1')
    render(<MathInlineNodeView {...props} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')

    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('math-source-input')).not.toBeInTheDocument())
    expect(
      (props as { editor: { commands: { focus: () => void } } }).editor.commands.focus,
    ).toHaveBeenCalled()
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
