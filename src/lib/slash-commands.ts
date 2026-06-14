/**
 * Slash-command catalog and search helpers.
 *
 * Data tables for the /-menu. Split out from `useBlockSlashCommands` so tests,
 * editor extensions, and other components can consume the metadata without
 * pulling in the hook's state machine and Tauri IPC surface.
 *
 * Any new slash command should be added to one of these arrays (or a new one
 * of the same shape) and wired into `searchSlashCommands`.
 */

import {
  AlertTriangle,
  Bold,
  Calendar,
  CalendarClock,
  CalendarDays,
  CalendarX,
  CheckCheck,
  CheckCircle2,
  CircleDot,
  Code,
  Grid3x3,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Highlighter,
  Info,
  Italic,
  LayoutTemplate,
  Lightbulb,
  Link2,
  ListOrdered,
  MapPin,
  Minus,
  Paperclip,
  Parentheses,
  Pilcrow,
  Quote,
  Repeat,
  Replace,
  Search,
  Signal,
  Smile,
  StickyNote,
  Strikethrough,
  Tag,
  Timer,
  UserCircle,
  XCircle,
} from 'lucide-react'
import { matchSorter } from 'match-sorter'

import type { PickerItem } from '../editor/SuggestionList'
import { matchesSearchFolded } from './fold-for-search'
import { getPropertyKeys } from './property-keys-cache'
import { getRecentCommands, RECENT_SLASH_PREFIX } from './recent-commands'

/**
 * #1105 — synthetic category for the "Recent" band the slash menu prepends
 * on an empty query. Joins the top recent slash ids against `SLASH_COMMANDS`
 * (skipping stale ids) and re-tags them with this category so
 * `SuggestionList`'s category grouping renders them as their own band above
 * the full list — mirroring the command palette's recents strip.
 */
export const RECENT_SLASH_CATEGORY = 'slashCommand.categories.recent'

/**
 * Build the "Recent" band for the empty-query slash menu: the most-recently
 * run base commands, re-tagged with {@link RECENT_SLASH_CATEGORY}. Stale ids
 * (in the MRU but no longer in `SLASH_COMMANDS`) are skipped, exactly as the
 * palette does (`CommandsModeBody.tsx`). Only base `SLASH_COMMANDS` are
 * surfaced — expanded sub-options (`turn-*`, `priority-*`, …) are reachable
 * by typing, not via the recents band. #1105.
 */
function recentSlashCommands(): PickerItem[] {
  const byId = new Map(SLASH_COMMANDS.map((c) => [c.id, c]))
  return getRecentCommands(RECENT_SLASH_PREFIX)
    .map((r) => byId.get(r.id))
    .filter((c): c is PickerItem => c != null)
    .map((c) => ({ ...c, category: RECENT_SLASH_CATEGORY }))
}

export const SLASH_COMMANDS: PickerItem[] = [
  {
    id: 'todo',
    label: 'TODO — Mark as to-do',
    category: 'slashCommand.categories.tasks',
    icon: CheckCircle2,
  },
  {
    id: 'doing',
    label: 'DOING — Mark as in progress',
    category: 'slashCommand.categories.tasks',
    icon: CircleDot,
  },
  {
    id: 'cancelled',
    label: 'CANCELLED — Mark as cancelled',
    category: 'slashCommand.categories.tasks',
    icon: XCircle,
  },
  {
    id: 'done',
    label: 'DONE — Mark as complete',
    category: 'slashCommand.categories.tasks',
    icon: CheckCheck,
  },
  {
    id: 'date',
    label: 'DATE — Link to a date page',
    category: 'slashCommand.categories.dates',
    icon: Calendar,
  },
  {
    id: 'due',
    label: 'DUE — Set due date on block',
    category: 'slashCommand.categories.dates',
    icon: CalendarClock,
  },
  {
    id: 'schedule',
    label: 'SCHEDULED — Set scheduled date on block',
    category: 'slashCommand.categories.dates',
    icon: CalendarDays,
  },
  {
    id: 'link',
    label: 'LINK — Insert page link',
    category: 'slashCommand.categories.references',
    icon: Link2,
  },
  {
    id: 'block-ref',
    label: 'BLOCK-REF — Insert block reference',
    category: 'slashCommand.categories.references',
    icon: Parentheses,
  },
  {
    id: 'tag',
    label: 'TAG — Insert tag reference',
    category: 'slashCommand.categories.references',
    icon: Tag,
  },
  // #211 P0-5 — mark slash commands. Each applies the mark to the current
  // selection, or (with no selection) inserts the delimiter pair and parks
  // the caret between the delimiters. Wired in `useSlashCommandMarks`.
  // `id: 'code-mark'` is distinct from the `code` code-*block* command above;
  // both surface under a `/code` query and disambiguate by category.
  {
    id: 'bold',
    label: 'BOLD — Bold text',
    category: 'slashCommand.categories.formatting',
    icon: Bold,
    keys: 'Ctrl + B',
  },
  {
    id: 'italic',
    label: 'ITALIC — Italic text',
    category: 'slashCommand.categories.formatting',
    icon: Italic,
    keys: 'Ctrl + I',
  },
  {
    id: 'code-mark',
    label: 'CODE — Inline code',
    category: 'slashCommand.categories.formatting',
    icon: Code,
    shortcutId: 'inlineCode',
  },
  {
    id: 'strike',
    label: 'STRIKE — Strikethrough text',
    category: 'slashCommand.categories.formatting',
    icon: Strikethrough,
    shortcutId: 'strikethrough',
  },
  {
    id: 'highlight',
    label: 'HIGHLIGHT — Highlight text',
    category: 'slashCommand.categories.formatting',
    icon: Highlighter,
    shortcutId: 'highlight',
  },
  {
    id: 'code',
    label: 'CODE — Insert code block',
    category: 'slashCommand.categories.structure',
    icon: Code,
  },
  {
    id: 'effort',
    label: 'EFFORT — Set effort estimate (15m/30m/1h/2h/4h/1d)',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'assignee',
    label: 'ASSIGNEE — Set assignee',
    category: 'slashCommand.categories.properties',
    icon: UserCircle,
  },
  {
    id: 'location',
    label: 'LOCATION — Set location',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'repeat',
    label: 'REPEAT — Set recurrence (daily/weekly/monthly/+Nd)',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'template',
    label: 'TEMPLATE — Insert block template',
    category: 'slashCommand.categories.templates',
    icon: LayoutTemplate,
  },
  {
    id: 'quote',
    label: 'QUOTE — Insert blockquote',
    category: 'slashCommand.categories.structure',
    icon: Quote,
  },
  {
    id: 'callout',
    label: 'CALLOUT — Insert callout block',
    category: 'slashCommand.categories.structure',
    icon: Info,
  },
  {
    id: 'table',
    label: 'TABLE — Insert table (e.g. /table 4x6)',
    category: 'slashCommand.categories.structure',
    icon: Grid3x3,
  },
  {
    // #215 — header-row opt-out: `withHeaderRow:true` is hardcoded for `/table`.
    id: 'table-no-header',
    label: 'TABLE (no header) — Insert table without a header row',
    category: 'slashCommand.categories.structure',
    icon: Grid3x3,
  },
  {
    id: 'numbered-list',
    label: 'NUMBERED LIST — Insert ordered list',
    category: 'slashCommand.categories.structure',
    icon: ListOrdered,
  },
  {
    id: 'divider',
    label: 'DIVIDER — Insert horizontal rule',
    category: 'slashCommand.categories.structure',
    icon: Minus,
  },
  {
    // #264 — "Turn into" parent entry. Typing `/turn` surfaces the
    // block-type conversion list (TURN_INTO_COMMANDS), which converts the
    // current block's cursor node (paragraph, H1–H3, quote, code, ordered
    // list, callout). Modeled as an inline-expanded family like the
    // heading/callout variants, not a nested submenu.
    id: 'turn',
    label: 'TURN INTO — Convert this block to another type',
    category: 'slashCommand.categories.structure',
    icon: Replace,
  },
  {
    id: 'query',
    label: 'QUERY — Insert embedded query block',
    category: 'slashCommand.categories.queries',
    icon: Search,
  },
  {
    id: 'attach',
    label: 'ATTACH — Attach file to block',
    category: 'slashCommand.categories.references',
    icon: Paperclip,
  },
  {
    // #286 — the browse-grid emoji picker. The inline `:` typeahead (#281)
    // handles fast keyboard insertion of a known shortcode; `/emoji` opens
    // the searchable categorized dialog for when you don't know it. Both
    // share the same dataset + Recents store. Opening the dialog is handled
    // by `openEmojiPicker` (mirrors `/query` → `openQueryBuilder`).
    id: 'emoji',
    label: 'EMOJI — Insert emoji from picker',
    category: 'slashCommand.categories.references',
    icon: Smile,
  },
]

export const PRIORITY_COMMANDS: PickerItem[] = [
  {
    id: 'priority-high',
    label: 'PRIORITY 1 — Set high priority',
    category: 'slashCommand.categories.tasks',
    icon: Signal,
  },
  {
    id: 'priority-medium',
    label: 'PRIORITY 2 — Set medium priority',
    category: 'slashCommand.categories.tasks',
    icon: Signal,
  },
  {
    id: 'priority-low',
    label: 'PRIORITY 3 — Set low priority',
    category: 'slashCommand.categories.tasks',
    icon: Signal,
  },
]

export const HEADING_COMMANDS: PickerItem[] = [
  {
    id: 'h1',
    label: 'Heading 1 — Large heading',
    category: 'slashCommand.categories.structure',
    icon: Heading1,
  },
  {
    id: 'h2',
    label: 'Heading 2 — Medium heading',
    category: 'slashCommand.categories.structure',
    icon: Heading2,
  },
  {
    id: 'h3',
    label: 'Heading 3 — Small heading',
    category: 'slashCommand.categories.structure',
    icon: Heading3,
  },
  { id: 'h4', label: 'Heading 4', category: 'slashCommand.categories.structure', icon: Heading4 },
  { id: 'h5', label: 'Heading 5', category: 'slashCommand.categories.structure', icon: Heading5 },
  { id: 'h6', label: 'Heading 6', category: 'slashCommand.categories.structure', icon: Heading6 },
]

export const REPEAT_COMMANDS: PickerItem[] = [
  {
    id: 'repeat-daily',
    label: 'REPEAT DAILY — Every day',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-weekly',
    label: 'REPEAT WEEKLY — Every week',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-monthly',
    label: 'REPEAT MONTHLY — Every month',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-yearly',
    label: 'REPEAT YEARLY — Every year',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-.+daily',
    label: 'REPEAT DAILY (from completion) — Days from when done',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-.+weekly',
    label: 'REPEAT WEEKLY (from completion) — Weeks from when done',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-.+monthly',
    label: 'REPEAT MONTHLY (from completion) — Months from when done',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-++daily',
    label: 'REPEAT DAILY (catch-up) — Advance to next future date',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-++weekly',
    label: 'REPEAT WEEKLY (catch-up) — Advance to next future date',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-++monthly',
    label: 'REPEAT MONTHLY (catch-up) — Advance to next future date',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
  {
    id: 'repeat-remove',
    label: 'REPEAT REMOVE — Clear recurrence',
    category: 'slashCommand.categories.repeat',
    icon: Repeat,
  },
]

export const EFFORT_COMMANDS: PickerItem[] = [
  {
    id: 'effort-15m',
    label: 'EFFORT 15m — 15 minutes',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-30m',
    label: 'EFFORT 30m — 30 minutes',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-1h',
    label: 'EFFORT 1h — 1 hour',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-2h',
    label: 'EFFORT 2h — 2 hours',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-4h',
    label: 'EFFORT 4h — 4 hours',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
  {
    id: 'effort-1d',
    label: 'EFFORT 1d — 1 day',
    category: 'slashCommand.categories.properties',
    icon: Timer,
  },
]

export const ASSIGNEE_COMMANDS: PickerItem[] = [
  {
    id: 'assignee-me',
    label: 'ASSIGNEE Me — Assign to me',
    category: 'slashCommand.categories.properties',
    icon: UserCircle,
  },
  {
    id: 'assignee-custom',
    label: 'ASSIGNEE Custom... — Enter custom assignee',
    category: 'slashCommand.categories.properties',
    icon: UserCircle,
  },
]

export const LOCATION_COMMANDS: PickerItem[] = [
  {
    id: 'location-office',
    label: 'LOCATION Office — Office',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'location-home',
    label: 'LOCATION Home — Home',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'location-remote',
    label: 'LOCATION Remote — Remote',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
  {
    id: 'location-custom',
    label: 'LOCATION Custom... — Enter custom location',
    category: 'slashCommand.categories.properties',
    icon: MapPin,
  },
]

const REPEAT_END_COMMANDS: PickerItem[] = [
  {
    id: 'repeat-until',
    label: 'REPEAT UNTIL — Stop repeating after a date',
    category: 'slashCommand.categories.repeat',
    icon: CalendarX,
  },
  {
    id: 'repeat-limit-5',
    label: 'REPEAT LIMIT 5 — Stop after 5 occurrences',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
  {
    id: 'repeat-limit-10',
    label: 'REPEAT LIMIT 10 — Stop after 10 occurrences',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
  {
    id: 'repeat-limit-20',
    label: 'REPEAT LIMIT 20 — Stop after 20 occurrences',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
  {
    id: 'repeat-limit-remove',
    label: 'REPEAT LIMIT REMOVE — Clear end condition',
    category: 'slashCommand.categories.repeat',
    icon: Hash,
  },
]

export const CALLOUT_COMMANDS: PickerItem[] = [
  {
    id: 'callout-info',
    label: 'CALLOUT INFO — Blue info callout',
    category: 'slashCommand.categories.structure',
    icon: Info,
  },
  {
    id: 'callout-warning',
    label: 'CALLOUT WARNING — Amber warning callout',
    category: 'slashCommand.categories.structure',
    icon: AlertTriangle,
  },
  {
    id: 'callout-tip',
    label: 'CALLOUT TIP — Green tip callout',
    category: 'slashCommand.categories.structure',
    icon: Lightbulb,
  },
  {
    id: 'callout-error',
    label: 'CALLOUT ERROR — Red error callout',
    category: 'slashCommand.categories.structure',
    icon: XCircle,
  },
  {
    id: 'callout-note',
    label: 'CALLOUT NOTE — Gray note callout',
    category: 'slashCommand.categories.structure',
    icon: StickyNote,
  },
]

/**
 * #264 — "Turn into" block-type conversion options.
 *
 * Single source of truth shared by the `/turn` slash family (surfaced via
 * `searchSlashCommands`) and the "Turn into ▸" group in the block
 * context-menu. Each `id` is `turn-<type>`; the structural slash handler
 * (`useSlashCommandStructural`) and the context-menu conversion callback
 * both dispatch off the same `id` via `turnIdToBlockType`, so the conversion
 * logic lives in one place and is never duplicated.
 *
 * `blockType` is the canonical type token used to compute the active-type
 * indication (highlighting the current block's type in the menu).
 */
export interface TurnIntoOption {
  /** Slash/menu item id: `turn-paragraph`, `turn-h1`, … */
  id: string
  /** Canonical block-type token for active-state matching. */
  blockType: string
  /** Short menu label (the context-menu localises via i18n; this is the fallback). */
  label: string
  /** Always set — non-optional so `TURN_INTO_COMMANDS` satisfies `PickerItem`. */
  icon: NonNullable<PickerItem['icon']>
}

export const TURN_INTO_OPTIONS: TurnIntoOption[] = [
  { id: 'turn-paragraph', blockType: 'paragraph', label: 'Text', icon: Pilcrow },
  { id: 'turn-h1', blockType: 'h1', label: 'Heading 1', icon: Heading1 },
  { id: 'turn-h2', blockType: 'h2', label: 'Heading 2', icon: Heading2 },
  { id: 'turn-h3', blockType: 'h3', label: 'Heading 3', icon: Heading3 },
  { id: 'turn-quote', blockType: 'quote', label: 'Quote', icon: Quote },
  { id: 'turn-code', blockType: 'code', label: 'Code block', icon: Code },
  {
    id: 'turn-numbered-list',
    blockType: 'numbered-list',
    label: 'Ordered list',
    icon: ListOrdered,
  },
  { id: 'turn-callout', blockType: 'callout', label: 'Callout', icon: Info },
]

/**
 * i18n label key for a "Turn into" target. Block-type tokens are kebab-case
 * (e.g. `numbered-list`), but translation keys follow the camelCase
 * `namespace.name` convention — so we camelCase the dynamic segment. Shared by
 * the block context menu and its i18n test so the two never drift (#986).
 */
export function turnIntoTypeKey(blockType: string): string {
  const segment = blockType.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  return `contextMenu.turnIntoType.${segment}`
}

export const TURN_INTO_COMMANDS: PickerItem[] = TURN_INTO_OPTIONS.map((o) => ({
  id: o.id,
  label: `TURN INTO ${o.label}`,
  category: 'slashCommand.categories.structure',
  icon: o.icon,
}))

export function searchSlashCommands(query: string): PickerItem[] {
  const q = query.toLowerCase()
  const baseResults = q ? matchSorter(SLASH_COMMANDS, q, { keys: ['label'] }) : SLASH_COMMANDS
  if (!q) {
    // #1105 — empty query: surface a "Recent" band (top-N most-recently-run
    // commands) above the full catalog so the highest-frequency surface is
    // progressively disclosed instead of dumping all commands flat. The full
    // list still follows below, so everything stays reachable; typing a query
    // bypasses the band entirely (the branch below).
    const recents = recentSlashCommands()
    return recents.length > 0 ? [...recents, ...baseResults] : baseResults
  }
  const priorityResults = matchSorter(PRIORITY_COMMANDS, q, { keys: ['label'] })
  const headingResults = matchSorter(HEADING_COMMANDS, q, { keys: ['label'] })
  const repeatResults = matchSorter(REPEAT_COMMANDS, q, { keys: ['label'] })
  const repeatEndResults = matchSorter(REPEAT_END_COMMANDS, q, { keys: ['label'] })
  const effortResults = matchSorter(EFFORT_COMMANDS, q, { keys: ['label'] })
  const assigneeResults = matchSorter(ASSIGNEE_COMMANDS, q, { keys: ['label'] })
  const locationResults = matchSorter(LOCATION_COMMANDS, q, { keys: ['label'] })
  const calloutResults = matchSorter(CALLOUT_COMMANDS, q, { keys: ['label'] })
  // #264 — `/turn` surfaces the block-type conversion options inline. The
  // parent `turn` entry lives in SLASH_COMMANDS (baseResults); the expanded
  // `turn-*` options are merged here so typing `/turn` lists every target type.
  // Gate on the `turn` prefix: the option labels embed their target-type name
  // ("TURN INTO Heading 1", "TURN INTO Quote", …), so matching them against an
  // unscoped query would duplicate the canonical type commands and pollute
  // searches like `/heading`, `/quote`, or `/code`.
  const turnIntoResults = q.startsWith('turn')
    ? matchSorter(TURN_INTO_COMMANDS, q, { keys: ['label'] })
    : []

  const tableMatch = q.match(/^table\s+(\d+)\s*x\s*(\d+)$/i)
  let results = [
    ...baseResults,
    ...priorityResults,
    ...headingResults,
    ...repeatResults,
    ...repeatEndResults,
    ...effortResults,
    ...assigneeResults,
    ...locationResults,
    ...calloutResults,
    ...turnIntoResults,
  ]
  if (tableMatch) {
    const rows = Number.parseInt(tableMatch[1] as string, 10)
    const cols = Number.parseInt(tableMatch[2] as string, 10)
    results = results.filter((r) => r.id !== 'table')
    results.unshift({
      id: `table:${rows}:${cols}`,
      label: `TABLE ${rows}\u00d7${cols} — Insert ${rows}\u00d7${cols} table`,
      category: 'slashCommand.categories.structure',
      icon: Grid3x3,
    })
  }
  return results
}

export async function searchPropertyKeys(query: string): Promise<PickerItem[]> {
  try {
    // PEND-35 Tier 2.5 — share the module-level cache from
    // `src/lib/property-keys-cache.ts` instead of firing a fresh
    // `list_property_keys` IPC on every keystroke. The cache also
    // dedupes concurrent fetches and invalidates on
    // `block:properties-changed`.
    const keys = await getPropertyKeys()
    // UX-248 — Unicode-aware fold.
    const filtered = query ? keys.filter((k) => matchesSearchFolded(k, query)) : keys
    return filtered.map((k) => ({ id: k, label: k }))
  } catch {
    return []
  }
}
