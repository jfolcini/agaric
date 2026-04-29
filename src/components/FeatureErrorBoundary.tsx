import { AlertCircle, Bug, RefreshCw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { dispatchBugReport } from '@/lib/bug-report-events'
import { i18n } from '@/lib/i18n'
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

  // UX-279: surface the in-app bug-report dialog with the captured error
  // pre-filled. The listener lives at the App shell — see `App.tsx`. Using
  // a global CustomEvent (not a prop callback) keeps section-level
  // boundaries decoupled from the dialog's mount point.
  handleReportBug = () => {
    const error = this.state.error
    dispatchBugReport({
      message: error?.message ?? i18n.t('error.unexpected'),
      ...(error?.stack ? { stack: error.stack } : {}),
    })
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
          {/* UX-12: reassure the user that retrying is non-destructive so the
              raw error.message above doesn't read as data loss. */}
          <p className="max-w-xs text-center text-sm text-muted-foreground">
            {i18n.t('errorBoundary.dataSafe')}
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            <Button variant="outline" size="sm" onClick={this.handleRetry}>
              <RefreshCw className="h-3.5 w-3.5" />
              {i18n.t('action.retry')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={this.handleReportBug}
              aria-label={i18n.t('bugReport.reportCrashTitle')}
            >
              <Bug className="h-3.5 w-3.5" />
              {i18n.t('bugReport.reportCrashTitle')}
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
