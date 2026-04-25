/**
 * Tests for DataSettingsTab component (UX-144).
 *
 * Validates:
 *  - Renders import and export sections
 *  - Import button triggers file input click
 *  - File selection calls importMarkdown
 *  - Shows import result after success
 *  - Export button calls exportGraphAsZip
 *  - Shows error toast on export failure
 *  - Has no a11y violations (axe)
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
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

beforeEach(() => {
  vi.clearAllMocks()
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

  it('file selection calls importMarkdown', async () => {
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
      expect(mockImportMarkdown).toHaveBeenCalledWith('# Hello', 'test.md')
    })
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

  it('has no a11y violations', async () => {
    const { container } = render(<DataSettingsTab />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
