/**
 * Tests for MermaidDiagram component.
 *
 * Validates:
 *  - Renders SVG output when mermaid.render succeeds
 *  - Shows error state when mermaid.render fails
 *  - Shows loading state initially
 *  - a11y compliance
 */

import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { __resetThemeStoreForTests, useTheme } from '@/hooks/useTheme'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}))

const mermaid = (await import('mermaid')).default
const mockedRender = vi.mocked(mermaid.render)
const mockedInitialize = vi.mocked(mermaid.initialize)

// Import after mocks are set up
const { MermaidDiagram } = await import('../MermaidDiagram')

describe('MermaidDiagram', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetThemeStoreForTests()
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    localStorage.clear()
    __resetThemeStoreForTests()
    document.documentElement.classList.remove('dark')
  })

  // #758 item 1: mermaid.initialize used to run once at module load, freezing
  // the theme to whatever the theme was at startup. It now runs inside the
  // render effect so each render picks up the current theme.
  it('initializes mermaid with the current theme from the theme store (#758 item 1)', async () => {
    mockedRender.mockResolvedValue({
      svg: '<svg><text>X</text></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    // Drive the canonical theme source (the module-level preference store)
    // into dark BEFORE mounting the diagram.
    const { result } = renderHook(() => useTheme())
    act(() => {
      result.current.setTheme('dark')
    })

    render(<MermaidDiagram code="graph TD; A-->B;" />)
    await screen.findByTestId('mermaid-diagram')

    expect(mockedInitialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', securityLevel: 'strict', startOnLoad: false }),
    )
  })

  // #2259: a rendered diagram must re-render with the new theme on a light/dark
  // toggle even when the source `code` is unchanged. Previously the render
  // effect depended only on [code, renderId], so a toggle left the SVG frozen
  // to its old theme. The effect now also depends on the theme store's `isDark`.
  it('re-renders with the new theme when the app theme is toggled (#2259)', async () => {
    mockedRender.mockResolvedValue({
      svg: '<svg><text>X</text></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    // Start in light (default). Diagram renders with the 'default' theme.
    render(<MermaidDiagram code="graph TD; A-->B;" />)
    await screen.findByTestId('mermaid-diagram')

    expect(mockedInitialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'default', securityLevel: 'strict' }),
    )
    const rendersBeforeToggle = mockedRender.mock.calls.length

    // Toggle to dark via the SAME mechanism the app uses (the theme store) —
    // no change to the diagram source.
    const { result } = renderHook(() => useTheme())
    act(() => {
      result.current.setTheme('dark')
    })

    // The diagram must re-initialize with the new theme and re-render.
    await waitFor(() => {
      expect(mockedInitialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: 'dark', securityLevel: 'strict' }),
      )
    })
    expect(mockedRender.mock.calls.length).toBeGreaterThan(rendersBeforeToggle)

    // Toggle back to light — re-renders again with the light theme.
    const rendersAfterDark = mockedRender.mock.calls.length
    act(() => {
      result.current.setTheme('light')
    })
    await waitFor(() => {
      expect(mockedInitialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: 'default', securityLevel: 'strict' }),
      )
    })
    expect(mockedRender.mock.calls.length).toBeGreaterThan(rendersAfterDark)
  })

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

  // Horizontal ScrollArea replaces bare overflow-x-auto on both
  //          the success diagram wrapper and the error-state `<pre>`.
  it('wraps the rendered diagram in a horizontal ScrollArea', async () => {
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

  it('wraps the error-state code block in a horizontal ScrollArea', async () => {
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
