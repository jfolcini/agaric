import { AlertCircle, Bug, RefreshCw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { relaunchApp } from '@/lib/relaunch-app'
import { BugReportDialog } from './BugReportDialog'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  reportOpen: boolean
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, reportOpen: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, reportOpen: false }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.error('ErrorBoundary', error.message, {
      stack: error.stack ?? '',
      componentStack: errorInfo.componentStack ?? '',
    })
  }

  render() {
    if (this.state.hasError) {
      const error = this.state.error
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 transition-opacity duration-200">
          <div
            className="flex flex-col items-center gap-3 rounded-lg border bg-destructive/5 p-8"
            role="alert"
          >
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h2 className="text-lg font-semibold">{i18n.t('error.generic')}</h2>
            <p className="text-sm text-muted-foreground max-w-sm text-center">
              {error?.message ?? i18n.t('error.unexpected')}
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              <Button variant="outline" onClick={() => void relaunchApp()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {i18n.t('action.reload')}
              </Button>
              <Button
                variant="outline"
                onClick={() => this.setState({ reportOpen: true })}
                aria-label={i18n.t('bugReport.reportCrashTitle')}
              >
                <Bug className="h-3.5 w-3.5" />
                {i18n.t('bugReport.reportCrashTitle')}
              </Button>
            </div>
          </div>
          <BugReportDialog
            open={this.state.reportOpen}
            onOpenChange={(open) => this.setState({ reportOpen: open })}
            initialTitle={error?.message ?? ''}
            initialDescription={error?.stack ?? ''}
          />
        </div>
      )
    }

    return this.props.children
  }
}
