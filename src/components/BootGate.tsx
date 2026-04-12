import { AlertCircle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useBootStore } from '../stores/boot'

export function BootGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { state, error, boot } = useBootStore(
    useShallow((s) => ({ state: s.state, error: s.error, boot: s.boot })),
  )
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    boot()
  }, [boot])

  useEffect(() => {
    if (state !== 'error') setRetrying(false)
  }, [state])

  if (state === 'booting') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-screen flex-col items-center justify-center gap-3 transition-opacity duration-200"
      >
        <Spinner size="xl" className="text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t('boot.starting')}</p>
      </div>
    )
  }

  if (state === 'recovering') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-screen flex-col items-center justify-center gap-2 transition-opacity duration-200"
      >
        <Spinner size="xl" className="text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t('boot.recovering')}</p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 transition-opacity duration-200">
        <div
          className="flex flex-col items-center gap-3 rounded-lg border bg-destructive/5 p-8"
          role="alert"
        >
          <AlertCircle className="h-8 w-8 text-destructive" />
          <h2 className="text-lg font-semibold">{t('boot.failedToStart')}</h2>
          <p className="text-sm text-muted-foreground max-w-sm text-center">{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setRetrying(true)
              boot()
            }}
            disabled={retrying}
          >
            {retrying ? (
              <Spinner />
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                {t('action.retry')}
              </>
            )}
          </Button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
