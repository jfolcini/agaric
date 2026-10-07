/**
 * DataTab — Import/Export data management. (The `'DataSettingsTab'`
 * logger label used by the sections/hook below is kept stable across
 * renames as a telemetry namespace.)
 *
 * Composition wiring: the Import card (all import affordances + the shared
 * import-runner state machine) lives in {@link ImportSection}, the Export
 * card in {@link ExportSection}, and the opt-in reconciliation oracle in
 * {@link IntegrityCheckSection} (#4886). The Edit history card is inline: a
 * single button into the History view (#5269). The pure import logic lives
 * in `@/lib/vault-import` and the shared runner in `./useImportRunner`.
 */

import { History } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ExportSection } from '@/components/settings/ExportSection'
import { ImportSection } from '@/components/settings/ImportSection'
import { IntegrityCheckSection } from '@/components/settings/IntegrityCheckSection'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useNavigationStore } from '@/stores/navigation'

export function DataTab(): React.ReactElement {
  const { t } = useTranslation()
  const setView = useNavigationStore((s) => s.setView)
  return (
    <div className="data-settings-tab space-y-6">
      <ImportSection />
      <ExportSection />
      <IntegrityCheckSection />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t('data.historyTitle')}
          </CardTitle>
          <CardDescription>{t('data.historyDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => setView('history')}>
            <History className="h-3.5 w-3.5" />
            {t('data.historyButton')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
