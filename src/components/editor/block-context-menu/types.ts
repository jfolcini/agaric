/**
 * BlockContextMenu — shared types.
 *
 * Extracted from `BlockContextMenu.tsx` so the menu shell, the label/hint
 * helpers and any future sub-components can share these types WITHOUT importing
 * back from `BlockContextMenu.tsx` (which would close an import cycle the
 * `frontend import cycles (zero)` hook forbids). Mirrors the AddFilterPopover
 * split (`add-filter/vocab.ts`).
 */

import type { BlockActions } from '@/hooks/useBlockActions'
import type { BlockTypeToken } from '@/lib/block-type-convert'

export interface BlockContextMenuProps {
  blockId: string
  position: { x: number; y: number }
  onClose: () => void
  /** Ref to the element that triggered the menu, for focus restoration. */
  triggerRef?: React.RefObject<HTMLElement | null> | undefined
  /**
   * A2 (#1020) — the per-block action callbacks, passed as a single cohesive
   * bag instead of ~15 individual optional props. This is the same `BlockActions`
   * registry that `useBlockActions()` publishes, so `SortableBlock` forwards it
   * verbatim (`actions={useBlockActions()}`) rather than re-drilling each
   * callback by hand.
   *
   * The prop is REQUIRED: a caller can no longer silently forget to wire the
   * actions and end up with a dead menu — the type system forces the bag to be
   * present. Individual entries inside the bag remain optional; a missing key
   * means "this affordance is not available here" and the corresponding menu
   * item is omitted (the long-standing conditional-group behaviour).
   *
   * The action keys consumed by this menu are: `onDelete`, `onIndent`,
   * `onDedent`, `onToggleTodo`, `onTogglePriority`, `onToggleCollapse`,
   * `onMoveUp`, `onMoveDown`, `onMerge`, `onDuplicate`, `onShowHistory`,
   * `onShowProperties`, `onZoomIn`, `onTurnInto`, and `onBatchDelete`.
   */
  actions: BlockActions
  hasChildren?: boolean | undefined
  isCollapsed?: boolean | undefined
  todoState?: (string | null) | undefined
  priority?: (string | null) | undefined
  /** Due date in YYYY-MM-DD format (for future use). */
  dueDate?: (string | null) | undefined
  /** URL of external link under cursor (for Copy URL action). */
  linkUrl?: string | undefined
  /**
   * #1445 — id used by the "Copy page reference" action (`[[ULID]]`). When the
   * menu's block IS a page this is the block's own id; otherwise it is the id
   * of the containing page. Resolved by `SortableBlock` from the per-page store
   * (no extra IPC). Omitted when the containing page is unknown, in which case
   * the "Copy page reference" item is hidden. "Copy block reference"
   * (`((ULID))`) always uses `blockId` directly and needs no extra prop.
   */
  pageRefId?: string | undefined
  /** Current block type, used to indicate the active option in "Turn into". */
  activeBlockType?: BlockTypeToken | undefined
  /**
   * Fix 6 — the active multi-selection (global `selectedBlockIds`). When this
   * contains more than one block AND includes the right-clicked block, the
   * menu enters "bulk" mode: Delete / TODO / Priority / Move ops apply to the
   * WHOLE selection instead of just this block. With no (or a single-block)
   * selection the menu behaves exactly as before — single-block ops only.
   *
   * #1018 — normally OMITTED. The menu subscribes to the global selection
   * itself (below), so the per-row `SortableBlock` no longer has to subscribe
   * to the whole `selectedBlockIds` array (that caused an O(N) re-render
   * cascade on every toggle). The subscription lives here because the menu is
   * the only consumer and it only mounts while open — closed-menu rows pay
   * nothing. This prop remains an explicit override (used by tests) and, when
   * provided, fully replaces the store read.
   */
  selectedBlockIds?: string[] | undefined
}

export interface MenuItem {
  label: string
  icon: React.ReactNode
  action: (() => void) | undefined
  className?: string
  shortcut?: string
  /** #264 — marks the active block type inside the "Turn into" group. */
  active?: boolean
  /**
   * #999 — indent the whole row one level (e.g. the "Turn into" child type
   * options nested under the parent toggle). Declared at the row level so the
   * indent is applied identically to both the actionable button and the
   * non-interactive active indicator (the flat render loop + roving-focus
   * forbid a wrapping `<div>`).
   */
  indented?: boolean
  /**
   * #1003 — marks a disclosure toggle ("Turn into", #1109 "Move & arrange").
   * When set, the row renders a trailing chevron (right when collapsed, down
   * when expanded) in place of a shortcut hint, and carries `aria-expanded` +
   * `aria-controls` so screen readers announce the parent/child relationship to
   * the inline-expanded options group it controls (see `disclosureId`).
   */
  expanded?: boolean
  /**
   * #1109 — id of the inline-expanded options group this row participates in.
   * On a toggle row (with `expanded`) it is the `aria-controls` target; on an
   * `indented` child row it is the id of the wrapping `role="group"`. Lets the
   * menu host more than one disclosure group ("Turn into" and "Move & arrange")
   * without the previously-hardcoded single `turnIntoGroupId`.
   */
  disclosureId?: string
  /**
   * #1109 — accessible label for the wrapping `role="group"` of `indented`
   * child rows (e.g. "Turn into", "Move & arrange"), announced to AT.
   */
  disclosureLabel?: string
}
