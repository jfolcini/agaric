import * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = React.forwardRef<HTMLElement, ToasterProps>(({ ...props }, ref) => {
  return (
    <Sonner
      ref={ref}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
})
Toaster.displayName = 'Toaster'

export { Toaster }
