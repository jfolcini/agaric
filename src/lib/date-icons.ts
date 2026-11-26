import { CalendarClock, Flag, type LucideIcon } from 'lucide-react'

/**
 * The glyph of each built-in date, wherever one is drawn or set (a chip, a
 * count, a drawer field, a toolbar button, a slash command): two calendars
 * read as one at chip size (#7040).
 */
export const DATE_ICONS = { due: Flag, scheduled: CalendarClock } as const satisfies Record<
  string,
  LucideIcon
>
