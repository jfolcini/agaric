/**
 * StorageFailureBanner — says why commands are failing when the cause is the
 * disk or the database (#6554): full, read-only or damaged. One row per cause,
 * from the first failed command until it is dismissed, however many commands
 * fail after it; each action still reports its own failure.
 */

import { AlertTriangle } from 'lucide-react'
import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { STORAGE_FAILURE_EVENT, type StorageFailureKind } from '@/lib/app-error'

const MESSAGE_KEY: Record<StorageFailureKind, string> = {
  storage_full: 'storage.full',
  storage_read_only: 'storage.readOnly',
  storage_corrupt: 'storage.corrupt',
}

export function StorageFailureBanner(): React.ReactElement | null {
  const { t } = useTranslation()
  const [kinds, setKinds] = useState<readonly StorageFailureKind[]>([])

  useEffect(() => {
    const show = (event: Event) => {
      const kind = (event as CustomEvent<StorageFailureKind>).detail
      setKinds((shown) => (shown.includes(kind) ? shown : [...shown, kind]))
    }
    window.addEventListener(STORAGE_FAILURE_EVENT, show)
    return () => window.removeEventListener(STORAGE_FAILURE_EVENT, show)
  }, [])

  if (kinds.length === 0) return null
  return (
    <div
      role="alert"
      className="border-b border-alert-error-border bg-alert-error px-4 text-sm text-alert-error-foreground"
      data-testid="storage-failure-banner"
    >
      {kinds.map((kind) => (
        <div key={kind} className="flex items-center gap-2 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">{t(MESSAGE_KEY[kind])}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setKinds((shown) => shown.filter((other) => other !== kind))}
          >
            {t('action.dismiss')}
          </Button>
        </div>
      ))}
    </div>
  )
}
