import { Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useBootStore } from '../stores/boot'

export function BootGate({ children }: { children: React.ReactNode }) {
  const { state, error, boot } = useBootStore()

  useEffect(() => {
    boot()
  }, [boot])

  if (state === 'booting') {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <h2 className="text-lg font-semibold">Failed to start</h2>
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => boot()}>
          Retry
        </Button>
      </div>
    )
  }

  return <>{children}</>
}
