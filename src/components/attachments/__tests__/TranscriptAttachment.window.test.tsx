/**
 * TranscriptAttachment windowing (#5364): a two-hour meeting's transcript
 * mounts only the rows near the view, and every row while find-in-page is
 * open, since find walks the rendered DOM.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

// The test DOM has no layout, so the real virtualizer would lay out no rows;
// the shared double lays out a window of 30 when the windowed path is taken.
vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: 30 }))

const mockedReadAttachment = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ipc-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-helpers')>()),
  readAttachment: mockedReadAttachment,
}))

import type { RecordingPlayer } from '@/components/attachments/AttachmentAudio'
import { TranscriptAttachment } from '@/components/attachments/TranscriptAttachment'
import { t } from '@/lib/i18n'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

const SEGMENTS = 1500

/** `[h:mm:ss] **Speaker:** text` paragraphs, one every few seconds over two hours. */
function longTranscript(): string {
  const stamp = (seconds: number) =>
    `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return Array.from(
    { length: SEGMENTS },
    (_, i) => `[${stamp(Math.floor((i * 7200) / SEGMENTS))}] **Alice:** line ${i}.`,
  ).join('\n\n')
}

function player(): RecordingPlayer {
  return { audio: null, seek: vi.fn(), attach: vi.fn(), heldSeek: { current: null } }
}

async function open(rec: RecordingPlayer) {
  // The page's scroller, as in the app; with none the transcript mounts every row.
  const view = render(
    <div style={{ overflowY: 'auto', height: 600 }}>
      <TranscriptAttachment
        att={{ id: 'att-transcript', filename: 'rec.transcript.md' }}
        player={rec}
        fallback={<span>chip</span>}
      />
    </div>,
  )
  fireEvent.click(screen.getByRole('button', { name: t('attachment.transcript') }))
  await screen.findAllByTestId('transcript-segment')
  await act(() => Promise.resolve())
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  useInPageFindStore.setState({ open: false })
  mockedReadAttachment.mockResolvedValue(new TextEncoder().encode(longTranscript()))
})

describe('TranscriptAttachment — a long transcript', () => {
  it('mounts only a window of its rows', async () => {
    await open(player())

    const rows = screen.getAllByTestId('transcript-segment')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(100)
    expect(rows[0]).toHaveTextContent('0:00:00Alice: line 0.')
  })

  it('mounts every row while find-in-page is open, and the window again once it closes', async () => {
    await open(player())

    act(() => useInPageFindStore.setState({ open: true }))
    expect(screen.getAllByTestId('transcript-segment')).toHaveLength(SEGMENTS)

    act(() => useInPageFindStore.setState({ open: false }))
    expect(screen.getAllByTestId('transcript-segment').length).toBeLessThan(100)
  })

  it('seeks the player from a windowed row', async () => {
    const rec = player()
    await open(rec)

    fireEvent.click(
      screen.getByRole('button', { name: t('attachment.seekTo', { time: '0:00:04' }) }),
    )

    expect(rec.seek).toHaveBeenCalledWith(4)
  })

  it('has no a11y violations windowed', async () => {
    const { container } = await open(player())
    expect(await axe(container)).toHaveNoViolations()
  })
})
