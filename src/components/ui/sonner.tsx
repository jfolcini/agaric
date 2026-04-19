import type * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ref, ...props }: ToasterProps & { ref?: React.Ref<HTMLElement> }) => {
  return (
    <Sonner
      ref={ref}
      data-slot="toaster"
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
}
Toaster.displayName = 'Toaster'

export { Toaster }
