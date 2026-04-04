/**
 * Tests for AttachmentList component.
 *
 * Validates:
 *  - Empty state when no attachments
 *  - Renders list of attachments with filenames
 *  - Shows correct MIME type icons
 *  - Delete button calls deleteAttachment IPC
 *  - Shows loading state
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { AttachmentList, formatSize } from '../AttachmentList'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

const mockedInvoke = vi.mocked(invoke)
const mockedToast = vi.mocked(toast)
const mockedToastSuccess = vi.mocked(toast.success)

function makeAttachment(
  id: string,
  filename: string,
  opts: { mimeType?: string; sizeBytes?: number; createdAt?: string } = {},
) {
  return {
    id,
    block_id: 'block-1',
    filename,
    mime_type: opts.mimeType ?? 'application/octet-stream',
    size_bytes: opts.sizeBytes ?? 1024,
    fs_path: `/files/${filename}`,
    created_at: opts.createdAt ?? new Date().toISOString(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: list_attachments returns empty
  mockedInvoke.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AttachmentList', () => {
  it('renders empty state when no attachments', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<AttachmentList blockId="block-1" />)

    expect(await screen.findByText(/No attachments yet/)).toBeInTheDocument()
  })

  it('renders list of attachments with filenames', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makeAttachment('a1', 'report.pdf'),
      makeAttachment('a2', 'photo.png', { mimeType: 'image/png' }),
    ])

    render(<AttachmentList blockId="block-1" />)

    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('photo.png')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    // Never-resolving promise keeps loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<AttachmentList blockId="block-1" />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(2)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders human-readable file sizes', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makeAttachment('a1', 'small.txt', { sizeBytes: 500, mimeType: 'text/plain' }),
      makeAttachment('a2', 'medium.doc', { sizeBytes: 2048 }),
      makeAttachment('a3', 'large.zip', { sizeBytes: 1048576 * 5 }),
    ])

    render(<AttachmentList blockId="block-1" />)

    expect(await screen.findByText('500 B')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByText('5.0 MB')).toBeInTheDocument()
  })

  it('delete button calls deleteAttachment IPC on double-click confirmation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    mockedInvoke.mockResolvedValueOnce([makeAttachment('a1', 'to-delete.txt')])

    render(<AttachmentList blockId="block-1" />)

    expect(await screen.findByText('to-delete.txt')).toBeInTheDocument()

    const deleteBtn = screen.getByRole('button', { name: /delete attachment to-delete\.txt/i })

    // First click — confirmation toast
    await user.click(deleteBtn)
    expect(mockedToast).toHaveBeenCalled()

    // Mock delete_attachment response
    mockedInvoke.mockResolvedValueOnce(undefined)

    // Second click — actually deletes
    await user.click(deleteBtn)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_attachment', { attachmentId: 'a1' })
    expect(mockedToastSuccess).toHaveBeenCalled()
  })

  it('resets pending delete state after timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    mockedInvoke.mockResolvedValueOnce([makeAttachment('a1', 'timeout-test.txt')])

    render(<AttachmentList blockId="block-1" />)

    expect(await screen.findByText('timeout-test.txt')).toBeInTheDocument()

    const deleteBtn = screen.getByRole('button', { name: /delete attachment timeout-test\.txt/i })

    // First click — enters pending state
    await user.click(deleteBtn)
    expect(mockedToast).toHaveBeenCalled()

    // Advance past the 3s timeout
    vi.advanceTimersByTime(3100)

    // Now clicking should be a new first click, not a confirm
    mockedToast.mockClear()
    await user.click(deleteBtn)
    // Should call toast again (first click), not invoke delete
    expect(mockedToast).toHaveBeenCalled()
    // delete_attachment should NOT have been called (only list_attachments)
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_attachment', expect.anything())
  })

  it('calls list_attachments with the correct blockId', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    render(<AttachmentList blockId="my-block-42" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_attachments', { blockId: 'my-block-42' })
    })
  })

  it('has no a11y violations (empty state)', async () => {
    mockedInvoke.mockResolvedValueOnce([])

    const { container } = render(<AttachmentList blockId="block-1" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations (with attachments)', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makeAttachment('a1', 'doc.pdf', { mimeType: 'application/pdf' }),
      makeAttachment('a2', 'photo.jpg', { mimeType: 'image/jpeg' }),
    ])

    const { container } = render(<AttachmentList blockId="block-1" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

describe('formatSize', () => {
  it('formats bytes', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1023)).toBe('1023 B')
  })

  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1024 * 1023)).toBe('1023.0 KB')
  })

  it('formats megabytes', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })
})
