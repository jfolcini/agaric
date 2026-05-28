/**
 * Tests for SpaceJournalTemplateEditor (PEND-30 D-2 extraction).
 *
 * Coverage:
 *  - Initial value seeded via lazy `useState`.
 *  - Saving via blur calls `setProperty`.
 *  - Clearing via blur calls `deleteProperty`.
 *  - Unchanged trim is a no-op (no IPC).
 *  - On IPC failure: toast.error fires + revert to last committed value.
 *  - The collapsible Examples panel renders + expands on summary click.
 *  - Successful commit calls `onCommitted(spaceId, value)` so parent
 *    cache reflects the new committed value.
 *  - SOURCE-LEVEL: the `journalTemplateInitializedRef` flag is gone.
 *  - SOURCE-LEVEL: `useRef` is not used at all in the new module.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { t } from '@/lib/i18n'

import { SpaceJournalTemplateEditor } from '../SpaceJournalTemplateEditor'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'set_property') return null
    if (cmd === 'delete_property') return null
    return null
  })
})

describe('SpaceJournalTemplateEditor', () => {
  it('seeds the textarea with initialValue on mount', () => {
    const seeded = `## Standup\n- TODOs`
    render(
      <SpaceJournalTemplateEditor spaceId="SPACE_1" initialValue={seeded} onCommitted={() => {}} />,
    )
    const textarea = screen.getByLabelText(t('space.journalTemplateLabel')) as HTMLTextAreaElement
    expect(textarea.value).toBe(seeded)
  })

  it('saving via blur calls setProperty with the entered value', async () => {
    const user = userEvent.setup()
    const onCommitted = vi.fn()
    render(
      <SpaceJournalTemplateEditor spaceId="SPACE_1" initialValue="" onCommitted={onCommitted} />,
    )

    const textarea = screen.getByLabelText(t('space.journalTemplateLabel')) as HTMLTextAreaElement
    await user.click(textarea)
    await user.type(textarea, 'Daily focus')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'set_property',
        expect.objectContaining({
          blockId: 'SPACE_1',
          key: 'journal_template',
          value: expect.objectContaining({ value_text: 'Daily focus' }),
        }),
      )
    })
    await waitFor(() => {
      expect(onCommitted).toHaveBeenCalledWith('SPACE_1', 'Daily focus')
    })
  })

  it('clearing via blur calls deleteProperty', async () => {
    const user = userEvent.setup()
    render(
      <SpaceJournalTemplateEditor
        spaceId="SPACE_1"
        initialValue="Existing template"
        onCommitted={() => {}}
      />,
    )

    const textarea = screen.getByLabelText(t('space.journalTemplateLabel')) as HTMLTextAreaElement
    await user.clear(textarea)
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'delete_property',
        expect.objectContaining({ blockId: 'SPACE_1', key: 'journal_template' }),
      )
    })
  })

  it('unchanged trim is a no-op (no IPC)', async () => {
    const user = userEvent.setup()
    render(
      <SpaceJournalTemplateEditor spaceId="SPACE_1" initialValue="Stable" onCommitted={() => {}} />,
    )

    const textarea = screen.getByLabelText(t('space.journalTemplateLabel')) as HTMLTextAreaElement
    await user.click(textarea)
    await user.tab()

    await new Promise((r) => setTimeout(r, 0))
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_property', expect.anything())
  })

  it('reverts to the last committed value and toasts on IPC failure', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') throw new Error('IPC offline')
      return null
    })
    const user = userEvent.setup()
    render(
      <SpaceJournalTemplateEditor
        spaceId="SPACE_1"
        initialValue="Original"
        onCommitted={() => {}}
      />,
    )

    const textarea = screen.getByLabelText(t('space.journalTemplateLabel')) as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, 'Edited but failing')
    await user.tab()

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('space.journalTemplateFailed'))
    })
    await waitFor(() => {
      expect(textarea.value).toBe('Original')
    })
  })

  it('collapsible Examples panel renders and expands on summary click (UX-375)', async () => {
    const user = userEvent.setup()
    render(<SpaceJournalTemplateEditor spaceId="SPACE_1" initialValue="" onCommitted={() => {}} />)

    const panel = screen.getByTestId('journal-template-examples') as HTMLDetailsElement
    expect(panel.open).toBe(false)

    const summary = within(panel).getByText(t('space.journalTemplateExamplesLabel'))
    await user.click(summary)
    await waitFor(() => {
      expect(panel.open).toBe(true)
    })

    expect(within(panel).getByText(t('space.journalTemplateExample1Title'))).toBeInTheDocument()
    expect(within(panel).getByText(t('space.journalTemplateExample2Title'))).toBeInTheDocument()
    expect(panel.textContent ?? '').toContain('<% today %>')
  })

  // SOURCE-LEVEL guard — the canary `journalTemplateInitializedRef`
  // from pre-PEND-30 D-2 must be gone as a declaration / runtime
  // symbol. Read the source on disk and assert no `useRef` call and no
  // identifier-style declaration of the old ref name.
  it('source no longer declares journalTemplateInitializedRef and uses no useRef', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'SpaceJournalTemplateEditor.tsx'), 'utf8')
    // No `useRef(...)` call anywhere in the file — lazy `useState`
    // does the whole job for the initial-vs-controlled-value seam.
    expect(src).not.toMatch(/\buseRef\s*\(/)
    expect(src).not.toMatch(/from 'react'.*useRef/)
    // The old ref must not appear as a const declaration. (It's
    // mentioned in the JSDoc to explain the refactor — that's fine
    // and doesn't make it a runtime symbol.)
    expect(src).not.toMatch(/const\s+journalTemplateInitializedRef\s*=/)
  })
})
