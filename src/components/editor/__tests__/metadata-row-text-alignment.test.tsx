/**
 * The block metadata row must line up with the block TEXT, not with the
 * content column's left edge.
 *
 * `SortableBlock` stacks the editor text and `BlockMetadataRow` as siblings in
 * one flex column, so they already share a left EDGE. That is not the same as
 * sharing a left ALIGNMENT: the text is inset from that edge by its own
 * horizontal padding, and the row originally had none — which put the chips
 * about 12px to the left of the first character, under the gutter rather than
 * under the title.
 *
 * This lives in its own file because the invariant spans two components that
 * no single existing suite renders together: `SortableBlock.test.tsx` mocks
 * `EditableBlock` away (so no real text container exists there to measure),
 * and `StaticBlock.test.tsx` never renders the metadata row. Both are rendered
 * for real here.
 *
 * It asserts the RELATIONSHIP, not the literal `px-3`. A test pinning `px-3`
 * on the row alone stays green if someone changes the TEXT's inset, which is
 * precisely the drift that produces the misalignment — the row would then be
 * "correct" against a value nothing else uses any more.
 *
 * KNOWN GAP, stated rather than implied: this covers the unfocused path only.
 * The focused path insets its text via `.ProseMirror { @apply px-3 }` in
 * `index.css`, and happy-dom applies no stylesheet, so there is no rendered
 * value to read. A change to that CSS rule alone would misalign the focused
 * state with nothing here going red. Keeping the two paths on the same value
 * is what makes one assertion meaningful for both; that coupling is asserted
 * by neither test nor type.
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BlockMetadataRow } from '@/components/editor/BlockInlineControls'
import { StaticBlock } from '@/components/editor/StaticBlock'

vi.mock('@/lib/open-url', () => ({ openUrl: vi.fn() }))

/**
 * The horizontal-inset utility classes on an element, order-insensitive.
 *
 * The `(^|:)` matches variant-prefixed insets (`sm:px-4`,
 * `[@media(pointer:coarse)]:px-2`) as well as bare ones. An anchored
 * `/^(px|pl)-/` would not, and that is not a hypothetical gap: adding a
 * breakpoint inset to `block-static` alone would be invisible to BOTH sides of
 * the comparison below, leaving this test green while the alignment drifts at
 * exactly that breakpoint. `block-static` already carries
 * `[@media(pointer:coarse)]:min-h-[2.75rem]`, so variant classes on it are an
 * established pattern rather than a shape nobody would reach for.
 */
const horizontalInset = (el: Element | null) =>
  [...(el?.classList ?? [])].filter((c) => /(^|:)(px|pl)-/.test(c)).toSorted()

describe('metadata row / block text alignment', () => {
  it('insets the metadata row by the same amount as the block text', () => {
    const text = render(<StaticBlock blockId="B1" content="Hello world" onFocus={vi.fn()} />)
    const textEl = text.container.querySelector('.block-static')
    expect(textEl).toBeInTheDocument()

    const row = render(
      <BlockMetadataRow
        blockId="B1"
        scheduledDate="2025-09-08"
        filteredProperties={[]}
        attachmentCount={0}
        showAttachments={false}
        onToggleAttachments={vi.fn()}
        onEditProp={vi.fn()}
        onEditKey={vi.fn()}
      />,
    )
    const rowEl = row.container.querySelector('.block-metadata-row')
    expect(rowEl).toBeInTheDocument()

    const textInset = horizontalInset(textEl)
    // Guard the guard. Without this, a text container that stopped carrying an
    // explicit inset class would make the comparison below `[] === []` — green,
    // and asserting nothing whatsoever.
    expect(textInset.length).toBeGreaterThan(0)

    expect(horizontalInset(rowEl)).toEqual(textInset)
  })
})
