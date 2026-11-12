/**
 * NoPeersPairing — what the sidebar Sync button opens while no device is
 * paired: `NoPeersDialog`, whose CTA opens the pairing dialog itself (#6520),
 * so pairing is one step away rather than three.
 *
 * Rendered inside `SidebarProvider` because on a phone the Sync button lives
 * in the navigation drawer, which would otherwise stay over the pairing sheet.
 * Both dialogs are lazy: they only ship once the no-peers branch fires.
 */

import type React from 'react'
import { lazy, Suspense, useCallback, useState } from 'react'

import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { useSidebar } from '@/components/ui/sidebar'

const NoPeersDialog = lazy(() =>
  import('@/components/dialogs/NoPeersDialog').then((m) => ({ default: m.NoPeersDialog })),
)
const PairingDialog = lazy(() =>
  import('@/components/dialogs/PairingDialog').then((m) => ({ default: m.PairingDialog })),
)

interface NoPeersPairingProps {
  /** Whether the "No devices paired" dialog is open. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NoPeersPairing({ open, onOpenChange }: NoPeersPairingProps): React.ReactElement {
  const { isMobile, setOpenMobile } = useSidebar()
  const [pairingOpen, setPairingOpen] = useState(false)

  const handlePair = useCallback(() => {
    onOpenChange(false)
    if (isMobile) setOpenMobile(false)
    setPairingOpen(true)
  }, [onOpenChange, isMobile, setOpenMobile])

  return (
    <FeatureErrorBoundary name="Sync setup" nameKey="errorBoundary.section.syncSetup">
      <Suspense fallback={null}>
        {open && <NoPeersDialog open onOpenChange={onOpenChange} onPair={handlePair} />}
        {pairingOpen && <PairingDialog open onOpenChange={setPairingOpen} />}
      </Suspense>
    </FeatureErrorBoundary>
  )
}
