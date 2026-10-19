/**
 * Page mode's attachments (#5743, #5915): what `PageAttachments` holds, and
 * what each block's view draws of it over the mock backend: the previews and
 * the badge, an image opened full screen, a file opened, and the reads and
 * writes behind them refused.
 *
 * Equivalent mutants, accepted:
 * - `take`'s filter dropped, or `list.length > 0` → `true` or `>= 0`: a
 *   block with no attachment then holds its own empty list, which reads as
 *   the shared one does.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  onTestFinished,
  vi,
} from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { EnteringIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import type { Row } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  blockEl,
  FakeTasks,
  getIn,
  mountNodeViews,
  SCOPE,
  seedPage,
  settleReads,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PageAttachments } from '@/editor/page-mode/page-attachments'
import type { AttachmentRow, PropertyRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const row = (id: string, blockId: string): AttachmentRow => ({
  id,
  block_id: blockId,
  mime_type: 'text/plain',
  filename: `${id}.txt`,
  size_bytes: 2,
  fs_path: `${id}.txt`,
  created_at: 0,
  content_hash: '',
})

describe('PageAttachments', () => {
  it('holds each block’s attachments as a read found them, none for a block with none', () => {
    const attachments = new PageAttachments({ A: [row('a1', 'A'), row('a2', 'A')], B: [] })

    expect(attachments.of('A').map(({ id }) => id)).toEqual(['a1', 'a2'])
    expect(attachments.of('B')).toEqual([])
    expect(attachments.of('C')).toEqual([])
  })

  it('a read replaces the last, and tells the listeners, until they unsubscribe', () => {
    const attachments = new PageAttachments({ A: [row('a1', 'A')] })
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = attachments.subscribe(first)
    attachments.subscribe(second)

    attachments.take({ B: [row('b1', 'B')] })
    expect(attachments.of('A')).toEqual([])
    expect(attachments.of('B').map(({ id }) => id)).toEqual(['b1'])
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1])

    unsubscribe()
    attachments.take({})
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2])
  })
})

describe('a block’s attachments in its view', () => {
  let teardown: (() => void) | null = null
  let objectUrl: MockInstance<typeof URL.createObjectURL>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IntersectionObserver', EnteringIntersectionObserver)
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
    // As the IPC does: the mock's rows are its own.
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      structuredClone(dispatch(cmd, args)),
    )
    objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment')
    onTestFinished(() => objectUrl.mockRestore())
  })

  afterEach(() => {
    teardown?.()
    teardown = null
    vi.unstubAllGlobals()
  })

  function attach(id: string, filename: string, mimeType: string, bytes: number[]): void {
    dispatch('add_attachment_with_bytes', { blockId: id, filename, mimeType, bytes })
  }

  /** A page of `texts` in the backend, drawn in page mode's view with what the backend holds. */
  async function open(texts: string[], before: (ids: string[]) => void = () => {}) {
    const { ids } = seedPage(texts)
    before(ids)
    const tasks = new FakeTasks()
    tasks.attachments.take(
      Object.fromEntries(
        ids.map((id) => [id, dispatch('list_attachments', { blockId: id }) as AttachmentRow[]]),
      ),
    )
    const rows = ids.map((id, i): Row => [id, 0, texts[i] as string])
    const mounted = mountNodeViews(rows, tasks)
    teardown = () => {
      mounted.unmount()
      mounted.editor.destroy()
    }
    await settleReads()
    return { ...mounted, ids }
  }

  const written = (id: string, key: string) =>
    (dispatch('get_properties', { blockId: id }) as PropertyRow[]).find((p) => p.key === key)
      ?.value_text

  it('draws the previews and the badge under the text, outside it, with no a11y violations', async () => {
    const { container, ids } = await open(['notes', 'plain'], ([notes]) => {
      attach(notes as string, 'notes.txt', 'text/plain', [...new TextEncoder().encode('hello')])
    })
    const block = blockEl(container, ids[0] as string)

    expect(getIn(block, '[data-testid="markdown-attachment-body"]')).toHaveTextContent('hello')
    expect(getIn(block, '[data-testid="attachment-badge"]').getAttribute('aria-label')).toBe(
      t('block.attachments', { count: 1 }),
    )
    expect(getIn(block, '.page-block-metadata')).not.toHaveAttribute('data-priority')
    expect(block.querySelector('.page-block-content [data-testid="attachment-badge"]')).toBeNull()
    expect(blockEl(container, ids[1] as string).querySelector('.page-block-metadata')).toBeNull()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('a read that finds the attachment gone takes the row off', async () => {
    const { container, ids, tasks } = await open(['notes'], ([notes]) => {
      attach(notes as string, 'notes.txt', 'text/plain', [104, 105])
    })

    act(() => tasks.attachments.take({}))

    expect(blockEl(container, ids[0] as string).querySelector('.page-block-metadata')).toBeNull()
  })

  it('an image opens full screen, and Escape closes it', async () => {
    const { container, ids } = await open(['photo'], ([photo]) => {
      attach(photo as string, 'photo.png', 'image/png', [137, 80, 78, 71])
    })

    fireEvent.click(
      within(blockEl(container, ids[0] as string)).getByRole('button', {
        name: t('attachment.openImageFullscreen', { filename: 'photo.png' }),
      }),
    )
    const lightbox = await screen.findByRole('dialog', { name: 'photo.png' })
    expect(lightbox).toBeVisible()

    fireEvent.keyDown(lightbox, { key: 'Escape' })
    await settleReads()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a file opens as a download of the bytes the backend holds', async () => {
    const { container, ids } = await open(['archive'], ([archive]) => {
      attach(archive as string, 'notes.zip', 'application/zip', [80, 75, 3, 4])
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    onTestFinished(() => click.mockRestore())

    await act(async () => {
      fireEvent.click(
        within(blockEl(container, ids[0] as string)).getByRole('button', {
          name: t('attachment.openFile', { filename: 'notes.zip' }),
        }),
      )
    })
    await settleReads()

    expect(click).toHaveBeenCalledTimes(1)
    const download = click.mock.contexts[0] as HTMLAnchorElement
    expect(download.download).toBe('notes.zip')
    const blob = objectUrl.mock.calls.at(-1)?.[0] as Blob
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([80, 75, 3, 4])
  })

  it('bytes the backend will not read show the image’s error, and a file’s open says so', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'read_attachment') throw new Error('database locked')
      return structuredClone(dispatch(cmd, args))
    })
    const { container, ids } = await open(['photo', 'archive'], ([photo, archive]) => {
      attach(photo as string, 'photo.png', 'image/png', [137, 80, 78, 71])
      attach(archive as string, 'notes.zip', 'application/zip', [80, 75, 3, 4])
    })

    expect(
      getIn(blockEl(container, ids[0] as string), '[data-testid="attachment-image-error"]'),
    ).toHaveTextContent(t('attachment.imageLoadFailed'))
    await act(async () => {
      fireEvent.click(
        within(blockEl(container, ids[1] as string)).getByRole('button', {
          name: t('attachment.openFile', { filename: 'notes.zip' }),
        }),
      )
    })
    await settleReads()

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('attachments.loadFailed'))
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('an image’s size, alignment and caption the backend refuses say so, and none is written', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_property') throw new Error('database locked')
      return structuredClone(dispatch(cmd, args))
    })
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { container, ids } = await open(['photo'], ([photo]) => {
      attach(photo as string, 'photo.png', 'image/png', [137, 80, 78, 71])
    })
    const photo = ids[0] as string
    const block = blockEl(container, photo)
    const showToolbar = () => fireEvent.focus(getIn(block, '[data-testid="image-resize-wrapper"]'))

    showToolbar()
    await act(async () => {
      fireEvent.click(getIn(block, '[data-testid="image-resize-50"]'))
    })
    await settleReads()
    expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith(t('imageResize.saveFailed'))
    expect(getIn(block, '[data-testid="image-resize-wrapper"]').style.maxWidth).not.toBe('50%')

    showToolbar()
    await act(async () => {
      fireEvent.click(getIn(block, '[data-testid="image-align-right"]'))
    })
    await settleReads()
    expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith(t('imageAlign.saveFailed'))
    expect(getIn(block, '[data-testid="attachment-section"]')).not.toHaveAttribute(
      'data-alignment',
      'right',
    )

    const caption = getIn(block, '[data-testid="image-caption-input"]')
    fireEvent.focus(caption)
    fireEvent.change(caption, { target: { value: 'A photo' } })
    await act(async () => {
      fireEvent.blur(caption)
    })
    await settleReads()
    expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith(t('imageCaption.saveFailed'))
    expect(caption).toHaveValue('')

    expect(
      ['image_width', 'image_alignment', 'image_caption'].map((k) => written(photo, k)),
    ).toEqual([undefined, undefined, undefined])
  })
})
