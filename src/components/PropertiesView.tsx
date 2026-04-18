/**
 * PropertiesView — browse, create, and manage property definitions.
 *
 * Thin orchestrator that renders DeadlineWarningSection and
 * PropertyDefinitionsList.
 */

import type React from 'react'
import { Separator } from '@/components/ui/separator'
import { DeadlineWarningSection } from './DeadlineWarningSection'
import { PropertyDefinitionsList } from './PropertyDefinitionsList'

export function PropertiesView(): React.ReactElement {
  return (
    <div className="space-y-4">
      <DeadlineWarningSection />
      <Separator />
      <PropertyDefinitionsList />
    </div>
  )
}
