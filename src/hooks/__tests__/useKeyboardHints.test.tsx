import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetHardwareKeyboardLatchForTests } from '@/hooks/useHasHardwareKeyboard'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useKeyboardHints } from '@/hooks/useKeyboardHints'

vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: vi.fn(() => true) }))

function Probe(): React.ReactElement {
  return <div data-testid="probe">{useKeyboardHints() ? 'shown' : 'hidden'}</div>
}

beforeEach(() => {
  _resetHardwareKeyboardLatchForTests()
})

afterEach(() => {
  _resetHardwareKeyboardLatchForTests()
})

describe('useKeyboardHints', () => {
  it('hides keyboard hints on a touch device with no hardware keyboard', () => {
    vi.mocked(useIsTouch).mockReturnValue(true)
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('hidden')
  })

  it('shows them on a touch device once a hardware key is pressed', () => {
    vi.mocked(useIsTouch).mockReturnValue(true)
    render(<Probe />)
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByTestId('probe')).toHaveTextContent('shown')
  })

  it('shows them on a fine pointer before any key is pressed', () => {
    vi.mocked(useIsTouch).mockReturnValue(false)
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('shown')
  })
})
