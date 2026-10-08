/**
 * SettingRow — the one settings row: label and description on the left, the
 * row's control on the right from `sm` up, stacked on phones (#5345).
 *
 * With `controlId` the label is a `<Label htmlFor>` naming the control and the
 * description gets `settingDescriptionId(controlId)`; the caller puts
 * `aria-describedby={settingDescriptionId(controlId)}` on the control, because
 * only it knows which element inside `children` is the control.
 */

import type * as React from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface SettingRowProps {
  label: React.ReactNode
  description?: React.ReactNode
  /** Id of the row's control; wires the label to it and ids the description. */
  controlId?: string
  /** The control(s), right side. */
  children: React.ReactNode
  className?: string
}

export function settingDescriptionId(controlId: string): string {
  return `${controlId}-description`
}

export function SettingRow({
  label,
  description,
  controlId,
  children,
  className,
}: SettingRowProps): React.ReactElement {
  return (
    <div
      data-slot="setting-row"
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        {controlId ? (
          <Label htmlFor={controlId} muted={false} className="block">
            {label}
          </Label>
        ) : (
          <p className="text-sm font-medium">{label}</p>
        )}
        {description ? (
          <p
            id={controlId ? settingDescriptionId(controlId) : undefined}
            className="text-xs text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
