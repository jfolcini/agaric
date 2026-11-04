/**
 * What *Read aloud*'s page entry point reads (#5745), and that a reading ends with the page it
 * reads: leaving the page unmounts it (views mount one at a time; `e2e/read-aloud.spec.ts`).
 */

import { render } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { type FakeSpeech, installFakeSpeech } from '@/__tests__/helpers/fake-speech'
import { readOpenPageAloud } from '@/hooks/useReadAloud'
import { t } from '@/lib/i18n'
import { __resetReadAloudForTests, getReadAloudSnapshot } from '@/lib/speech/read-aloud'
import { useNavigationStore } from '@/stores/navigation'
import { getPageStore, PageBlockStoreProvider } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useTabsStore } from '@/stores/tabs'

const LINKED = '01HX4ZQ8AAAAAAAAAAAAAAAAAA'

let speech: FakeSpeech

/** Speaks the reading to its end, returning every utterance's text. */
function drain(): string[] {
  while (getReadAloudSnapshot().reading) speech.endCurrent()
  return speech.spoken.map((u) => u.text)
}

/** Opens page `pageId`, titled `title`, in the page editor, with `blocks` loaded. */
function openPage(pageId: string, title: string, blocks = [makeBlock({ id: 'B1' })]) {
  useTabsStore.setState({
    tabs: [{ id: 'tab-1', pageStack: [{ pageId, title }], label: title }],
    activeTabIndex: 0,
  })
  useNavigationStore.getState().setView('page-editor')
  const view = render(
    <PageBlockStoreProvider pageId={pageId}>
      <div />
    </PageBlockStoreProvider>,
  )
  getPageStore(pageId)?.setState({ blocks: blocks.map((b) => ({ ...b, page_id: pageId })) })
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetReadAloudForTests()
  useResolveStore.getState().batchSet([{ id: LINKED, title: 'Garden', deleted: false }])
  useNavigationStore.getState().setView('journal')
  speech = installFakeSpeech()
})

afterEach(() => {
  // Before the fake goes: a test that failed mid-reading must not end it on a later unmount.
  __resetReadAloudForTests()
  vi.unstubAllGlobals()
})

describe('reading the page', () => {
  it('reads its title, then its blocks in tree order', () => {
    openPage('PAGE_1', 'My page', [
      makeBlock({ id: 'B1', content: `see [[${LINKED}]]` }),
      makeBlock({ id: 'B2', content: 'nested', parent_id: 'B1', depth: 1 }),
    ])
    readOpenPageAloud()
    expect(getReadAloudSnapshot().currentBlockId).toBe('PAGE_1')
    expect(drain()).toEqual(['My page', 'see Garden', 'nested'])
  })

  it('says to open a page when none is on screen', () => {
    useNavigationStore.getState().setView('pages')
    readOpenPageAloud()
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('readAloud.noPage'))
    expect(speech.spoken).toHaveLength(0)
  })
})

describe('a reading ends by itself', () => {
  it('when the page it reads unmounts', () => {
    const view = openPage('PAGE_1', 'My page')
    const other = render(
      <PageBlockStoreProvider pageId="PAGE_2">
        <div />
      </PageBlockStoreProvider>,
    )
    readOpenPageAloud()
    other.unmount()
    expect(getReadAloudSnapshot().reading).toBe(true)
    view.unmount()
    expect(getReadAloudSnapshot().reading).toBe(false)
    expect(speech.cancel).toHaveBeenCalledTimes(1)
  })
})
