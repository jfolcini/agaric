/**
 * Tests for DiagramViewer (#5638): the Expand button and the full-screen view
 * shared by Mermaid diagrams and display math.
 *
 * happy-dom has no layout, so the viewer's screen and content sizes are
 * stubbed to make the fit computable: content twice the screen's width fits at
 * just under 50%.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

const writeText = vi.fn<(text: string) => Promise<void>>()
vi.mock('@/lib/clipboard', () => ({ writeText: (text: string) => writeText(text) }))
const downloadBlob = vi.fn<(blob: Blob, name: string) => void>()
vi.mock('@/lib/export-graph', () => ({
  downloadBlob: (blob: Blob, name: string) => downloadBlob(blob, name),
}))
const notifyError = vi.fn()
vi.mock('@/lib/notify', () => ({
  notify: { success: vi.fn(), error: (m: unknown) => notifyError(m) },
}))

const { DiagramViewer } = await import('@/components/rendering/DiagramViewer')

const SCREEN = { width: 1032, height: 832 }
const CONTENT = { width: 2000, height: 400 }

function stubLayout(): void {
  const size = (el: HTMLElement, axis: 'width' | 'height') =>
    el.dataset['testid'] === 'diagram-viewer-surface'
      ? CONTENT[axis]
      : el.firstElementChild?.getAttribute('data-testid') === 'diagram-viewer-surface'
        ? SCREEN[axis]
        : 0
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this, 'width')
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this, 'height')
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this, 'width')
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return size(this, 'height')
  })
}

function renderViewer(onParentClick = vi.fn()) {
  const view = render(
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- stands in for the static block's click-to-edit surface
    <div onClick={onParentClick} className="group/diagram relative">
      <DiagramViewer
        title="Mermaid diagram"
        source="graph LR; A-->B"
        copyLabel="Copy source"
        svg="<svg/>"
      >
        <div>diagram</div>
      </DiagramViewer>
    </div>,
  )
  return { ...view, onParentClick }
}

const expandButton = () => screen.getByRole('button', { name: 'Expand' })
const zoomLabel = () => screen.getByTestId('diagram-viewer-zoom')

describe('DiagramViewer', () => {
  beforeEach(stubLayout)
  afterEach(() => {
    vi.restoreAllMocks()
    writeText.mockReset()
    downloadBlob.mockReset()
    notifyError.mockReset()
  })

  it('renders only the Expand button until opened', () => {
    renderViewer()
    expect(expandButton()).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens fitted without the click reaching the block underneath', async () => {
    const user = userEvent.setup()
    const { onParentClick } = renderViewer()
    await user.click(expandButton())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // (1032 - 32) / 2000 — the content scaled to the screen width.
    expect(zoomLabel()).toHaveTextContent('50%')
    await user.click(screen.getByRole('button', { name: 'Actual size (100%)' }))
    expect(zoomLabel()).toHaveTextContent('100%')
    await user.click(screen.getByRole('button', { name: /^Fit to screen/ }))
    expect(zoomLabel()).toHaveTextContent('50%')
    // A click on the content itself, which has no handler of its own.
    await user.click(screen.getByTestId('diagram-viewer-surface'))
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('copies the source and downloads the SVG', async () => {
    writeText.mockResolvedValue()
    const user = userEvent.setup()
    renderViewer()
    await user.click(expandButton())
    await user.click(screen.getByRole('button', { name: 'Copy source' }))
    expect(writeText).toHaveBeenCalledWith('graph LR; A-->B')
    await user.click(screen.getByRole('button', { name: 'Download SVG' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    const [blob, name] = downloadBlob.mock.calls[0] ?? []
    expect(name).toBe('diagram.svg')
    expect(blob?.type).toBe('image/svg+xml')
    expect(await blob?.text()).toBe('<svg/>')
  })

  it('reports a failed copy instead of failing silently', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const user = userEvent.setup()
    renderViewer()
    await user.click(expandButton())
    await user.click(screen.getByRole('button', { name: 'Copy source' }))
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith("Couldn't copy to the clipboard"))
  })

  it('closes on Escape and returns focus to Expand', async () => {
    const user = userEvent.setup()
    renderViewer()
    await user.click(expandButton())
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(expandButton()).toHaveFocus()
  })

  it('has no a11y violations closed or open', async () => {
    const user = userEvent.setup()
    const { container } = renderViewer()
    expect(await axe(container)).toHaveNoViolations()
    await user.click(expandButton())
    expect(await axe(screen.getByRole('dialog'))).toHaveNoViolations()
  })
})
