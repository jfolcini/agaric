import type * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ref, ...props }: ToasterProps & { ref?: React.Ref<HTMLElement> }) => (
  <Sonner
    ref={ref}
    data-slot="toaster"
    className="toaster group"
    // Sonner's `richColors` palette is a fixed set of hsl values; mapping it
    // onto the alert tokens makes success/info/warning/error toasts follow
    // every theme, like the callouts that use the same tokens.
    style={
      {
        '--normal-bg': 'var(--popover)',
        '--normal-text': 'var(--popover-foreground)',
        '--normal-border': 'var(--border)',
        '--success-bg': 'var(--alert-tip)',
        '--success-text': 'var(--alert-tip-foreground)',
        '--success-border': 'var(--alert-tip-border)',
        '--info-bg': 'var(--alert-info)',
        '--info-text': 'var(--alert-info-foreground)',
        '--info-border': 'var(--alert-info-border)',
        '--warning-bg': 'var(--alert-warning)',
        '--warning-text': 'var(--alert-warning-foreground)',
        '--warning-border': 'var(--alert-warning-border)',
        '--error-bg': 'var(--alert-error)',
        '--error-text': 'var(--alert-error-foreground)',
        '--error-border': 'var(--alert-error-border)',
        '--border-radius': 'var(--radius-md)',
      } as React.CSSProperties
    }
    // Sonner's stylesheet is unlayered, so a layered utility needs `!` to beat
    // its hardcoded `0 4px 12px` shadow.
    toastOptions={{ classNames: { toast: 'shadow-(--shadow-floating)!' } }}
    {...props}
  />
)

Toaster.displayName = 'Toaster'

export { Toaster }
