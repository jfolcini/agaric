/**
 * ToggleRow — horizontal `flex items-start justify-between gap-4` row with a
 * labelled description on the left and a `Switch` on the right.
 *
 * This is the canonical "setting toggle row" extracted from the copies that had
 * drifted across the settings tabs (EditorTab ×2, NotificationsTab, AutostartRow
 * — #1653). The deliberate non-fit for {@link FormField}, which is a *vertical*
 * label-above-control stack; this primitive is the *horizontal* toggle layout.
 *
 * Accessibility: the `id` is wired to both the `Label`'s `htmlFor` and the
 * `Switch`'s `id`, so the switch is named by its label. The same text is also
 * passed as the Switch's `aria-label`, matching the prior inline markup.
 */

import type React from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export interface ToggleRowProps {
  /** Stable id linking the Label (`htmlFor`) to the Switch (`id`). */
  id: string
  /** Label text for the row; also used as the Switch's accessible name. */
  label: string
  /** Muted helper paragraph rendered below the label. */
  description: string
  /** Current toggle state. */
  checked: boolean
  /** Called with the next state when the user toggles the Switch. */
  onCheckedChange: (checked: boolean) => void
  /** Disables the Switch (e.g. while a toggle round-trip is pending). */
  disabled?: boolean
  /** Optional test id forwarded onto the Switch. */
  'data-testid'?: string
}

export function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  'data-testid': dataTestid,
}: ToggleRowProps): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 space-y-1">
        <Label htmlFor={id} muted={false}>
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        data-testid={dataTestid}
      />
    </div>
  )
}
