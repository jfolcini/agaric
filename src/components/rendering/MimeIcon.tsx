/**
 * MimeIcon — small Lucide icon picker keyed off a MIME type string.
 *
 * Used by attachment list rows and attachment chips. `image/*` → Image,
 * `text/*` → FileText, everything else → File.
 *
 * Sized from the font-size setting rather than in em: the chips pin text-xs,
 * where 1em would stay 12px at every setting (#5369).
 */

import { File, FileText, Image as ImageIcon } from 'lucide-react'
import type React from 'react'

export function MimeIcon({ mimeType }: { mimeType: string }): React.ReactElement {
  if (mimeType.startsWith('image/')) {
    return (
      <ImageIcon
        className="size-[var(--agaric-font-size,1rem)] shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    )
  }
  if (mimeType.startsWith('text/')) {
    return (
      <FileText
        className="size-[var(--agaric-font-size,1rem)] shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    )
  }
  return (
    <File
      className="size-[var(--agaric-font-size,1rem)] shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  )
}
