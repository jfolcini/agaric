/**
 * Toolbar button configuration arrays extracted from FormattingToolbar.
 *
 * Each `create*` factory returns a `ToolbarButtonConfig[]` ready to
 * be consumed by `ToolbarButtonGroup`.  Factories that need editor
 * interaction accept an `Editor` parameter; pure-event configs are
 * plain functions with no parameters.
 */

import type { Editor } from '@tiptap/react'
import type { LucideIcon } from 'lucide-react'
import {
  AtSign,
  Bold,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Code,
  FileSymlink,
  Highlighter,
  Italic,
  ListFilter,
  Parentheses,
  Redo2,
  Settings2,
  Smile,
  Strikethrough,
  Underline,
  Undo2,
  X,
} from 'lucide-react'

import { dispatchBlockEvent } from '@/lib/block-events'

// ── Shared constants ────────────────────────────────────────────────────

/** Shared active-state class applied to toolbar buttons when their feature is on. */
export const toolbarActiveClass = 'bg-accent text-accent-foreground'

/** Languages available in the code block language selector popover. */
export const CODE_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'rust',
  'bash',
  'sql',
  'html',
  'css',
  'json',
  'go',
  'java',
  'c',
  'cpp',
  'ruby',
  'markdown',
  'yaml',
  'toml',
] as const

/** Short display labels shown on the toolbar button when a code block language is active. */
export const LANG_SHORT: Record<string, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  rust: 'RS',
  bash: 'SH',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  go: 'GO',
  java: 'JA',
  c: 'C',
  cpp: 'C++',
  ruby: 'RB',
  markdown: 'MD',
  yaml: 'YML',
  toml: 'TOML',
}

// ── Types ───────────────────────────────────────────────────────────────

export interface ToolbarButtonConfig {
  icon: LucideIcon
  label: string
  tip: string
  activeKey?: string
  disabledWhenFalse?: string
  action: () => void
  /**
   * Overflow priority used by `useToolbarOverflow` (Layer B).
   * Higher = stays visible longer under width pressure. 100 = always visible,
   * 30 = drops first. Optional; defaults to 0 (drops first) when unset.
   * Applied only to buttons rendered inside the always-visible toolbar; the
   * mark toggles fed into `SelectionBubbleMenu` ignore this field.
   */
  priority?: number
}

// ── Factory functions ───────────────────────────────────────────────────

export function createMarkToggles(editor: Editor): ToolbarButtonConfig[] {
  return [
    {
      icon: Bold,
      label: 'toolbar.bold',
      tip: 'toolbar.boldTip',
      activeKey: 'bold',
      action: () => editor.chain().focus().toggleBold().run(),
    },
    {
      icon: Italic,
      label: 'toolbar.italic',
      tip: 'toolbar.italicTip',
      activeKey: 'italic',
      action: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      icon: Code,
      label: 'toolbar.code',
      tip: 'toolbar.codeTip',
      activeKey: 'code',
      action: () => editor.chain().focus().toggleCode().run(),
    },
    {
      icon: Strikethrough,
      label: 'toolbar.strikethrough',
      tip: 'toolbar.strikethroughTip',
      activeKey: 'strike',
      action: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      icon: Highlighter,
      label: 'toolbar.highlight',
      tip: 'toolbar.highlightTip',
      activeKey: 'highlight',
      action: () => editor.chain().focus().toggleHighlight().run(),
    },
    {
      // #211 P2-5 — underline. Takes the bubble menu to 7 marks + Link,
      // within the ≤8-button calm-UI ceiling the issue adopts.
      icon: Underline,
      label: 'toolbar.underline',
      tip: 'toolbar.underlineTip',
      activeKey: 'underline',
      action: () => editor.chain().focus().toggleUnderline().run(),
    },
  ]
}

export function createRefsAndBlocks(editor: Editor): ToolbarButtonConfig[] {
  return [
    {
      icon: FileSymlink,
      label: 'toolbar.internalLink',
      tip: 'toolbar.pageLinkTip',
      priority: 60,
      action: () => {
        const { from, to } = editor.state.selection
        if (from !== to) {
          editor.commands.resolveBlockLinkFromSelection()
        } else {
          editor.chain().focus().insertContent('[[').run()
        }
      },
    },
    {
      // #213 PR 4 — block-ref creation parity. Mirrors the page-link button
      // above: resolve a selection into a `((ref))`, or insert the `((`
      // trigger to open the BlockRefPicker when there's no selection.
      icon: Parentheses,
      label: 'toolbar.insertBlockRef',
      tip: 'toolbar.blockRefTip',
      priority: 60,
      action: () => {
        const { from, to } = editor.state.selection
        if (from !== to) {
          editor.commands.resolveBlockRefFromSelection()
        } else {
          editor.chain().focus().insertContent('((').run()
        }
      },
    },
    {
      icon: AtSign,
      label: 'toolbar.insertTag',
      tip: 'toolbar.tagTip',
      priority: 60,
      action: () => {
        // The AtTagPicker extension only opens the suggestion popup when
        // `@` is preceded by whitespace or is at the start of a block
        // (`allowedPrefixes: [' ', '\u00A0', '\n']` — see `at-tag-picker.ts`).
        // Inserting a bare `@` mid-text would therefore type the glyph
        // without triggering the picker, which is surprising for a button
        // labelled via t('toolbar.insertTag'). Prepend a space when the previous char
        // isn't already a valid prefix so clicking the button reliably
        // opens the picker regardless of caret position.
        const { from } = editor.state.selection
        const prev = from > 0 ? editor.state.doc.textBetween(from - 1, from) : ''
        const needsSpace = prev !== '' && prev !== ' ' && prev !== '\u00A0' && prev !== '\n'
        editor
          .chain()
          .focus()
          .insertContent(needsSpace ? ' @' : '@')
          .run()
      },
    },
    {
      // #215 — embed a live query block. Opens the visual query builder for
      // the focused block (one click), the mouse-first twin of the `/query`
      // slash command and the `{{` picker. Distinct ListFilter icon (not the
      // search magnifier) to signal "embedded query view", not find-in-notes.
      // Long-tail insert: low priority so it overflows before high-frequency
      // structure buttons under width pressure (#217).
      icon: ListFilter,
      label: 'toolbar.insertQuery',
      tip: 'toolbar.queryTip',
      priority: 30,
      action: () => dispatchBlockEvent('OPEN_QUERY_BUILDER'),
    },
    {
      // #281 — open the browse-grid emoji picker (the mouse-first twin of the
      // `:` typeahead and the `/emoji` slash command). Routes through the
      // focus-keyed block bus so the dialog targets the focused block and
      // inserts at its caret. Long-tail insert: low priority so it overflows
      // before high-frequency structure buttons under width pressure.
      icon: Smile,
      label: 'toolbar.emoji',
      tip: 'toolbar.emojiTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_EMOJI_PICKER'),
    },
  ]
}

/**
 * #1960 — the structure buttons (ordered list / divider / callout) were folded
 * into the "Turn into" popover (`TurnIntoMenu`), which now owns every block-type
 * transform. The group is intentionally empty: group 1 of the toolbar now holds
 * only the table-insert picker (and the contextual table-ops trigger), which are
 * inserts requiring dimensions, not block-type conversions. Kept as a function
 * (rather than deleted) so the group plumbing in `items.ts` stays uniform.
 */
export function createStructureButtons(): ToolbarButtonConfig[] {
  return []
}

export function createMetadataButtons(): ToolbarButtonConfig[] {
  return [
    {
      // #265 — the three date pickers (insert / due / scheduled) all have
      // slash twins (`/date`, `/due`, `/scheduled`) and are long-tail on the
      // standing bar. Demoted (70 → 40) toward the overflow popover so the
      // high-frequency TODO toggle (80) and priority cycle (75) keep their
      // place; the dates remain reachable via slash + overflow.
      icon: CalendarDays,
      label: 'toolbar.insertDate',
      tip: 'toolbar.insertDateTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_DATE_PICKER'),
    },
    {
      icon: CalendarClock,
      label: 'toolbar.setDueDate',
      tip: 'toolbar.dueDateTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_DUE_DATE_PICKER'),
    },
    {
      icon: CalendarCheck2,
      label: 'toolbar.setScheduledDate',
      tip: 'toolbar.scheduledDateTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_SCHEDULED_DATE_PICKER'),
    },
    {
      icon: CheckSquare,
      label: 'toolbar.todoToggle',
      tip: 'toolbar.todoToggleTip',
      priority: 80,
      action: () => dispatchBlockEvent('TOGGLE_TODO_STATE'),
    },
    {
      icon: Settings2,
      label: 'toolbar.properties',
      tip: 'toolbar.propertiesTip',
      priority: 40,
      action: () => dispatchBlockEvent('OPEN_BLOCK_PROPERTIES'),
    },
  ]
}

export function createHistoryButtons(editor: Editor): ToolbarButtonConfig[] {
  return [
    {
      icon: Undo2,
      label: 'toolbar.undo',
      tip: 'toolbar.undoTip',
      disabledWhenFalse: 'canUndo',
      priority: 100,
      action: () => editor.chain().focus().undo().run(),
    },
    {
      icon: Redo2,
      label: 'toolbar.redo',
      tip: 'toolbar.redoTip',
      disabledWhenFalse: 'canRedo',
      priority: 100,
      action: () => editor.chain().focus().redo().run(),
    },
    {
      icon: X,
      label: 'toolbar.discard',
      tip: 'toolbar.discardTip',
      priority: 30,
      action: () => dispatchBlockEvent('DISCARD_BLOCK_EDIT'),
    },
  ]
}
