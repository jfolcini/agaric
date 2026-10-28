/**
 * #5686 — the ULID tokens *Edit as Markdown* leaves in its text: what reads as
 * one, the hint it shows, how its ids are resolved, and which resolve to
 * nothing before a save.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  findUlidTokens,
  findUnresolvedUlidTokens,
  resolveUlidTokens,
  ulidTokenHint,
} from '@/components/pages/ulid-tokens'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const PAGE = '01K0000000000000000000PAGE'
const TAG = '01K00000000000000000000TAG'
const BLOCK = '01K0000000000000000000REF1'
const GONE = '01K000000000000000000000GN'
const TRASHED = '01K000000000000000000TRASH'
/** ULID-shaped, but `O` is not Crockford: the backend finds nothing for it. */
const MALFORMED = '01K000000000000000000000OO'

interface Resolved {
  id: string
  title: string | null
  block_type: string
  deleted: boolean
}

const ROWS: Resolved[] = [
  { id: PAGE, title: 'Project Plan', block_type: 'page', deleted: false },
  { id: TAG, title: 'urgent', block_type: 'tag', deleted: false },
  { id: BLOCK, title: 'Call the bank\nabout the loan', block_type: 'content', deleted: false },
  { id: TRASHED, title: 'Old notes', block_type: 'page', deleted: true },
]

function stubBatchResolve() {
  const batchResolve = vi.fn((args: unknown) => {
    const { ids } = args as { ids: string[] }
    return ROWS.filter((r) => ids.includes(r.id))
  })
  mockedInvoke.mockImplementation(mockInvokeCommands({ batch_resolve: batchResolve }))
  return batchResolve
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  useResolveStore.setState({ cache: new Map(), version: 0 })
})

describe('findUlidTokens', () => {
  it('reads each kind, with its id and its range in the text', () => {
    const text = `See [[${PAGE}]] and #[${TAG}], ((${BLOCK})).\n  owner:: ${PAGE}`
    const tokens = findUlidTokens(text)

    expect(tokens.map((t) => [t.kind, t.id, text.slice(t.from, t.to)])).toEqual([
      ['link', PAGE, `[[${PAGE}]]`],
      ['tag', TAG, `#[${TAG}]`],
      ['ref', BLOCK, `((${BLOCK}))`],
      ['property', PAGE, PAGE],
    ])
  })

  it('reads no token in a title, a short id or a value with more text', () => {
    const text = [
      '[[Project Plan]] #urgent ((01K00))',
      `owner:: ${PAGE} and more`,
      `std::${PAGE}`,
    ].join('\n')

    expect(findUlidTokens(text)).toEqual([])
  })

  it('reads a property value after any key, indented or not, with a tab or trailing blanks', () => {
    const text = `ref:: ${PAGE}\n    due_date::\t${BLOCK}  `
    expect(findUlidTokens(text).map((t) => [t.kind, t.id])).toEqual([
      ['property', PAGE],
      ['property', BLOCK],
    ])
  })
})

describe('resolveUlidTokens', () => {
  it('asks for every uncached id in one batch, a malformed one too', async () => {
    const batchResolve = stubBatchResolve()
    useResolveStore.getState().set(TAG, 'urgent', false)

    await resolveUlidTokens(
      findUlidTokens(`[[${PAGE}]] #[${TAG}] ((${BLOCK})) ((${BLOCK})) [[${MALFORMED}]]`),
    )

    expect(batchResolve).toHaveBeenCalledTimes(1)
    expect(batchResolve.mock.calls[0]?.[0]).toMatchObject({ ids: [PAGE, BLOCK, MALFORMED] })
    expect(useResolveStore.getState().resolveTitle(BLOCK)).toBe('Call the bank')
  })

  it('asks nothing when every id is cached', async () => {
    const batchResolve = stubBatchResolve()
    useResolveStore.getState().set(PAGE, 'Project Plan', false)

    await resolveUlidTokens(findUlidTokens(`[[${PAGE}]] ((${PAGE}))`))

    expect(batchResolve).not.toHaveBeenCalled()
  })
})

describe('ulidTokenHint', () => {
  it("shows a resolved target's title, and a trashed one's marked deleted", async () => {
    stubBatchResolve()
    const tokens = findUlidTokens(`[[${PAGE}]] [[${TRASHED}]]`)
    await resolveUlidTokens(tokens)

    expect(tokens.map(ulidTokenHint)).toEqual([
      { label: 'Project Plan', deleted: false },
      { label: 'Old notes', deleted: true },
    ])
  })

  it("shows each kind's fallback label, marked deleted, for a target nothing resolves", async () => {
    stubBatchResolve()
    const tokens = findUlidTokens(`[[${GONE}]] #[${GONE}] ((${GONE})) ((${MALFORMED}))`)
    await resolveUlidTokens(tokens)

    expect(tokens.map(ulidTokenHint)).toEqual([
      { label: '[[01K00000...]]', deleted: true },
      { label: '#01K00000...', deleted: true },
      { label: '(( 01K00000... ))', deleted: true },
      { label: '(( 01K00000... ))', deleted: true },
    ])
  })

  it('shows nothing for an id not asked about yet', () => {
    expect(findUlidTokens(`((${BLOCK}))`).map(ulidTokenHint)).toEqual([null])
  })
})

describe('findUnresolvedUlidTokens', () => {
  it('finds the unknown and the malformed, not the resolved or the trashed', async () => {
    stubBatchResolve()

    const unresolved = await findUnresolvedUlidTokens(
      `- [[${PAGE}]] ((${GONE}))\n  ref:: ${TRASHED}\n- #[${TAG}] [[${MALFORMED}]]`,
    )

    expect(unresolved.map((t) => [t.kind, t.id])).toEqual([
      ['ref', GONE],
      ['link', MALFORMED],
    ])
  })

  it('reports nothing it could not ask about when the request fails', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        batch_resolve: () => {
          throw new Error('backend down')
        },
      }),
    )

    expect(await findUnresolvedUlidTokens(`((${GONE}))`)).toEqual([])
  })
})

describe('findUlidTokens, a labelled link', () => {
  // The page-mode parser's grammar (`tryConsumeBlockLink`): the label runs to the first `]`,
  // which must close the token, and holds no newline; an empty one is no label.
  it('reads `[[ULID|label]]` as one link token, label included', () => {
    const text = `see [[${PAGE}|my label]] and [[${PAGE}]] and ((${BLOCK})) and #[${TAG}]`
    const tokens = findUlidTokens(text)

    expect(tokens.map((t) => [t.kind, t.id, text.slice(t.from, t.to)])).toEqual([
      ['link', PAGE, `[[${PAGE}|my label]]`],
      ['link', PAGE, `[[${PAGE}]]`],
      ['ref', BLOCK, `((${BLOCK}))`],
      ['tag', TAG, `#[${TAG}]`],
    ])
  })

  it('reads an empty label, and a `|` inside one', () => {
    const text = `[[${PAGE}|]] [[${PAGE}|a|b]]`
    expect(findUlidTokens(text).map((t) => text.slice(t.from, t.to))).toEqual([
      `[[${PAGE}|]]`,
      `[[${PAGE}|a|b]]`,
    ])
  })

  it('reads no token when the label holds a `]` before the close or a line break', () => {
    expect(findUlidTokens(`[[${PAGE}|a]b]]`)).toEqual([])
    expect(findUlidTokens(`[[${PAGE}|a\nb]]`)).toEqual([])
    expect(findUlidTokens(`[[${PAGE}|unclosed`)).toEqual([])
  })

  it('asks the backend for the labelled link’s id, not its label', async () => {
    const batchResolve = stubBatchResolve()

    await resolveUlidTokens(findUlidTokens(`[[${PAGE}|the plan]]`))

    expect(batchResolve.mock.calls[0]?.[0]).toMatchObject({ ids: [PAGE] })
  })
})
