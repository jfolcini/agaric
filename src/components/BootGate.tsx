import { AlertCircle, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useBootStore } from '../stores/boot'

export function BootGate({ children }: { children: React.ReactNode }) {
  const { state, error, boot } = useBootStore()
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    boot()
  }, [boot])

  useEffect(() => {
    if (state !== 'error') setRetrying(false)
  }, [state])

  if (state === 'booting') {
    return (
      <div role="status" aria-live="polite" className="flex h-screen flex-col items-center justify-center gap-3 transition-opacity duration-200">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">Starting Agaric&hellip;</p>
      </div>
    )
  }

  if (state === 'recovering') {
    return (
      <div role="status" aria-live="polite" className="flex h-screen flex-col items-center justify-center gap-2 transition-opacity duration-200">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">Recovering&hellip;</p>
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
          <h2 className="text-lg font-semibold">Failed to start</h2>
          <p className="text-sm text-muted-foreground max-w-sm text-center">{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setRetrying(true)
              boot()
            }}
            disabled={retrying}
          >
            {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Retry'}
          </Button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
