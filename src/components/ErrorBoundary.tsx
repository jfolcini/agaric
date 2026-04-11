import { AlertCircle, RefreshCw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.error('ErrorBoundary', error.message, {
      stack: error.stack ?? '',
      componentStack: errorInfo.componentStack ?? '',
    })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 transition-opacity duration-200">
          <div
            className="flex flex-col items-center gap-3 rounded-lg border bg-destructive/5 p-8"
            role="alert"
          >
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h2 className="text-lg font-semibold">Something went wrong</h2>
            <p className="text-sm text-muted-foreground max-w-sm text-center">
              {this.state.error?.message ?? 'An unexpected error occurred'}
            </p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
