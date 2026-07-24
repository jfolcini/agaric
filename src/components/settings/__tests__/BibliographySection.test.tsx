/**
 * Tests for BibliographySection — specifically the IPC ERROR path of
 * `useBibliographyImport`, which calls the `import_bibliography` Tauri command.
 *
 * The primary test drives the bibliography IPC to REJECT and asserts the
 * component surfaces the failure (error toast + input reset + `setImporting`
 * released) rather than swallowing it. It is non-tautological: if the handler
 * swallowed the rejection, `toast.error` would never fire and the test fails.
 */

import { act, render, renderHook, screen } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BibliographyResultPanel,
  useBibliographyImport,
} from '@/components/settings/BibliographySection'
import type { SpaceRow } from '@/lib/bindings'
import { useSpaceStore } from '@/stores/space'

const mockImportBibliography = vi.fn()
vi.mock('@/lib/bindings', () => ({
  commands: {
    importBibliography: (...args: unknown[]) => mockImportBibliography(...args),
  },
}))

// #1935 — the failure is logged at ERROR with a filename-distinct message so
// the logger's rate-limiter (keyed on module:message) doesn't suppress repeats.
const mockLoggerError = vi.fn()
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...a: unknown[]) => mockLoggerError(...a),
  },
}))

import { toast } from 'sonner'

const DEFAULT_TEST_SPACE: SpaceRow = {
  id: 'SPACE_DEFAULT',
  name: 'Personal',
  accent_color: 'accent-blue',
}

/** A fake change event carrying selected files and a resettable value. */
function fileEvent(file: File): React.ChangeEvent<HTMLInputElement> {
  return {
    target: { files: [file], value: 'C:\\fakepath\\seed.bib' },
  } as unknown as React.ChangeEvent<HTMLInputElement>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockImportBibliography.mockReset()
  useSpaceStore.setState({
    currentSpaceId: DEFAULT_TEST_SPACE.id,
    availableSpaces: [DEFAULT_TEST_SPACE],
    isReady: true,
  })
})

describe('useBibliographyImport (IPC error path)', () => {
  it('surfaces the rejection as an error toast, resets the input, and releases importing', async () => {
    // The IPC AppError wire shape: { kind, message } — Validation failures
    // carry real text the user should see (#1935).
    mockImportBibliography.mockRejectedValueOnce({
      kind: 'validation',
      message: 'unbalanced braces at line 3',
    })

    const setImporting = vi.fn()
    const { result } = renderHook(() => useBibliographyImport(setImporting))

    const event = fileEvent(new File(['@article{x, title={Y}}'], 'bad.bib', { type: 'text/plain' }))
    await act(async () => {
      await result.current.handleBibliographyImport(event)
    })

    // The IPC was actually attempted with the inferred format + active space.
    expect(mockImportBibliography).toHaveBeenCalledWith(
      '@article{x, title={Y}}',
      'bibtex',
      DEFAULT_TEST_SPACE.id,
    )

    // The rejection is surfaced (NOT swallowed) as an error toast that carries
    // the extracted reason. If the component swallowed the rejection, this
    // assertion fails.
    expect(toast.error).toHaveBeenCalledWith(
      'Failed to import bad.bib: unbalanced braces at line 3',
    )

    // Logged at ERROR with a filename-distinct message.
    expect(mockLoggerError).toHaveBeenCalledWith(
      'DataSettingsTab',
      'bibliography import failed: bad.bib',
      { fileName: 'bad.bib' },
      expect.anything(),
    )

    // `importing` is toggled on for the run and released in `finally` even
    // though the IPC threw — otherwise every import button would stay disabled.
    expect(setImporting).toHaveBeenNthCalledWith(1, true)
    expect(setImporting).toHaveBeenLastCalledWith(false)

    // The input is reset so a retry re-opens the picker cleanly.
    expect(event.target.value).toBe('')

    // No success toast on a failed import, and no result panel state.
    expect(toast.success).not.toHaveBeenCalled()
    expect(result.current.bibResult).toBeNull()
  })

  it('does not fire the IPC (or crash) for an empty file — surfaces a reason instead', async () => {
    const setImporting = vi.fn()
    const { result } = renderHook(() => useBibliographyImport(setImporting))

    const event = fileEvent(new File(['   \n'], 'empty.bib', { type: 'text/plain' }))
    await act(async () => {
      await result.current.handleBibliographyImport(event)
    })

    expect(mockImportBibliography).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Cannot import empty.bib: the file is empty.')
    // Guard branch returns before `setImporting(true)`.
    expect(setImporting).not.toHaveBeenCalled()
    expect(event.target.value).toBe('')
  })
})

describe('BibliographyResultPanel', () => {
  it('renders the page/skip summary and the warnings list', () => {
    render(
      <BibliographyResultPanel
        result={{
          pagesCreated: 3,
          entriesSkipped: 1,
          warnings: ['duplicate key smith2020 skipped'],
        }}
      />,
    )

    expect(screen.getByTestId('bib-import-summary')).toHaveTextContent(
      'Imported 3 reference pages (1 skipped)',
    )
    expect(screen.getByTestId('bib-import-warnings-heading')).toHaveTextContent('1 warning')
    expect(screen.getByText('duplicate key smith2020 skipped')).toBeInTheDocument()
  })
})
