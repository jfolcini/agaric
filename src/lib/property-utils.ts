import type { LucideIcon } from 'lucide-react'
import {
  CalendarCheck2,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  Clock,
  MapPin,
  Repeat,
  User,
} from 'lucide-react'

/**
 * Human-friendly display name for a property key.
 *
 * Built-in keys (underscore/hyphen-separated) are title-cased with spaces.
 * User-created keys pass through the same transform so `my_custom_prop`
 * becomes "My Custom Prop".
 */
export function formatPropertyName(key: string): string {
  return key.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Icon lookup for built-in property keys. Returns `undefined` for custom keys. */
export const BUILTIN_PROPERTY_ICONS: Record<string, LucideIcon> = {
  due_date: CalendarCheck2,
  scheduled_date: CalendarClock,
  created_at: CalendarPlus,
  completed_at: CheckCircle2,
  effort: Clock,
  assignee: User,
  location: MapPin,
  repeat: Repeat,
}
