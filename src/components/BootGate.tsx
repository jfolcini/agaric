import { useEffect } from 'react'
import { useBootStore } from '../stores/boot'

export function BootGate({ children }: { children: React.ReactNode }) {
  const { state, error, boot } = useBootStore()

  useEffect(() => {
    boot()
  }, [boot])

  if (state === 'booting') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
        }}
      >
        <p>Loading...</p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '1rem',
        }}
      >
        <h2>Failed to start</h2>
        <p style={{ color: '#ef4444' }}>{error}</p>
        <button type="button" onClick={() => boot()}>
          Retry
        </button>
      </div>
    )
  }

  return <>{children}</>
}
