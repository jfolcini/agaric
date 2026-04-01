import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { QrScanner } from '../QrScanner'

// Mock html5-qrcode module so dynamic import resolves without camera
vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class MockHtml5Qrcode {
    async start() {
      throw new Error('Camera access denied')
    }
    async stop() {}
  },
}))

describe('QrScanner', () => {
  it('renders without crashing', () => {
    render(<QrScanner onScan={vi.fn()} />)
    expect(screen.getByText('Camera preview')).toBeDefined()
  })

  it('shows scan button', () => {
    render(<QrScanner onScan={vi.fn()} />)
    expect(screen.getByRole('button', { name: /scan qr code/i })).toBeDefined()
  })

  it('passes accessibility audit', async () => {
    const { container } = render(<QrScanner onScan={vi.fn()} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('scanner region has aria-label', () => {
    render(<QrScanner onScan={vi.fn()} />)
    const region = document.getElementById('qr-scanner-region')
    expect(region).toBeTruthy()
    expect(region?.getAttribute('aria-label')).toBe('QR code scanner viewport')
    expect(region?.tagName.toLowerCase()).toBe('section')
  })

  it('calls onError when camera access fails', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    const onError = vi.fn()

    render(<QrScanner onScan={onScan} onError={onError} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    // Should show error and call onError callback
    expect(await screen.findByText('Camera access denied')).toBeDefined()
    expect(onError).toHaveBeenCalledWith('Camera access denied')
    expect(onScan).not.toHaveBeenCalled()
  })

  it('shows Retry Camera button after error', async () => {
    const user = userEvent.setup()
    render(<QrScanner onScan={vi.fn()} onError={vi.fn()} />)

    const scanBtn = screen.getByRole('button', { name: /scan qr code/i })
    await user.click(scanBtn)

    // After error, button text should change to "Retry Camera"
    expect(await screen.findByRole('button', { name: /retry camera/i })).toBeDefined()
  })
})
