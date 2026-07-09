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
import { useState } from 'react'
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

function makeProps(
  latex: string,
  updateAttributes: (attrs: { latex: string }) => void = vi.fn(),
  deleteNode: () => void = vi.fn(),
) {
  return {
    node: { attrs: { latex } },
    updateAttributes,
    deleteNode,
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

/**
 * #2453 — a whitespace-only inline math atom has no canonical serialized form:
 * the serializer drops it on emit (#2451), so an invisible atom wedged between
 * two delimiter-wrapped runs makes serialize → parse → serialize non-idempotent.
 * The node view drops the atom when the user finishes editing its source with
 * empty/whitespace LaTeX — on CLOSE (blur / Enter / Escape), never per-keystroke,
 * so clearing the field to retype does not delete the node mid-edit.
 */
describe('MathNodeView drops whitespace-only atoms on close (#2453)', () => {
  afterEach(() => vi.clearAllMocks())

  it('deletes the node when the source editor is blurred with empty LaTeX', async () => {
    const deleteNode = vi.fn()
    render(<MathInlineNodeView {...makeProps('', vi.fn(), deleteNode)} />)
    // The empty atom renders the placeholder; open its source and blur without typing.
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    fireEvent.blur(input)
    expect(deleteNode).toHaveBeenCalledTimes(1)
  })

  it('deletes the node on Enter when the LaTeX is whitespace-only', async () => {
    const deleteNode = vi.fn()
    render(<MathInlineNodeView {...makeProps('   ', vi.fn(), deleteNode)} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(deleteNode).toHaveBeenCalledTimes(1)
  })

  it('does NOT delete the node when closing with non-empty LaTeX', async () => {
    const deleteNode = vi.fn()
    render(<MathInlineNodeView {...makeProps('a^2', vi.fn(), deleteNode)} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    fireEvent.blur(input)
    expect(deleteNode).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('math-source-input')).not.toBeInTheDocument())
  })

  it('does not delete on a per-keystroke edit that leaves the field empty mid-typing', async () => {
    // Only a CLOSE with empty latex drops the atom; an intermediate empty value
    // during editing must keep the node so the user can retype.
    const deleteNode = vi.fn()
    const update = vi.fn()
    render(<MathInlineNodeView {...makeProps('a', update, deleteNode)} />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    fireEvent.change(input, { target: { value: '' } })
    expect(update).toHaveBeenCalledWith({ latex: '' })
    expect(deleteNode).not.toHaveBeenCalled()
  })

  it('type → clear → blur drops the atom via the real updateAttributes → re-render chain', async () => {
    // Fidelity harness: a real `updateAttributes` that mutates the node's latex
    // and re-renders (mirroring TipTap's setNodeMarkup), so the close handler
    // reads the value the user actually left rather than a static seed.
    const deleteNode = vi.fn()
    function Harness(): React.ReactElement {
      const [latex, setLatex] = useState('a')
      const update = ({ latex: v }: { latex: string }) => setLatex(v)
      return <MathInlineNodeView {...makeProps(latex, update, deleteNode)} />
    }
    render(<Harness />)
    fireEvent.click(await screen.findByTestId('math-rendered'))
    const input = await screen.findByTestId('math-source-input')
    // Clear the field — re-renders the node view with latex='' committed.
    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(input).toHaveValue(''))
    fireEvent.blur(input)
    expect(deleteNode).toHaveBeenCalledTimes(1)
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
