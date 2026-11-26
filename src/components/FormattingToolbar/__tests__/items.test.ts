/**
 * The bar's slots under width pressure (#6532): which buttons `computeOverflow`
 * keeps on the formatting toolbar as it narrows, with the priorities the
 * config and `buildToolbarItems` give them. On a phone the bar is a few
 * 44 px buttons wide, and what stays on it is what a thumb reaches without
 * opening More.
 */

import type { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'

import { buildToolbarItems } from '@/components/FormattingToolbar/items'
import {
  createHistoryButtons,
  createIndentButtons,
  createDateButtons,
  createRefsAndBlocks,
  createStructureButtons,
  createTaskButtons,
} from '@/components/FormattingToolbar/toolbar-config'
import { computeOverflow, OVERFLOW_TRIGGER_WIDTH_PX } from '@/hooks/useToolbarOverflow'

// The configs only close over the editor; no button is pressed here.
const editor = {} as Editor
const noop = () => {}

/** A coarse-pointer toolbar button (`icon-xs` is 44 px there). */
const BUTTON_PX = 44
/** A group separator: a 1 px rule with `mx-0.5` either side. */
const SEPARATOR_PX = 5

/** The bar's items; on touch with Indent and Outdent, as `FormattingToolbar` builds it there. */
function items(touch: boolean) {
  const indent = touch ? createIndentButtons(noop, noop) : []
  return buildToolbarItems(
    {
      refsAndBlocks: createRefsAndBlocks(editor),
      structureButtons: [...createStructureButtons(editor), ...indent],
      taskButtons: createTaskButtons(),
      dateButtons: createDateButtons(),
      historyButtons: createHistoryButtons(editor, touch),
    },
    { touch },
  )
}

/** The keys left on the bar at `width` px of content box. */
function onBar(touch: boolean, width: number): Set<string> {
  const all = items(touch)
  const widths = new Map(
    all.map((item) => [item.key, item.kind === 'separator' ? SEPARATOR_PX : BUTTON_PX]),
  )
  const { visible } = computeOverflow(all, width, widths, OVERFLOW_TRIGGER_WIDTH_PX)
  return new Set(visible.filter((item) => item.kind === 'button').map((item) => item.key))
}

/** Every bar width from nothing to wider than the whole bar. */
const WIDTHS = Array.from({ length: 1200 }, (_, i) => i + 1)

/** `keeper` is on the bar at every width `dropped` is: it is never folded into More first. */
function outlives(touch: boolean, keeper: string, dropped: string): void {
  for (const width of WIDTHS) {
    const bar = onBar(touch, width)
    if (bar.has(dropped)) expect(bar.has(keeper), `${keeper} at ${width} px`).toBe(true)
  }
}

describe('the Task group', () => {
  it('holds Toggle TODO, Cycle priority, one Date menu and Properties, in that order', () => {
    const task = items(false).filter((item) => item.kind === 'button' && item.group === 2)
    expect(task.map((item) => item.key)).toEqual([
      'toolbar.todoToggle',
      'toolbar.cyclePriority',
      'toolbar.date',
      'toolbar.properties',
    ])
  })
})

describe('the rarer inserts', () => {
  /** The bar and More at a width with room for every button. */
  function split(touch: boolean) {
    const all = items(touch)
    const { visible, overflowed } = computeOverflow(all, 5000, new Map(), 0)
    return { bar: visible.map((item) => item.key), more: overflowed.map((item) => item.key) }
  }

  it('with a fine pointer, are in More with room on the bar, one rule where their group was', () => {
    const { bar, more } = split(false)
    expect(more).toEqual([
      'toolbar.insertBlockRef',
      'toolbar.insertQuery',
      'toolbar.emoji',
      'toolbar.newLine',
      'toolbar.insertTable',
    ])
    expect(bar).toEqual([
      'toolbar.format',
      'toolbar.turnInto',
      'toolbar.internalLink',
      'toolbar.insertTag',
      'sep-0',
      'toolbar.todoToggle',
      'toolbar.cyclePriority',
      'toolbar.date',
      'toolbar.properties',
      'sep-2',
      'toolbar.undo',
      'toolbar.redo',
    ])
  })

  it('on touch, New line stays on the bar', () => {
    const { bar, more } = split(true)
    expect(more).toEqual([
      'toolbar.insertBlockRef',
      'toolbar.insertQuery',
      'toolbar.emoji',
      'toolbar.insertTable',
    ])
    expect(bar).toContain('toolbar.newLine')
  })
})

describe('the toolbar under width pressure', () => {
  it.each([false, true])('Toggle TODO outlives Cycle priority (touch: %s)', (touch) => {
    outlives(touch, 'toolbar.todoToggle', 'toolbar.cyclePriority')
  })

  it.each([
    'toolbar.todoToggle',
    'toolbar.internalLink',
    'toolbar.insertTag',
    'toolbar.indent',
    'toolbar.outdent',
  ])('on touch, %s outlives Undo and Redo', (keeper) => {
    outlives(true, keeper, 'toolbar.undo')
    outlives(true, keeper, 'toolbar.redo')
  })

  // The bar spans the viewport less its `px-2` padding.
  it.each([
    [412, 396, ['toolbar.todoToggle', 'toolbar.indent', 'toolbar.outdent']],
    [360, 344, ['toolbar.todoToggle', 'toolbar.indent']],
  ])('on a %s px phone (a %s px bar), the bar keeps %s', (_phone, width, keys) => {
    const bar = onBar(true, width)
    for (const key of keys) expect(bar.has(key), key).toBe(true)
  })

  it('on touch, Toggle TODO outlives Indent and Outdent', () => {
    outlives(true, 'toolbar.todoToggle', 'toolbar.indent')
    outlives(true, 'toolbar.todoToggle', 'toolbar.outdent')
  })

  it('with a fine pointer, Undo and Redo outlive Toggle TODO', () => {
    outlives(false, 'toolbar.undo', 'toolbar.todoToggle')
    outlives(false, 'toolbar.redo', 'toolbar.todoToggle')
  })
})
