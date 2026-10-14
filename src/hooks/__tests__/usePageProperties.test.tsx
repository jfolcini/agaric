/**
 * #5445 — the page header's two property consumers (`usePageTemplateMeta`,
 * `PagePropertyTable`) share one `get_properties` fetch per page open, and a
 * `block:properties-changed` event refetches it only when the changed block is
 * the page itself (a TODO toggle on a child block must not).
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { PagePropertyTable } from '@/components/pages/PagePropertyTable'
import { usePageTemplateMeta } from '@/hooks/usePageTemplateMeta'
import type { PropertyRow } from '@/lib/bindings'
import { EVENT_PROPERTY_CHANGED } from '@/lib/block-event-names'
import { _resetPropertyChangeDispatchForTest } from '@/lib/property-change-dispatch'

const eventListeners = new Map<string, (event: unknown) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: unknown) => void): Promise<() => void> => {
      eventListeners.set(eventName, handler)
      return () => {
        eventListeners.delete(eventName)
      }
    },
  ),
}))

const mockedInvoke = vi.mocked(invoke)
const PAGE_ID = 'PAGE_1'
const CHILD_ID = 'CHILD_1'

let storedRows: PropertyRow[] = []

function templateRow(): PropertyRow {
  return {
    key: 'template',
    value_text: 'true',
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  }
}

function firePropertyEvent(blockId: string): void {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler({ payload: { block_id: blockId, changed_keys: ['todo_state'] } })
}

function callsOf(command: string): number {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === command).length
}

function TemplateFlag() {
  const { isTemplate } = usePageTemplateMeta(
    PAGE_ID,
    (key) => key,
    () => {},
  )
  return <span data-testid="is-template">{String(isTemplate)}</span>
}

function renderPageHeaderConsumers() {
  return render(
    <>
      <TemplateFlag />
      <PagePropertyTable pageId={PAGE_ID} />
    </>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  _resetPropertyChangeDispatchForTest()
  // The dispatcher's listener only registers inside Tauri.
  ;(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {}
  storedRows = []
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      get_properties: () => storedRows,
      list_property_defs: () => ({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
    }),
  )
})

describe('page header properties (#5445)', () => {
  it('fetches the page properties once per page open', async () => {
    renderPageHeaderConsumers()

    await waitFor(() => {
      expect(callsOf('list_property_defs')).toBe(1)
    })
    await waitFor(() => {
      expect(callsOf('get_properties')).toBe(1)
    })
    expect(mockedInvoke).toHaveBeenCalledWith('get_properties', { blockId: PAGE_ID })
  })

  it('refetches on an event for the page and ignores one for another block', async () => {
    renderPageHeaderConsumers()
    await waitFor(() => {
      expect(callsOf('get_properties')).toBe(1)
    })
    await waitFor(() => {
      expect(callsOf('list_property_defs')).toBe(1)
    })
    storedRows = [templateRow()]

    act(() => {
      firePropertyEvent(CHILD_ID)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(callsOf('get_properties')).toBe(1)
    expect(callsOf('list_property_defs')).toBe(1)
    expect(screen.getByTestId('is-template')).toHaveTextContent('false')

    act(() => {
      firePropertyEvent(PAGE_ID)
    })
    await waitFor(() => {
      expect(screen.getByTestId('is-template')).toHaveTextContent('true')
    })
    expect(callsOf('get_properties')).toBe(2)
    expect(screen.getByRole('button', { name: /\(1\)/ })).toBeInTheDocument()
  })
})
