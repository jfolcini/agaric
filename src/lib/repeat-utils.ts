/** Format a repeat property value into a human-readable label. */
export function formatRepeatLabel(value: string): string {
  const mode = value.startsWith('.+')
    ? ' (from completion)'
    : value.startsWith('++')
      ? ' (catch-up)'
      : ''
  const interval = value.replace(/^(\.\+|\+\+|\+)/, '')
  const labels: Record<string, string> = {
    daily: 'daily',
    weekly: 'weekly',
    monthly: 'monthly',
    yearly: 'yearly',
  }
  if (labels[interval]) return `${labels[interval]}${mode}`
  // Custom interval: +3d, 2w, etc.
  const match = interval.match(/^(\d+)([dwm])$/)
  if (match) {
    const n = match[1]
    const singular = n === '1'
    const unit =
      match[2] === 'd'
        ? singular
          ? 'day'
          : 'days'
        : match[2] === 'w'
          ? singular
            ? 'week'
            : 'weeks'
          : singular
            ? 'month'
            : 'months'
    return `every ${n} ${unit}${mode}`
  }
  return value
}
