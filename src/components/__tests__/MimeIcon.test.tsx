/**
 * Tests for the shared MimeIcon component (extracted from AttachmentList +
 * AttachmentRenderer; previously two byte-identical copies — MAINT-129).
 */

import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { MimeIcon } from '../MimeIcon'

describe('MimeIcon', () => {
  it('renders an Image icon for image/* mime types', () => {
    const { container } = render(<MimeIcon mimeType="image/png" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // Lucide attaches the icon name as a class for the rendered SVG.
    expect(svg?.classList.value).toContain('lucide-image')
  })

  it('renders a FileText icon for text/* mime types', () => {
    const { container } = render(<MimeIcon mimeType="text/markdown" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.classList.value).toContain('lucide-file-text')
  })

  it('falls back to a generic File icon for everything else', () => {
    const { container } = render(<MimeIcon mimeType="application/pdf" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // Generic File icon — not the FileText variant.
    expect(svg?.classList.value).toContain('lucide-file')
    expect(svg?.classList.value).not.toContain('lucide-file-text')
  })

  it('marks the icon as decorative (aria-hidden)', () => {
    const { container } = render(<MimeIcon mimeType="image/jpeg" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('shares the canonical sizing classes used across attachment surfaces', () => {
    const { container } = render(<MimeIcon mimeType="text/plain" />)
    const svg = container.querySelector('svg')
    expect(svg?.classList.value).toContain('h-4')
    expect(svg?.classList.value).toContain('w-4')
    expect(svg?.classList.value).toContain('shrink-0')
    expect(svg?.classList.value).toContain('text-muted-foreground')
  })

  it('has no a11y violations', async () => {
    const { container } = render(<MimeIcon mimeType="image/png" />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
