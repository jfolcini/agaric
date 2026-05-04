/**
 * useDialogOrSheet — returns a Dialog (AlertDialog) on desktop and a
 * Sheet (`side="bottom"`) on mobile.
 *
 * Both Radix primitives share the same `open` / `onOpenChange` controlled
 * API, so a caller can swap them at the structural level: `<Root>`,
 * `<Content>`, `<Header>`, `<Title>`, `<Description>`, `<Footer>`.
 *
 * The hook returns a discriminated union keyed by `isMobile` so callers can
 * branch on action / cancel button rendering when needed (the AlertDialog
 * primitives auto-close on click, while Sheet has no equivalent and the
 * caller must close via `onOpenChange(false)`).
 *
 * PEND-23 H3 — applied to ConfirmDialog first; consumers that wrap it
 * (HistoryRestoreDialog, ConflictKeepDialog) inherit the Sheet behaviour
 * automatically on phones < 768 px.
 */

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from './useIsMobile'

interface DesktopParts {
  isMobile: false
  Root: typeof AlertDialog
  Content: typeof AlertDialogContent
  Header: typeof AlertDialogHeader
  Title: typeof AlertDialogTitle
  Description: typeof AlertDialogDescription
  Footer: typeof AlertDialogFooter
}

interface MobileParts {
  isMobile: true
  Root: typeof Sheet
  Content: typeof SheetContent
  Header: typeof SheetHeader
  Title: typeof SheetTitle
  Description: typeof SheetDescription
  Footer: typeof SheetFooter
}

export type DialogOrSheetParts = DesktopParts | MobileParts

export function useDialogOrSheet(): DialogOrSheetParts {
  const isMobile = useIsMobile()
  if (isMobile) {
    return {
      isMobile: true,
      Root: Sheet,
      Content: SheetContent,
      Header: SheetHeader,
      Title: SheetTitle,
      Description: SheetDescription,
      Footer: SheetFooter,
    }
  }
  return {
    isMobile: false,
    Root: AlertDialog,
    Content: AlertDialogContent,
    Header: AlertDialogHeader,
    Title: AlertDialogTitle,
    Description: AlertDialogDescription,
    Footer: AlertDialogFooter,
  }
}
