import 'vitest'

interface AxeMatchers {
  toHaveNoViolations(): void
}

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
