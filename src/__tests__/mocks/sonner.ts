// Shared Sonner mock used by the global vi.mock('sonner') in src/test-setup.ts
// and available for individual test files to import when they need to assert
// on specific toast calls.
//
// Usage (default via setupFiles): tests that just need sonner to not blow up
// require no further action — the global mock from test-setup.ts applies
// automatically.
//
// Usage (assertions): test files that want to assert on toast calls can import
// `toast` from `sonner` directly (the global mock returns the singleton below)
// and call `vi.mocked(toast.error).toHaveBeenCalledWith(...)`. Or import the
// `toast` singleton from this file for direct access.
//
// Usage (overrides): tests that need custom capture variables can still
// declare their own per-file `vi.mock('sonner', () => ({ ... }))`, which
// overrides this shared mock for that file. The shared mock is therefore
// opt-out, not opt-in.
import { createElement, forwardRef } from 'react'
import { vi } from 'vitest'

// A callable mock function with method properties attached — sonner's `toast`
// can be called directly (`toast('msg')`) and also exposes typed methods
// (`toast.error`, `toast.success`, etc.).
type ToastMock = ReturnType<typeof vi.fn> & {
  error: ReturnType<typeof vi.fn>
  success: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  message: ReturnType<typeof vi.fn>
  loading: ReturnType<typeof vi.fn>
  promise: ReturnType<typeof vi.fn>
  custom: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}

export const toast: ToastMock = Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  message: vi.fn(),
  loading: vi.fn(),
  promise: vi.fn(),
  custom: vi.fn(),
  dismiss: vi.fn(),
})

// Stub component exports so `import { Toaster } from 'sonner'` in app code
// doesn't crash when resolved through the mock. Uses forwardRef so that the
// UI wrapper in `src/components/ui/sonner.tsx` (which forwards its ref to the
// inner `Toaster`) can still attach to a real DOM node in unit tests — see
// `src/components/ui/__tests__/sonner.test.tsx`.
export const Toaster = forwardRef<HTMLElement>((props, ref) =>
  createElement('section', {
    ref,
    'data-testid': 'sonner-toaster-mock',
    ...(props as Record<string, unknown>),
  }),
)
;(Toaster as { displayName?: string }).displayName = 'Toaster'

/** Reset all toast mock state. Call from test `beforeEach` if needed. */
export function resetToastMocks() {
  toast.mockReset()
  toast.error.mockReset()
  toast.success.mockReset()
  toast.warning.mockReset()
  toast.info.mockReset()
  toast.message.mockReset()
  toast.loading.mockReset()
  toast.promise.mockReset()
  toast.custom.mockReset()
  toast.dismiss.mockReset()
}
