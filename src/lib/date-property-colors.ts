/**
 * Color mapping for date property sources in agenda pills.
 *
 * Each source type gets a distinct color pair (light bg + dark text) for
 * use in badge/pill rendering across weekly, monthly, and calendar views.
 */

export interface SourceColor {
  /** Tailwind classes for light mode background + text */
  light: string
  /** Tailwind classes for dark mode background + text */
  dark: string
  /** Short display label */
  label: string
}

const SOURCE_COLORS: Record<string, SourceColor> = {
  'column:due_date': {
    light: 'bg-date-due text-date-due-foreground',
    dark: '',
    label: 'Due',
  },
  'column:scheduled_date': {
    light: 'bg-date-scheduled text-date-scheduled-foreground',
    dark: '',
    label: 'Scheduled',
  },
}

/** Default color for custom date properties (property:*) */
const PROPERTY_DEFAULT: SourceColor = {
  light: 'bg-date-property text-date-property-foreground',
  dark: '',
  label: 'Property',
}

/** Get the color config for a given agenda source string. */
export function getSourceColor(source: string): SourceColor {
  if (SOURCE_COLORS[source]) return SOURCE_COLORS[source]
  if (source.startsWith('property:')) return PROPERTY_DEFAULT
  // Fallback for unknown sources
  return {
    light: 'bg-muted text-muted-foreground',
    dark: '',
    label: source,
  }
}

/**
 * Compute the short display label for a source.
 * For `property:xyz`, extracts "xyz" and title-cases it.
 * For known column sources, returns the predefined label.
 */
export function getSourceLabel(source: string): string {
  const known = SOURCE_COLORS[source]
  if (known) return known.label
  if (source.startsWith('property:')) {
    const name = source.slice('property:'.length)
    return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ')
  }
  return source
}
