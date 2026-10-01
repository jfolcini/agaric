/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons (post Layer A): Format, Internal Link, Tag, Blockquote | Code Block,
 * Heading | Ordered List, Divider, Callout | Cycle Priority, Date, Due Date,
 * Scheduled Date, TODO, Properties | Undo, Redo, Discard. The mark toggles
 * + External Link live in `SelectionBubbleMenu` (Layer A); the leading
 * "Format" popover (#1958) re-exposes those same mark toggles so they can be
 * applied at the caret with no selection (and on touch, where the bubble is
 * suppressed).
 *
 * Layer B: each button carries a `priority` (see
 * `src/lib/toolbar-config.ts`). When the container is narrow enough that not
 * every button fits, the lowest-priority buttons collapse into a
 * `MoreHorizontal` overflow popover. Group separators disappear when both
 * sides have lost all visible buttons. The hook `useToolbarOverflow` does
 * the measurement via `ResizeObserver` on the container + an off-screen
 * sentinel for per-item widths.
 *
 * Uses onPointerDown + preventDefault so clicks never steal focus from TipTap.
 * Priority and Date buttons dispatch custom events that BlockTree listens for.
 *
 * Per-group renderers, the item-flatten helper, shared primitives and the
 * frame (overflow, roving focus, touch pinning, shared with *Edit as
 * Markdown*'s toolbar) live in `./FormattingToolbar/`. This file only owns
 * wiring — editor state, popover open state and the render-dispatch switch.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { buildConfigByKey, buildToolbarItems } from '@/components/FormattingToolbar/items'
import { renderCyclePriority } from '@/components/FormattingToolbar/MetadataGroup'
import {
  renderFormatButton,
  renderTableOpsButton,
  renderTablePickerButton,
  renderTurnIntoButton,
} from '@/components/FormattingToolbar/RefsAndBlocksGroup'
import { type RenderMode, renderConfigButton } from '@/components/FormattingToolbar/shared'
import { ToolbarFrame } from '@/components/FormattingToolbar/ToolbarFrame'
import type { ToolbarItem } from '@/hooks/useToolbarOverflow'
import {
  createHistoryButtons,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
} from '@/lib/toolbar-config'

interface FormattingToolbarProps {
  editor: Editor
  /** Block ID used to associate toolbar with its editor via aria-controls. */
  blockId?: string
  /** Current priority of the focused block (null, '1', '2', '3'). */
  currentPriority?: string | null
}

function getHeadingLevel(editor: Editor): number {
  for (let lvl = 1; lvl <= 6; lvl++) {
    if (editor.isActive('heading', { level: lvl })) return lvl
  }
  return 0
}

export function FormattingToolbar({
  editor,
  blockId,
  currentPriority,
}: FormattingToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const [formatPopoverOpen, setFormatPopoverOpen] = useState(false)
  const [turnIntoPopoverOpen, setTurnIntoPopoverOpen] = useState(false)
  const [tableOpsPopoverOpen, setTableOpsPopoverOpen] = useState(false)
  const [tablePickerPopoverOpen, setTablePickerPopoverOpen] = useState(false)

  const state = useEditorState({
    editor,
    // #3056 — `ctx.editor` can be momentarily null during mount/teardown (the
    // editor instance is torn down while this toolbar is still mounted), even
    // though the `editor` prop is typed non-null. Guard before touching
    // `.isActive()`/`.can()` and fall back to inert defaults.
    selector: (ctx) => {
      if (!ctx.editor) {
        return {
          codeBlock: false,
          codeBlockLanguage: '',
          blockquote: false,
          headingLevel: 0,
          isInsideTable: false,
          canUndo: false,
          canRedo: false,
        }
      }
      return {
        codeBlock: ctx.editor.isActive('codeBlock'),
        codeBlockLanguage: ctx.editor.isActive('codeBlock')
          ? ((ctx.editor.getAttributes('codeBlock')['language'] as string) ?? '')
          : '',
        blockquote: ctx.editor.isActive('blockquote'),
        headingLevel: getHeadingLevel(ctx.editor),
        // #215 — drives the contextual table-ops trigger's presence.
        isInsideTable: ctx.editor.isActive('table'),
        canUndo: ctx.editor.can().undo(),
        canRedo: ctx.editor.can().redo(),
      }
    },
  })

  const groups = useMemo(
    () => ({
      refsAndBlocks: createRefsAndBlocks(editor),
      structureButtons: createStructureButtons(editor),
      metadataButtons: createMetadataButtons(),
      historyButtons: createHistoryButtons(editor),
    }),
    [editor],
  )
  const configByKey = useMemo(() => buildConfigByKey(groups), [groups])
  const items: ToolbarItem[] = useMemo(
    () => buildToolbarItems(groups, { includeTableOps: state.isInsideTable }),
    [groups, state.isInsideTable],
  )

  // ── Item renderer dispatch ────────────────────────────────────────────

  const renderItem = (
    item: ToolbarItem,
    mode: RenderMode,
    closeOverflow: () => void,
  ): React.ReactElement | null => {
    switch (item.key) {
      case 'toolbar.format': {
        return renderFormatButton({
          editor,
          mode,
          t,
          open: formatPopoverOpen,
          setOpen: setFormatPopoverOpen,
        })
      }
      case 'toolbar.turnInto': {
        return renderTurnIntoButton({
          editor,
          mode,
          t,
          open: turnIntoPopoverOpen,
          setOpen: setTurnIntoPopoverOpen,
          blockId,
        })
      }
      case 'toolbar.tableOps': {
        return renderTableOpsButton({
          editor,
          mode,
          t,
          open: tableOpsPopoverOpen,
          setOpen: setTableOpsPopoverOpen,
          onOverflowClose: closeOverflow,
        })
      }
      case 'toolbar.insertTable': {
        return renderTablePickerButton({
          editor,
          mode,
          t,
          open: tablePickerPopoverOpen,
          setOpen: setTablePickerPopoverOpen,
          onOverflowClose: closeOverflow,
        })
      }
      case 'toolbar.cyclePriority': {
        return renderCyclePriority({
          mode,
          t,
          currentPriority,
          onAfterOverflowAction: closeOverflow,
        })
      }
      default: {
        const cfg = configByKey.get(item.key)
        if (!cfg) return null
        return renderConfigButton(
          cfg,
          state as Record<string, unknown>,
          mode,
          t,
          mode === 'overflow' ? closeOverflow : undefined,
        )
      }
    }
  }

  return (
    <ToolbarFrame
      items={items}
      renderItem={renderItem}
      label={t('toolbar.formatting')}
      testId="formatting-toolbar"
      controls={blockId ? `editor-${blockId}` : undefined}
    />
  )
}
