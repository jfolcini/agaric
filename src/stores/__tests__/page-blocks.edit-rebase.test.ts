/**
 * #6533 — an edit from an editor that never showed a peer's edit keeps it.
 * The store sends the text the editor started from; the backend (here the
 * tauri mock, pinned to it by `conformance/fixtures/edit_block_rebase.json`)
 * replays the editor's change on the text the block holds.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { answerInvokeFromMock } from '@/__tests__/helpers/invoke'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS } from '@/lib/tauri-mock/seed'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)
const BLOCK = SEED_IDS.BLOCK_GS_1

async function loadedPage() {
  const page = createPageBlockStore(SEED_IDS.PAGE_GETTING_STARTED)
  await page.getState().load()
  return page
}

async function storedText(): Promise<string | null | undefined> {
  return (await loadedPage()).getState().blocksById.get(BLOCK)?.content
}

describe('edit from a stale editor (#6533)', () => {
  let page: Awaited<ReturnType<typeof loadedPage>>
  let loadedText: string

  beforeEach(async () => {
    vi.clearAllMocks()
    await answerInvokeFromMock(mockedInvoke)
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    page = await loadedPage()
    loadedText = page.getState().blocksById.get(BLOCK)?.content ?? ''
    expect(loadedText).not.toBe('')
  })

  /** A peer's edit lands in the backend; the store, like the editor, has not seen it. */
  const peerEdits = () => dispatch('edit_block', { blockId: BLOCK, toText: `Peer: ${loadedText}` })

  it('keeps the peer’s edit when given the text the editor started from', async () => {
    await peerEdits()
    const ok = await page.getState().edit(BLOCK, `${loadedText} typed`, { baseText: loadedText })

    expect(ok).toBe(true)
    expect(page.getState().blocksById.get(BLOCK)?.content).toBe(`Peer: ${loadedText} typed`)
    expect(await storedText()).toBe(`Peer: ${loadedText} typed`)
  })

  it('rebases each later commit from the editor’s own text', async () => {
    await peerEdits()
    await page.getState().edit(BLOCK, `${loadedText} one`, { baseText: loadedText })

    await page.getState().edit(BLOCK, `${loadedText} one two`, { baseText: `${loadedText} one` })

    expect(await storedText()).toBe(`Peer: ${loadedText} one two`)
  })

  it('sends an edit started under one still in flight as it is, writing nothing twice', async () => {
    // A debounced commit and the blur that overtakes it both start from the
    // loaded text: the second holds the first's change already.
    const first = page.getState().edit(BLOCK, `${loadedText} one`, { baseText: loadedText })
    const second = page.getState().edit(BLOCK, `${loadedText} one two`, { baseText: loadedText })

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(await storedText()).toBe(`${loadedText} one two`)
  })

  it('rebases again once the edit in flight has answered', async () => {
    await page.getState().edit(BLOCK, `${loadedText} one`)

    await page.getState().edit(BLOCK, `${loadedText} one two`, { baseText: `${loadedText} one` })
    await dispatch('edit_block', { blockId: BLOCK, toText: `Peer: ${loadedText} one two` })
    await page
      .getState()
      .edit(BLOCK, `${loadedText} one two three`, { baseText: `${loadedText} one two` })

    expect(await storedText()).toBe(`Peer: ${loadedText} one two three`)
  })

  it('writes the text as sent when no base is given', async () => {
    await peerEdits()
    await page.getState().edit(BLOCK, `${loadedText} typed`)

    expect(await storedText()).toBe(`${loadedText} typed`)
  })
})
