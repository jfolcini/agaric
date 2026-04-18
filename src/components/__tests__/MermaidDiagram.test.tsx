/**
 * Tests for MermaidDiagram component.
 *
 * Validates:
 *  - Renders SVG output when mermaid.render succeeds
 *  - Shows error state when mermaid.render fails
 *  - Shows loading state initially
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}))

const mermaid = (await import('mermaid')).default
const mockedRender = vi.mocked(mermaid.render)

// Import after mocks are set up
const { MermaidDiagram } = await import('../MermaidDiagram')

describe('MermaidDiagram', () => {
  it('shows loading state initially', () => {
    // Make render hang by never resolving
    mockedRender.mockReturnValue(new Promise(() => {}))

    render(<MermaidDiagram code="graph TD; A-->B;" />)

    const loading = screen.getByTestId('mermaid-loading')
    expect(loading).toBeInTheDocument()
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading.textContent).toContain('Rendering diagram')
  })

  it('renders SVG output when mermaid.render succeeds', async () => {
    const fakeSvg = '<svg><text>Hello</text></svg>'
    mockedRender.mockResolvedValue({
      svg: fakeSvg,
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    render(<MermaidDiagram code="graph TD; A-->B;" />)

    const diagram = await screen.findByTestId('mermaid-diagram')
    expect(diagram).toBeInTheDocument()
    expect(diagram).toHaveAttribute('role', 'img')
    expect(diagram.innerHTML).toBe(fakeSvg)
  })

  it('shows error state when mermaid.render fails', async () => {
    mockedRender.mockRejectedValue(new Error('Parse error: invalid syntax'))

    render(<MermaidDiagram code="invalid mermaid" />)

    const errorEl = await screen.findByTestId('mermaid-error')
    expect(errorEl).toBeInTheDocument()
    expect(errorEl).toHaveAttribute('role', 'alert')
    expect(errorEl.textContent).toContain('Parse error: invalid syntax')
    // Raw code should be shown as fallback
    expect(errorEl.querySelector('code')?.textContent).toBe('invalid mermaid')
  })

  it('shows error state with non-Error rejection', async () => {
    mockedRender.mockRejectedValue('string error')

    render(<MermaidDiagram code="bad code" />)

    const errorEl = await screen.findByTestId('mermaid-error')
    expect(errorEl).toBeInTheDocument()
    expect(errorEl.textContent).toContain('string error')
  })

  it('has no a11y violations when rendering SVG', async () => {
    const fakeSvg = '<svg><text>Diagram</text></svg>'
    mockedRender.mockResolvedValue({
      svg: fakeSvg,
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    const { container } = render(<MermaidDiagram code="graph TD; A-->B;" />)

    await screen.findByTestId('mermaid-diagram')

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when showing error', async () => {
    mockedRender.mockRejectedValue(new Error('fail'))

    const { container } = render(<MermaidDiagram code="bad" />)

    await screen.findByTestId('mermaid-error')

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // UX-226: horizontal ScrollArea replaces bare overflow-x-auto on both
  //          the success diagram wrapper and the error-state `<pre>`.
  it('wraps the rendered diagram in a horizontal ScrollArea (UX-226)', async () => {
    const fakeSvg = '<svg><text>X</text></svg>'
    mockedRender.mockResolvedValue({
      svg: fakeSvg,
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    const { container } = render(<MermaidDiagram code="graph TD;" />)

    await screen.findByTestId('mermaid-diagram')

    // The scroll viewport is a direct ancestor of the diagram div.
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).toBeInTheDocument()
    const diagram = screen.getByTestId('mermaid-diagram')
    expect(viewport).toContainElement(diagram)

    // No bare overflow-x-auto anywhere.
    const anyOverflowX = container.querySelector('.overflow-x-auto')
    expect(anyOverflowX).toBeNull()
  })

  it('wraps the error-state code block in a horizontal ScrollArea (UX-226)', async () => {
    mockedRender.mockRejectedValue(new Error('bad syntax'))

    const { container } = render(<MermaidDiagram code="garbage" />)

    await screen.findByTestId('mermaid-error')

    // The `<pre><code>garbage</code></pre>` lives inside a ScrollArea viewport.
    const viewports = container.querySelectorAll('[data-slot="scroll-area-viewport"]')
    expect(viewports.length).toBeGreaterThan(0)
    const code = container.querySelector('code')
    expect(code).toBeInTheDocument()
    expect(code?.textContent).toBe('garbage')
    // The `code` is inside at least one ScrollArea viewport.
    const codeInsideAnyViewport = Array.from(viewports).some((vp) => vp.contains(code as Node))
    expect(codeInsideAnyViewport).toBe(true)

    // No bare overflow-x-auto anywhere.
    const anyOverflowX = container.querySelector('.overflow-x-auto')
    expect(anyOverflowX).toBeNull()
  })
})
