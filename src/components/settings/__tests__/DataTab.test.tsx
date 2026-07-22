/**
 * Tests for DataTab component.
 *
 * Validates:
 *  - Renders import and export sections
 *  - Import button triggers file input click
 *  - File selection calls importMarkdown
 *  - Shows import result after success
 *  - Export button calls exportGraphAsZip
 * Export filename embeds the sanitized active space name
 *  - Shows error toast on export failure
 *  - Has no a11y violations (axe)
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { DataTab } from '@/components/settings/DataTab'
import type { SpaceRow } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

const mockExportGraphAsZip = vi.fn()
const mockExportAllSpacesAsZip = vi.fn()
const mockDownloadBlob = vi.fn()

vi.mock('@/lib/export-graph', () => ({
  exportGraphAsZip: (...args: unknown[]) => mockExportGraphAsZip(...args),
  exportAllSpacesAsZip: (...args: unknown[]) => mockExportAllSpacesAsZip(...args),
  downloadBlob: (...args: unknown[]) => mockDownloadBlob(...args),
}))

const mockImportMarkdown = vi.fn()
const mockImportBibliography = vi.fn()
// #1927 — post-import navigation resolves the imported page's title to an
// id via `resolvePageByAlias`, then calls `useTabsStore.navigateToPage`.
const mockResolvePageByAlias = vi.fn()

vi.mock('@/lib/tauri', () => ({
  importMarkdown: (...args: unknown[]) => mockImportMarkdown(...args),
  importBibliography: (...args: unknown[]) => mockImportBibliography(...args),
  resolvePageByAlias: (...args: unknown[]) => mockResolvePageByAlias(...args),
}))

// #1927 — mock the tabs store so we can assert post-import navigation
// without standing up the full multi-store navigation chain.
const mockNavigateToPage = vi.fn()
vi.mock('@/stores/tabs', () => ({
  useTabsStore: (selector: (s: { navigateToPage: typeof mockNavigateToPage }) => unknown) =>
    selector({ navigateToPage: mockNavigateToPage }),
}))

// #1935 — assert the per-file failure is logged at ERROR with a
// filename-distinct message (so the rate-limiter doesn't suppress repeats).
const mockLoggerError = vi.fn()
const mockLoggerWarn = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}))

import { toast } from 'sonner'

// `import_markdown` now requires `space_id`. Seed a
// default active space in `beforeEach` so the existing tests exercise
// The happy path; per-test overrides (filename test, the new
// "disabled when no space" test below) override this fixture.
const DEFAULT_TEST_SPACE: SpaceRow = {
  id: 'SPACE_DEFAULT',
  name: 'Personal',
  accent_color: 'accent-blue',
}

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` wipes call history but NOT queued `mockImplementationOnce`
  // / `mockResolvedValueOnce` impls. A test that leaves an unconsumed `once`
  // (e.g. the cancel test, whose 2nd file is never reached) would bleed it
  // into the next test — reset the implementation queue explicitly.
  mockImportMarkdown.mockReset()
  mockImportBibliography.mockReset()
  mockResolvePageByAlias.mockReset()
  useSpaceStore.setState({
    currentSpaceId: DEFAULT_TEST_SPACE.id,
    availableSpaces: [DEFAULT_TEST_SPACE],
    isReady: true,
  })
})

describe('DataTab', () => {
  it('renders import and export sections', () => {
    render(<DataTab />)

    expect(screen.getByText('Import')).toBeInTheDocument()
    expect(screen.getByText('Export All Pages')).toBeInTheDocument()
    expect(screen.getByText('Choose Files')).toBeInTheDocument()
    expect(screen.getByText('Export All')).toBeInTheDocument()
  })

  it('import button triggers file input click', async () => {
    const user = userEvent.setup()
    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const clickSpy = vi.spyOn(fileInput, 'click')

    const importBtn = screen.getByRole('button', { name: /Choose Files/i })
    await user.click(importBtn)

    expect(clickSpy).toHaveBeenCalled()
  })

  it('file selection calls importMarkdown with the active spaceId', async () => {
    const importResult = {
      page_title: 'Test Page',
      blocks_created: 5,
      properties_set: 2,
      warnings: [],
    }
    mockImportMarkdown.mockResolvedValueOnce(importResult)

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // `importMarkdown` takes `(content, filename,
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
        // #1925 — a single-file (non-folder) import has no sibling assets, so
        // `vaultFiles` is null (documented limitation; only the folder picker
        // exposes siblings).
        null,
      )
    })
  })

  it('disables the import button when no active space is selected', () => {
    // `import_markdown` rejects empty / unknown
    // ULIDs. Pre-bootstrap (no active space) the button must stay
    // disabled rather than firing a doomed IPC. Explicitly clear the
    // beforeEach seed for this test only.
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })

    render(<DataTab />)

    const importBtn = screen.getByRole('button', { name: /Choose Files/i })
    expect(importBtn).toBeDisabled()
  })

  it('surfaces a visible + screen-reader-announced reason when import is gated', () => {
    // A disabled button with only a `title`
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

    render(<DataTab />)

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

  it('hides the import-not-ready hint once a space becomes active', () => {
    // Sanity check: when the SpaceStore eventually hydrates, the hint
    // disappears and `aria-describedby` is dropped — otherwise screen
    // readers would announce a stale "Select a space…" forever.
    render(<DataTab />)

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

    render(<DataTab />)

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
    // #128 — the 4th `onProgress` arg receives
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

    render(<DataTab />)

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
    mockExportGraphAsZip.mockResolvedValueOnce({
      blob: mockBlob,
      exportedPages: 1,
      skippedPages: 0,
      skippedAttachments: 0,
    })

    render(<DataTab />)

    // Exact string match (not `/Export All/i`, #2964) — the new
    // "Export All Spaces" button's accessible name contains "Export All" as
    // a substring, which a substring-matching regex would ambiguously match
    // too. An exact-name match still targets this single-space button only.
    const exportBtn = screen.getByRole('button', { name: 'Export All' })
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

  it('export filename includes the sanitized active space name', async () => {
    const user = userEvent.setup()
    const mockBlob = new Blob(['zip'], { type: 'application/zip' })
    mockExportGraphAsZip.mockResolvedValueOnce({
      blob: mockBlob,
      exportedPages: 1,
      skippedPages: 0,
      skippedAttachments: 0,
    })

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

    render(<DataTab />)

    // Exact string match (not `/Export All/i`, #2964) — the new
    // "Export All Spaces" button's accessible name contains "Export All" as
    // a substring, which a substring-matching regex would ambiguously match
    // too. An exact-name match still targets this single-space button only.
    const exportBtn = screen.getByRole('button', { name: 'Export All' })
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

    render(<DataTab />)

    // Exact string match (not `/Export All/i`, #2964) — the new
    // "Export All Spaces" button's accessible name contains "Export All" as
    // a substring, which a substring-matching regex would ambiguously match
    // too. An exact-name match still targets this single-space button only.
    const exportBtn = screen.getByRole('button', { name: 'Export All' })
    await user.click(exportBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Export failed')
    })
  })

  // #2965 — `exportGraphAsZip` no longer silently reports success when it
  // dropped pages/attachments: the caller must surface a warning toast (still
  // downloading the ZIP, which carries its own `export-report.txt`) instead
  // of the plain success toast.
  it('shows a warning toast (not the plain success toast) when pages/attachments were skipped (#2965)', async () => {
    const user = userEvent.setup()
    const mockBlob = new Blob(['zip'], { type: 'application/zip' })
    mockExportGraphAsZip.mockResolvedValueOnce({
      blob: mockBlob,
      exportedPages: 2,
      skippedPages: 2,
      skippedAttachments: 1,
    })

    render(<DataTab />)

    // Exact string match (not `/Export All/i`, #2964) — the new
    // "Export All Spaces" button's accessible name contains "Export All" as
    // a substring, which a substring-matching regex would ambiguously match
    // too. An exact-name match still targets this single-space button only.
    const exportBtn = screen.getByRole('button', { name: 'Export All' })
    await user.click(exportBtn)

    await waitFor(() => {
      // Still downloads the (partial) ZIP.
      expect(mockDownloadBlob).toHaveBeenCalledWith(
        mockBlob,
        expect.stringMatching(/agaric-export-.+\.zip/),
      )
      expect(toast.warning).toHaveBeenCalledWith(
        'Export finished with some items skipped: 2 pages skipped; 1 attachment skipped',
      )
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  // #2965 — the zero-skipped (happy) path must be unchanged: plain success
  // toast, no warning.
  it('shows the plain success toast and no warning when nothing was skipped (#2965)', async () => {
    const user = userEvent.setup()
    const mockBlob = new Blob(['zip'], { type: 'application/zip' })
    mockExportGraphAsZip.mockResolvedValueOnce({
      blob: mockBlob,
      exportedPages: 3,
      skippedPages: 0,
      skippedAttachments: 0,
    })

    render(<DataTab />)

    // Exact string match (not `/Export All/i`, #2964) — the new
    // "Export All Spaces" button's accessible name contains "Export All" as
    // a substring, which a substring-matching regex would ambiguously match
    // too. An exact-name match still targets this single-space button only.
    const exportBtn = screen.getByRole('button', { name: 'Export All' })
    await user.click(exportBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Export complete')
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  // #2964 — whole-vault "Export all spaces" action, a sibling of the
  // single active-space "Export All" button above (which
  // `exportAllSpacesAsZip` never touches, and vice versa).
  describe('export all spaces (#2964)', () => {
    it('the new button triggers exportAllSpacesAsZip and downloads the ZIP, leaving the single-space button untouched', async () => {
      const user = userEvent.setup()
      const mockBlob = new Blob(['zip'], { type: 'application/zip' })
      mockExportAllSpacesAsZip.mockResolvedValueOnce({
        blob: mockBlob,
        spaceCount: 2,
        exportedPages: 5,
        skippedPages: 0,
        skippedAttachments: 0,
      })

      render(<DataTab />)

      const exportAllSpacesBtn = screen.getByRole('button', { name: 'Export All Spaces' })
      await user.click(exportAllSpacesBtn)

      await waitFor(() => {
        expect(mockExportAllSpacesAsZip).toHaveBeenCalled()
        expect(mockDownloadBlob).toHaveBeenCalledWith(
          mockBlob,
          expect.stringMatching(/agaric-export-all-spaces-\d{4}-\d{2}-\d{2}\.zip/),
        )
        expect(toast.success).toHaveBeenCalledWith('Exported 2 spaces')
      })
      // The single-space exporter is a fully separate action — clicking the
      // all-spaces button must never invoke it.
      expect(mockExportGraphAsZip).not.toHaveBeenCalled()
    })

    it('the old single-space "Export All" button still triggers exportGraphAsZip only', async () => {
      const user = userEvent.setup()
      const mockBlob = new Blob(['zip'], { type: 'application/zip' })
      mockExportGraphAsZip.mockResolvedValueOnce({
        blob: mockBlob,
        exportedPages: 1,
        skippedPages: 0,
        skippedAttachments: 0,
      })

      render(<DataTab />)

      const exportBtn = screen.getByRole('button', { name: 'Export All' })
      await user.click(exportBtn)

      await waitFor(() => {
        expect(mockExportGraphAsZip).toHaveBeenCalled()
      })
      expect(mockExportAllSpacesAsZip).not.toHaveBeenCalled()
    })

    it('shows a distinct "no spaces" warning and does not download when the vault has zero spaces', async () => {
      const user = userEvent.setup()
      mockExportAllSpacesAsZip.mockResolvedValueOnce({
        blob: new Blob(['zip'], { type: 'application/zip' }),
        spaceCount: 0,
        exportedPages: 0,
        skippedPages: 0,
        skippedAttachments: 0,
      })

      render(<DataTab />)

      const exportAllSpacesBtn = screen.getByRole('button', { name: 'Export All Spaces' })
      await user.click(exportAllSpacesBtn)

      await waitFor(() => {
        expect(toast.warning).toHaveBeenCalledWith('No spaces to export')
      })
      expect(mockDownloadBlob).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      // Regression guard: the zero-spaces branch must re-enable the button
      // (not strand it disabled/loading forever) — a prior version of this
      // handler `return`ed from inside the `try` before its trailing
      // `setExportingAllSpaces(false)`, which is not in a `finally`.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Export All Spaces' })).not.toBeDisabled()
      })
    })

    it('shows a warning toast (not plain success) when the all-spaces export skipped items', async () => {
      const user = userEvent.setup()
      const mockBlob = new Blob(['zip'], { type: 'application/zip' })
      mockExportAllSpacesAsZip.mockResolvedValueOnce({
        blob: mockBlob,
        spaceCount: 2,
        exportedPages: 3,
        skippedPages: 1,
        skippedAttachments: 2,
      })

      render(<DataTab />)

      const exportAllSpacesBtn = screen.getByRole('button', { name: 'Export All Spaces' })
      await user.click(exportAllSpacesBtn)

      await waitFor(() => {
        expect(mockDownloadBlob).toHaveBeenCalledWith(mockBlob, expect.any(String))
        expect(toast.warning).toHaveBeenCalledWith(
          'Export finished with some items skipped: 1 page skipped; 2 attachments skipped',
        )
      })
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('shows an error toast on export-all-spaces failure', async () => {
      const user = userEvent.setup()
      mockExportAllSpacesAsZip.mockRejectedValueOnce(new Error('export all failed'))

      render(<DataTab />)

      const exportAllSpacesBtn = screen.getByRole('button', { name: 'Export All Spaces' })
      await user.click(exportAllSpacesBtn)

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Export failed')
      })
      expect(mockDownloadBlob).not.toHaveBeenCalled()
    })

    it('has no a11y violations in the export card with the new button present', async () => {
      const { container } = render(<DataTab />)

      expect(screen.getByRole('button', { name: 'Export All Spaces' })).toBeInTheDocument()

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })

  it('shows per-file progress text during multi-file import', async () => {
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

    render(<DataTab />)

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

  it('shows cumulative blocks + bytes secondary line after first file completes', async () => {
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

    render(<DataTab />)

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

  it('hides secondary progress line when no blocks/bytes are reported yet', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    mockImportMarkdown.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r
        }),
    )

    render(<DataTab />)

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

  it('renders a <progress> bar alongside the text during multi-file import', async () => {
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

    render(<DataTab />)

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
    const { container } = render(<DataTab />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // #1928 — soft parse warnings are surfaced as their actual strings in an
  // expandable list, not just an opaque count.
  it('renders warning strings in an expandable details list (#1928)', async () => {
    mockImportMarkdown.mockResolvedValueOnce({
      page_title: 'Doc',
      blocks_created: 4,
      properties_set: 0,
      warnings: ['Dropped malformed YAML on line 2', 'Unrecognized property "foo"'],
    })

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# Hello'], 'doc.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The collapsible summary shows the warning count…
    await waitFor(() => {
      expect(screen.getByTestId('import-warnings-heading')).toHaveTextContent('2 warnings')
    })
    // …and the actual warning strings are rendered (a <details> renders its
    // contents in the DOM even when collapsed).
    expect(screen.getByText('Dropped malformed YAML on line 2')).toBeInTheDocument()
    expect(screen.getByText('Unrecognized property "foo"')).toBeInTheDocument()
    expect(screen.getByTestId('import-result-details')).toBeInTheDocument()
  })

  // #1928 — when many files fail, only the first N are shown until the user
  // expands the list.
  it('caps the failure list and reveals the rest on "Show all" (#1928)', async () => {
    const user = userEvent.setup()
    // 7 files, all fail → 7 failure rows, capped at 5 until expanded.
    mockImportMarkdown.mockRejectedValue(new Error('boom'))

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const files = Array.from(
      { length: 7 },
      (_, i) => new File(['x'], `f${i}.md`, { type: 'text/markdown' }),
    )
    Object.defineProperty(fileInput, 'files', { value: files })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(screen.getByTestId('import-result-details')).toBeInTheDocument()
    })
    // At rest: only the first 5 failure rows are rendered.
    expect(screen.getAllByTestId('import-failure-item')).toHaveLength(5)

    await user.click(screen.getByTestId('import-details-toggle'))
    expect(screen.getAllByTestId('import-failure-item')).toHaveLength(7)
    // The marker strings are the actual failure messages, not an opaque count.
    // #1935 — each row now appends the failure reason, so match on a
    // substring (`<name>: <reason>`) rather than the reason-less string.
    expect(screen.getByText(/Failed to import f6\.md: boom/)).toBeInTheDocument()
  })

  // #1928 — when every file fails, show an error-toned state and fire NO
  // success toast.
  it('shows an error state and no success toast when every file fails (#1928)', async () => {
    mockImportMarkdown.mockRejectedValue(new Error('boom'))

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['x'], 'a.md', { type: 'text/markdown' })
    const file2 = new File(['y'], 'b.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(screen.getByTestId('import-result-error')).toHaveTextContent(
        'All 2 files failed to import.',
      )
    })
    // No green success toast for a total failure.
    expect(toast.success).not.toHaveBeenCalled()
    // An error toast is surfaced instead.
    expect(toast.error).toHaveBeenCalledWith('All 2 files failed to import.')
  })

  // #1928 — partial failure suppresses the success toast and offers a retry.
  it('does not fire a success toast on partial failure (#1928)', async () => {
    mockImportMarkdown
      .mockResolvedValueOnce({
        page_title: 'ok',
        blocks_created: 3,
        properties_set: 0,
        warnings: [],
      })
      .mockRejectedValueOnce(new Error('boom'))

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['x'], 'ok.md', { type: 'text/markdown' })
    const file2 = new File(['y'], 'bad.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(screen.getByTestId('import-failures-heading')).toHaveTextContent(
        '1 file failed to import',
      )
    })
    expect(toast.success).not.toHaveBeenCalled()
    // notify.retry routes through toast.error with a retry action.
    expect(toast.error).toHaveBeenCalled()
    // #1935 — the failure row now appends the underlying reason.
    expect(screen.getByText(/Failed to import bad\.md: boom/)).toBeInTheDocument()
  })

  // #1929 — the result region is a polite live region so the outcome is
  // announced when the progress region clears.
  it('wraps the import result in a polite status live region (#1929)', async () => {
    mockImportMarkdown.mockResolvedValueOnce({
      page_title: 'Doc',
      blocks_created: 1,
      properties_set: 0,
      warnings: [],
    })

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# Hello'], 'doc.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      const region = screen.getByTestId('import-result')
      expect(region).toHaveAttribute('role', 'status')
      expect(region).toHaveAttribute('aria-live', 'polite')
      expect(region).toHaveAttribute('aria-atomic', 'true')
    })
  })

  // #1929 — both progress bars carry distinguishing accessible names.
  it('gives both progress bars accessible names (#1929)', async () => {
    let resolveImport: (v: unknown) => void = () => {}
    mockImportMarkdown.mockImplementationOnce(
      (
        _c: string,
        _f: string,
        _s: string,
        onProgress?: (u: { kind: string; blocks_total?: number; blocks_done?: number }) => void,
      ) => {
        onProgress?.({ kind: 'started', blocks_total: 3 })
        onProgress?.({ kind: 'progress', blocks_done: 1, blocks_total: 3 })
        return new Promise((resolve) => {
          resolveImport = resolve
        })
      },
    )

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['- a\n- b\n- c'], 'big.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      const fileBar = screen.getByTestId('import-progress-bar')
      const blockBar = screen.getByTestId('import-block-progress-bar')
      expect(fileBar).toHaveAccessibleName('File import progress')
      expect(blockBar).toHaveAccessibleName('Block import progress')
      // Distinct names so AT can tell the two bars apart.
      expect(fileBar.getAttribute('aria-label')).not.toBe(blockBar.getAttribute('aria-label'))
    })

    await act(async () => {
      resolveImport({ page_title: 'Big', blocks_created: 3, properties_set: 0, warnings: [] })
    })
  })

  // #1929 — axe audit of the rendered result panel (with failures + warnings).
  it('has no a11y violations with a populated result panel (#1929)', async () => {
    mockImportMarkdown
      .mockResolvedValueOnce({
        page_title: 'ok',
        blocks_created: 2,
        properties_set: 1,
        warnings: ['a warning'],
      })
      .mockRejectedValueOnce(new Error('boom'))

    const { container } = render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['x'], 'ok.md', { type: 'text/markdown' })
    const file2 = new File(['y'], 'bad.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(screen.getByTestId('import-result-details')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // #1927 — the folder/vault input must carry `webkitdirectory`; without
  // it `file.webkitRelativePath` is always empty and the #1446
  // folder→namespace mapping can never fire.
  it('exposes a folder input carrying webkitdirectory (#1927)', () => {
    render(<DataTab />)

    const folderInput = screen.getByTestId('import-folder-input') as HTMLInputElement
    // jsdom lowercases the attribute; assert presence (value is empty string).
    expect(folderInput.hasAttribute('webkitdirectory')).toBe(true)

    // A dedicated button drives it, distinct from "Choose Files".
    expect(screen.getByTestId('import-folder-button')).toBeInTheDocument()
  })

  // #2510 — the dedicated "Import Obsidian vault" affordance is a discoverable,
  // explicitly-named entry point. Like the generic folder button its input must
  // carry `webkitdirectory` (a vault is a folder pick), and a distinct,
  // Obsidian-labelled button must drive it so vault support is not hidden behind
  // the generic "Import Folder" label.
  it('exposes a dedicated Obsidian vault affordance carrying webkitdirectory (#2510)', () => {
    render(<DataTab />)

    const vaultInput = screen.getByTestId('import-obsidian-input') as HTMLInputElement
    // jsdom lowercases the attribute; assert presence (value is empty string).
    expect(vaultInput.hasAttribute('webkitdirectory')).toBe(true)

    // A distinct, discoverable button, labelled for Obsidian and separate from
    // the generic "Import Folder" / "Choose Files" affordances.
    const vaultBtn = screen.getByTestId('import-obsidian-button')
    expect(vaultBtn).toBeInTheDocument()
    expect(vaultBtn).toHaveTextContent('Import Obsidian Vault')
    expect(screen.getByRole('button', { name: /Import Obsidian Vault/i })).toBeInTheDocument()
  })

  // #2510 — clicking the Obsidian button opens ITS folder picker (the dedicated
  // `webkitdirectory` input), reusing the same folder-import pipeline.
  it('Obsidian vault button triggers its folder input click (#2510)', async () => {
    const user = userEvent.setup()
    render(<DataTab />)

    const vaultInput = screen.getByTestId('import-obsidian-input') as HTMLInputElement
    const clickSpy = vi.spyOn(vaultInput, 'click')

    await user.click(screen.getByTestId('import-obsidian-button'))

    expect(clickSpy).toHaveBeenCalled()
  })

  // #2510 — a vault import lands in a space, so the affordance is gated on an
  // active space exactly like the other import buttons (no doomed IPC).
  it('disables the Obsidian vault button when no active space is selected (#2510)', () => {
    useSpaceStore.setState({
      currentSpaceId: null,
      availableSpaces: [],
      isReady: false,
    })

    render(<DataTab />)

    expect(screen.getByTestId('import-obsidian-button')).toBeDisabled()
  })

  // #2510 — a folder pick made through the Obsidian button flows through the
  // SAME `handleFileImport` path, so a vault-relative `.md` file is imported
  // with its folder-relative path (the #1446 folder→namespace mapping), proving
  // the affordance is wired to the real import pipeline and not a dead button.
  it('imports a picked vault file through the Obsidian affordance (#2510)', async () => {
    mockImportMarkdown.mockResolvedValueOnce({
      page_title: 'Note',
      blocks_created: 3,
      properties_set: 0,
      warnings: [],
    })

    render(<DataTab />)

    const vaultInput = screen.getByTestId('import-obsidian-input') as HTMLInputElement
    const file = new File(['# Note'], 'Note.md', { type: 'text/markdown' })
    // Emulate a folder pick: the browser prefixes the chosen vault folder name.
    Object.defineProperty(file, 'webkitRelativePath', { value: 'MyVault/Note.md' })
    Object.defineProperty(vaultInput, 'files', { value: [file] })

    await act(async () => {
      vaultInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(mockImportMarkdown).toHaveBeenCalledWith(
        '# Note',
        // #1446 — the folder-relative path drives the namespace mapping.
        'MyVault/Note.md',
        DEFAULT_TEST_SPACE.id,
        expect.any(Function),
        // No attachment refs in the content ⇒ null vaultFiles payload.
        null,
      )
    })
  })

  // #1927 — the import target space must be visible so the destination is
  // not silent.
  it('shows the import target space name (#1927)', () => {
    render(<DataTab />)

    const label = screen.getByTestId('import-target-space')
    expect(label).toHaveTextContent('Importing into: Personal')
  })

  // #1935 — a failed file surfaces its actual error reason, not just the
  // generic "Failed to import <name>".
  it('renders the failure reason for a failed file (#1935)', async () => {
    mockImportMarkdown.mockRejectedValueOnce(
      // The IPC AppError wire shape: { kind, message }. Validation errors
      // carry real text the user should see.
      { kind: 'validation', message: 'space_id does not refer to a live space block' },
    )

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# Hello'], 'bad.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(
        screen.getByText('Failed to import bad.md: space_id does not refer to a live space block'),
      ).toBeInTheDocument()
    })
  })

  // #1935 — the per-file failure is logged at ERROR with a
  // filename-distinct message so the logger's rate-limiter (keyed on
  // module:message) doesn't suppress repeats across a multi-file import.
  it('logs each file failure at error with a filename-distinct message (#1935)', async () => {
    mockImportMarkdown
      .mockRejectedValueOnce(new Error('boom-a'))
      .mockRejectedValueOnce(new Error('boom-b'))

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['x'], 'a.md', { type: 'text/markdown' })
    const file2 = new File(['y'], 'b.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalledTimes(2)
    })
    // logger.error(module, message, data, cause) — message MUST include the
    // filename so the two calls have DISTINCT keys.
    const messages = mockLoggerError.mock.calls.map((c) => c[1] as string)
    expect(messages).toContain('file import failed: a.md')
    expect(messages).toContain('file import failed: b.md')
    expect(new Set(messages).size).toBe(2)
    // It is an ERROR, never demoted to WARN for this code path.
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })

  // #1927 — after a successful import the result panel offers a navigation
  // action that resolves the imported page and calls navigateToPage.
  it('navigates to the imported page from the View action (#1927)', async () => {
    const user = userEvent.setup()
    mockImportMarkdown.mockResolvedValueOnce({
      page_title: 'My Imported Page',
      blocks_created: 4,
      properties_set: 0,
      warnings: [],
    })
    mockResolvePageByAlias.mockResolvedValueOnce(['PAGE_ULID', 'My Imported Page'])

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# Hello'], 'page.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const viewBtn = await screen.findByTestId('import-view-button')
    await user.click(viewBtn)

    await waitFor(() => {
      // Resolves the title (an alias) → id, scoped to the target space …
      expect(mockResolvePageByAlias).toHaveBeenCalledWith({
        alias: 'My Imported Page',
        spaceId: DEFAULT_TEST_SPACE.id,
      })
      // … then reuses the app's navigation action.
      expect(mockNavigateToPage).toHaveBeenCalledWith('PAGE_ULID', 'My Imported Page')
    })
  })

  // #1927 — Cancel stops the loop between files and reports how many were
  // imported before the abort.
  it('cancels a multi-file import and reports partial progress (#1927)', async () => {
    const user = userEvent.setup()
    let resolveFirst: (v: unknown) => void = () => {}
    mockImportMarkdown
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r
          }),
      )
      // Second file should NEVER be reached once cancel is set before it.
      .mockImplementationOnce(() => {
        throw new Error('second file should not start after cancel')
      })

    render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file1 = new File(['# A'], 'one.md', { type: 'text/markdown' })
    const file2 = new File(['# B'], 'two.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file1, file2] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // First file is in flight — the Cancel affordance is visible. Click it
    // so the abort flag is set before the loop advances to file two.
    const cancelBtn = await screen.findByTestId('import-cancel-button')
    await user.click(cancelBtn)

    // Now let the first file complete; the loop then sees the abort flag
    // and breaks before starting the second file.
    await act(async () => {
      resolveFirst({ page_title: 'one', blocks_created: 1, properties_set: 0, warnings: [] })
    })

    // Only the first file ran.
    expect(mockImportMarkdown).toHaveBeenCalledTimes(1)
    // The cancellation toast reports how many imported before the abort.
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith('Import cancelled — 1 file imported.')
    })
  })

  // #1927 — axe audit including the new folder button, target label, and
  // Cancel control during an in-flight import.
  it('has no a11y violations with the new import controls (#1927)', async () => {
    let resolveImport: (v: unknown) => void = () => {}
    mockImportMarkdown.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveImport = r
        }),
    )

    const { container } = render(<DataTab />)

    const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
    const file = new File(['# A'], 'one.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Cancel control is mounted while importing — audit this state.
    await screen.findByTestId('import-cancel-button')
    const results = await axe(container)
    expect(results).toHaveNoViolations()

    await act(async () => {
      resolveImport({ page_title: 'one', blocks_created: 1, properties_set: 0, warnings: [] })
    })
  })

  // #1925 — vault attachment import (PR 2). The folder picker's FileList holds
  // markdown AND sibling assets; the FE pre-scans each markdown for refs and
  // ships only the matched files' bytes as `vaultFiles`.
  describe('vault attachment import (#1925)', () => {
    /** Make a `File` carrying a `webkitRelativePath` (the folder-pick shape). */
    const folderFile = (
      bytes: BlobPart[],
      name: string,
      relativePath: string,
      type = 'text/markdown',
    ): File => {
      const f = new File(bytes, name, { type })
      Object.defineProperty(f, 'webkitRelativePath', { value: relativePath })
      return f
    }

    const okResult = {
      page_title: 'note',
      blocks_created: 1,
      properties_set: 0,
      warnings: [],
    }

    it('ships a referenced sibling file as vaultFiles { path, bytes }', async () => {
      mockImportMarkdown.mockResolvedValueOnce(okResult)

      render(<DataTab />)
      const folderInput = screen.getByTestId('import-folder-input') as HTMLInputElement

      const md = folderFile(['![](assets/diagram.png)'], 'note.md', 'MyVault/note.md')
      const png = folderFile(
        [new Uint8Array([1, 2, 3, 4])],
        'diagram.png',
        'MyVault/assets/diagram.png',
        'image/png',
      )
      Object.defineProperty(folderInput, 'files', { value: [md, png] })

      await act(async () => {
        folderInput.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() => expect(mockImportMarkdown).toHaveBeenCalled())
      const vaultFiles = mockImportMarkdown.mock.calls[0]?.[4] as Array<{
        path: string
        bytes: number[]
      }> | null
      expect(vaultFiles).toHaveLength(1)
      // Path is vault-root-relative (top folder stripped).
      expect(vaultFiles?.[0]?.path).toBe('assets/diagram.png')
      // Bytes are the read file contents (non-empty number[]).
      expect(vaultFiles?.[0]?.bytes).toEqual([1, 2, 3, 4])
    })

    it('omits a referenced-but-absent file from vaultFiles', async () => {
      mockImportMarkdown.mockResolvedValueOnce(okResult)

      render(<DataTab />)
      const folderInput = screen.getByTestId('import-folder-input') as HTMLInputElement

      // Markdown references a file that is NOT in the FileList.
      const md = folderFile(['![](assets/missing.png)'], 'note.md', 'MyVault/note.md')
      Object.defineProperty(folderInput, 'files', { value: [md] })

      await act(async () => {
        folderInput.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() => expect(mockImportMarkdown).toHaveBeenCalled())
      // No refs resolved ⇒ null payload (backend warns about the missing file).
      expect(mockImportMarkdown.mock.calls[0]?.[4]).toBeNull()
    })

    it('passes null vaultFiles for a single-file (non-folder) import', async () => {
      mockImportMarkdown.mockResolvedValueOnce(okResult)

      render(<DataTab />)
      const fileInput = screen.getByTestId('import-file-input') as HTMLInputElement
      // A plain `.md` pick: webkitRelativePath is empty ⇒ no sibling assets.
      const file = new File(['![](assets/diagram.png)'], 'note.md', { type: 'text/markdown' })
      Object.defineProperty(fileInput, 'files', { value: [file] })

      await act(async () => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() => expect(mockImportMarkdown).toHaveBeenCalled())
      expect(mockImportMarkdown.mock.calls[0]?.[4]).toBeNull()
    })
  })

  // #1282 — Evernote `.enex` import. Each note in the picked file is parsed in
  // the browser and handed to the shared `importMarkdown` IPC as one page.
  describe('Evernote .enex import (#1282)', () => {
    const okResult = (title = 'note') => ({
      page_title: title,
      blocks_created: 2,
      properties_set: 0,
      warnings: [],
    })

    /** A minimal two-note ENEX document. */
    const twoNoteEnex = () => {
      const content = (enml: string) => `<![CDATA[<en-note>${enml}</en-note>]]>`
      return (
        `<?xml version="1.0" encoding="UTF-8"?><en-export>` +
        `<note><title>Alpha</title><content>${content('<h1>A</h1><p>body</p>')}</content>` +
        `<created>20210102T030405Z</created><tag>Multi Word</tag></note>` +
        `<note><title>Beta</title><content>${content('<p>b</p>')}</content></note>` +
        `</en-export>`
      )
    }

    it('renders the enex input and button', () => {
      render(<DataTab />)
      expect(screen.getByTestId('import-enex-input')).toBeInTheDocument()
      const btn = screen.getByTestId('import-enex-button')
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveTextContent('Import Evernote (.enex)')
      // The input only accepts `.enex`.
      expect(screen.getByTestId('import-enex-input')).toHaveAttribute('accept', '.enex')
    })

    it('clicking the enex button opens the enex input', async () => {
      const user = userEvent.setup()
      render(<DataTab />)
      const input = screen.getByTestId('import-enex-input') as HTMLInputElement
      const clickSpy = vi.spyOn(input, 'click')
      await user.click(screen.getByTestId('import-enex-button'))
      expect(clickSpy).toHaveBeenCalled()
    })

    it('calls importMarkdown once per note with the converted markdown', async () => {
      mockImportMarkdown.mockResolvedValue(okResult())

      render(<DataTab />)
      const input = screen.getByTestId('import-enex-input') as HTMLInputElement
      const file = new File([twoNoteEnex()], 'export.enex', { type: 'application/xml' })
      Object.defineProperty(input, 'files', { value: [file] })

      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })

      // Two notes → two importMarkdown calls (one page each).
      await waitFor(() => expect(mockImportMarkdown).toHaveBeenCalledTimes(2))

      // First call: filename derived from the note title, converted markdown,
      // active space, a progress callback, and no vault files (undefined).
      const [content0, filename0, spaceId0, onProgress0, vaultFiles0] = mockImportMarkdown.mock
        .calls[0] as [string, string, string, unknown, unknown]
      expect(filename0).toBe('Alpha.md')
      expect(spaceId0).toBe(DEFAULT_TEST_SPACE.id)
      expect(typeof onProgress0).toBe('function')
      // #2513 — a note with no `<en-media>` attachments ships null vaultFiles
      // (consistent with the single-file `.md` path).
      expect(vaultFiles0).toBeNull()
      // Frontmatter + tag token + converted body all present.
      expect(content0).toContain('source: evernote')
      expect(content0).toContain('#[[Multi Word]]')
      expect(content0).toContain('# A')

      expect(mockImportMarkdown.mock.calls[1]?.[1]).toBe('Beta.md')
    })

    it('aggregates block counts across notes and shows a success result', async () => {
      mockImportMarkdown
        .mockResolvedValueOnce({ ...okResult('Alpha'), blocks_created: 3 })
        .mockResolvedValueOnce({ ...okResult('Beta'), blocks_created: 4 })

      render(<DataTab />)
      const input = screen.getByTestId('import-enex-input') as HTMLInputElement
      const file = new File([twoNoteEnex()], 'export.enex', { type: 'application/xml' })
      Object.defineProperty(input, 'files', { value: [file] })

      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })

      // 3 + 4 = 7 blocks aggregated across the two notes. #2513 — the aggregate
      // toast now labels the units "notes" (one page per note), not "files".
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          'Imported 7 blocks from 2 notes',
          expect.anything(),
        )
      })
    })

    it('surfaces an error notify when a file fails to parse', async () => {
      render(<DataTab />)
      const input = screen.getByTestId('import-enex-input') as HTMLInputElement
      // Malformed XML → parseEnex throws.
      const bad = new File(['<en-export><note><title>oops</note>'], 'broken.enex', {
        type: 'application/xml',
      })
      Object.defineProperty(input, 'files', { value: [bad] })

      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Could not read broken.enex: not a valid Evernote export.',
        )
      })
      // No note ever reached the IPC.
      expect(mockImportMarkdown).not.toHaveBeenCalled()
      // The parse failure is logged at ERROR with a filename-distinct message.
      expect(mockLoggerError).toHaveBeenCalled()
    })

    // #2513 (part 4) — when the ONLY picked file fails to parse, the per-file
    // parse toast is the ONLY error toast: the summary fallback must NOT also
    // fire (previously it double-toasted), matching the `.md` path.
    it('fires a single error toast (no double) when the only file fails to parse (#2513)', async () => {
      render(<DataTab />)
      const input = screen.getByTestId('import-enex-input') as HTMLInputElement
      const bad = new File(['<en-export><note><title>oops</note>'], 'broken.enex', {
        type: 'application/xml',
      })
      Object.defineProperty(input, 'files', { value: [bad] })

      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Could not read broken.enex: not a valid Evernote export.',
        )
      })
      // The generic summary ("All 1 file failed to import.") must NOT fire on
      // top of the per-file toast, and exactly one error toast is shown.
      expect(toast.error).not.toHaveBeenCalledWith('All 1 file failed to import.')
      expect(toast.error).toHaveBeenCalledTimes(1)
    })

    // #2513 (part 1) — a note with an embedded `<resource>` referenced by
    // `<en-media>` ships the decoded bytes as `vaultFiles`, reusing the same
    // vault-attachment plumbing the folder import uses, and the note's markdown
    // carries the rewritten `![](path)` ref the backend matches to those bytes.
    it('ships decoded en-media attachment bytes as vaultFiles (#2513)', async () => {
      mockImportMarkdown.mockResolvedValue(okResult())

      // "hello" (base64 aGVsbG8=) has MD5 5d41402abc4b2a76b9719d911017c592,
      // which is the en-media hash referencing the resource.
      const md5 = '5d41402abc4b2a76b9719d911017c592'
      const cdata = (enml: string) => `<![CDATA[<en-note>${enml}</en-note>]]>`
      const enexXml =
        `<?xml version="1.0" encoding="UTF-8"?><en-export><note><title>Img</title>` +
        `<content>${cdata(`<div><en-media hash="${md5}" type="image/png"/></div>`)}</content>` +
        `<resource><data encoding="base64">aGVsbG8=</data><mime>image/png</mime>` +
        `<resource-attributes><file-name>pic.png</file-name></resource-attributes>` +
        `</resource></note></en-export>`

      render(<DataTab />)
      const input = screen.getByTestId('import-enex-input') as HTMLInputElement
      const file = new File([enexXml], 'withmedia.enex', { type: 'application/xml' })
      Object.defineProperty(input, 'files', { value: [file] })

      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() => expect(mockImportMarkdown).toHaveBeenCalled())
      const [content0, , , , vaultFiles0] = mockImportMarkdown.mock.calls[0] as [
        string,
        string,
        string,
        unknown,
        Array<{ path: string; bytes: number[] }> | null,
      ]
      // The markdown embeds the rewritten attachment ref.
      expect(content0).toContain('![](pic.png)')
      // The decoded resource bytes ("hello") ship as a VaultFile at that path.
      expect(vaultFiles0).toHaveLength(1)
      expect(vaultFiles0?.[0]?.path).toBe('pic.png')
      expect(vaultFiles0?.[0]?.bytes).toEqual([104, 101, 108, 108, 111])
    })

    it('has no a11y violations with the enex control present', async () => {
      const { container } = render(<DataTab />)
      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })

  // #2513 (part 2) — Joplin `.jex` import. The picked tar archive is unpacked in
  // the browser and each note handed to the shared `importMarkdown` IPC as one
  // page, reusing the `.enex` attachment (`vaultFiles`) plumbing.
  describe('Joplin .jex import (#2513)', () => {
    const okResult = (title = 'note') => ({
      page_title: title,
      blocks_created: 2,
      properties_set: 0,
      warnings: [],
    })

    const textEnc = new TextEncoder()

    /** Encode a NUL-terminated octal tar header field of `len` bytes. */
    const octalField = (n: number, len: number): string =>
      `${n.toString(8).padStart(len - 1, '0')}\0`

    /** Build a minimal USTAR archive from `{ name, data }` members. */
    const buildTar = (members: { name: string; data: Uint8Array }[]): Uint8Array => {
      const blocks: Uint8Array[] = []
      for (const { name, data } of members) {
        const header = new Uint8Array(512)
        header.set(textEnc.encode(name).subarray(0, 100), 0)
        header.set(textEnc.encode(octalField(data.length, 12)), 124)
        header[156] = 0x30
        header.set(textEnc.encode('ustar\0'), 257)
        for (let i = 148; i < 156; i++) header[i] = 0x20
        let sum = 0
        for (let i = 0; i < 512; i++) sum += header[i] ?? 0
        header.set(textEnc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
        blocks.push(header)
        const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
        padded.set(data)
        blocks.push(padded)
      }
      blocks.push(new Uint8Array(512), new Uint8Array(512))
      const total = blocks.reduce((n, b) => n + b.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const b of blocks) {
        out.set(b, off)
        off += b.length
      }
      return out
    }

    const joplinItem = (content: string, props: Record<string, string>): string => {
      const meta = Object.entries(props)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      return `${content}\n\n${meta}\n`
    }

    const NOTE_ID = 'b'.repeat(32)
    const RES_ID = 'd'.repeat(32)

    /** A one-note archive whose note embeds a resource by `:/id`. */
    const noteWithResourceJex = (): Uint8Array => {
      const note = joplinItem(`Picture Note\n\nSee ![pic](:/${RES_ID}).`, {
        id: NOTE_ID,
        parent_id: '',
        type_: '1',
      })
      const resMeta = joplinItem('pic.png', {
        id: RES_ID,
        mime: 'image/png',
        file_extension: 'png',
        type_: '4',
      })
      return buildTar([
        { name: `${NOTE_ID}.md`, data: textEnc.encode(note) },
        { name: `${RES_ID}.md`, data: textEnc.encode(resMeta) },
        { name: `resources/${RES_ID}.png`, data: new Uint8Array([104, 101, 108, 108, 111]) },
      ])
    }

    /** Dispatch a change on the jex input for `bytes` under `filename`. */
    const importJex = async (bytes: Uint8Array, filename: string) => {
      const input = screen.getByTestId('import-jex-input') as HTMLInputElement
      const file = new File([bytes as BlobPart], filename, { type: 'application/octet-stream' })
      Object.defineProperty(input, 'files', { value: [file] })
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }

    it('renders the jex input and button', () => {
      render(<DataTab />)
      const btn = screen.getByTestId('import-jex-button')
      expect(btn).toHaveTextContent('Import Joplin (.jex)')
      expect(screen.getByTestId('import-jex-input')).toHaveAttribute('accept', '.jex')
    })

    it('imports each note as a page and ships resource bytes as vaultFiles', async () => {
      mockImportMarkdown.mockResolvedValue(okResult('Picture Note'))

      render(<DataTab />)
      await importJex(noteWithResourceJex(), 'notes.jex')

      await waitFor(() => expect(mockImportMarkdown).toHaveBeenCalledTimes(1))
      const [content0, filename0, spaceId0, onProgress0, vaultFiles0] = mockImportMarkdown.mock
        .calls[0] as [string, string, string, unknown, Array<{ path: string; bytes: number[] }>]
      expect(filename0).toBe('Picture Note.md')
      expect(spaceId0).toBe(DEFAULT_TEST_SPACE.id)
      expect(typeof onProgress0).toBe('function')
      // Joplin body is already markdown; the resource embed is rewritten and the
      // frontmatter stamps the joplin source.
      expect(content0).toContain('source: joplin')
      expect(content0).toContain('![pic](pic.png)')
      // The decoded resource bytes ("hello") ship via the vault-attachment path.
      expect(vaultFiles0).toHaveLength(1)
      expect(vaultFiles0[0]?.path).toBe('pic.png')
      expect(vaultFiles0[0]?.bytes).toEqual([104, 101, 108, 108, 111])
    })

    it('labels the aggregate success toast "notes"', async () => {
      mockImportMarkdown.mockResolvedValue({ ...okResult(), blocks_created: 5 })
      render(<DataTab />)
      await importJex(noteWithResourceJex(), 'notes.jex')
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          'Imported 5 blocks from 1 note',
          expect.anything(),
        )
      })
    })

    it('fires a single error toast (no double) when the archive has no notes', async () => {
      render(<DataTab />)
      // A tar with no `.md` items yields zero notes → one parse-failure toast.
      const empty = buildTar([{ name: 'readme.txt', data: textEnc.encode('hi') }])
      await importJex(empty, 'empty.jex')

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Could not read empty.jex: not a valid Joplin export.',
        )
      })
      // The generic summary must NOT also fire, and exactly one error toast shows.
      expect(toast.error).not.toHaveBeenCalledWith('All 1 file failed to import.')
      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(mockImportMarkdown).not.toHaveBeenCalled()
    })
  })

  // #1454 — bibliography import (.bib BibTeX / .json CSL-JSON). A single
  // file maps to a single `import_bibliography` IPC; format is inferred from
  // the picked file's extension.
  describe('bibliography import (#1454)', () => {
    const okResult = {
      pages_created: 3,
      entries_skipped: 1,
      properties_set: 12,
      warnings: [],
    }

    /** Dispatch a change event on the bib input carrying `file`. */
    const pickBibFile = async (file: File): Promise<void> => {
      const input = screen.getByTestId('import-bib-input') as HTMLInputElement
      Object.defineProperty(input, 'files', { value: [file] })
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }

    it('renders the bibliography input and button', () => {
      render(<DataTab />)

      const input = screen.getByTestId('import-bib-input')
      expect(input).toBeInTheDocument()
      // The picker filters to exactly the two supported extensions.
      expect(input).toHaveAttribute('accept', '.bib,.json')

      const btn = screen.getByTestId('import-bib-button')
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveTextContent('Import Bibliography (.bib/.json)')
    })

    it('clicking the bibliography button opens the file input', async () => {
      const user = userEvent.setup()
      render(<DataTab />)

      const input = screen.getByTestId('import-bib-input') as HTMLInputElement
      const clickSpy = vi.spyOn(input, 'click')
      await user.click(screen.getByTestId('import-bib-button'))
      expect(clickSpy).toHaveBeenCalled()
    })

    it('is disabled until a space is ready, with the shared not-ready hint', () => {
      useSpaceStore.setState({
        currentSpaceId: null,
        availableSpaces: [],
        isReady: false,
      })

      render(<DataTab />)

      const btn = screen.getByTestId('import-bib-button')
      expect(btn).toBeDisabled()
      // Same aria-describedby wiring as the markdown import button — the
      // visible hint explains WHY the control is unactionable.
      const hint = screen.getByTestId('import-space-not-ready-hint')
      expect(btn).toHaveAttribute('aria-describedby', hint.id)
    })

    it('imports a .bib file as bibtex and shows the created/skipped toast', async () => {
      mockImportBibliography.mockResolvedValueOnce(okResult)

      render(<DataTab />)
      await pickBibFile(
        new File(['@article{knuth1984, title={Literate Programming}}'], 'refs.bib', {
          type: 'text/plain',
        }),
      )

      await waitFor(() => {
        // Extension → format inference: `.bib` → 'bibtex'; content and the
        // active space's ULID flow through unchanged.
        expect(mockImportBibliography).toHaveBeenCalledWith(
          '@article{knuth1984, title={Literate Programming}}',
          'bibtex',
          DEFAULT_TEST_SPACE.id,
        )
      })
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Imported 3 reference pages (1 skipped)')
      })
      // The result panel mirrors the toast summary.
      expect(screen.getByTestId('bib-import-summary')).toHaveTextContent(
        'Imported 3 reference pages (1 skipped)',
      )
    })

    it('imports a .json file as csl-json', async () => {
      mockImportBibliography.mockResolvedValueOnce({ ...okResult, pages_created: 1 })

      render(<DataTab />)
      const csl = '[{"id":"a","type":"book","title":"A"}]'
      await pickBibFile(new File([csl], 'library.json', { type: 'application/json' }))

      await waitFor(() => {
        expect(mockImportBibliography).toHaveBeenCalledWith(csl, 'csl-json', DEFAULT_TEST_SPACE.id)
      })
    })

    it('rejects an unsupported extension without firing the IPC', async () => {
      render(<DataTab />)
      // The `accept` filter should prevent this from the picker, but
      // drag-drop / OS quirks can still hand over an arbitrary file.
      await pickBibFile(new File(['@misc{x}'], 'refs.txt', { type: 'text/plain' }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Cannot import refs.txt: only .bib and .json bibliography files are supported.',
        )
      })
      expect(mockImportBibliography).not.toHaveBeenCalled()
    })

    it('rejects an empty file without firing the IPC', async () => {
      render(<DataTab />)
      await pickBibFile(new File(['   \n'], 'empty.bib', { type: 'text/plain' }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Cannot import empty.bib: the file is empty.')
      })
      expect(mockImportBibliography).not.toHaveBeenCalled()
    })

    it('renders backend warnings in the warnings panel', async () => {
      mockImportBibliography.mockResolvedValueOnce({
        ...okResult,
        warnings: ['duplicate key smith2020 skipped', 'entry doe2021 has no title'],
      })

      render(<DataTab />)
      await pickBibFile(new File(['@misc{x}'], 'refs.bib', { type: 'text/plain' }))

      await waitFor(() => {
        expect(screen.getByTestId('bib-import-warnings-heading')).toHaveTextContent('2 warnings')
      })
      // The actual warning strings render (a <details> keeps its contents in
      // the DOM even while collapsed).
      expect(screen.getByText('duplicate key smith2020 skipped')).toBeInTheDocument()
      expect(screen.getByText('entry doe2021 has no title')).toBeInTheDocument()
      expect(screen.getAllByTestId('bib-import-warning-item')).toHaveLength(2)
    })

    it('surfaces the AppError message on failure (#1935 pattern)', async () => {
      // IPC AppError wire shape: { kind, message } — Validation failures
      // carry real text the user should see.
      mockImportBibliography.mockRejectedValueOnce({
        kind: 'validation',
        message: 'unbalanced braces at line 3',
      })

      render(<DataTab />)
      await pickBibFile(new File(['@misc{x'], 'bad.bib', { type: 'text/plain' }))

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Failed to import bad.bib: unbalanced braces at line 3',
        )
      })
      // No success toast and no result panel on the failure path.
      expect(toast.success).not.toHaveBeenCalled()
      expect(screen.queryByTestId('bib-import-result')).not.toBeInTheDocument()
    })

    it('has no a11y violations with a populated bibliography result panel', async () => {
      mockImportBibliography.mockResolvedValueOnce({
        ...okResult,
        warnings: ['duplicate key smith2020 skipped'],
      })

      const { container } = render(<DataTab />)
      await pickBibFile(new File(['@misc{x}'], 'refs.bib', { type: 'text/plain' }))

      await waitFor(() => {
        expect(screen.getByTestId('bib-import-result')).toBeInTheDocument()
      })
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
