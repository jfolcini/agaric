/**
 * Tests for DataSettingsTab component (UX-144).
 *
 * Validates:
 *  - Renders import and export sections
 *  - Import button triggers file input click
 *  - File selection calls importMarkdown
 *  - Shows import result after success
 *  - Export button calls exportGraphAsZip
 *  - Export filename embeds the sanitized active space name (UX-385)
 *  - Shows error toast on export failure
 *  - Has no a11y violations (axe)
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { SpaceRow } from '../../lib/tauri'
import { useSpaceStore } from '../../stores/space'
import { DataSettingsTab } from '../DataSettingsTab'

const mockExportGraphAsZip = vi.fn()
const mockDownloadBlob = vi.fn()

vi.mock('../../lib/export-graph', () => ({
  exportGraphAsZip: (...args: unknown[]) => mockExportGraphAsZip(...args),
  downloadBlob: (...args: unknown[]) => mockDownloadBlob(...args),
}))

const mockImportMarkdown = vi.fn()

vi.mock('../../lib/tauri', () => ({
  importMarkdown: (...args: unknown[]) => mockImportMarkdown(...args),
}))

import { toast } from 'sonner'

// PEND-35 Tier 1.1 — `import_markdown` now requires `space_id`. Seed a
// default active space in `beforeEach` so the existing tests exercise
// the happy path; per-test overrides (UX-385 filename test, the new
// "disabled when no space" test below) override this fixture.
const DEFAULT_TEST_SPACE: SpaceRow = {
  id: 'SPACE_DEFAULT',
  name: 'Personal',
  accent_color: 'accent-blue',
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({
    currentSpaceId: DEFAULT_TEST_SPACE.id,
    availableSpaces: [DEFAULT_TEST_SPACE],
    isReady: true,
  })
})

describe('DataSettingsTab', () => {
  it('renders import and export sections', () => {
    render(<DataSettingsTab />)

    expect(screen.getByText('Import')).toBeInTheDocument()
    expect(screen.getByText('Export All Pages')).toBeInTheDocument()
    expect(screen.getByText('Choose Files')).toBeInTheDocument()
    expect(screen.getByText('Export All')).toBeInTheDocument()
  })

  it('import button triggers file input click', async () => {
    const user = userEvent.setup()
    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const clickSpy = vi.spyOn(fileInput, 'click')

    const importBtn = screen.getByRole('button', { name: /Choose Files/i })
    await user.click(importBtn)

    expect(clickSpy).toHaveBeenCalled()
  })

  it('file selection calls importMarkdown with the active spaceId (PEND-35)', async () => {
    const importResult = {
      page_title: 'Test Page',
      blocks_created: 5,
      properties_set: 2,
      warnings: [],
    }
    mockImportMarkdown.mockResolvedValueOnce(importResult)

    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // PEND-35 Tier 1.1 — `importMarkdown` takes `(content, filename,
    // spaceId, onProgress?)`. Assert the active space's ULID flows
    // through so the backend can stamp `space = ?spaceId` on the imported
    // page. #128 added the 4th `onProgress` callback arg — assert it is a
    // function so the per-block progress channel is always wired up.
    await waitFor(() => {
      expect(mockImportMarkdown).toHaveBeenCalledWith(
        '# Hello',
        'test.md',
        DEFAULT_TEST_SPACE.id,
        expect.any(Function),
      )
    })
  })

  it('disables the import button when no active space is selected (PEND-35)', () => {
    // PEND-35 Tier 1.1 — `import_markdown` rejects empty / unknown
    // ULIDs. Pre-bootstrap (no active space) the button must stay
    // disabled rather than firing a doomed IPC. Explicitly clear the
    // beforeEach seed for this test only.
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })

    render(<DataSettingsTab />)

    const importBtn = screen.getByRole('button', { name: /Choose Files/i })
    expect(importBtn).toBeDisabled()
  })

  it('surfaces a visible + screen-reader-announced reason when import is gated (PEND-35)', () => {
    // PEND-35 Tier 1.1 — A disabled button with only a `title`
    // attribute is invisible on touch (`pointer:coarse`) and on
    // browsers that suppress tooltips for `disabled` controls
    // (Chromium drops the hover synth because the Button has
    // `disabled:pointer-events-none`). The visible inline hint plus
    // `aria-describedby` on the button covers desktop, mobile, and AT.
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })

    render(<DataSettingsTab />)

    const hint = screen.getByTestId('import-space-not-ready-hint')
    expect(hint).toHaveTextContent('Select a space before importing.')
    // Polite live-region so the announcement does not interrupt other
    // status messages (e.g. import progress in the same panel).
    expect(hint).toHaveAttribute('aria-live', 'polite')

    // The disabled button references the hint via `aria-describedby`,
    // so a screen reader reading the focused button also hears the
    // reason. This is the contract — without it the button is just
    // "Choose Files, dimmed" with no explanation.
    const importBtn = screen.getByRole('button', { name: /Choose Files/i })
    expect(importBtn).toHaveAttribute('aria-describedby', hint.id)
  })

  it('hides the import-not-ready hint once a space becomes active (PEND-35)', () => {
    // Sanity check: when the SpaceStore eventually hydrates, the hint
    // disappears and `aria-describedby` is dropped — otherwise screen
    // readers would announce a stale "Select a space…" forever.
    render(<DataSettingsTab />)

    expect(screen.queryByTestId('import-space-not-ready-hint')).not.toBeInTheDocument()
    const importBtn = screen.getByRole('button', { name: /Choose Files/i })
    expect(importBtn).not.toBeDisabled()
    expect(importBtn).not.toHaveAttribute('aria-describedby')
  })

  it('shows import result after success', async () => {
    const importResult = {
      page_title: 'Test Page',
      blocks_created: 5,
      properties_set: 2,
      warnings: [],
    }
    mockImportMarkdown.mockResolvedValueOnce(importResult)

    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(screen.getByText(/5 blocks/)).toBeInTheDocument()
      expect(screen.getByText(/2 properties/)).toBeInTheDocument()
    })
  })

  it('renders streamed per-block progress from the import channel (#128)', async () => {
    // #128 (PEND-38 / PEND-06 Tier 3) — the 4th `onProgress` arg receives
    // `started` → `progress` → `complete` events over a Channel. Drive
    // them through the mock and assert the intra-file block bar + label
    // reflect the stream while the import is in flight.
    let resolveImport: (r: unknown) => void = () => {}
    mockImportMarkdown.mockImplementationOnce(
      (
        _content: string,
        _filename: string,
        _spaceId: string,
        onProgress?: (u: {
          kind: string
          blocks_total?: number
          blocks_done?: number
          blocks_created?: number
          properties_set?: number
          page_title?: string
        }) => void,
      ) => {
        // Emit a started + two progress ticks synchronously so the UI
        // updates mid-import, then hold the promise open so the
        // in-flight progress UI stays mounted for the assertions.
        onProgress?.({ kind: 'started', page_title: 'Big', blocks_total: 3 })
        onProgress?.({ kind: 'progress', blocks_done: 1, blocks_total: 3 })
        onProgress?.({ kind: 'progress', blocks_done: 2, blocks_total: 3 })
        return new Promise((resolve) => {
          resolveImport = resolve
        })
      },
    )

    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['- a\n- b\n- c'], 'big.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The streamed `progress` events drive a determinate block bar.
    await waitFor(() => {
      const label = screen.getByTestId('import-block-progress')
      expect(label).toHaveTextContent('Block 2 of 3')
    })
    const bar = screen.getByTestId('import-block-progress-bar') as HTMLProgressElement
    expect(bar.value).toBe(2)
    expect(bar.max).toBe(3)

    // Resolve the import so the loop completes and unmounts the progress UI.
    await act(async () => {
      resolveImport({
        page_title: 'Big',
        blocks_created: 3,
        properties_set: 0,
        warnings: [],
      })
    })

    await waitFor(() => {
      expect(screen.queryByTestId('import-block-progress')).not.toBeInTheDocument()
    })
  })

  it('export button calls exportGraphAsZip', async () => {
    const user = userEvent.setup()
    const mockBlob = new Blob(['zip'], { type: 'application/zip' })
    mockExportGraphAsZip.mockResolvedValueOnce(mockBlob)

    render(<DataSettingsTab />)

    const exportBtn = screen.getByRole('button', { name: /Export All/i })
    await user.click(exportBtn)

    await waitFor(() => {
      expect(mockExportGraphAsZip).toHaveBeenCalled()
      expect(mockDownloadBlob).toHaveBeenCalledWith(
        mockBlob,
        expect.stringMatching(/agaric-export-.+\.zip/),
      )
      expect(toast.success).toHaveBeenCalledWith('Export complete')
    })
  })

  it('export filename includes the sanitized active space name (UX-385)', async () => {
    const user = userEvent.setup()
    const mockBlob = new Blob(['zip'], { type: 'application/zip' })
    mockExportGraphAsZip.mockResolvedValueOnce(mockBlob)

    const STAR_SPACE: SpaceRow = {
      id: 'SPACE_STAR',
      name: '🌟 My Project',
      accent_color: 'accent-emerald',
    }
    useSpaceStore.setState({
      currentSpaceId: STAR_SPACE.id,
      availableSpaces: [STAR_SPACE],
      isReady: true,
    })

    render(<DataSettingsTab />)

    const exportBtn = screen.getByRole('button', { name: /Export All/i })
    await user.click(exportBtn)

    await waitFor(() => {
      expect(mockDownloadBlob).toHaveBeenCalledWith(
        mockBlob,
        // Sanitized: lowercased, non-alphanumeric runs collapsed to `-`,
        // leading/trailing dashes trimmed. So "🌟 My Project" becomes
        // "my-project" in the filename.
        expect.stringMatching(/^agaric-export-my-project-\d{4}-\d{2}-\d{2}\.zip$/),
      )
    })
  })

  it('shows error toast on export failure', async () => {
    const user = userEvent.setup()
    mockExportGraphAsZip.mockRejectedValueOnce(new Error('export error'))

    render(<DataSettingsTab />)

    const exportBtn = screen.getByRole('button', { name: /Export All/i })
    await user.click(exportBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Export failed')
    })
  })

  it('shows per-file progress text during multi-file import (UX-283)', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    let resolveSecond: (v: unknown) => void = () => {}
    mockImportMarkdown
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r
          }),
      )

    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['# A'], 'one.md', { type: 'text/markdown' })
    const file2 = new File(['# B'], 'two.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(screen.getByText('Importing file 1 of 2: one.md')).toBeInTheDocument()
    })

    await act(async () => {
      resolveFirst({ page_title: 'one', blocks_created: 1, properties_set: 0, warnings: [] })
    })

    await waitFor(() => {
      expect(screen.getByText('Importing file 2 of 2: two.md')).toBeInTheDocument()
    })

    await act(async () => {
      resolveSecond({ page_title: 'two', blocks_created: 1, properties_set: 0, warnings: [] })
    })

    await waitFor(() => {
      expect(screen.queryByText(/Importing file/)).not.toBeInTheDocument()
    })
  })

  it('shows cumulative blocks + bytes secondary line after first file completes (UX-384)', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    let resolveSecond: (v: unknown) => void = () => {}
    mockImportMarkdown
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r
          }),
      )

    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    // 2048-byte payload so formatBytes promotes to "2.0 KB" and the
    // assertion below isn't sensitive to platform-specific quirks of
    // a sub-1KB byte count rendering.
    const file1 = new File(['x'.repeat(2048)], 'one.md', { type: 'text/markdown' })
    const file2 = new File(['# B'], 'two.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Before any file has finished, the secondary line is hidden — we
    // don't want to show "0 blocks · 0 B" while the first IPC is in
    // flight.
    expect(screen.queryByTestId('import-progress-detail')).not.toBeInTheDocument()

    await act(async () => {
      resolveFirst({ page_title: 'one', blocks_created: 7, properties_set: 0, warnings: [] })
    })

    // After file 1 resolves, the secondary line appears with
    // cumulative blocks (7) and bytes (2048 = 2.0 KB).
    await waitFor(() => {
      const detail = screen.getByTestId('import-progress-detail')
      expect(detail).toHaveTextContent('7 blocks')
      expect(detail).toHaveTextContent('2.0 KB')
    })

    await act(async () => {
      resolveSecond({ page_title: 'two', blocks_created: 3, properties_set: 0, warnings: [] })
    })

    // Once the import finishes, the secondary line disappears along
    // with the rest of the progress UI.
    await waitFor(() => {
      expect(screen.queryByTestId('import-progress-detail')).not.toBeInTheDocument()
    })
  })

  it('hides secondary progress line when no blocks/bytes are reported yet (UX-384)', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    mockImportMarkdown.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r
        }),
    )

    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['# A'], 'one.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Primary "Importing file 1 of 1" line is visible while the IPC is
    // pending, but the secondary detail line stays hidden until at
    // least one file has resolved.
    await waitFor(() => {
      expect(screen.getByTestId('import-progress')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('import-progress-detail')).not.toBeInTheDocument()

    await act(async () => {
      resolveFirst({ page_title: 'one', blocks_created: 1, properties_set: 0, warnings: [] })
    })
  })

  it('renders a <progress> bar alongside the text during multi-file import (UX-12)', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    let resolveSecond: (v: unknown) => void = () => {}
    mockImportMarkdown
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r
          }),
      )

    render(<DataSettingsTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['# A'], 'one.md', { type: 'text/markdown' })
    const file2 = new File(['# B'], 'two.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Progress bar tracks the current file index against the total.
    const progressBar = (await screen.findByTestId('import-progress-bar')) as HTMLProgressElement
    expect(progressBar.tagName).toBe('PROGRESS')
    expect(progressBar.value).toBe(1)
    expect(progressBar.max).toBe(2)

    await act(async () => {
      resolveFirst({ page_title: 'one', blocks_created: 1, properties_set: 0, warnings: [] })
    })

    await waitFor(() => {
      const updated = screen.getByTestId('import-progress-bar') as HTMLProgressElement
      expect(updated.value).toBe(2)
    })

    await act(async () => {
      resolveSecond({ page_title: 'two', blocks_created: 1, properties_set: 0, warnings: [] })
    })

    // Once the import finishes, the progress bar disappears.
    await waitFor(() => {
      expect(screen.queryByTestId('import-progress-bar')).not.toBeInTheDocument()
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(<DataSettingsTab />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
