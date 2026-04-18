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
  Info,
  LayoutTemplate,
  Lightbulb,
  Link2,
  ListOrdered,
  MapPin,
  Minus,
  Paperclip,
  Quote,
  Repeat,
  Search,
  Signal,
  StickyNote,
  Tag,
  Timer,
  UserCircle,
  XCircle,
} from 'lucide-react'
import { matchSorter } from 'match-sorter'
import type { PickerItem } from '../editor/SuggestionList'
import { listPropertyKeys } from './tauri'

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
    id: 'tag',
    label: 'TAG — Insert tag reference',
    category: 'slashCommand.categories.references',
    icon: Tag,
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

export function searchSlashCommands(query: string): PickerItem[] {
  const q = query.toLowerCase()
  const baseResults = q ? matchSorter(SLASH_COMMANDS, q, { keys: ['label'] }) : SLASH_COMMANDS
  if (!q) return baseResults
  const priorityResults = matchSorter(PRIORITY_COMMANDS, q, { keys: ['label'] })
  const headingResults = matchSorter(HEADING_COMMANDS, q, { keys: ['label'] })
  const repeatResults = matchSorter(REPEAT_COMMANDS, q, { keys: ['label'] })
  const repeatEndResults = matchSorter(REPEAT_END_COMMANDS, q, { keys: ['label'] })
  const effortResults = matchSorter(EFFORT_COMMANDS, q, { keys: ['label'] })
  const assigneeResults = matchSorter(ASSIGNEE_COMMANDS, q, { keys: ['label'] })
  const locationResults = matchSorter(LOCATION_COMMANDS, q, { keys: ['label'] })
  const calloutResults = matchSorter(CALLOUT_COMMANDS, q, { keys: ['label'] })

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
    const keys = await listPropertyKeys()
    const q = query.toLowerCase()
    const filtered = q ? keys.filter((k) => k.toLowerCase().includes(q)) : keys
    return filtered.map((k) => ({ id: k, label: k }))
  } catch {
    return []
  }
}
