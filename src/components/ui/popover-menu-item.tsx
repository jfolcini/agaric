import { cn } from '@/lib/utils'

interface PopoverMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
}

export function PopoverMenuItem({
  active,
  className,
  disabled,
  children,
  ...props
}: PopoverMenuItemProps) {
  return (
    <button
      type="button"
      className={cn(
        'w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent cursor-pointer transition-colors',
        active && 'bg-accent font-medium',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}
