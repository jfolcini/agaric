import { AlertCircle, RefreshCw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import i18n from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'

interface FeatureErrorBoundaryProps {
  children: React.ReactNode
  name: string
  className?: string
}

interface FeatureErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class FeatureErrorBoundary extends React.Component<
  FeatureErrorBoundaryProps,
  FeatureErrorBoundaryState
> {
  constructor(props: FeatureErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): FeatureErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.error(this.props.name, error.message, {
      stack: error.stack ?? '',
      componentStack: errorInfo.componentStack ?? '',
    })
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className={cn(
            'flex flex-col items-center justify-center gap-3 rounded-lg border bg-destructive/5 p-6',
            this.props.className,
          )}
          role="alert"
        >
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="text-sm font-medium">
            {i18n.t('error.sectionCrashed', { section: this.props.name })}
          </p>
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            {this.state.error?.message ?? i18n.t('error.unexpected')}
          </p>
          <Button variant="outline" size="sm" onClick={this.handleRetry}>
            <RefreshCw className="h-3.5 w-3.5" />
            {i18n.t('action.retry')}
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
