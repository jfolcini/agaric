/**
 * FormField — shared label + control + help-text + error wrapper.
 *
 * Replaces the inline `<div className="space-y-2"><label ...>label</label>
 * <Control /></div>` shape recurring across settings tabs and property
 * editors (see plan `pending/design-system-maintainability-2026-05-09.md`
 * § 2d).
 *
 * The component delegates labelling to the shared `Label` primitive so
 * typography stays consistent. Pass `htmlFor` to associate the label
 * with a control; otherwise the label is purely visual.
 *
 * Scope of this change: AppearanceTab is migrated as the smallest case
 * study. `PropertyRowEditor`, `KeyboardSettingsTab`, and
 * `GoogleCalendarSettingsTab` are deliberately deferred to a follow-up
 * — the plan calls those out as larger surfaces best migrated
 * separately.
 */

import type * as React from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface FormFieldProps {
  /** Required label text. */
  label: string
  /** Optional helper paragraph rendered below the control. */
  description?: string
  /** Optional error message; overrides `description` styling. */
  error?: string
  /** The control(s). */
  children: React.ReactNode
  /** Forwarded to the `<Label>` for control association. */
  htmlFor?: string
  /** Extra classes for the wrapper. */
  className?: string
  /** Ref to the wrapper `<div>`. */
  ref?: React.Ref<HTMLDivElement>
}

const FormField = ({
  ref,
  label,
  description,
  error,
  children,
  htmlFor,
  className,
}: FormFieldProps) => {
  return (
    <div ref={ref} data-slot="form-field" className={cn('space-y-2', className)}>
      <Label htmlFor={htmlFor} muted={false}>
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}
FormField.displayName = 'FormField'

export { FormField }
