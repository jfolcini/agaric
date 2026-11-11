/**
 * MeetingDialog (#5364): the `/meeting` dialog against the tauri mock, whose
 * `add_meeting` twin is pinned to the backend by `meeting_add.json`. Every
 * assertion re-queries the mock's state, never the call shape.
 */

import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { MeetingDialog } from '@/components/attachments/MeetingDialog'
import { getAttachmentInvalidationKey } from '@/lib/attachment-invalidation'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { PREFERENCES, writePreference } from '@/lib/preferences'
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
  localStorage.clear()
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

  it('keeps a date picked before the block’s day arrives', async () => {
    const blockId = blockOnDay('2031-03-14')
    let releaseBlock = (): void => {}
    const blockRead = new Promise<void>((resolve) => {
      releaseBlock = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'get_block') await blockRead
      return dispatch(cmd, args)
    })
    render(<Harness blockId={blockId} />)

    fireEvent.change(await dateInput(), { target: { value: '2031-05-01' } })
    releaseBlock()

    await waitFor(() =>
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_block')).toHaveLength(2),
    )
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-05-01'))
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

describe('MeetingDialog — the palette’s New meeting and the remembered template', () => {
  async function templateSelect(container: HTMLElement): Promise<HTMLSelectElement> {
    const select = container.ownerDocument.querySelector('select')
    if (select === null) throw new Error('no template select')
    await waitFor(() =>
      expect(select.querySelector(`option[value="${SEED_IDS.PAGE_TMPL_MEETING}"]`)).not.toBeNull(),
    )
    return select
  }

  it('opens on the template the last meeting in this space was made from', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const first = render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await user.selectOptions(await templateSelect(first.container), SEED_IDS.PAGE_TMPL_MEETING)
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    first.unmount()

    const second = render(<Harness blockId={blockOnDay('2031-03-21')} />)
    const select = await templateSelect(second.container)
    await waitFor(() => expect(select.value).toBe(SEED_IDS.PAGE_TMPL_MEETING))
  })

  it('makes the meeting with no template when the remembered one is no longer a template', async () => {
    const user = userEvent.setup()
    writePreference(PREFERENCES.meetingTemplate, SEED_IDS.BLOCK_GS_1, 'SPACE_PERSONAL')
    const onClose = vi.fn()
    const { container } = render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await templateSelect(container)

    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const pageId = pageTitled('Meeting 2031-03-14')?.['id']
    const children = [...blocks.values()].filter(
      (b) => b['parent_id'] === pageId && b['deleted_at'] == null,
    )
    expect(children).toHaveLength(1)
  })

  it('links a meeting with no block from its day’s journal', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreated = vi.fn()
    render(<MeetingDialog onClose={onClose} onCreated={onCreated} />)
    fireEvent.change(await dateInput(), { target: { value: '2031-04-01' } })

    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const pageId = pageTitled('Meeting 2031-04-01')?.['id'] as string
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ page_id: pageId }))
    const day = pageTitled('2031-04-01')?.['id']
    const links = [...blocks.values()].filter(
      (b) => b['parent_id'] === day && b['deleted_at'] == null,
    )
    expect(links.map((b) => b['content'])).toEqual([`[[${pageId}]]`])
  })
})

describe('MeetingDialog — mutation triage (#5364)', () => {
  function templatePage(title: string): string {
    const id = dispatch('create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: 'SPACE_PERSONAL',
    }) as string
    dispatch('set_property', {
      blockId: id,
      key: 'template',
      value: {
        value_text: 'true',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    return id
  }

  async function created(onClose: ReturnType<typeof vi.fn>) {
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  }

  it('dates the meeting on a page titled only by a day, not on one that holds a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 0, 2, 10, 0))
    for (const title of ['Notes 2031-03-14', '2031-03-14 notes']) {
      const blockId = blockOnDay(title)
      const { unmount } = render(<Harness blockId={blockId} />)
      await waitFor(() =>
        expect(
          mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_block').length,
        ).toBeGreaterThan(0),
      )
      await waitFor(async () => expect((await dateInput()).value).toBe('2030-01-02'))
      unmount()
      mockedInvoke.mockClear()
    }
  })

  it('keeps today on a page that is no day once the block’s page has been read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 0, 2, 10, 0))
    let read = (): void => {}
    const pageRead = new Promise<void>((resolve) => {
      read = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const result = dispatch(cmd, args)
      if (cmd === 'get_block') read()
      return result
    })
    render(<Harness blockId={SEED_IDS.BLOCK_GS_1} />)
    await pageRead
    await waitFor(async () => expect((await dateInput()).value).toBe('2030-01-02'))
  })

  it('opens on the remembered template among several, and remembers no template too', async () => {
    const user = userEvent.setup()
    const other = templatePage('Retro Template')
    writePreference(PREFERENCES.meetingTemplate, other, 'SPACE_PERSONAL')
    const onClose = vi.fn()
    const first = render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    const select = first.container.ownerDocument.querySelector('select')
    await waitFor(() => expect(select?.value).toBe(other))

    if (select === null) throw new Error('no template select')
    await user.selectOptions(select, 'none')
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await created(onClose)
    first.unmount()

    const second = render(<Harness blockId={blockOnDay('2031-03-21')} />)
    const again = second.container.ownerDocument.querySelector('select')
    await waitFor(() => expect(again?.querySelector(`option[value="${other}"]`)).not.toBeNull())
    expect(again?.value).toBe('none')
  })

  it('trims the title, and sends written text only as a written summary', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.type(screen.getByLabelText(t('meeting.titleLabel')), '  Sync  ')
    await user.type(screen.getByLabelText(t('meeting.summaryTextLabel')), 'Written.')
    await user.click(screen.getByRole('radio', { name: t('meeting.summaryAsFile') }))
    await user.upload(screen.getByLabelText(t('meeting.summaryFileLabel')), file('recap.txt', [83]))
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await created(onClose)

    const pageId = pageTitled('Sync 2031-03-14')?.['id']
    const children = [...blocks.values()].filter(
      (b) => b['parent_id'] === pageId && b['deleted_at'] == null,
    )
    expect(children.map((b) => b['content'])).not.toContain('Written.')
    expect(attachedNames(children[0]?.['id'] as string)).toEqual(['recap.summary.md'])
  })

  it('makes no summary of whitespace, and keeps its summary mode when the active one is pressed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.click(screen.getByRole('radio', { name: t('meeting.summaryAsText') }))
    expect(screen.getByLabelText(t('meeting.summaryTextLabel'))).toBeInTheDocument()
    await user.type(screen.getByLabelText(t('meeting.summaryTextLabel')), '   ')
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await created(onClose)

    const pageId = pageTitled('Meeting 2031-03-14')?.['id']
    const children = [...blocks.values()].filter(
      (b) => b['parent_id'] === pageId && b['deleted_at'] == null,
    )
    expect(children).toHaveLength(1)
  })

  it('shows it is saving and cannot be sent again or closed until the meeting is made', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'add_meeting') await held
      return dispatch(cmd, args)
    })
    const onClose = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    const saving = await screen.findByRole('button', { name: t('meeting.creating') })
    expect(saving).toBeDisabled()
    expect(saving.querySelector('[role="status"], svg')).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()

    finish()
    await created(onClose)
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'add_meeting')).toHaveLength(1)
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await dateInput()

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
    expect(pageTitled('Meeting 2031-03-14')).toBeUndefined()
  })

  it('names the meeting it made in the toast, the default title included', async () => {
    const user = userEvent.setup()
    for (const [typed, title] of [
      ['Sync', 'Sync 2031-03-14'],
      ['', 'Meeting 2031-03-21'],
    ] as const) {
      vi.mocked(toast.success).mockClear()
      const onClose = vi.fn()
      const day = title.slice(-10)
      const { unmount } = render(<Harness blockId={blockOnDay(day)} onClose={onClose} />)
      await waitFor(async () => expect((await dateInput()).value).toBe(day))
      if (typed !== '') await user.type(screen.getByLabelText(t('meeting.titleLabel')), typed)
      await user.click(screen.getByRole('button', { name: t('meeting.create') }))
      await created(onClose)
      const [message, options] = vi.mocked(toast.success).mock.calls[0] ?? []
      expect(message).toBe(t('meeting.created', { title }))
      expect((options as { action?: { label: string } } | undefined)?.action?.label).toBe(
        t('action.undo'),
      )
      unmount()
    }
  })

  it('reloads the link’s page after Undo, and says so when Undo fails', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreated = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} onCreated={onCreated} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await created(onClose)
    const [, options] = vi.mocked(toast.success).mock.calls[0] ?? []
    const undo = (options as { action?: { onClick: () => void } } | undefined)?.action

    undo?.onClick()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2))
    expect(pageTitled('Meeting 2031-03-14')).toBeUndefined()

    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'revert_ops') throw new Error('backend down')
      return dispatch(cmd, args)
    })
    undo?.onClick()
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('meeting.undoFailed')),
    )
    expect(onCreated).toHaveBeenCalledTimes(2)
  })
})

describe('MeetingDialog — mutation triage (#6435)', () => {
  let warn: MockInstance<typeof logger.warn>
  let error: MockInstance<typeof logger.error>

  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
  })

  function templateIn(spaceId: string, title: string): string {
    const id = dispatch('create_page_in_space', {
      parentId: null,
      content: title,
      spaceId,
    }) as string
    dispatch('set_property', {
      blockId: id,
      key: 'template',
      value: {
        value_text: 'true',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    return id
  }

  function templateOptions(): string[] {
    const select = document.querySelector('select')
    if (select === null) throw new Error('no template select')
    return [...select.options].map((option) => option.value)
  }

  /** Lets every IPC already answered run its continuations, then renders. */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  function failing(command: string, failure: Error): void {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === command) throw failure
      return dispatch(cmd, args)
    })
  }

  it('names its parts: description, template, no template and the summary choice', async () => {
    render(<Harness blockId={blockOnDay('2031-03-14')} />)
    await waitFor(() => expect(templateOptions()).toContain(SEED_IDS.PAGE_TMPL_MEETING))

    expect(screen.getByText(t('meeting.description'))).toBeInTheDocument()
    const select = screen.getByLabelText(t('meeting.templateLabel')) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(within(select).getByRole('option', { name: t('meeting.noTemplate') })).toHaveValue(
      'none',
    )
    expect(screen.getByText(t('meeting.summaryLabel'), { selector: 'legend' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup')).toHaveAccessibleName(t('meeting.summaryLabel'))
  })

  it('shows today and no template until the block’s day and the templates arrive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 0, 2, 10, 0))
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'get_block' || cmd === 'query_by_property') return new Promise(() => {})
      return dispatch(cmd, args)
    })
    render(<Harness blockId={blockOnDay('2031-03-14')} />)

    expect((await dateInput()).value).toBe('2030-01-02')
    expect(templateOptions()).toEqual(['none'])
  })

  it('dates a meeting with no block today, with nothing to log', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 0, 2, 10, 0))
    render(<MeetingDialog onClose={vi.fn()} onCreated={vi.fn()} />)
    await waitFor(() => expect(templateOptions()).toContain(SEED_IDS.PAGE_TMPL_MEETING))
    await settle()

    expect((await dateInput()).value).toBe('2030-01-02')
    expect(warn).not.toHaveBeenCalled()
  })

  it('dates the meeting today, with nothing to log, once both reads find a page that is no day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 0, 2, 10, 0))
    render(<Harness blockId={SEED_IDS.BLOCK_GS_1} />)
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_block')).toHaveLength(2),
    )
    await settle()

    expect((await dateInput()).value).toBe('2030-01-02')
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs a block it cannot read and keeps today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2030, 0, 2, 10, 0))
    const failure = new Error('backend down')
    failing('get_block', failure)
    render(<Harness blockId={blockOnDay('2031-03-14')} />)

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'MeetingDialog',
        'could not read the block’s day',
        undefined,
        failure,
      ),
    )
    expect((await dateInput()).value).toBe('2030-01-02')
  })

  it('logs templates it cannot list and offers no template', async () => {
    const failure = new Error('backend down')
    failing('query_by_property', failure)
    render(<Harness blockId={blockOnDay('2031-03-14')} />)

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'MeetingDialog',
        'could not list the templates',
        undefined,
        failure,
      ),
    )
    expect(templateOptions()).toEqual(['none'])
  })

  it('lists the templates of the space it is in, not of the one it left', async () => {
    const work = templateIn('SPACE_WORK', 'Work Template')
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      const scope = (args as { scope?: { space_id?: string } } | undefined)?.scope
      if (cmd === 'query_by_property' && scope?.space_id === 'SPACE_PERSONAL') await held
      return dispatch(cmd, args)
    })
    render(<MeetingDialog onClose={vi.fn()} onCreated={vi.fn()} />)

    await act(() => useSpaceStore.setState({ currentSpaceId: 'SPACE_WORK' }))
    await waitFor(() => expect(templateOptions()).toEqual(['none', work]))
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(templateOptions()).toEqual(['none', work])
  })

  it('cannot be sent before a space is chosen', async () => {
    useSpaceStore.setState({ currentSpaceId: null })
    render(<MeetingDialog onClose={vi.fn()} onCreated={vi.fn()} />)
    await settle()

    expect(screen.getByRole('button', { name: t('meeting.create') })).toBeDisabled()
  })

  it('names the meeting in the toast with its title trimmed on both sides', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.type(screen.getByLabelText(t('meeting.titleLabel')), '  Sync  ')
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const [message] = vi.mocked(toast.success).mock.calls[0] ?? []
    expect(message).toBe(t('meeting.created', { title: 'Sync 2031-03-14' }))
  })

  it('drops a summary file picked before switching back to written text', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.click(screen.getByRole('radio', { name: t('meeting.summaryAsFile') }))
    await user.upload(screen.getByLabelText(t('meeting.summaryFileLabel')), file('recap.txt', [83]))
    await user.click(screen.getByRole('radio', { name: t('meeting.summaryAsText') }))
    await user.type(screen.getByLabelText(t('meeting.summaryTextLabel')), 'Written.')
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const pageId = pageTitled('Meeting 2031-03-14')?.['id']
    const children = [...blocks.values()].filter(
      (b) => b['parent_id'] === pageId && b['deleted_at'] == null,
    )
    expect(children.map((b) => b['content'])).toContain('Written.')
    expect(children.flatMap((b) => attachedNames(b['id'] as string))).toEqual([])
  })

  it('has every attachment list re-read after the meeting is made and after its Undo', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreated = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} onCreated={onCreated} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))
    const before = getAttachmentInvalidationKey()

    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(getAttachmentInvalidationKey()).toBe(before + 1)

    const [, options] = vi.mocked(toast.success).mock.calls[0] ?? []
    ;(options as { action?: { onClick: () => void } } | undefined)?.action?.onClick()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2))
    expect(getAttachmentInvalidationKey()).toBe(before + 2)
  })

  it('logs a refused meeting with the block it was for', async () => {
    const user = userEvent.setup()
    const blockId = blockOnDay('2031-03-14')
    const failure = new Error('backend down')
    failing('add_meeting', failure)
    render(<Harness blockId={blockId} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

    await user.click(screen.getByRole('button', { name: t('meeting.create') }))

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'MeetingDialog',
        'meeting.createFailed (IPC error)',
        { linkBlockId: blockId },
        failure,
      ),
    )
  })

  it('logs a failed Undo', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
    await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))
    await user.click(screen.getByRole('button', { name: t('meeting.create') }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const failure = new Error('backend down')
    failing('revert_ops', failure)

    const [, options] = vi.mocked(toast.success).mock.calls[0] ?? []
    ;(options as { action?: { onClick: () => void } } | undefined)?.action?.onClick()

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'MeetingDialog',
        'meeting.undoFailed (IPC error)',
        undefined,
        failure,
      ),
    )
  })

  it('submits without letting the browser send the form', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const prevented: boolean[] = []
    const record = (event: Event) => prevented.push(event.defaultPrevented)
    document.addEventListener('submit', record)
    try {
      render(<Harness blockId={blockOnDay('2031-03-14')} onClose={onClose} />)
      await waitFor(async () => expect((await dateInput()).value).toBe('2031-03-14'))

      await user.click(screen.getByRole('button', { name: t('meeting.create') }))

      await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
      expect(prevented).toEqual([true])
    } finally {
      document.removeEventListener('submit', record)
    }
  })
})
