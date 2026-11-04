import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'

const mockedReadAttachment = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-helpers')>()),
  readAttachment: mockedReadAttachment,
}))

vi.mock('@/components/RichContentRenderer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/components/RichContentRenderer')>()
  return { ...mod, renderRichContent: vi.fn(mod.renderRichContent) }
})

import { AttachmentRenderer } from '@/components/attachments/AttachmentRenderer'
import { renderRichContent } from '@/components/RichContentRenderer'
import { t } from '@/lib/i18n'

const TRANSCRIPT = [
  '# Standup',
  '[00:00] **Alice:** Morning.',
  '[00:10] **Bob:** Hi.',
  '[01:00] **Alice:** Bye.',
].join('\n\n')

const audio = {
  id: 'att-audio',
  filename: 'rec.ogg',
  fs_path: 'attachments/att-audio',
  mime_type: 'audio/ogg',
  size_bytes: 3,
}
const transcript = {
  id: 'att-transcript',
  filename: 'rec.transcript.md',
  fs_path: 'attachments/att-transcript',
  mime_type: 'text/markdown',
  size_bytes: TRANSCRIPT.length,
}

const props = {
  blockId: 'B1',
  imageWidth: '100',
  imageHovered: false,
  imageAlignment: 'center' as const,
  imageCaption: '',
  onImageHoveredChange: vi.fn(),
  onImageWidthChange: vi.fn(),
  onImageAlignmentChange: vi.fn(),
  onImageCaptionChange: vi.fn(),
  onLightboxOpen: vi.fn(),
  onPdfOpen: vi.fn(),
}

/** The player's viewport gate; `autoEnter` reports every observed element in view. */
class MockIntersectionObserver {
  static autoEnter = true
  static instances: MockIntersectionObserver[] = []
  observed = new Set<Element>()
  callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    MockIntersectionObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.add(el)
    if (MockIntersectionObserver.autoEnter) this.enterAll()
  }
  unobserve(el: Element): void {
    this.observed.delete(el)
  }
  disconnect(): void {
    this.observed.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  enterAll(): void {
    const entries = [...this.observed].map(
      (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
    )
    this.callback(entries, this as unknown as IntersectionObserver)
  }
}

/**
 * The test DOM has no media stack: stands in for the element's `duration`,
 * and records every `currentTime` the app sets.
 */
function fakeMedia(player: HTMLAudioElement, duration: number) {
  const media = { duration, seeks: [] as number[], currentTime: 0 }
  Object.defineProperty(player, 'duration', { get: () => media.duration })
  Object.defineProperty(player, 'currentTime', {
    get: () => media.currentTime,
    set: (time: number) => {
      media.seeks.push(time)
      media.currentTime = time
    },
  })
  return media
}

async function findPlayer(container: HTMLElement): Promise<HTMLAudioElement> {
  await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
  return container.querySelector('audio') as HTMLAudioElement
}

function transcriptToggle(): HTMLElement {
  return screen.getByRole('button', { name: t('attachment.transcript') })
}

async function expandTranscript(): Promise<void> {
  fireEvent.click(transcriptToggle())
  await screen.findAllByTestId('transcript-segment')
  // The bytes land outside `act`, so the rows can show before React's passive
  // effects run, and the player's listener reads the transcript through them.
  await act(() => Promise.resolve())
}

function seekButton(time: string): HTMLElement {
  return screen.getByRole('button', { name: t('attachment.seekTo', { time }) })
}

function currentSegments(): string[] {
  return screen
    .getAllByTestId('transcript-segment')
    .filter((row) => row.getAttribute('aria-current') === 'true')
    .map((row) => row.textContent ?? '')
}

function timeUpdate(player: HTMLAudioElement, media: { currentTime: number }, time: number) {
  media.currentTime = time
  act(() => {
    fireEvent(player, new Event('timeupdate'))
  })
}

describe('TranscriptAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    let urls = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock/${++urls}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    mockedReadAttachment.mockImplementation(async (id: string) =>
      id === transcript.id ? new TextEncoder().encode(TRANSCRIPT) : new Uint8Array([1, 2, 3]),
    )
    MockIntersectionObserver.autoEnter = true
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('starts collapsed and reads the transcript only once expanded', async () => {
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[transcript, audio]} />,
    )
    await findPlayer(container)

    expect(transcriptToggle()).toHaveAttribute('aria-expanded', 'false')
    expect(mockedReadAttachment).not.toHaveBeenCalledWith(transcript.id)
    expect(screen.queryByTestId('transcript-segment')).toBeNull()

    await expandTranscript()
    expect(transcriptToggle()).toHaveAttribute('aria-expanded', 'true')
    expect(mockedReadAttachment).toHaveBeenCalledWith(transcript.id)
    expect(screen.getAllByTestId('transcript-segment').map((row) => row.textContent)).toEqual([
      'Standup',
      '00:00Alice: Morning.',
      '00:10Bob: Hi.',
      '01:00Alice: Bye.',
    ])
  })

  it('seeks the player to the time a timestamp names, by click or by keyboard', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    const media = fakeMedia(await findPlayer(container), 90)
    await expandTranscript()

    await user.click(seekButton('00:10'))
    expect(media.seeks).toEqual([10])

    seekButton('01:00').focus()
    await user.keyboard('{Enter}')
    expect(media.seeks).toEqual([10, 60])
  })

  it('highlights the segment the playhead is in as the player plays', async () => {
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    const player = await findPlayer(container)
    const media = fakeMedia(player, 90)
    await expandTranscript()
    expect(currentSegments()).toEqual(['00:00Alice: Morning.'])

    timeUpdate(player, media, 12)
    expect(currentSegments()).toEqual(['00:10Bob: Hi.'])

    timeUpdate(player, media, 75)
    expect(currentSegments()).toEqual(['01:00Alice: Bye.'])
  })

  it('re-renders only the segment that stops being current and the one that starts', async () => {
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    const player = await findPlayer(container)
    const media = fakeMedia(player, 90)
    await expandTranscript()
    const renders = vi.mocked(renderRichContent)

    renders.mockClear()
    timeUpdate(player, media, 12)
    expect(renders.mock.calls.map(([markdown]) => markdown)).toEqual([
      '**Alice:** Morning.',
      '**Bob:** Hi.',
    ])

    renders.mockClear()
    timeUpdate(player, media, 13)
    expect(renders).not.toHaveBeenCalled()
  })

  it('listens to the player only while expanded, and catches up on expanding', async () => {
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    const player = await findPlayer(container)
    const media = fakeMedia(player, 90)
    const listen = vi.spyOn(player, 'addEventListener')
    const unlisten = vi.spyOn(player, 'removeEventListener')
    const timeListeners = (spy: typeof listen) =>
      spy.mock.calls.filter(([type]) => type === 'timeupdate').length

    media.currentTime = 70
    expect(timeListeners(listen)).toBe(0)
    await expandTranscript()
    expect(timeListeners(listen)).toBe(1)
    expect(currentSegments()).toEqual(['01:00Alice: Bye.'])

    fireEvent.click(transcriptToggle())
    expect(timeListeners(unlisten)).toBe(1)
  })

  it('holds a seek made before the player has loaded, and applies it once it has', async () => {
    MockIntersectionObserver.autoEnter = false
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    await expandTranscript()
    fireEvent.click(seekButton('00:10'))

    act(() => {
      for (const io of MockIntersectionObserver.instances) io.enterAll()
    })
    const player = await findPlayer(container)
    const media = fakeMedia(player, 90)
    fireEvent(player, new Event('loadedmetadata'))
    expect(media.seeks).toEqual([10])
  })

  it('keeps a held seek over the rewind that follows finding an unknown length', async () => {
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    const player = await findPlayer(container)
    const media = fakeMedia(player, Infinity)
    await expandTranscript()

    fireEvent.click(seekButton('00:10'))
    fireEvent(player, new Event('loadedmetadata'))
    fireEvent.click(seekButton('01:00'))
    media.duration = 90
    fireEvent(player, new Event('durationchange'))

    expect(media.seeks).toEqual([Number.MAX_SAFE_INTEGER, 60])
  })

  it('renders a transcript with no timestamps as plain Markdown, with no seek buttons', async () => {
    mockedReadAttachment.mockImplementation(async (id: string) =>
      id === transcript.id ? new TextEncoder().encode('# Notes\n\nNo times.') : new Uint8Array([1]),
    )
    render(<AttachmentRenderer {...props} attachments={[audio, transcript]} />)
    fireEvent.click(transcriptToggle())

    const body = await screen.findByTestId('transcript-attachment-body')
    expect(within(body).getByRole('heading', { name: 'Notes' })).toBeInTheDocument()
    expect(within(body).queryAllByRole('button')).toEqual([])
  })

  it('renders a transcript on a block without audio as the plain Markdown preview', async () => {
    render(<AttachmentRenderer {...props} attachments={[transcript]} />)

    await waitFor(() =>
      expect(screen.getByTestId('markdown-attachment-body').textContent).toContain(
        '[00:10] Bob: Hi.',
      ),
    )
    expect(screen.queryByTestId('transcript-attachment')).toBeNull()
    expect(
      screen.queryByRole('button', { name: t('attachment.seekTo', { time: '00:10' }) }),
    ).toBeNull()
  })

  it('falls back to the file chip when the transcript cannot be read', async () => {
    mockedReadAttachment.mockImplementation(async (id: string) => {
      if (id === transcript.id) throw new Error('boom')
      return new Uint8Array([1])
    })
    render(<AttachmentRenderer {...props} attachments={[audio, transcript]} />)
    fireEvent.click(transcriptToggle())

    expect(
      await screen.findByRole('button', {
        name: t('attachment.openFile', { filename: transcript.filename }),
      }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('transcript-attachment')).toBeNull()
  })

  it('has no a11y violations collapsed', async () => {
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    await findPlayer(container)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no a11y violations expanded, with a current segment', async () => {
    const { container } = render(
      <AttachmentRenderer {...props} attachments={[audio, transcript]} />,
    )
    fakeMedia(await findPlayer(container), 90)
    await expandTranscript()
    expect(currentSegments()).toHaveLength(1)
    expect(await axe(container)).toHaveNoViolations()
  })
})
