/**
 * `trackPageFlush` (#6953): leaving a page flushes its edited block, and a flush whose text lands
 * only after its IPCs answer can outlast coming back. The reopened page's load reads again once
 * every flush its snapshot may predate has settled.
 */
import { invoke } from '@tauri-apps/api/core'
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { BlockRow } from '@/lib/bindings'
import {
  type PageBlockState,
  PageBlockStoreProvider,
  trackPageFlush,
  usePageBlockStoreApi,
} from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const PAGE = 'PAGE_1'
const TYPED = 'call the plumber #splitcall'
const NAMED = 'call the plumber #[01TAG0000000000000000000000]'

vi.mock('@/stores/undo', () => ({
  useUndoStore: { getState: () => ({ onNewAction: vi.fn(), clearPage: vi.fn() }) },
}))

function row(content: string): BlockRow {
  return {
    id: 'B1',
    block_type: 'content',
    content,
    parent_id: PAGE,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: PAGE,
  }
}

/** Answers the loads with `answers` in turn, each when its promise resolves; returns the read count. */
function stubLoads(answers: Array<Promise<string>>): () => number {
  let next = 0
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      load_page_subtree: async () => {
        const content = await (answers[next++] ?? Promise.resolve(NAMED))
        return { blocks: [row(content)], truncated: false, total: 1 }
      },
    }),
  )
  return () => next
}

/** A promise and the function that resolves it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Mount the page's provider and return its live store. */
function mountPage(): StoreApi<PageBlockState> {
  const sink: StoreApi<PageBlockState>[] = []
  function Probe(): React.ReactElement {
    const store = usePageBlockStoreApi()
    useEffect(() => {
      sink.push(store)
    }, [store])
    return <span />
  }
  render(
    <PageBlockStoreProvider pageId={PAGE}>
      <Probe />
    </PageBlockStoreProvider>,
  )
  const [store] = sink
  if (store === undefined) throw new Error('the provider published no store')
  return store
}

const contentOf = (store: StoreApi<PageBlockState>) =>
  store.getState().blocksById.get('B1')?.content

describe('trackPageFlush', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  })

  it('reads the page again once a flush writing as the load read has landed', async () => {
    const reads = stubLoads([Promise.resolve(TYPED)])
    const flush = deferred<boolean>()
    trackPageFlush(PAGE, flush.promise)
    const store = mountPage()
    await act(() => store.getState().load())
    expect(contentOf(store)).toBe(TYPED)

    await act(async () => flush.resolve(true))

    await vi.waitFor(() => expect(contentOf(store)).toBe(NAMED))
    expect(reads()).toBe(2)
  })

  it('reads the page again after a flush that started and landed while the load read', async () => {
    const first = deferred<string>()
    const reads = stubLoads([first.promise])
    const store = mountPage()
    const loading = store.getState().load()

    trackPageFlush(PAGE, Promise.resolve(true))
    await act(async () => {
      first.resolve(TYPED)
      await loading
    })

    await vi.waitFor(() => expect(contentOf(store)).toBe(NAMED))
    expect(reads()).toBe(2)
  })

  it('reads the page once when every flush landed before the load began', async () => {
    const reads = stubLoads([Promise.resolve(NAMED)])
    const flush = Promise.resolve(true)
    trackPageFlush(PAGE, flush)
    await flush
    const store = mountPage()

    await act(() => store.getState().load())

    expect(contentOf(store)).toBe(NAMED)
    expect(reads()).toBe(1)
  })
})
