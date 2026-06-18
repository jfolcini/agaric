/**
 * Tests for MermaidCodeBlockView — the editor's code-block node view (#1438).
 *
 * Validates:
 *  - language === 'mermaid' renders the diagram (MermaidDiagram) for valid src
 *  - invalid mermaid degrades gracefully (inline error, editor not crashed)
 *  - the raw-source toggle swaps between rendered diagram and editable source
 *  - a non-mermaid code block renders the standard editable code block, NOT
 *    the diagram path
 *
 * `@tiptap/react`'s NodeViewWrapper/NodeViewContent are stubbed to plain DOM
 * (TipTap doesn't render in the test environment — see components AGENTS.md),
 * and `mermaid` is mocked exactly as MermaidDiagram's own tests do.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}))

// Stub the TipTap React node-view primitives to plain DOM so the view renders
// in happy-dom. NodeViewContent is the ProseMirror-managed editable slot; here
// it is just a passive element.
vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
  NodeViewContent: ({ as: As = 'div', ...rest }: { as?: string }) => {
    const Tag = As as keyof React.JSX.IntrinsicElements
    return <Tag data-testid="node-view-content" {...rest} />
  },
}))

const mermaid = (await import('mermaid')).default
const mockedRender = vi.mocked(mermaid.render)

const { MermaidCodeBlockView } = await import('../MermaidCodeBlockView')

/** Build a minimal NodeViewProps stand-in carrying a code-block node. */
function makeProps(
  language: string | null,
  text: string,
): React.ComponentProps<typeof MermaidCodeBlockView> {
  return {
    node: {
      attrs: { language },
      textContent: text,
    },
    // The remaining NodeViewProps fields are unused by the component.
  } as unknown as React.ComponentProps<typeof MermaidCodeBlockView>
}

describe('MermaidCodeBlockView (#1438)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the MermaidDiagram for a valid mermaid source', async () => {
    mockedRender.mockResolvedValue({
      svg: '<svg><text>diagram</text></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    render(<MermaidCodeBlockView {...makeProps('mermaid', 'graph TD; A-->B;')} />)

    const diagram = await screen.findByTestId('mermaid-diagram')
    expect(diagram).toBeInTheDocument()
    expect(diagram.innerHTML).toBe('<svg><text>diagram</text></svg>')
  })

  it('degrades gracefully on invalid mermaid (inline error, no crash)', async () => {
    mockedRender.mockRejectedValue(new Error('Parse error: invalid syntax'))

    render(<MermaidCodeBlockView {...makeProps('mermaid', 'definitely not mermaid')} />)

    const errorEl = await screen.findByTestId('mermaid-error')
    expect(errorEl).toBeInTheDocument()
    expect(errorEl.textContent).toContain('Parse error: invalid syntax')
    // The raw source is still available as a fallback inside the error box.
    expect(errorEl.querySelector('code')?.textContent).toBe('definitely not mermaid')
  })

  it('toggles between the rendered diagram and the editable raw source', async () => {
    mockedRender.mockResolvedValue({
      svg: '<svg></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    render(<MermaidCodeBlockView {...makeProps('mermaid', 'graph TD; A-->B;')} />)

    // Starts in rendered mode: diagram visible, source hidden.
    const rendered = screen.getByTestId('mermaid-rendered')
    expect(rendered).not.toHaveAttribute('hidden')
    const sourcePre = screen.getByTestId('node-view-content').closest('pre')
    expect(sourcePre).toHaveAttribute('hidden')

    // Toggle to source.
    fireEvent.click(screen.getByTestId('mermaid-toggle-source'))
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-rendered')).toHaveAttribute('hidden')
    })
    expect(screen.getByTestId('node-view-content').closest('pre')).not.toHaveAttribute('hidden')

    // Toggle back to the diagram.
    fireEvent.click(screen.getByTestId('mermaid-toggle-source'))
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-rendered')).not.toHaveAttribute('hidden')
    })
  })

  it('prevents the default mousedown on the toggle so the editor is not blurred', () => {
    mockedRender.mockResolvedValue({
      svg: '<svg></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })
    render(<MermaidCodeBlockView {...makeProps('mermaid', 'graph TD; A-->B;')} />)
    const toggle = screen.getByTestId('mermaid-toggle-source')
    // A blur-suppressing mousedown handler must call preventDefault.
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    toggle.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('renders an empty-state hint when the mermaid source is blank', () => {
    render(<MermaidCodeBlockView {...makeProps('mermaid', '   ')} />)
    // No diagram render attempted for blank source.
    expect(mockedRender).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument()
    expect(screen.getByTestId('mermaid-rendered').textContent).toContain('Empty diagram')
  })

  it('renders a standard editable code block (no diagram) for a non-mermaid language', () => {
    render(<MermaidCodeBlockView {...makeProps('js', 'const a = 1')} />)

    // No mermaid-specific UI for a JS block.
    expect(screen.queryByTestId('mermaid-node-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mermaid-toggle-source')).not.toBeInTheDocument()
    expect(mockedRender).not.toHaveBeenCalled()

    // The editable code content slot is present with the language class.
    const content = screen.getByTestId('node-view-content')
    expect(content.tagName).toBe('CODE')
    expect(content).toHaveClass('language-js')
  })

  it('renders a standard editable code block for a language-less code block', () => {
    render(<MermaidCodeBlockView {...makeProps(null, 'plain code')} />)
    expect(screen.queryByTestId('mermaid-node-view')).not.toBeInTheDocument()
    const content = screen.getByTestId('node-view-content')
    expect(content.tagName).toBe('CODE')
  })
})
