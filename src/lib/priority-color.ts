/** Badge color class by priority level (theme-aware). */
export function priorityColor(p: string): string {
  if (p === '1') return 'bg-priority-urgent text-priority-foreground'
  if (p === '2') return 'bg-priority-high text-priority-foreground'
  return 'bg-priority-normal text-priority-foreground'
}
