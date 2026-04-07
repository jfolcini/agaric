import type React from 'react'
import i18n from '../lib/i18n'

export function ChoiceValuePicker({
  choices,
  label,
  selected,
  onChange,
}: {
  choices: string[]
  label: string
  selected: string[]
  onChange: (values: string[]) => void
}): React.ReactElement {
  return (
    <fieldset
      className="flex flex-col gap-1 border-0 p-0 m-0"
      aria-label={i18n.t('agendaFilter.optionsLabel', { label })}
    >
      <legend className="sr-only">{i18n.t('agendaFilter.optionsLabel', { label })}</legend>
      {choices.map((choice) => {
        const checked = selected.includes(choice)
        return (
          <label
            key={choice}
            className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent active:bg-accent/70 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => {
                if (checked) {
                  onChange(selected.filter((v) => v !== choice))
                } else {
                  onChange([...selected, choice])
                }
              }}
              className="accent-primary"
            />
            {choice}
          </label>
        )
      })}
    </fieldset>
  )
}
