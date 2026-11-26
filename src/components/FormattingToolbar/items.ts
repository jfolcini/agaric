/**
 * Pure helper that flattens the `ToolbarButtonConfig` groups plus the custom
 * buttons (Format and Turn into popover triggers, the table triggers, the
 * cycle-priority badge, the Date menu) into the ordered `ToolbarItem[]`
 * consumed by `useToolbarOverflow`.
 *
 * Group ids: 0 = Format, Turn into, refs and inserts, 1 = structure,
 * 2 = the Task group, 3 = history. Separators sit between groups.
 *
 * Kept as a pure function so the orchestrator's `useMemo` can hold the
 * full result and so this module has no React dependency.
 */

import type { ToolbarButtonConfig } from '@/components/FormattingToolbar/toolbar-config'
import type { ToolbarItem } from '@/hooks/useToolbarOverflow'

export interface ToolbarItemGroups {
  refsAndBlocks: ToolbarButtonConfig[]
  structureButtons: ToolbarButtonConfig[]
  /** The state toggle first: the priority cycle and the Date menu follow it. */
  taskButtons: ToolbarButtonConfig[]
  /** The Date menu's rows: they are one button on the bar (`renderDateMenu`). */
  dateButtons: ToolbarButtonConfig[]
  historyButtons: ToolbarButtonConfig[]
}

export interface BuildToolbarItemsOptions {
  /**
   * #215 — when the selection is inside a table cell, append the table-ops
   * popover trigger to the structure group. Driven by editor state, so the
   * caller passes `editor.isActive('table')`; toggling it changes the item
   * list, which re-triggers `useToolbarOverflow`'s measurement.
   */
  includeTableOps?: boolean
  /** A coarse pointer: New line stays on the bar (`IN_MORE`). */
  touch?: boolean
}

/**
 * The rarer inserts, in More even when the bar has room. On touch New line stays
 * on the bar: it is the one line break a phone's keyboard cannot type (#5160).
 */
const IN_MORE: ReadonlySet<string> = new Set([
  'toolbar.insertBlockRef',
  'toolbar.insertQuery',
  'toolbar.emoji',
  'toolbar.insertTable',
  'toolbar.newLine',
])

export function buildToolbarItems(
  groups: ToolbarItemGroups,
  options: BuildToolbarItemsOptions = {},
): ToolbarItem[] {
  const { refsAndBlocks, structureButtons, taskButtons, dateButtons, historyButtons } = groups
  const { includeTableOps = false, touch = false } = options
  const out: ToolbarItem[] = []
  const pushButton = (key: string, group: number, priority: number, isPopoverTrigger?: boolean) => {
    out.push({
      kind: 'button',
      key,
      group,
      priority,
      ...(isPopoverTrigger === true && { isPopoverTrigger: true }),
      ...(IN_MORE.has(key) && !(touch && key === 'toolbar.newLine') && { inMore: true }),
    })
  }

  // Group 0 — refs + blocks + popover triggers
  // #1958 — the Format popover (inline mark toggles, applied at the caret with
  // no selection) leads the group at near-top priority so it survives overflow
  // collapse at any realistic width: it is the primary text-formatting
  // affordance and the only mark access on touch (where the selection bubble is
  // suppressed). Kept just below Undo/Redo (100 with a fine pointer), whose
  // never-overflow invariant has priority under extreme width pressure.
  pushButton('toolbar.format', 0, 95, true)
  // #1960 — "Turn into" (Pilcrow) popover hosts every block-type transform,
  // REPLACING the standalone Heading / Code-block / Callout / Blockquote /
  // Ordered-list / Divider buttons (now redundant). Sits just after Format at
  // near-top priority so both survive overflow collapse.
  pushButton('toolbar.turnInto', 0, 94, true)
  for (const c of refsAndBlocks) pushButton(c.label, 0, c.priority ?? 0)
  out.push({ kind: 'separator', key: 'sep-0', group: 0, priority: 0 })

  // Group 1 — structure
  for (const c of structureButtons) pushButton(c.label, 1, c.priority ?? 0)
  // #215b — table-insert grid picker. Always present (structural insert with a
  // `/table` slash twin); demoted toward overflow like the other long-tail
  // structure inserts (divider 35 / callout 30) so it drops in first.
  pushButton('toolbar.insertTable', 1, 45, true)
  // Table ops ride here too (structural), but only while in a table. High
  // priority so it survives overflow collapse — it's contextual and the
  // user is actively working in the table they'd want to edit.
  if (includeTableOps) pushButton('toolbar.tableOps', 1, 95, true)
  out.push({ kind: 'separator', key: 'sep-1', group: 1, priority: 0 })

  // Group 2 — the Task group: state, priority, the Date menu, then the block's properties.
  const [stateToggle, ...restOfTask] = taskButtons
  if (stateToggle !== undefined) pushButton(stateToggle.label, 2, stateToggle.priority ?? 0)
  // Below the TODO toggle (80).
  pushButton('toolbar.cyclePriority', 2, 75)
  pushButton('toolbar.date', 2, Math.max(0, ...dateButtons.map((c) => c.priority ?? 0)))
  for (const c of restOfTask) pushButton(c.label, 2, c.priority ?? 0)
  out.push({ kind: 'separator', key: 'sep-2', group: 2, priority: 0 })

  // Group 3 — history
  for (const c of historyButtons) pushButton(c.label, 3, c.priority ?? 0)

  return out
}

/** Build a `label -> config` lookup for `renderConfigButton`. */
export function buildConfigByKey(groups: ToolbarItemGroups): Map<string, ToolbarButtonConfig> {
  const { refsAndBlocks, structureButtons, taskButtons, historyButtons } = groups
  const map = new Map<string, ToolbarButtonConfig>()
  for (const c of [...refsAndBlocks, ...structureButtons, ...taskButtons, ...historyButtons]) {
    map.set(c.label, c)
  }
  return map
}
