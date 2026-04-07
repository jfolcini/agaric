import { cn } from '@/lib/utils'

export function SectionTitle({
  color,
  label,
  count,
  className,
}: {
  color: string
  label: string
  count: number
  className?: string
}) {
  return (
    <h4 className={cn('text-xs font-semibold mb-1.5 flex items-center gap-1', color, className)}>
      <span>{label}</span>
      <span className="text-muted-foreground font-normal">({count})</span>
    </h4>
  )
}
