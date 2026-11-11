/**
 * Tests for the Import card's merge question (#6277 decision 7): picking a
 * Markdown file whose title names an existing page lists that page in a
 * dialog before anything imports, and only a confirm runs the import.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { ImportSection } from '@/components/settings/ImportSection'
import { t } from '@/lib/i18n'
import { useSpaceStore } from '@/stores/space'

const mockImportMarkdown = vi.fn()
vi.mock('@/lib/ipc-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-helpers')>()
  return { ...actual, importMarkdown: (...args: unknown[]) => mockImportMarkdown(...args) }
})

vi.mock('@/stores/tabs', () => ({
  useTabsStore: (selector: (s: { navigateToPage: () => void }) => unknown) =>
    selector({ navigateToPage: vi.fn() }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const listImportMerges = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockImportMarkdown.mockReset()
  listImportMerges.mockReset()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE',
    availableSpaces: [{ id: 'SPACE', name: 'Personal', accent_color: 'accent-blue' }],
    isReady: true,
  })
  stubInvoke(vi.mocked(invoke), {
    list_import_merges: (args) => listImportMerges(args),
    list_all_tags_in_space: () => [],
    batch_resolve: () => [],
  })
  mockImportMarkdown.mockResolvedValue({
    page_title: 'Plan',
    page_id: 'PLAN',
    blocks_created: 1,
    properties_set: 0,
    collapsed: [],
    warnings: [],
    anchors: [],
    deferred: [],
    merged: [],
  })
})

async function pick(...names: string[]): Promise<void> {
  const input = screen.getByTestId('import-file-input') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: names.map((name) => new File(['body'], name)) })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('ImportSection merge question', () => {
  it('lists the existing page and imports once the user confirms', async () => {
    const user = userEvent.setup()
    listImportMerges.mockReturnValue([{ page_id: 'PLAN', title: 'Plan' }])
    const { baseElement } = render(<ImportSection />)

    await pick('Plan.md')

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('listitem')).toHaveTextContent('Plan')
    expect(listImportMerges).toHaveBeenCalledWith({ spaceId: 'SPACE', filenames: ['Plan.md'] })
    expect(mockImportMarkdown).not.toHaveBeenCalled()
    expect(await axe(baseElement)).toHaveNoViolations()

    await user.click(within(dialog).getByRole('button', { name: t('data.importMergeConfirm') }))

    await waitFor(() => expect(mockImportMarkdown).toHaveBeenCalledOnce())
    expect(
      await screen.findByText(t('data.importResultUpToDate', { count: 1 }), { exact: false }),
    ).toBeInTheDocument()
  })

  it('reports an update that added no block as a success, not as nothing imported', async () => {
    const user = userEvent.setup()
    listImportMerges.mockReturnValue([{ page_id: 'PLAN', title: 'Plan' }])
    mockImportMarkdown.mockResolvedValue({
      page_title: 'Plan',
      page_id: 'PLAN',
      blocks_created: 0,
      properties_set: 0,
      collapsed: [],
      warnings: [],
      anchors: [],
      deferred: [],
      merged: [],
    })
    render(<ImportSection />)

    await pick('Plan.md')
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('data.importMergeConfirm') }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('does not call a run all failed when an update that added no block succeeded beside a failure', async () => {
    const user = userEvent.setup()
    listImportMerges.mockReturnValue([{ page_id: 'PLAN', title: 'Plan' }])
    mockImportMarkdown
      .mockResolvedValueOnce({
        page_title: 'Plan',
        page_id: 'PLAN',
        blocks_created: 0,
        properties_set: 0,
        collapsed: [],
        warnings: [],
        anchors: [],
        deferred: [],
        merged: [],
      })
      .mockRejectedValueOnce({ kind: 'validation', message: 'line 2: refused' })
    render(<ImportSection />)

    await pick('Plan.md', 'Bad.md')
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('data.importMergeConfirm') }))

    const result = await screen.findByTestId('import-result')
    expect(result).toHaveTextContent(t('data.importResultUpToDate', { count: 1 }))
    expect(screen.queryByTestId('import-result-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('import-failures-heading')).toBeInTheDocument()
  })

  it('reports a re-import that changed nothing as already up to date', async () => {
    const user = userEvent.setup()
    listImportMerges.mockReturnValue([{ page_id: 'PLAN', title: 'Plan' }])
    mockImportMarkdown.mockResolvedValueOnce({
      page_title: 'Plan',
      page_id: 'PLAN',
      blocks_created: 0,
      properties_set: 0,
      collapsed: [],
      warnings: [],
      anchors: [],
      deferred: [],
      merged: [],
    })
    render(<ImportSection />)

    await pick('Plan.md')
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('data.importMergeConfirm') }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(t('data.importUpToDate'))
    expect(toast.error).not.toHaveBeenCalled()
    const result = await screen.findByTestId('import-result')
    expect(result).toHaveTextContent(t('data.importResultUpToDate', { count: 1 }))
    expect(result).not.toHaveTextContent(t('data.importResultUpdated', { count: 1 }))
  })

  it('reports the pages a run updated apart from those already up to date', async () => {
    const user = userEvent.setup()
    listImportMerges.mockReturnValue([
      { page_id: 'PLAN', title: 'Plan' },
      { page_id: 'LOG', title: 'Log' },
    ])
    mockImportMarkdown
      .mockResolvedValueOnce({
        page_title: 'Plan',
        page_id: 'PLAN',
        blocks_created: 1,
        properties_set: 0,
        collapsed: [],
        warnings: [],
        anchors: [],
        deferred: [],
        merged: [{ device_id: 'D', seq: 1 }],
      })
      .mockResolvedValueOnce({
        page_title: 'Log',
        page_id: 'LOG',
        blocks_created: 0,
        properties_set: 0,
        collapsed: [],
        warnings: [],
        anchors: [],
        deferred: [],
        merged: [],
      })
    render(<ImportSection />)

    await pick('Plan.md', 'Log.md')
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('data.importMergeConfirm') }))

    const result = await screen.findByTestId('import-result')
    expect(result).toHaveTextContent(t('data.importResultUpdated', { count: 1 }))
    expect(result).toHaveTextContent(t('data.importResultUpToDate', { count: 1 }))
  })

  it('imports nothing when the user declines', async () => {
    const user = userEvent.setup()
    listImportMerges.mockReturnValue([{ page_id: 'PLAN', title: 'Plan' }])
    render(<ImportSection />)

    await pick('Plan.md')
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: t('dialog.cancel') }))

    expect(
      await screen.findByTestId('import-result-cancelled', undefined, { timeout: 2000 }),
    ).toHaveTextContent(t('data.importCancelled', { count: 0 }))
    expect(mockImportMarkdown).not.toHaveBeenCalled()
  })

  it('imports nothing and says why when the pages cannot be read', async () => {
    listImportMerges.mockRejectedValue({ kind: 'database', message: 'disk gone' })
    render(<ImportSection />)

    await pick('Plan.md')

    expect(await screen.findByTestId('import-result-cancelled')).toBeInTheDocument()
    expect(screen.getByTestId('import-warning-item')).toHaveTextContent(
      t('data.importMergeCheckFailed', { reason: 'disk gone' }),
    )
    expect(mockImportMarkdown).not.toHaveBeenCalled()
  })
})
