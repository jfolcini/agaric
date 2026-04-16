/**
 * TaskStatesSection -- manage custom task state keywords.
 *
 * Reads/writes the task cycle to localStorage independently.
 */

import { X } from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function TaskStatesSection(): React.ReactElement {
  const { t } = useTranslation()
  const [states, setStates] = useState<(string | null)[]>(() => {
    try {
      const stored = localStorage.getItem('task_cycle')
      if (stored) return JSON.parse(stored)
    } catch {}
    return [null, 'TODO', 'DOING', 'DONE']
  })
  const [newState, setNewState] = useState('')

  const save = useCallback((updated: (string | null)[]) => {
    setStates(updated)
    try {
      localStorage.setItem('task_cycle', JSON.stringify(updated))
    } catch {}
  }, [])

  const handleAdd = useCallback(() => {
    const trimmed = newState.trim().toUpperCase()
    if (!trimmed || states.includes(trimmed)) return
    save([...states, trimmed])
    setNewState('')
  }, [newState, states, save])

  const handleRemove = useCallback(
    (state: string) => {
      save(states.filter((s) => s !== state))
    },
    [states, save],
  )

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('propertiesView.taskStates')}</h3>
      <p className="text-xs text-muted-foreground">{t('propertiesView.taskStatesDesc')}</p>
      <div className="flex flex-wrap gap-1">
        <Badge variant="outline" className="text-xs">
          {t('task.noneState')}
        </Badge>
        {states.filter(Boolean).map((s) => (
          <Badge key={s} variant="secondary" className="text-xs flex items-center gap-1">
            {s}
            <button
              type="button"
              className="ml-0.5 hover:text-destructive active:text-destructive active:scale-95"
              aria-label={t('settings.removeState', { state: s })}
              onClick={() => {
                if (s) handleRemove(s)
              }}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          className="h-7 text-sm flex-1"
          placeholder={t('propertiesView.addTaskState')}
          value={newState}
          onChange={(e) => setNewState(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
        />
        <Button size="sm" variant="outline" onClick={handleAdd} disabled={!newState.trim()}>
          {t('propertiesView.add')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('propertiesView.taskStatesReload')}</p>
    </div>
  )
}
