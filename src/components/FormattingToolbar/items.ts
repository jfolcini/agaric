/**
 * Pure helper that flattens the four `ToolbarButtonConfig` groups plus
 * the three custom buttons (heading-level popover trigger, code-block
 * popover trigger, cycle-priority badge) into the ordered
 * `ToolbarItem[]` consumed by `useToolbarOverflow`.
 *
 * Group ids: 0 = refs+blocks+heading/codeBlock, 1 = structure,
 * 2 = priority+metadata, 3 = history. Separators sit between groups.
 *
 * Kept as a pure function so the orchestrator's `useMemo` can hold the
 * full result and so this module has no React dependency.
 */

import type { ToolbarItem } from '@/hooks/useToolbarOverflow'
import type { ToolbarButtonConfig } from '@/lib/toolbar-config'

export interface ToolbarItemGroups {
  refsAndBlocks: ToolbarButtonConfig[]
  structureButtons: ToolbarButtonConfig[]
  metadataButtons: ToolbarButtonConfig[]
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
}

export function buildToolbarItems(
  groups: ToolbarItemGroups,
  options: BuildToolbarItemsOptions = {},
): ToolbarItem[] {
  const { refsAndBlocks, structureButtons, metadataButtons, historyButtons } = groups
  const { includeTableOps = false } = options
  const out: ToolbarItem[] = []
  const pushButton = (key: string, group: number, priority: number, isPopoverTrigger?: boolean) => {
    out.push(
      isPopoverTrigger
        ? { kind: 'button', key, group, priority, isPopoverTrigger: true }
        : { kind: 'button', key, group, priority },
    )
  }

  // Group 0 — refs + blocks + popover triggers
  // #1958 — the Format popover (inline mark toggles, applied at the caret with
  // no selection) leads the group at near-top priority so it survives overflow
  // collapse at any realistic width: it is the primary text-formatting
  // affordance and the only mark access on touch (where the selection bubble is
  // suppressed). Kept just below Undo/Redo (100), whose never-overflow
  // invariant has priority under extreme width pressure.
  pushButton('toolbar.format', 0, 95, true)
  for (const c of refsAndBlocks) pushButton(c.label, 0, c.priority ?? 0)
  pushButton('toolbar.codeBlockLanguage', 0, 90, true)
  pushButton('toolbar.headingLevel', 0, 90, true)
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

  // Group 2 — priority + metadata
  pushButton('toolbar.cyclePriority', 2, 80)
  for (const c of metadataButtons) pushButton(c.label, 2, c.priority ?? 0)
  out.push({ kind: 'separator', key: 'sep-2', group: 2, priority: 0 })

  // Group 3 — history
  for (const c of historyButtons) pushButton(c.label, 3, c.priority ?? 0)

  return out
}

/** Build a `label -> config` lookup for `renderConfigButton`. */
export function buildConfigByKey(groups: ToolbarItemGroups): Map<string, ToolbarButtonConfig> {
  const { refsAndBlocks, structureButtons, metadataButtons, historyButtons } = groups
  const map = new Map<string, ToolbarButtonConfig>()
  for (const c of [...refsAndBlocks, ...structureButtons, ...metadataButtons, ...historyButtons]) {
    map.set(c.label, c)
  }
  return map
}
