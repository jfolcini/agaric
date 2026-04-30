/**
 * MimeIcon — small Lucide icon picker keyed off a MIME type string.
 *
 * Used by attachment list rows and attachment chips. `image/*` → Image,
 * `text/*` → FileText, everything else → File.
 */

import { File, FileText, Image as ImageIcon } from 'lucide-react'
import type React from 'react'

export function MimeIcon({ mimeType }: { mimeType: string }): React.ReactElement {
  if (mimeType.startsWith('image/')) {
    return <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  if (mimeType.startsWith('text/')) {
    return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  return <File className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
}
