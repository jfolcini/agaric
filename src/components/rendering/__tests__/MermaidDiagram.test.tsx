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
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { __resetThemeStoreForTests, useTheme } from '@/hooks/useTheme'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}))

// happy-dom has no 2D canvas; the token resolver itself is covered in
// mermaid-theme.test.ts, so here it is stubbed to either outcome.
vi.mock('@/components/rendering/mermaid-theme', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rendering/mermaid-theme')>()),
  readDiagramColors: vi.fn(() => null),
}))

const mermaid = (await import('mermaid')).default
const { readDiagramColors } = await import('@/components/rendering/mermaid-theme')
const mockedRender = vi.mocked(mermaid.render)
const mockedInitialize = vi.mocked(mermaid.initialize)

// Import after mocks are set up
const { MermaidDiagram } = await import('@/components/rendering/MermaidDiagram')

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

  // #5638 — the diagram is painted from the theme's tokens, so a switch that
  // keeps `isDark` (dark → dracula) must re-render too.
  it('re-renders on a theme change that keeps the same light/dark side (#5638)', async () => {
    mockedRender.mockResolvedValue({
      svg: '<svg><text>X</text></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })
    const { result } = renderHook(() => useTheme())
    act(() => {
      result.current.setTheme('dark')
    })
    render(<MermaidDiagram code="graph TD; A-->B;" />)
    await screen.findByTestId('mermaid-diagram')
    const rendersBefore = mockedRender.mock.calls.length

    act(() => {
      result.current.setTheme('dracula')
    })

    await waitFor(() => {
      expect(mockedRender.mock.calls.length).toBe(rendersBefore + 1)
    })
    await screen.findByTestId('mermaid-diagram')
    expect(mockedRender.mock.calls.length).toBe(rendersBefore + 1)
  })

  it('uses the base theme with token colours when the tokens resolve (#5638)', async () => {
    vi.mocked(readDiagramColors).mockReturnValueOnce({
      background: '#101010',
      fill: '#202020',
      text: '#f0f0f0',
      line: '#a0a0a0',
      grid: '#303030',
      note: '#404030',
      noteLine: '#e0e0a0',
      active: '#203040',
      activeLine: '#a0c0f0',
      done: '#204030',
      doneLine: '#a0f0c0',
      crit: '#402020',
      critLine: '#f0a0a0',
    })
    mockedRender.mockResolvedValue({
      svg: '<svg><text>X</text></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })

    render(<MermaidDiagram code="graph TD; A-->B;" />)
    await screen.findByTestId('mermaid-diagram')

    expect(mockedInitialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'base',
        securityLevel: 'strict',
        themeVariables: expect.objectContaining({
          primaryColor: '#202020',
          primaryTextColor: '#f0f0f0',
          lineColor: '#a0a0a0',
        }),
        themeCSS: expect.stringContaining('.labelBkg'),
      }),
    )
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

  // #5638 — Expand opens the full-screen viewer with the diagram at its
  // natural size: the inline width:100%/max-width sizing is replaced by the
  // viewBox size.
  it('opens the viewer from Expand with the diagram at natural size (#5638)', async () => {
    mockedRender.mockResolvedValue({
      svg: '<svg id="mermaid-x" width="100%" style="max-width: 300px;" viewBox="0 0 300 100"><text>X</text></svg>',
      diagramType: 'flowchart',
      bindFunctions: vi.fn(),
    })
    const user = userEvent.setup()
    render(<MermaidDiagram code="graph TD; A-->B;" />)
    await screen.findByTestId('mermaid-diagram')

    await user.click(screen.getByRole('button', { name: 'Expand' }))

    const dialog = screen.getByRole('dialog')
    const svg = dialog.querySelector('svg')
    expect(svg).toHaveAttribute('width', '300')
    expect(svg).toHaveAttribute('height', '100')
    expect(svg?.getAttribute('style') ?? '').not.toContain('max-width')
    expect(screen.getByRole('button', { name: 'Copy source' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download SVG' })).toBeInTheDocument()
    expect(await axe(dialog)).toHaveNoViolations()
  })
})
