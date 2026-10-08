/**
 * ToggleRow — a {@link SettingRow} whose control is a `Switch` (#1653, #5345).
 *
 * The `id` is the Switch's id, so the row's `Label htmlFor` names it and its
 * description describes it. The label is also the Switch's `aria-label`.
 */

import type React from 'react'

import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
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
    // A switch is small enough to stay beside its label on phones too.
    <SettingRow
      label={label}
      description={description}
      controlId={id}
      className="flex-row items-center gap-4"
    >
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        aria-describedby={description ? settingDescriptionId(id) : undefined}
        data-testid={dataTestid}
      />
    </SettingRow>
  )
}
