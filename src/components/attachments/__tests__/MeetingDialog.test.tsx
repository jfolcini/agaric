/**
 * MeetingDialog (#5364): the `/meeting` dialog against the tauri mock, whose
 * `add_meeting` twin is pinned to the backend by `meeting_add.json`. Every
 * assertion re-queries the mock's state, never the call shape.
 */

import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { MeetingDialog } from '@/components/attachments/MeetingDialog'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, blockTags, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

/** The dialog the way BlockTree drives it: `onClose` clears the block id. */
function Harness({
  blockId,
  onClose,
  onCreated = vi.fn(),
}: {
  blockId: string
  onClose?: () => void
  onCreated?: () => void
}) {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <MeetingDialog
      linkBlockId={blockId}
      onCreated={onCreated}
      onClose={() => {
        onClose?.()
        setOpen(false)
      }}
    />
  )
}

function pageTitled(title: string): Record<string, unknown> | undefined {
  return [...blocks.values()].find(
    (b) => b['block_type'] === 'page' && b['content'] === title && b['deleted_at'] == null,
  )
}

function attachedNames(blockId: string): string[] {
  const rows = dispatch('list_attachments', { blockId }) as Array<Record<string, unknown>>
  return rows.map((row) => row['filename'] as string).toSorted()
}

/** A content block on a fresh journal day far from today. */
function blockOnDay(day: string): string {
  const pageId = dispatch('create_page_in_space', {
    parentId: null,
    content: day,
    spaceId: 'SPACE_PERSONAL',
  }) as string
  const created = dispatch('create_block', {
    blockType: 'content',
    content: 'Standup',
    parentId: pageId,
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
  }) as { id: string }
  return created.id
}

function file(name: string, bytes: number[], type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

async function dateInput(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText(t('meeting.dateLabel'))) as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MeetingDialog', () => {
  it('dates the meeting on the journal day the block is on', async () => {
    const blockId = blockOnDay('2031-03-14')
    render(<Harness blockId={blockId} />)

    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))
    expect(screen.getByLabelText(t('meeting.titleLabel'))).toHaveAttribute(
      'placeholder',
      t('meeting.defaultTitle'),
    )
  })

  it('dates the meeting today on a page that is no journal day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 0, 2, 10, 0))
    render(<Harness blockId={SEED_IDS.BLOCK_GS_1} />)

    const input = await dateInput()
    await waitFor(() => expect(input.value).toBe('2030-01-02'))
  })

  it('makes the page from the template, attaches the files and links it from the block', async () => {
    const user = userEvent.setup()
    const blockId = blockOnDay('2031-03-14')
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const { container } = render(
      <Harness blockId={blockId} onClose={onClose} onCreated={onCreated} />,
    )
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.type(screen.getByLabelText(t('meeting.titleLabel')), 'Sync')
    const templateSelect = container.ownerDocument.querySelector('select')
    await waitFor(() =>
      expect(
        templateSelect?.querySelector(`option[value="${SEED_IDS.PAGE_TMPL_MEETING}"]`),
      ).not.toBeNull(),
    )
    if (templateSelect === null) throw new Error('no template select')
    await user.selectOptions(templateSelect, SEED_IDS.PAGE_TMPL_MEETING)
    await user.upload(
      screen.getByLabelText(t('meeting.audioLabel')),
      file('call.ogg', [1, 2], 'audio/ogg'),
    )
    await user.upload(
      screen.getByLabelText(t('meeting.transcriptLabel')),
      file('notes.md', [91, 48]),
    )
    await user.type(screen.getByLabelText(t('meeting.summaryTextLabel')), 'Shipped.')
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onCreated).toHaveBeenCalledOnce()
    const page = pageTitled('Sync 2031-03-14')
    expect(page).toBeDefined()
    const pageId = page?.['id'] as string
    expect(properties.get(pageId)?.get('meeting_date')?.['value_date']).toBe('2031-03-14')
    const tagNames = [...(blockTags.get(pageId) ?? [])].map((id) => blocks.get(id)?.['content'])
    expect(tagNames).toEqual(['meeting'])
    expect(blocks.get(blockId)?.['content']).toBe(`Standup [[${pageId}]]`)
    const children = [...blocks.values()].filter(
      (b) => b['parent_id'] === pageId && b['deleted_at'] == null,
    )
    expect(children.map((b) => b['content'])).toContain('## Action items for Sync 2031-03-14')
    const recording = children.find((b) => attachedNames(b['id'] as string).length > 0)
    expect(attachedNames(recording?.['id'] as string)).toEqual(['call.ogg', 'notes.transcript.md'])
    expect(children.map((b) => b['content'])).toContain('Shipped.')
  })

  it('attaches the summary as a file when asked to', async () => {
    const user = userEvent.setup()
    const blockId = blockOnDay('2031-03-14')
    const onClose = vi.fn()
    render(<Harness blockId={blockId} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.click(screen.getByRole('radio', { name: t('meeting.summaryAsFile') }))
    await user.upload(screen.getByLabelText(t('meeting.summaryFileLabel')), file('recap.txt', [83]))
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const pageId = pageTitled('Meeting 2031-03-14')?.['id'] as string
    const recording = [...blocks.values()].find(
      (b) => b['parent_id'] === pageId && b['deleted_at'] == null,
    )
    expect(attachedNames(recording?.['id'] as string)).toEqual(['recap.summary.md'])
  })

  it('offers an Undo that takes the whole meeting back', async () => {
    const user = userEvent.setup()
    const blockId = blockOnDay('2031-03-14')
    const onClose = vi.fn()
    render(<Harness blockId={blockId} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(pageTitled('Meeting 2031-03-14')).toBeDefined()

    const [, options] = vi.mocked(toast.success).mock.calls[0] ?? []
    const action = (options as { action?: { onClick: () => void } } | undefined)?.action
    action?.onClick()

    await waitFor(() => expect(pageTitled('Meeting 2031-03-14')).toBeUndefined())
    expect(blocks.get(blockId)?.['content']).toBe('Standup')
  })

  it('Cancel closes the dialog and makes nothing', async () => {
    const user = userEvent.setup()
    const blockId = blockOnDay('2031-03-14')
    const onClose = vi.fn()
    render(<Harness blockId={blockId} onClose={onClose} />)
    await dateInput()

    await user.click(screen.getByRole('button', { name: t('action.cancel') }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(pageTitled('Meeting 2031-03-14')).toBeUndefined()
    expect(blocks.get(blockId)?.['content']).toBe('Standup')
  })

  it('keeps the dialog open and says why when the meeting is refused', async () => {
    const user = userEvent.setup()
    const blockId = blockOnDay('2031-03-14')
    dispatch('create_page_in_space', {
      parentId: null,
      content: 'Meeting 2031-03-14',
      spaceId: 'SPACE_PERSONAL',
    })
    const onClose = vi.fn()
    render(<Harness blockId={blockId} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledOnce())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: t('meeting.create') })).toBeEnabled()
    expect(blocks.get(blockId)?.['content']).toBe('Standup')
  })

  it('reports a failed call and keeps the dialog open', async () => {
    const user = userEvent.setup()
    const blockId = blockOnDay('2031-03-14')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'add_meeting') throw new Error('backend down')
      return dispatch(cmd, args)
    })
    const onClose = vi.fn()
    render(<Harness blockId={blockId} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))
    fireEvent.change(await dateInput(), { target: { value: '2031-03-15' } })

    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('meeting.createFailed')),
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(pageTitled('Meeting 2031-03-15')).toBeUndefined()
  })

  it('has no a11y violations', async () => {
    render(<Harness blockId={SEED_IDS.BLOCK_GS_1} />)
    const dialog = await screen.findByTestId('meeting-dialog')
    await waitFor(async () => {
      expect(await axe(dialog)).toHaveNoViolations()
    })
  })
})
