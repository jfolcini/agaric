/**
 * useDialogOrSheet — returns a `Dialog` (or `AlertDialog`) on desktop and a
 * `Sheet` (`side="bottom"`) on mobile.
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
 * **`kind` discriminant:**
 *  - `'alert'` (default) — desktop returns `AlertDialog` parts. Use for
 *    confirmation prompts that must trap interaction until the user
 *    decides (e.g. delete confirmations). `ConfirmDialog` is the canonical
 *    consumer.
 *  - `'dialog'` — desktop returns the regular `Dialog` parts. Use for form-
 *    style surfaces where users can dismiss by clicking outside / pressing
 *    Escape without consequence (BugReportDialog, RenameDialog,
 *    WelcomeModal, QuickCaptureDialog, SpaceManageDialog, PdfViewerDialog).
 *
 * The mobile path is always `Sheet` regardless of `kind` — phones < 768 px
 * benefit from the same bottom-sheet ergonomics whether the surface is a
 * form or a confirmation. The desktop discriminant only swaps Radix's
 * AlertDialog (auto-close action buttons, more restrictive focus trap) for
 * regular Dialog (manual close, lighter modal semantics).
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

import { useIsMobile } from './useIsMobile'

export type DialogKind = 'alert' | 'dialog'

interface DesktopAlertParts {
  isMobile: false
  kind: 'alert'
  Root: typeof AlertDialog
  Content: typeof AlertDialogContent
  Header: typeof AlertDialogHeader
  Title: typeof AlertDialogTitle
  Description: typeof AlertDialogDescription
  Footer: typeof AlertDialogFooter
}

interface DesktopDialogParts {
  isMobile: false
  kind: 'dialog'
  Root: typeof Dialog
  Content: typeof DialogContent
  Header: typeof DialogHeader
  Title: typeof DialogTitle
  Description: typeof DialogDescription
  Footer: typeof DialogFooter
}

interface MobileParts {
  isMobile: true
  kind: DialogKind
  Root: typeof Sheet
  Content: typeof SheetContent
  Header: typeof SheetHeader
  Title: typeof SheetTitle
  Description: typeof SheetDescription
  Footer: typeof SheetFooter
}

export type DialogOrSheetParts = DesktopAlertParts | DesktopDialogParts | MobileParts

export function useDialogOrSheet(kind: DialogKind = 'alert'): DialogOrSheetParts {
  const isMobile = useIsMobile()
  if (isMobile) {
    return {
      isMobile: true,
      kind,
      Root: Sheet,
      Content: SheetContent,
      Header: SheetHeader,
      Title: SheetTitle,
      Description: SheetDescription,
      Footer: SheetFooter,
    }
  }
  if (kind === 'dialog') {
    return {
      isMobile: false,
      kind: 'dialog',
      Root: Dialog,
      Content: DialogContent,
      Header: DialogHeader,
      Title: DialogTitle,
      Description: DialogDescription,
      Footer: DialogFooter,
    }
  }
  return {
    isMobile: false,
    kind: 'alert',
    Root: AlertDialog,
    Content: AlertDialogContent,
    Header: AlertDialogHeader,
    Title: AlertDialogTitle,
    Description: AlertDialogDescription,
    Footer: AlertDialogFooter,
  }
}
