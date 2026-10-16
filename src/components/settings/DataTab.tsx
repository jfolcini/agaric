/**
 * DataTab — Import/Export data management, and the way into Edit history.
 * (The `'DataSettingsTab'` logger label used by the sections/hook below is
 * kept stable across renames as a telemetry namespace.)
 *
 * Composition wiring: the Import card (all import affordances + the shared
 * import-runner state machine) lives in {@link ImportSection}, the Export
 * card in {@link ExportSection}. The pure import logic lives in
 * `@/lib/vault-import` and the shared runner in `./useImportRunner`.
 */

import { History } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ExportSection } from '@/components/settings/ExportSection'
import { ImportSection } from '@/components/settings/ImportSection'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { SettingRow } from '@/components/ui/setting-row'
import { useNavigationStore } from '@/stores/navigation'

export function DataTab(): React.ReactElement {
  const { t } = useTranslation()
  const setView = useNavigationStore((s) => s.setView)

  return (
    <div className="data-settings-tab space-y-6">
      <ImportSection />
      <ExportSection />
      {/* HistoryView is a full-page view: it portals its filter bar into the
          shell header and takes Space / Enter / arrows on `document`, so the
          row opens it rather than hosting it. */}
      <Card>
        <CardContent>
          <SettingRow
            label={t('settings.history.label')}
            description={t('settings.history.description')}
          >
            <Button variant="outline" size="sm" onClick={() => setView('history')}>
              <History />
              {t('settings.history.openButton')}
            </Button>
          </SettingRow>
        </CardContent>
      </Card>
    </div>
  )
}
