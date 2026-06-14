/**
 * FormField — the vertical `<div className="space-y-2"><Label/>{control}
 * {help|error}</div>` stack: a label above a single control, with an
 * optional muted help paragraph or a `role="alert"` error below it.
 *
 * Use it wherever a setting/property is a labelled field laid out as a
 * vertical stack — e.g. `AppearanceTab` (theme / font-size / week-start
 * selects) and the Google Calendar window-size input (`SettingsForm`).
 * The component delegates labelling to the shared `Label` primitive so
 * typography stays consistent. Pass `htmlFor` to associate the label
 * with a control; otherwise the label is purely visual.
 *
 * This is NOT a fit for, and deliberately does not model:
 *   - Toggle rows (`flex items-start justify-between gap-4` with the
 *     Label + help on the left and a `Switch` on the right) — see
 *     EditorTab, NotificationsTab, AutostartRow, QuickCaptureRow and the
 *     GCal privacy row. They are horizontal, not a vertical stack.
 *   - `PropertyRowEditor`, which is a row editor that puts `aria-label`
 *     on inline editors and has no Label + control + help/error stack.
 *   - Inline validation/status errors that need their own element `id`
 *     for `aria-describedby` linkage (KeyboardSettingsTab) or that float
 *     free of any labelled control (GoogleCalendarSettingsTab's
 *     `statusError`). FormField's error region has no addressable id.
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
