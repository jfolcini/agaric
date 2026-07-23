/**
 * DataTab — Import/Export data management. (The `'DataSettingsTab'`
 * logger label used by the sections/hook below is kept stable across
 * renames as a telemetry namespace.)
 *
 * Thin composition wiring only: the Import card (all import affordances +
 * the shared import-runner state machine) lives in {@link ImportSection},
 * and the Export card in {@link ExportSection}. The pure import logic lives
 * in `@/lib/vault-import` and the shared runner in `./useImportRunner`.
 */

import type React from 'react'

import { ExportSection } from '@/components/settings/ExportSection'
import { ImportSection } from '@/components/settings/ImportSection'

export function DataTab(): React.ReactElement {
  return (
    <div className="data-settings-tab space-y-6">
      <ImportSection />
      <ExportSection />
    </div>
  )
}
