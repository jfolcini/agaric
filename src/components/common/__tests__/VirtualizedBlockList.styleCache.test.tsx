/**
 * #3738 note 3 — the per-offset style cache must not punish rows that never
 * moved.
 *
 * `BacklinkRow` is `memo`'d so that the panel re-rendering on every arrow-key /
 * focus change does not rebuild every mounted row's element tree (#2193), and
 * that memo compares `style` by reference — which is why `VirtualizedBlockList`
 * caches one style object per virtual offset (#3732 note 3, pinned by
 * `CollapsibleGroupList.virtualization.test.tsx`).
 *
 * The eviction was the hole. `if (cache.size > rowCount * 2) cache.clear()`
 * fires in the MIDDLE of a render pass, on the first row whose offset happens to
 * push the map over the cap. Every row already served in that pass keeps a
 * reference the cache no longer holds, so the next render mints a fresh object
 * for each of them: a whole-window memo miss caused by two rows re-measuring.
 *
 * The lever is re-measurement churn — the real virtualizer shifts the rows BELOW
 * a row whose measured height changed and leaves the ones above alone. The
 * shared mock's `rowStart` models exactly that; `estimateSize`/`windowSize`
 * cannot.
 */

import { render } from '@testing-library/react'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

/** Rows 0-1 hold their offset; rows 2-3 move by this much every re-measure. */
const churn = vi.hoisted(() => ({ shift: 0 }))
/** Deliberately not a multiple of the 36px estimate, so no shifted offset can
 *  collide with another row's un-shifted one and read as a cache hit. */
const SHIFT_STEP = 7
const STABLE_ROWS = 2

vi.mock('@tanstack/react-virtual', () =>
  mockReactVirtual({
    rowStart: (index, defaultStart) =>
      index < STABLE_ROWS ? defaultStart : defaultStart + churn.shift,
  }),
)

import { VirtualizedBlockList } from '@/components/common/VirtualizedBlockList'

const BLOCKS = [{ id: 'B0' }, { id: 'B1' }, { id: 'B2' }, { id: 'B3' }]

type StyleMap = Map<string, React.CSSProperties>

function listElement(collect: StyleMap) {
  return (
    <VirtualizedBlockList
      blocks={BLOCKS}
      renderBlock={(block, ctx) => {
        collect.set(block.id, ctx.style)
        return (
          <li key={block.id} ref={ctx.measureRef} style={ctx.style} data-index={ctx.index}>
            {block.id}
          </li>
        )
      }}
    />
  )
}

beforeEach(() => {
  churn.shift = 0
})

describe('VirtualizedBlockList — style cache eviction', () => {
  it('keeps a settled row’s style identity while other rows churn past the cap', () => {
    const styles: StyleMap[] = []
    const nextPass = () => {
      const collect: StyleMap = new Map()
      styles.push(collect)
      return listElement(collect)
    }

    const utils = render(nextPass())
    // Three re-measures of the bottom two rows. Each mints two offsets nothing
    // will ever ask for again, which is what drives the map past `rowCount * 2`.
    for (let i = 1; i <= 3; i++) {
      churn.shift = SHIFT_STEP * i
      utils.rerender(nextPass())
    }
    // …and now a render in which NOTHING moves.
    utils.rerender(nextPass())

    const settled = styles.at(-2)
    const quiet = styles.at(-1)
    expect(settled?.size).toBe(BLOCKS.length)
    expect(quiet?.size).toBe(BLOCKS.length)

    // THE property: a row whose offset did not change hands back the SAME
    // object, so `memo` holds. Under `cache.clear()` the rows served before the
    // clear lost their entries and every one of these is a fresh object.
    for (const block of BLOCKS) {
      expect(quiet?.get(block.id)).toBe(settled?.get(block.id))
    }
  })

  it('still hands a moved row a fresh style (the cache is keyed on the offset)', () => {
    const first: StyleMap = new Map()
    const second: StyleMap = new Map()

    const utils = render(listElement(first))
    churn.shift = SHIFT_STEP
    utils.rerender(listElement(second))

    // Rows that held their offset keep their object…
    expect(second.get('B0')).toBe(first.get('B0'))
    expect(second.get('B1')).toBe(first.get('B1'))
    // …and the ones that moved get a style carrying the new offset.
    expect(second.get('B2')).not.toBe(first.get('B2'))
    expect(second.get('B2')?.transform).toBe(`translateY(${2 * 36 + SHIFT_STEP}px)`)
  })
})
