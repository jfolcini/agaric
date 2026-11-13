/**
 * #6531 — `splitOff` and `mergeInto`: each is one backend command, shown in
 * the store at once, one undo entry, and held ahead of later writes to the
 * blocks it changes. The backend here is the tauri mock, pinned to the real
 * one by `conformance/fixtures/split_block.json` and `merge_blocks.json`.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { answerInvokeFromMock, deferred } from '@/__tests__/helpers/invoke'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS } from '@/lib/tauri-mock/seed'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)
const PAGE = SEED_IDS.PAGE_GETTING_STARTED
const FIRST = SEED_IDS.BLOCK_GS_1
const SECOND = SEED_IDS.BLOCK_GS_2
const NEW_ID = '01SPTNEW000000000000000001'

async function loadedPage() {
  const page = createPageBlockStore(PAGE)
  await page.getState().load()
  return page
}

/** The page as a fresh load reads it: `[id, parent, text]` in document order. */
async function storedRows(): Promise<Array<[string, string | null, string | null]>> {
  return (await loadedPage()).getState().blocks.map((b) => [b.id, b.parent_id, b.content])
}

/** Make `command` answer only when the returned function is called. */
function holdBack(command: string): () => void {
  const answer = mockedInvoke.getMockImplementation() as typeof invoke
  const gate = deferred<void>()
  mockedInvoke.mockImplementation((cmd, args) =>
    cmd === command ? gate.promise.then(() => answer(cmd, args)) : answer(cmd, args),
  )
  return () => gate.resolve()
}

function refuse(command: string): void {
  const answer = mockedInvoke.getMockImplementation() as typeof invoke
  mockedInvoke.mockImplementation((cmd, args) =>
    cmd === command
      ? Promise.reject({ kind: 'validation', message: 'refused' })
      : answer(cmd, args),
  )
}

const commandsSent = () => mockedInvoke.mock.calls.map(([command]) => command)
const undoRefs = () =>
  useUndoStore
    .getState()
    .pages.get(PAGE)
    ?.undoStack.map((e) => e.refs?.length)

describe('splitOff and mergeInto (#6531)', () => {
  let page: Awaited<ReturnType<typeof loadedPage>>
  let firstText: string
  let secondText: string

  beforeEach(async () => {
    vi.clearAllMocks()
    await answerInvokeFromMock(mockedInvoke)
    useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
    useUndoStore.setState({ pages: new Map() })
    page = await loadedPage()
    firstText = page.getState().blocksById.get(FIRST)?.content ?? ''
    secondText = page.getState().blocksById.get(SECOND)?.content ?? ''
    expect(firstText.length).toBeGreaterThan(4)
    expect(secondText).not.toBe('')
  })

  describe('splitOff', () => {
    it('shows both halves before the command answers, then persists them', async () => {
      const before = firstText.slice(0, 4)
      const after = firstText.slice(4)
      const split = page.getState().splitOff(FIRST, before, after, NEW_ID)

      const shown = page.getState().blocks
      const at = shown.findIndex((b) => b.id === FIRST)
      expect(shown[at]?.content).toBe(before)
      expect([shown[at + 1]?.id, shown[at + 1]?.content]).toEqual([NEW_ID, after])

      expect(await split).toBe(true)
      const stored = await storedRows()
      const storedAt = stored.findIndex(([id]) => id === FIRST)
      expect(stored.slice(storedAt, storedAt + 3)).toEqual([
        [FIRST, PAGE, before],
        [NEW_ID, PAGE, after],
        [SECOND, PAGE, secondText],
      ])
    })

    it('is one command and one undo entry of its two ops', async () => {
      await page.getState().splitOff(FIRST, firstText.slice(0, 4), firstText.slice(4), NEW_ID)

      expect(commandsSent().filter((c) => c !== 'load_page_subtree')).toEqual(['split_block'])
      expect(undoRefs()).toEqual([2])
    })

    it('keeps a peer’s edit of the kept text when given the text the editor started from', async () => {
      await dispatch('edit_block', { blockId: FIRST, toText: `Peer: ${firstText}` })

      await page
        .getState()
        .splitOff(FIRST, firstText.slice(0, 4), firstText.slice(4), NEW_ID, { baseText: firstText })

      const kept = `Peer: ${firstText.slice(0, 4)}`
      expect(page.getState().blocksById.get(FIRST)?.content).toBe(kept)
      expect((await storedRows()).find(([id]) => id === FIRST)?.[2]).toBe(kept)
    })

    it('holds an edit of the new block until the split has answered', async () => {
      const answerSplit = holdBack('split_block')
      const split = page
        .getState()
        .splitOff(FIRST, firstText.slice(0, 4), firstText.slice(4), NEW_ID)
      const typed = page.getState().edit(NEW_ID, 'typed in the new block')
      await Promise.resolve()
      await Promise.resolve()
      expect(commandsSent()).not.toContain('edit_block')

      answerSplit()
      expect(await Promise.all([split, typed])).toEqual([true, true])
      expect((await storedRows()).find(([id]) => id === NEW_ID)?.[2]).toBe('typed in the new block')
    })

    it('puts the block back whole when the command is refused', async () => {
      const shownBefore = page.getState().blocks
      refuse('split_block')

      const ok = await page
        .getState()
        .splitOff(FIRST, firstText.slice(0, 4), firstText.slice(4), NEW_ID)

      expect(ok).toBe(false)
      expect(page.getState().blocks).toBe(shownBefore)
      expect(undoRefs()).toBeUndefined()
      expect((await storedRows()).find(([id]) => id === NEW_ID)).toBeUndefined()
    })
  })

  describe('mergeInto', () => {
    it('shows the merge before the command answers, then persists it', async () => {
      const mergedText = `${firstText}${secondText}`
      const merge = page.getState().mergeInto(SECOND, FIRST, mergedText, { baseText: firstText })

      expect(page.getState().blocksById.get(FIRST)?.content).toBe(mergedText)
      expect(page.getState().blocksById.has(SECOND)).toBe(false)

      expect(await merge).toBe(true)
      const stored = await storedRows()
      expect(stored.find(([id]) => id === FIRST)?.[2]).toBe(mergedText)
      expect(stored.find(([id]) => id === SECOND)).toBeUndefined()
    })

    it('moves the merged-away block’s children under the target, after its own', async () => {
      const scope = { kind: 'active', space_id: 'SPACE_PERSONAL' }
      const child = (parentId: string, content: string, blockId: string) =>
        dispatch('create_block', { blockType: 'content', content, parentId, scope, blockId })
      await child(FIRST, 'own child', '01CHD000000000000000000001')
      await child(SECOND, 'moved one', '01CHD000000000000000000002')
      await child(SECOND, 'moved two', '01CHD000000000000000000003')
      await child('01CHD000000000000000000003', 'grandchild', '01CHD000000000000000000004')
      await page.getState().load()

      const merge = page.getState().mergeInto(SECOND, FIRST, `${firstText}${secondText}`)
      const childrenOfFirst = () =>
        page
          .getState()
          .blocks.filter((b) => b.parent_id === FIRST)
          .map((b) => b.content)
      expect(childrenOfFirst()).toEqual(['own child', 'moved one', 'moved two'])

      expect(await merge).toBe(true)
      expect(childrenOfFirst()).toEqual(['own child', 'moved one', 'moved two'])
      const stored = await storedRows()
      expect(stored.filter(([, parent]) => parent === FIRST).map(([, , text]) => text)).toEqual([
        'own child',
        'moved one',
        'moved two',
      ])
      expect(stored.find(([, , text]) => text === 'grandchild')?.[1]).toBe(
        '01CHD000000000000000000003',
      )
      // The edit, two moves and the delete.
      expect(undoRefs()).toEqual([4])
    })

    it('is one command and one undo entry of its ops', async () => {
      await page.getState().mergeInto(SECOND, FIRST, `${firstText}${secondText}`)

      expect(commandsSent().filter((c) => c !== 'load_page_subtree')).toEqual(['merge_blocks'])
      expect(undoRefs()).toEqual([2])
    })

    it('appends the tail to a peer’s edit of the target', async () => {
      await dispatch('edit_block', { blockId: FIRST, toText: `Peer: ${firstText}` })

      await page
        .getState()
        .mergeInto(SECOND, FIRST, `${firstText}${secondText}`, { baseText: firstText })

      const written = `Peer: ${firstText}${secondText}`
      expect(page.getState().blocksById.get(FIRST)?.content).toBe(written)
      expect((await storedRows()).find(([id]) => id === FIRST)?.[2]).toBe(written)
    })

    it('holds an edit of the target until the merge has answered', async () => {
      const mergedText = `${firstText}${secondText}`
      const answerMerge = holdBack('merge_blocks')
      const merge = page.getState().mergeInto(SECOND, FIRST, mergedText)
      const typed = page.getState().edit(FIRST, `${mergedText} typed`, { baseText: mergedText })
      await Promise.resolve()
      await Promise.resolve()
      expect(commandsSent()).not.toContain('edit_block')

      answerMerge()
      expect(await Promise.all([merge, typed])).toEqual([true, true])
      expect((await storedRows()).find(([id]) => id === FIRST)?.[2]).toBe(`${mergedText} typed`)
    })

    it('puts both blocks back when the command is refused', async () => {
      const shownBefore = page.getState().blocks
      refuse('merge_blocks')

      const ok = await page.getState().mergeInto(SECOND, FIRST, `${firstText}${secondText}`)

      expect(ok).toBe(false)
      expect(page.getState().blocks).toBe(shownBefore)
      expect(undoRefs()).toBeUndefined()
      const stored = await storedRows()
      expect(stored.find(([id]) => id === FIRST)?.[2]).toBe(firstText)
      expect(stored.find(([id]) => id === SECOND)?.[2]).toBe(secondText)
    })
  })
})
