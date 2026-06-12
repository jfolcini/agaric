/**
 * #899 mobile-search polish — PaletteBody wiring tests.
 *
 * Covers the two features that live inside the all-pages palette body:
 *  - #131 recent search terms in the empty state (mobile only).
 *  - #132 voice dictation mic button (feature-detected, mobile only).
 *
 * Both are gated on `useIsMobile()`; the hook is mocked so each test
 * pins the viewport explicitly. The Web Speech API is mocked via a fake
 * window constructor.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CommandPalette } from '@/components/common/CommandPalette'
import { addRecentSearch, getRecentSearches } from '@/lib/recent-searches'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>()
  return {
    ...actual,
    searchBlocks: vi.fn(),
    searchBlocksPartitioned: vi.fn(),
  }
})

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => true),
}))

import { useIsMobile } from '@/hooks/useIsMobile'
import { searchBlocks, searchBlocksPartitioned } from '@/lib/tauri'

const mockedSearchBlocksPartitioned = vi.mocked(searchBlocksPartitioned)
const mockedSearchBlocks = vi.mocked(searchBlocks)
const mockedUseIsMobile = vi.mocked(useIsMobile)

type PartitionedResp = Awaited<ReturnType<typeof searchBlocksPartitioned>>

function emptyPartition(): PartitionedResp['pages'] {
  return { items: [], next_cursor: null, has_more: false, total_count: null }
}

// ── Fake Web Speech API ──────────────────────────────────────────────
class FakeRecognition {
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  onresult: ((e: SpeechRecognitionEvent) => void) | null = null
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null = null
  onend: ((e: Event) => void) | null = null
  onstart: ((e: Event) => void) | null = null
  start = vi.fn()
  stop = vi.fn()
  abort = vi.fn()
  emitResult(transcript: string): void {
    this.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        item: () => ({}) as SpeechRecognitionResult,
        0: {
          length: 1,
          isFinal: true,
          item: () => ({ transcript, confidence: 1 }),
          0: { transcript, confidence: 1 },
        },
      },
    } as unknown as SpeechRecognitionEvent)
  }
}

let lastRecognition: FakeRecognition | null = null
function MakeRecognition(this: FakeRecognition): FakeRecognition {
  lastRecognition = new FakeRecognition()
  return lastRecognition
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseIsMobile.mockReturnValue(true)
  localStorage.clear()
  lastRecognition = null
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
  useCommandPaletteStore.setState({
    open: false,
    mode: 'search',
    query: '',
    pendingViewQuery: null,
    previousFocusedElement: null,
  })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  useNavigationStore.setState({ currentView: 'pages', selectedBlockId: null })
  mockedSearchBlocksPartitioned.mockResolvedValue({
    pages: emptyPartition(),
    blocks: emptyPartition(),
  })
  mockedSearchBlocks.mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
    total_count: null,
  })
})

afterEach(() => {
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
})

function openPalette(): void {
  act(() => {
    useCommandPaletteStore.getState().open$()
  })
}

describe('#131 recent searches (empty state)', () => {
  it('lists recent search terms when the input is empty on mobile', () => {
    addRecentSearch('alpha')
    addRecentSearch('beta')
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('palette-recent-searches-group')).toBeInTheDocument()
    expect(screen.getByTestId('palette-recent-search-beta')).toBeInTheDocument()
    expect(screen.getByTestId('palette-recent-search-alpha')).toBeInTheDocument()
  })

  it('does NOT render recent searches on desktop (mobile-gated)', () => {
    mockedUseIsMobile.mockReturnValue(false)
    addRecentSearch('alpha')
    render(<CommandPalette />)
    openPalette()
    expect(screen.queryByTestId('palette-recent-searches-group')).not.toBeInTheDocument()
  })

  it('tapping a recent term refills the query', async () => {
    const user = userEvent.setup()
    addRecentSearch('alpha')
    render(<CommandPalette />)
    openPalette()
    await user.click(screen.getByTestId('palette-recent-search-alpha'))
    expect(useCommandPaletteStore.getState().query).toBe('alpha')
  })

  it('Clear empties the recent-search list', async () => {
    const user = userEvent.setup()
    addRecentSearch('alpha')
    addRecentSearch('beta')
    render(<CommandPalette />)
    openPalette()
    await user.click(screen.getByTestId('palette-recent-searches-clear'))
    expect(getRecentSearches()).toEqual([])
    expect(screen.queryByTestId('palette-recent-searches-group')).not.toBeInTheDocument()
  })

  it('records the query on escalation so it appears next time', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    await user.type(input, 'committed')
    // Mobile escalation CTA is always present in mobile search mode.
    const escalate = await screen.findByTestId('palette-escalation-footer')
    await user.click(escalate)
    expect(getRecentSearches()).toContain('committed')
  })
})

describe('#132 voice input', () => {
  it('hides the mic button when the Web Speech API is unavailable', () => {
    render(<CommandPalette />)
    openPalette()
    expect(screen.queryByTestId('palette-voice-button')).not.toBeInTheDocument()
  })

  it('shows the mic button when SpeechRecognition is available on mobile', () => {
    window.SpeechRecognition = MakeRecognition as unknown as SpeechRecognitionConstructor
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('palette-voice-button')).toBeInTheDocument()
  })

  it('hides the mic button on desktop even when SpeechRecognition exists', () => {
    mockedUseIsMobile.mockReturnValue(false)
    window.SpeechRecognition = MakeRecognition as unknown as SpeechRecognitionConstructor
    render(<CommandPalette />)
    openPalette()
    expect(screen.queryByTestId('palette-voice-button')).not.toBeInTheDocument()
  })

  it('starts recognition and fills the query from a transcript', async () => {
    window.SpeechRecognition = MakeRecognition as unknown as SpeechRecognitionConstructor
    render(<CommandPalette />)
    openPalette()
    const mic = screen.getByTestId('palette-voice-button')
    act(() => {
      fireEvent.click(mic)
    })
    expect(lastRecognition?.start).toHaveBeenCalled()
    act(() => {
      lastRecognition?.emitResult('dictated query')
    })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().query).toBe('dictated query')
    })
  })
})
