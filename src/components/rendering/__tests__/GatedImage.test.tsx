/**
 * Tests for the privacy-gated image render (#1492), shared by the editor node
 * view and the static renderer.
 *
 * Covers: external placeholder + domain + Load in click mode; clicking Load
 * loads the image (and remembers the host); never-mode placeholder has no Load;
 * allowlisted / always show the real `<img>`; local/data srcs always render the
 * `<img>`; a11y.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import {
  EXTERNAL_IMAGE_ALLOWLIST_KEY,
  EXTERNAL_IMAGE_POLICY_KEY,
} from '@/lib/external-image-policy'

import { GatedImage } from '../GatedImage'

// #1434 — resolving an `attachment:<id>` ref reads the bytes over IPC.
const mockReadAttachment = vi.fn()
vi.mock('@/lib/tauri', () => ({
  readAttachment: (...args: unknown[]) => mockReadAttachment(...args),
}))

afterEach(() => {
  localStorage.clear()
  mockReadAttachment.mockReset()
})

describe('GatedImage — local/data srcs always load', () => {
  it('renders the real <img> for a relative src under default policy', () => {
    render(<GatedImage src="/favicon.svg" alt="logo" />)
    const img = screen.getByTestId('image-rendered')
    expect(img.getAttribute('src')).toBe('/favicon.svg')
    expect(screen.queryByTestId('image-external-blocked')).toBeNull()
  })

  it('lazy-loads and async-decodes the real <img> to limit layout shift (#1642)', () => {
    render(<GatedImage src="/favicon.svg" alt="logo" />)
    const img = screen.getByTestId('image-rendered')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('decoding')).toBe('async')
  })

  it('falls back to the labelled broken-image placeholder on load error', () => {
    render(<GatedImage src="/missing.png" alt="a cat" />)
    fireEvent.error(screen.getByTestId('image-rendered'))
    expect(screen.queryByTestId('image-rendered')).toBeNull()
    expect(screen.getByTestId('image-broken').textContent).toContain('a cat')
  })
})

describe('GatedImage — click mode (default)', () => {
  it('shows a placeholder with the domain and a Load button (no <img>)', () => {
    render(<GatedImage src="https://images.example.com/cat.png" alt="cat" />)
    expect(screen.queryByTestId('image-rendered')).toBeNull()
    const blocked = screen.getByTestId('image-external-blocked')
    expect(blocked).toBeTruthy()
    expect(screen.getByTestId('image-external-domain').textContent).toBe('images.example.com')
    expect(screen.getByTestId('image-load-button')).toBeTruthy()
  })

  it('clicking Load loads the image and remembers the host', async () => {
    const user = userEvent.setup()
    render(<GatedImage src="https://images.example.com/cat.png" alt="cat" />)
    await user.click(screen.getByTestId('image-load-button'))

    // The real <img> is now mounted with the external src…
    const img = screen.getByTestId('image-rendered')
    expect(img.getAttribute('src')).toBe('https://images.example.com/cat.png')
    expect(screen.queryByTestId('image-external-blocked')).toBeNull()
    // …and the host was persisted to the allowlist.
    expect(localStorage.getItem(EXTERNAL_IMAGE_ALLOWLIST_KEY)).toContain('images.example.com')
  })

  it('auto-loads an already-allowlisted host', () => {
    localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, JSON.stringify(['images.example.com']))
    render(<GatedImage src="https://images.example.com/cat.png" alt="cat" />)
    expect(screen.getByTestId('image-rendered').getAttribute('src')).toBe(
      'https://images.example.com/cat.png',
    )
  })

  it('does NOT auto-load evil-example.com when only example.com is allowlisted', () => {
    localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, JSON.stringify(['example.com']))
    render(<GatedImage src="https://evil-example.com/cat.png" alt="cat" />)
    expect(screen.queryByTestId('image-rendered')).toBeNull()
    expect(screen.getByTestId('image-external-domain').textContent).toBe('evil-example.com')
  })
})

describe('GatedImage — never mode', () => {
  it('shows a muted placeholder with NO Load button', () => {
    localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'never')
    render(<GatedImage src="https://images.example.com/cat.png" alt="cat" />)
    expect(screen.queryByTestId('image-rendered')).toBeNull()
    expect(screen.getByTestId('image-external-blocked')).toBeTruthy()
    expect(screen.queryByTestId('image-load-button')).toBeNull()
    expect(screen.getByTestId('image-external-blocked-note')).toBeTruthy()
  })
})

describe('GatedImage — always mode', () => {
  it('renders the real <img> for an external src', () => {
    localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'always')
    render(<GatedImage src="https://images.example.com/cat.png" alt="cat" />)
    expect(screen.getByTestId('image-rendered').getAttribute('src')).toBe(
      'https://images.example.com/cat.png',
    )
  })
})

describe('GatedImage — a11y', () => {
  it('blocked placeholder has no a11y violations', async () => {
    const { container } = render(<GatedImage src="https://images.example.com/cat.png" alt="cat" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('GatedImage — attachment ref resolution (#1434)', () => {
  const ORIG_CREATE = URL.createObjectURL
  const ORIG_REVOKE = URL.revokeObjectURL
  afterEach(() => {
    URL.createObjectURL = ORIG_CREATE
    URL.revokeObjectURL = ORIG_REVOKE
  })

  it('resolves `attachment:<id>` to an object URL and renders the <img>', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:obj-1')
    URL.revokeObjectURL = vi.fn()
    mockReadAttachment.mockResolvedValue(new Uint8Array([1, 2, 3]))

    render(<GatedImage src="attachment:ATT_1" alt="pasted" />)

    // The attachment bytes are read by id, then the <img> renders the object URL.
    await waitFor(() => {
      expect(screen.getByTestId('image-rendered').getAttribute('src')).toBe('blob:obj-1')
    })
    expect(mockReadAttachment).toHaveBeenCalledWith('ATT_1')
    expect(screen.getByTestId('image-rendered').getAttribute('alt')).toBe('pasted')
  })

  it('shows the broken-image placeholder when the attachment fails to load', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:obj-2')
    mockReadAttachment.mockRejectedValue(new Error('gone'))

    render(<GatedImage src="attachment:MISSING" alt="pasted" />)

    await waitFor(() => {
      expect(screen.getByTestId('image-broken')).toBeTruthy()
    })
    expect(screen.queryByTestId('image-rendered')).toBeNull()
  })

  it('revokes the object URL on unmount', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:obj-3')
    const revoke = vi.fn()
    URL.revokeObjectURL = revoke
    mockReadAttachment.mockResolvedValue(new Uint8Array([9]))

    const { unmount } = render(<GatedImage src="attachment:ATT_2" alt="x" />)
    await waitFor(() => {
      expect(screen.getByTestId('image-rendered')).toBeTruthy()
    })
    unmount()
    expect(revoke).toHaveBeenCalledWith('blob:obj-3')
  })
})
