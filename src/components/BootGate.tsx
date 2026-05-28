import { AlertCircle, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'

import { useBootStore } from '../stores/boot'

export function BootGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { state, error, boot } = useBootStore(
    useShallow((s) => ({ state: s.state, error: s.error, boot: s.boot })),
  )
  const [retrying, setRetrying] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [copied, setCopied] = useState(false)

  const diagnostics = useMemo(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'
    const platform = typeof navigator !== 'undefined' ? navigator.platform : 'n/a'
    return [
      `Error: ${error}`,
      `User-Agent: ${ua}`,
      `Platform: ${platform}`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n')
  }, [error])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard write may fail in some browsers; ignore.
    }
  }

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
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            data-testid="boot-show-details"
          >
            {showDetails ? t('boot.hideDetailsButton') : t('boot.showDetailsButton')}
          </button>
          {showDetails && (
            <div
              className="mt-2 w-full max-w-md flex flex-col gap-2"
              data-testid="boot-diagnostics"
            >
              <ScrollArea orientation="horizontal" className="bg-background border rounded-md">
                <pre className="text-xs p-3 whitespace-pre-wrap font-mono text-foreground/80">
                  {diagnostics}
                </pre>
              </ScrollArea>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                data-testid="boot-copy-diagnostics"
              >
                {copied ? t('boot.copiedLabel') : t('boot.copyDiagnosticsLabel')}
              </Button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return <>{children}</>
}
