/**
 * The row *Read aloud* is speaking carries `data-reading` (#5745), and only that row.
 */

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { type FakeSpeech, installFakeSpeech } from '@/__tests__/helpers/fake-speech'
import { SortableBlock } from '@/components/editor/SortableBlock'
import { __resetReadAloudForTests, startReading, stopReading } from '@/lib/speech/read-aloud'

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}))

vi.mock('@/components/editor/EditableBlock', () => ({
  EditableBlock: (props: { blockId: string }) => <div>{props.blockId}</div>,
}))

function rovingEditor() {
  return {
    editor: null,
    mount: vi.fn(),
    updateListMarker: vi.fn(),
    listMarker: vi.fn(() => ({ style: 'none' as const, ordinal: undefined })),
    unmount: vi.fn(() => null),
    activeBlockId: null,
    getMarkdown: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    originalMarkdown: '',
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
    storedMarkdown: '',
    readAsTyped: vi.fn(),
  }
}

let speech: FakeSpeech

function renderRows() {
  const editor = rovingEditor()
  return render(
    <>
      <SortableBlock blockId="A" content="a" isFocused={false} rovingEditor={editor} />
      <SortableBlock blockId="B" content="b" isFocused={false} rovingEditor={editor} />
    </>,
  )
}

/** The ids of the rows marked as being read. */
function readingRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-reading]')].map(
    (row) => row.getAttribute('data-block-id') ?? '',
  )
}

beforeEach(() => {
  __resetReadAloudForTests()
  speech = installFakeSpeech()
})

afterEach(() => {
  // Before the fake goes: a test that failed mid-reading must not end it on a later unmount.
  __resetReadAloudForTests()
  vi.unstubAllGlobals()
})

describe('SortableBlock — Read aloud marker', () => {
  it('follows the block being spoken, and leaves when the reading ends', () => {
    const { container } = renderRows()
    expect(readingRows(container)).toEqual([])
    act(() => {
      startReading(
        [
          { blockId: 'A', text: 'a' },
          { blockId: 'B', text: 'b' },
        ],
        {},
      )
    })
    expect(readingRows(container)).toEqual(['A'])
    act(() => speech.endCurrent())
    expect(readingRows(container)).toEqual(['B'])
    act(() => stopReading())
    expect(readingRows(container)).toEqual([])
  })

  it('has no a11y violations while a row is marked', async () => {
    const { container } = renderRows()
    act(() => startReading([{ blockId: 'A', text: 'a' }], {}))
    expect(await axe(container)).toHaveNoViolations()
  })
})
