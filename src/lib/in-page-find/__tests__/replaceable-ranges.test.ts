/** `replaceableRanges` (#6608): which matches a replace rewrites, for a preview that writes nothing. */
import { describe, expect, it } from 'vitest'

import { blockFindText } from '@/lib/in-page-find/block-text'
import { compileQuery } from '@/lib/in-page-find/matcher'
import { replaceableRanges, replaceInContent } from '@/lib/in-page-find/replace'

const PAGE = '01HZ00000000000000000PAGEA'
const resolveTitle = (): string => 'Target'

function rangesOf(content: string, query: string) {
  const compiled = compileQuery(query, { caseSensitive: false, wholeWord: false, isRegex: false })
  if (compiled.kind !== 'literal') throw new Error('not a literal query')
  return compiled.matcher(blockFindText(content, resolveTitle))
}

describe('replaceableRanges', () => {
  it("answers the block's own matches and counts the one in a link's label", () => {
    const content = `needle and [[${PAGE}|needle link]] and needle`
    const ranges = rangesOf(content, 'needle')

    const { applied, skipped } = replaceableRanges(content, ranges, resolveTitle)

    expect(ranges).toHaveLength(3)
    expect(applied).toEqual([ranges[0], ranges[2]])
    expect(skipped).toBe(1)
    // The same choice the write makes.
    const written = replaceInContent(
      content,
      ranges.map((r) => ({ ...r, text: 'pin' })),
      resolveTitle,
    )
    expect(written).toEqual({
      content: `pin and [[${PAGE}|needle link]] and pin`,
      replaced: applied.length,
      skipped,
    })
  })

  it('answers nothing for a block with no text of its own to find', () => {
    expect(replaceableRanges(null, [{ start: 0, end: 3 }], resolveTitle)).toEqual({
      applied: [],
      skipped: 0,
    })
    expect(replaceableRanges('{{query tag:needle}}', [{ start: 0, end: 3 }], resolveTitle)).toEqual(
      { applied: [], skipped: 0 },
    )
    expect(replaceableRanges('needle', [], resolveTitle)).toEqual({ applied: [], skipped: 0 })
  })
})
